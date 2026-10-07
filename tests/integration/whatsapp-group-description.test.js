// A descrição do grupo no WhatsApp (task 3): as rotas que o popup "Editar
// descrição" da aba Grupos usa — ler a atual e gravar uma nova, um grupo por vez.
//
// O que estes testes protegem: o texto vai para o WhatsApp como veio (vazio apaga),
// o limite de 2048 do WhatsApp é cobrado aqui, e as duas falhas que o usuário
// resolve sozinho (número caído, número que não é admin) voltam com o motivo
// legível — é o que o popup mostra ao lado de cada grupo no "aplicar em todos".
import { describe, it, expect, beforeEach } from "vitest";
import { request, app, createTestUser, waCalls, resetWa } from "../helpers/app.js";
import { setGroupDesc, failGroupDesc } from "../helpers/wa-mock.js";

const rota = (jid, numberId = "num-1") => `/api/whatsapp/sessions/${numberId}/groups/${encodeURIComponent(jid)}/description`;

beforeEach(() => resetWa());

describe("GET descrição", () => {
  it("devolve a descrição atual do grupo", async () => {
    const { auth } = await createTestUser();
    setGroupDesc("a@g.us", "Regras: só ofertas");
    const r = await auth("get", rota("a@g.us"));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ description: "Regras: só ofertas" });
  });

  it("grupo sem descrição volta texto vazio", async () => {
    const { auth } = await createTestUser();
    const r = await auth("get", rota("sem@g.us"));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ description: "" });
  });

  it("número desconectado volta 409 com o motivo", async () => {
    const { auth } = await createTestUser();
    failGroupDesc("a@g.us", "Sessão não está conectada (status: disconnected).");
    const r = await auth("get", rota("a@g.us"));
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: "not_connected", error: "O número deste grupo está desconectado." });
  });

  it("sem login, 401", async () => {
    const r = await request(app).get(rota("a@g.us"));
    expect(r.status).toBe(401);
  });
});

describe("PUT descrição", () => {
  it("grava no WhatsApp pelo número e grupo da rota", async () => {
    const { user, auth } = await createTestUser();
    const r = await auth("put", rota("a@g.us")).send({ description: "Nova descrição" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, description: "Nova descrição" });
    expect(waCalls.setGroupDescription).toEqual([{ userId: user.id, numberId: "num-1", jid: "a@g.us", description: "Nova descrição" }]);
    expect((await auth("get", rota("a@g.us"))).body.description).toBe("Nova descrição");
  });

  it("vazio é aceito: apaga a descrição", async () => {
    const { auth } = await createTestUser();
    setGroupDesc("a@g.us", "velha");
    const r = await auth("put", rota("a@g.us")).send({ description: "" });
    expect(r.status).toBe(200);
    expect(waCalls.setGroupDescription[0].description).toBe("");
    expect((await auth("get", rota("a@g.us"))).body.description).toBe("");
  });

  it("acima de 2048 caracteres é recusado antes de chegar no WhatsApp", async () => {
    const { auth } = await createTestUser();
    const ok = await auth("put", rota("a@g.us")).send({ description: "x".repeat(2048) });
    expect(ok.status).toBe(200);
    const longo = await auth("put", rota("a@g.us")).send({ description: "x".repeat(2049) });
    expect(longo.status).toBe(400);
    expect(waCalls.setGroupDescription).toHaveLength(1);
  });

  it("sem texto (ou não-texto) é 400", async () => {
    const { auth } = await createTestUser();
    expect((await auth("put", rota("a@g.us")).send({})).status).toBe(400);
    expect((await auth("put", rota("a@g.us")).send({ description: 123 })).status).toBe(400);
    expect(waCalls.setGroupDescription).toHaveLength(0);
  });

  it("número que não é admin: 409 not_admin", async () => {
    const { auth } = await createTestUser();
    failGroupDesc("a@g.us", "not-authorized");
    const r = await auth("put", rota("a@g.us")).send({ description: "x" });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: "not_admin", error: "O número não é admin deste grupo." });
  });

  it("número desconectado: 409 not_connected", async () => {
    const { auth } = await createTestUser();
    failGroupDesc("a@g.us", "Sessão não encontrada — adicione o número primeiro.");
    const r = await auth("put", rota("a@g.us")).send({ description: "x" });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("not_connected");
  });

  it("outra falha do WhatsApp vira 500 genérico", async () => {
    const { auth } = await createTestUser();
    failGroupDesc("a@g.us", "rate-overlimit");
    const r = await auth("put", rota("a@g.us")).send({ description: "x" });
    expect(r.status).toBe(500);
  });

  it("sem login, 401", async () => {
    const r = await request(app).put(rota("a@g.us")).send({ description: "x" });
    expect(r.status).toBe(401);
  });
});
