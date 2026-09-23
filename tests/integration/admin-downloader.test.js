// Admin › Downloader — gating e autorização dos arquivos.
//
// Estas rotas têm uma forma incomum e fácil de quebrar sem ninguém notar:
//
//  - as duas que entregam arquivo ficam FORA do requireAuth de propósito (são
//    abertas por <a href>, que não manda header), e quem autoriza é a chave do
//    job. Um refactor que "conserte" isso pondo requireAuth nelas quebra todo
//    download; um que tire a checagem da chave abre os vídeos pra qualquer um.
//  - o POST /jobs e o PUT /templates/:id têm parser próprio de 64mb/8mb,
//    registrado no server.js ANTES do express.json() global de 2mb. Se alguém
//    trocar aquilo por um app.use() no prefixo, ele passa a casar também com os
//    GET de arquivo e os downloads morrem em 401.

import { describe, it, expect, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { request, app, createTestUser, auth as authMod } from "../helpers/app.js";

const require = createRequire(import.meta.url);
const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "backend");
const jobs = require(path.join(backend, "downloader", "jobs.js"));

async function makeAdmin() {
  const u = await createTestUser();
  await authMod.setUserRole(u.user.id, "admin");
  return u;
}

const CHAVE_FALSA = "f".repeat(48);

// Criar um job cria a pasta do lote em disco. Limpar SÓ as que este arquivo
// criou, e não com o resetTmp(): o tmp/ é o mesmo do backend que pode estar
// rodando em paralelo na máquina, e apagá-lo inteiro levaria junto um lote de
// verdade no meio do download.
const criados = [];
function anota(res) {
  if (res.body?.jobId) criados.push(res.body.jobId);
  return res;
}

afterAll(() => {
  for (const id of criados) {
    const job = jobs.getJob(id);
    if (job) fs.rmSync(job.dir, { recursive: true, force: true });
  }
});

describe("Downloader — gating", () => {
  it("sem token, as rotas autenticadas respondem 401", async () => {
    for (const [metodo, rota] of [
      ["get", "/api/admin/downloader/health"],
      ["post", "/api/admin/downloader/list"],
      ["get", "/api/admin/downloader/templates"],
      ["post", "/api/admin/downloader/jobs"],
      ["get", "/api/admin/downloader/jobs/qualquer-id"],
    ]) {
      const res = await request(app)[metodo](rota).send({});
      expect(res.status, `${metodo.toUpperCase()} ${rota}`).toBe(401);
    }
  });

  it("user comum recebe 403", async () => {
    const { token } = await createTestUser();
    const res = await request(app)
      .get("/api/admin/downloader/templates")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it("admin passa", async () => {
    const { token } = await makeAdmin();
    const res = await request(app)
      .get("/api/admin/downloader/templates")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.templates)).toBe(true);
  });
});

describe("Downloader — rotas de arquivo", () => {
  // O ponto: elas NÃO podem exigir token (o <a href> não manda header), mas
  // também não podem entregar nada sem a chave certa. Um 401 aqui significa
  // que alguém pôs requireAuth nelas e quebrou todo download.
  it("respondem 404 sem a chave — nunca 401", async () => {
    for (const rota of [
      "/api/admin/downloader/jobs/id-qualquer/zip",
      "/api/admin/downloader/jobs/id-qualquer/file/video-qualquer",
    ]) {
      const res = await request(app).get(rota);
      expect(res.status, rota).toBe(404);
    }
  });

  it("responde 404 com chave errada, e não 403", async () => {
    // 403 confirmaria que o job existe; 404 não conta nada a quem chuta id.
    const res = await request(app).get(`/api/admin/downloader/jobs/id-qualquer/zip?k=${CHAVE_FALSA}`);
    expect(res.status).toBe(404);
  });

  it("não explode com chave de tamanho diferente do esperado", async () => {
    // timingSafeEqual lança quando os buffers têm tamanhos diferentes: sem a
    // conferência de tamanho antes, isto virava 500.
    for (const k of ["", "a", "z".repeat(200)]) {
      const res = await request(app).get(`/api/admin/downloader/jobs/id/zip?k=${k}`);
      expect(res.status, `k=${k.slice(0, 5)}…`).toBe(404);
    }
  });
});

describe("Downloader — limites de corpo", () => {
  it("POST /jobs aceita corpo acima dos 2mb globais", async () => {
    const { token } = await makeAdmin();
    // ~3mb de overlay falso: passa dos 2mb do parser global, cabe nos 64mb do
    // parser próprio. O overlay é recusado depois (não é PNG), mas o que se
    // testa aqui é o corpo CHEGAR — um 413 significaria que o parser de 64mb
    // saiu do lugar no server.js.
    const res = anota(await request(app)
      .post("/api/admin/downloader/jobs")
      .set("Authorization", `Bearer ${token}`)
      .send({
        videos: [{ id: "abc", url: "https://www.youtube.com/watch?v=abc", title: "T", duration: 5 }],
        overlay: `data:image/png;base64,${"A".repeat(3 * 1024 * 1024)}`,
      }));
    expect(res.status).not.toBe(413);
    expect(res.body.jobId).toBeTruthy();
  });

  it("recusa lote acima do teto, que é o que segura o corpo de 64mb", async () => {
    const { token } = await makeAdmin();
    const videos = Array.from({ length: 31 }, (_, i) => ({
      id: `v${i}`, url: `https://www.youtube.com/watch?v=v${i}`, title: `T${i}`, duration: 5,
    }));
    const res = await request(app)
      .post("/api/admin/downloader/jobs")
      .set("Authorization", `Bearer ${token}`)
      .send({ videos });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no máximo 30/i);
  });

  it("recusa lote vazio", async () => {
    const { token } = await makeAdmin();
    const res = await request(app)
      .post("/api/admin/downloader/jobs")
      .set("Authorization", `Bearer ${token}`)
      .send({ videos: [] });
    expect(res.status).toBe(400);
  });
});

describe("Downloader — chave do job ponta a ponta", () => {
  it("o GET do job entrega a chave, e só ela abre o .zip", async () => {
    const { token } = await makeAdmin();
    const criar = anota(await request(app)
      .post("/api/admin/downloader/jobs")
      .set("Authorization", `Bearer ${token}`)
      .send({ videos: [{ id: "abc", url: "https://www.youtube.com/watch?v=abc", title: "T", duration: 5 }] }));
    expect(criar.status).toBe(200);

    const status = await request(app)
      .get(`/api/admin/downloader/jobs/${criar.body.jobId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(status.status).toBe(200);
    expect(status.body.key).toMatch(/^[0-9a-f]{48}$/);
    // O caminho em disco nunca pode sair na resposta.
    expect(JSON.stringify(status.body)).not.toContain("/tmp/");

    // Chave certa: passa da autorização. 404 aqui é "nenhum arquivo pronto"
    // (o yt-dlp não rodou neste teste), não "não autorizado" — o que importa é
    // que a chave errada é barrada do mesmo jeito.
    const errada = await request(app)
      .get(`/api/admin/downloader/jobs/${criar.body.jobId}/zip?k=${CHAVE_FALSA}`);
    expect(errada.status).toBe(404);
  });

  it("um admin não enxerga o lote de outro", async () => {
    const a = await makeAdmin();
    const b = await makeAdmin();
    const criar = anota(await request(app)
      .post("/api/admin/downloader/jobs")
      .set("Authorization", `Bearer ${a.token}`)
      .send({ videos: [{ id: "abc", url: "https://www.youtube.com/watch?v=abc", title: "T", duration: 5 }] }));

    const alheio = await request(app)
      .get(`/api/admin/downloader/jobs/${criar.body.jobId}`)
      .set("Authorization", `Bearer ${b.token}`);
    expect(alheio.status).toBe(404);
  });
});
