// Cookie do ML + etiquetas da conta: `PUT /api/affiliate` (salvar o cookie já o
// testa, buscando as etiquetas) e `POST /api/affiliate/ml/etiquetas` (o "Testar
// conexão", que rebusca com o cookie salvo). fetch mockado no lugar do ML.
//
// O que pode quebrar sem ninguém notar: gravar um cookie que o ML não aceita,
// usar o cookie errado (o da conta do sistema em vez do do próprio usuário), ou
// a padrão não seguir a etiqueta em uso no ML.
//
// No fim, o refresh do affiliate-store: é ele que leva a config gravada no
// server até o worker, que tem o cache dele.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { request, app, createTestUser, affiliate, prisma } from "../helpers/app.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const store = require(path.resolve(__dirname, "..", "..", "backend", "scraping", "affiliate-store"));
const FX = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "fixtures", "ml-etiquetas.json"), "utf8"));

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const login = () => new Response("Found", { status: 302, headers: { location: "https://www.mercadolivre.com/jms/mlb/lgz/login" } });

let fetchMock, getTags;

beforeEach(() => {
  getTags = () => json(FX.getTags);
  fetchMock = vi.fn(async (url) => {
    if (new URL(url).pathname.endsWith("/getTags")) return getTags();
    return new Response("", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const TAGS = [
  { tag: "allangroisman", inUse: true, createdAt: "2026-07-21 17:27:07.151627" },
  { tag: "grupo-ofertas", inUse: false, createdAt: "2026-09-30 10:00:00.000000" },
];

describe("PUT /api/affiliate — salvar o cookie já testa", () => {
  it("grava o cookie, as etiquetas e a padrão (a em uso no ML); o status volta com elas", async () => {
    const { user, auth } = await createTestUser();
    affiliate.writeScraperMLAdminSession({ cookie: "ssid=cookie-do-sistema", tag: "sistema" });

    const res = await auth("put", "/api/affiliate").send({ cookie: "ssid=cookie-do-cliente" });
    expect(res.status).toBe(200);
    expect(res.body.ml).toMatchObject({ configured: true, tag: "allangroisman", tags: TAGS });
    expect(res.body.ml.tagsFetchedAt).toEqual(expect.any(String));
    // Testou com o cookie que acabou de chegar — nunca com o da conta do sistema.
    expect(fetchMock.mock.calls[0][1].headers.Cookie).toBe("ssid=cookie-do-cliente");
    expect(affiliate.readMLConfig(user.id)).toMatchObject({ cookie: "ssid=cookie-do-cliente", tag: "allangroisman" });
    affiliate.clearScraperMLAdminSession();
  });

  it("a TAG manual não existe mais: `tag` no corpo é ignorada", async () => {
    const { user, auth } = await createTestUser();
    const res = await auth("put", "/api/affiliate").send({ tag: "digitada", cookie: "ssid=x" });
    expect(res.status).toBe(200);
    expect(affiliate.readMLConfig(user.id).tag).toBe("allangroisman");
  });

  it("sem cookie: 400, sem chamar o ML", async () => {
    const { auth } = await createTestUser();
    const res = await auth("put", "/api/affiliate").send({ tag: "so-tag" });
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cookie que o ML não aceita (302 pro login): 409 e o cookie de antes fica", async () => {
    const { user, auth } = await createTestUser();
    affiliate.writeConfig(user.id, { tag: "allangroisman", cookie: "ssid=bom" });
    getTags = login;

    const res = await auth("put", "/api/affiliate").send({ cookie: "ssid=vencido" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe(affiliate.ML_LINK_KIND.COOKIE);
    expect(res.body.error).toMatch(/não aceitou este cookie/i);
    expect(affiliate.readMLConfig(user.id).cookie).toBe("ssid=bom");
  });

  it("conta sem etiqueta: 409 pedindo pra criar uma, sem gravar", async () => {
    const { user, auth } = await createTestUser();
    getTags = () => json([]);
    const res = await auth("put", "/api/affiliate").send({ cookie: "ssid=x" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/não tem etiquetas/);
    expect(affiliate.readMLConfig(user.id).cookie).toBe(null);
  });
});

describe("POST /api/affiliate/ml/etiquetas — Testar conexão", () => {
  it("exige login", async () => {
    const res = await request(app).post("/api/affiliate/ml/etiquetas");
    expect(res.status).toBe(401);
  });

  it("qualquer usuário rebusca com o PRÓPRIO cookie salvo", async () => {
    const { user, auth } = await createTestUser();
    // Config de antes da task 5: TAG digitada, sem lista.
    affiliate.writeConfig(user.id, { tag: "digitada", cookie: "ssid=cookie-do-cliente" });

    const res = await auth("post", "/api/affiliate/ml/etiquetas");
    expect(res.status).toBe(200);
    expect(res.body.ml).toMatchObject({ tag: "allangroisman", tags: TAGS });
    expect(fetchMock.mock.calls[0][1].headers.Cookie).toBe("ssid=cookie-do-cliente");
    // O cookie não muda; a padrão passa a ser a em uso no ML.
    expect(affiliate.readMLConfig(user.id)).toMatchObject({ cookie: "ssid=cookie-do-cliente", tag: "allangroisman" });
  });

  it("a padrão acompanha a em uso no ML", async () => {
    const { user, auth } = await createTestUser();
    affiliate.writeConfig(user.id, { tag: "allangroisman", cookie: "ssid=c" });
    getTags = () => json(FX.getTags.map(t => ({ ...t, in_use: t.tag === "grupo-ofertas" })));

    const res = await auth("post", "/api/affiliate/ml/etiquetas");
    expect(res.status).toBe(200);
    expect(affiliate.readMLConfig(user.id).tag).toBe("grupo-ofertas");
  });

  it("sem cookie: 409 com o motivo, sem chamar o ML", async () => {
    const { auth } = await createTestUser();
    const res = await auth("post", "/api/affiliate/ml/etiquetas");
    expect(res.status).toBe(409);
    expect(res.body.code).toBe(affiliate.ML_LINK_KIND.SEM_CONFIG);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cookie vencido: 409, e a lista de antes fica", async () => {
    const { user, auth } = await createTestUser();
    affiliate.writeConfig(user.id, { tag: "allangroisman", cookie: "ssid=c", tags: TAGS });
    getTags = login;

    const res = await auth("post", "/api/affiliate/ml/etiquetas");
    expect(res.status).toBe(409);
    expect(res.body.code).toBe(affiliate.ML_LINK_KIND.COOKIE);
    expect(affiliate.readMLConfig(user.id).tags).toEqual(TAGS);
  });

  it("a troca da em uso no ML saiu: o PUT não existe mais", async () => {
    const { auth } = await createTestUser();
    const res = await auth("put", "/api/affiliate/ml/etiquetas").send({ tag: "grupo-ofertas" });
    expect(res.status).toBe(404);
  });
});

describe("affiliate-store: refresh entre processos", () => {
  it("lê a TAG que outro processo gravou e avisa quem mudou", async () => {
    const { user } = await createTestUser();
    affiliate.writeConfig(user.id, { tag: "antiga", cookie: "ssid=c" });
    await store.flush();

    // Outro processo (o server) grava direto no banco.
    await prisma().affiliateConfig.update({
      where: { userId: user.id },
      data: { data: { ml: { tag: "nova", cookie: "ssid=c", updatedAt: new Date().toISOString() } } },
    });

    const avisados = [];
    const mudou = await store.refresh((id) => avisados.push(id));
    expect(mudou).toContain(user.id);
    expect(avisados).toContain(user.id);
    expect(affiliate.readMLConfig(user.id).tag).toBe("nova");

    // Sem mudança no banco, o próximo refresh não avisa ninguém por ele.
    expect(await store.refresh()).not.toContain(user.id);
  });

  it("linha apagada no banco sai do cache", async () => {
    const { user } = await createTestUser();
    affiliate.writeConfig(user.id, { tag: "x", cookie: "ssid=c" });
    await store.flush();
    await prisma().affiliateConfig.delete({ where: { userId: user.id } });

    expect(await store.refresh()).toContain(user.id);
    expect(affiliate.readMLConfig(user.id).tag).toBeNull();
  });

  it("não pisa numa gravação deste processo que ainda está em vôo", async () => {
    const { user } = await createTestUser();
    affiliate.writeConfig(user.id, { tag: "recente", cookie: "ssid=c" });
    // Sem flush: o upsert pode não ter chegado ao banco quando o refresh lê.
    await store.refresh();
    expect(affiliate.readMLConfig(user.id).tag).toBe("recente");
    await store.flush();
  });
});
