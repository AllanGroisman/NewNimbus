// Limpeza automática das conversas de grupo (task 13): o popup "Limpeza
// automática" de cada número na aba WhatsApp.
//
// O que estes testes protegem: a configuração é por usuário e por número, só aceita
// as frequências do popup e jids de grupo, o "Limpar agora" passa pelo worker e
// grava o resumo, número desconectado volta 409 legível, e o tick só roda o que
// venceu — sem avançar o relógio quando a limpeza falhou.
import { describe, it, expect, beforeEach } from "vitest";
import { createRequire } from "module";
import { request, app, createTestUser, waCalls, resetWa, waConnect } from "../helpers/app.js";

const require = createRequire(import.meta.url);
const chatCleanup = require("../../backend/whatsapp/chat-cleanup.js");
const { prisma } = require("../../backend/db.js");

const rota = (numberId = "num-1") => `/api/whatsapp/sessions/${numberId}/cleanup`;

beforeEach(() => resetWa());

describe("GET/PUT configuração", () => {
  it("salva e devolve a configuração do número", async () => {
    const { auth } = await createTestUser();
    const put = await auth("put", rota()).send({ enabled: true, intervalHours: 24, jids: ["a@g.us", "b@g.us", "a@g.us"] });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ numberId: "num-1", enabled: true, intervalHours: 24, jids: ["a@g.us", "b@g.us"], lastRunAt: null });

    const get = await auth("get", "/api/whatsapp/cleanup");
    expect(get.status).toBe(200);
    expect(get.body).toHaveLength(1);
    expect(get.body[0]).toMatchObject({ numberId: "num-1", jids: ["a@g.us", "b@g.us"] });
  });

  it("segundo PUT atualiza em vez de duplicar", async () => {
    const { auth } = await createTestUser();
    await auth("put", rota()).send({ enabled: true, intervalHours: 24, jids: ["a@g.us"] });
    await auth("put", rota()).send({ enabled: false, intervalHours: 6, jids: [] });
    const get = await auth("get", "/api/whatsapp/cleanup");
    expect(get.body).toEqual([expect.objectContaining({ enabled: false, intervalHours: 6, jids: [] })]);
  });

  it("recusa frequência fora das opções", async () => {
    const { auth } = await createTestUser();
    const r = await auth("put", rota()).send({ enabled: true, intervalHours: 1, jids: ["a@g.us"] });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Frequência/);
  });

  it("recusa jid que não é de grupo", async () => {
    const { auth } = await createTestUser();
    const r = await auth("put", rota()).send({ enabled: true, intervalHours: 24, jids: ["5511999999999@s.whatsapp.net"] });
    expect(r.status).toBe(400);
  });

  it("um usuário não vê a configuração do outro", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    await a.auth("put", rota()).send({ enabled: true, intervalHours: 24, jids: ["a@g.us"] });
    const r = await b.auth("get", "/api/whatsapp/cleanup");
    expect(r.body).toEqual([]);
  });

  it("sem login, 401", async () => {
    expect((await request(app).get("/api/whatsapp/cleanup")).status).toBe(401);
    expect((await request(app).put(rota()).send({})).status).toBe(401);
  });
});

describe("POST limpar agora", () => {
  it("manda os grupos marcados pelo worker e grava o resumo", async () => {
    const { user, auth } = await createTestUser();
    waConnect(user.id, "num-1");
    await auth("put", rota()).send({ enabled: false, intervalHours: 24, jids: ["a@g.us", "b@g.us"] });
    const r = await auth("post", `${rota()}/run`);
    expect(r.status).toBe(200);
    expect(waCalls.clearGroupChats).toEqual([{ userId: user.id, numberId: "num-1", jids: ["a@g.us", "b@g.us"] }]);
    expect(r.body.lastRunAt).toBeTruthy();
    expect(r.body.lastResult).toMatchObject({ cleared: 2, skipped: 0, errors: 0 });
  });

  it("sem grupos marcados, 400", async () => {
    const { user, auth } = await createTestUser();
    waConnect(user.id, "num-1");
    const r = await auth("post", `${rota()}/run`);
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("no_groups");
  });

  it("número desconectado volta 409 e não marca como rodado", async () => {
    const { auth } = await createTestUser();
    await auth("put", rota()).send({ enabled: true, intervalHours: 24, jids: ["a@g.us"] });
    const r = await auth("post", `${rota()}/run`);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("not_connected");
    const get = await auth("get", "/api/whatsapp/cleanup");
    expect(get.body[0].lastRunAt).toBeNull();
  });
});

describe("tick", () => {
  it("roda o que venceu e pula o que não venceu", async () => {
    const { user, auth } = await createTestUser();
    waConnect(user.id, "num-1");
    waConnect(user.id, "num-2");
    await auth("put", rota("num-1")).send({ enabled: true, intervalHours: 6, jids: ["a@g.us"] });
    await auth("put", rota("num-2")).send({ enabled: true, intervalHours: 24, jids: ["b@g.us"] });
    // num-2 rodou há 1h: só vence daqui a 23h.
    await prisma().whatsappChatCleanup.update({
      where: { userId_numberId: { userId: user.id, numberId: "num-2" } },
      data: { lastRunAt: new Date(Date.now() - 3600 * 1000) },
    });
    await chatCleanup.tick();
    const mine = waCalls.clearGroupChats.filter(c => c.userId === user.id);
    expect(mine.map(c => c.numberId)).toEqual(["num-1"]);
  });

  it("desligado não roda", async () => {
    const { user, auth } = await createTestUser();
    waConnect(user.id, "num-1");
    await auth("put", rota()).send({ enabled: false, intervalHours: 6, jids: ["a@g.us"] });
    await chatCleanup.tick();
    expect(waCalls.clearGroupChats.filter(c => c.userId === user.id)).toEqual([]);
  });

  it("número desconectado não avança lastRunAt", async () => {
    const { user, auth } = await createTestUser();
    await auth("put", rota()).send({ enabled: true, intervalHours: 6, jids: ["a@g.us"] });
    await chatCleanup.tick();
    const row = await prisma().whatsappChatCleanup.findUnique({
      where: { userId_numberId: { userId: user.id, numberId: "num-1" } },
    });
    expect(row.lastRunAt).toBeNull();
  });
});

describe("desconectar número", () => {
  it("mantém a configuração de limpeza (a rota é a mesma do Remover)", async () => {
    const { user, auth } = await createTestUser();
    waConnect(user.id, "num-1");
    await auth("put", rota()).send({ enabled: true, intervalHours: 24, jids: ["a@g.us"] });
    const del = await auth("delete", "/api/whatsapp/sessions/num-1");
    expect(del.status).toBe(200);
    const get = await auth("get", "/api/whatsapp/cleanup");
    expect(get.body).toEqual([expect.objectContaining({ numberId: "num-1", jids: ["a@g.us"] })]);
  });
});
