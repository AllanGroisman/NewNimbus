// Testa a corrida critica do OPS_FIELDS: scheduler escreve campos operacionais
// (queue, history, sentToday, etc) e PUT /api/state do frontend NAO pode
// sobrescrever esses campos. Esta logica fica em backend/storage.js.

import { describe, it, expect } from "vitest";
import { request, app, createTestUser, storage } from "../helpers/app.js";
import { makeGroup } from "../helpers/fixtures.js";

describe("GET /api/state — vazio", () => {
  it("devolve state default pro user novo", async () => {
    const { auth } = await createTestUser({ plan: "pro" });
    const res = await auth("get", "/api/state");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      groups: [],
      numbers: [],
      whatsappGroups: [],
      settings: {},
    });
  });
});

describe("PUT /api/state — save basico", () => {
  it("persiste groups, numbers, settings", async () => {
    const { auth } = await createTestUser({ plan: "pro" });
    const payload = {
      groups: [makeGroup({ id: 1, name: "G1" })],
      numbers: [{ id: "num-1", phone: "5511..." }],
      whatsappGroups: [],
      settings: { theme: "dark" },
    };
    const put = await auth("put", "/api/state").send(payload);
    expect(put.status).toBe(200);
    const get = await auth("get", "/api/state");
    expect(get.body.groups[0].name).toBe("G1");
    expect(get.body.settings.theme).toBe("dark");
  });
});

describe("OPS_FIELDS — preservacao da escrita do scheduler", () => {
  it("frontend save NAO apaga queue/history/sentToday/lastSend do disco", async () => {
    const { user, auth } = await createTestUser({ plan: "pro" });

    const grupo = makeGroup({ id: 42, name: "Campanha X" });
    await auth("put", "/api/state").send({ groups: [grupo] });

    await storage.updateGroupOps(user.id, 42, {
      queue: [{ key: "k1", name: "Produto A", link: "https://x.com/a" }],
      history: [{ key: "h1", name: "Antigo", sentAt: new Date().toISOString() }],
      sentToday: 3,
      sentWeek: 5,
      weekData: [1, 1, 0, 0, 1, 1, 1],
      lastSend: "2025-01-01T12:00:00.000Z",
      avgDiscount: 35,
    });

    const grupoSemOps = { ...grupo };
    delete grupoSemOps.queue;
    delete grupoSemOps.history;
    delete grupoSemOps.sentToday;
    delete grupoSemOps.lastSend;
    grupoSemOps.name = "Nome editado pelo user";
    await auth("put", "/api/state").send({ groups: [grupoSemOps] });

    const get = await auth("get", "/api/state");
    const g = get.body.groups.find(g => g.id === 42);
    expect(g.name).toBe("Nome editado pelo user");
    expect(g.queue).toHaveLength(1);
    expect(g.queue[0].name).toBe("Produto A");
    expect(g.history).toHaveLength(1);
    expect(g.sentToday).toBe(3);
    expect(g.sentWeek).toBe(5);
    expect(g.weekData).toEqual([1, 1, 0, 0, 1, 1, 1]);
    expect(g.lastSend).toBe("2025-01-01T12:00:00.000Z");
    expect(g.avgDiscount).toBe(35);
  });

  it("frontend save tambem NAO sobrescreve quando o payload contem campos ops", async () => {
    const { user, auth } = await createTestUser({ plan: "pro" });
    await auth("put", "/api/state").send({ groups: [makeGroup({ id: 7 })] });
    await storage.updateGroupOps(user.id, 7, {
      queue: [{ key: "scheduler-item", name: "Item do scheduler" }],
    });
    await auth("put", "/api/state").send({
      groups: [{ ...makeGroup({ id: 7 }), queue: [] }],
    });
    const get = await auth("get", "/api/state");
    const g = get.body.groups.find(g => g.id === 7);
    expect(g.queue).toHaveLength(1);
    expect(g.queue[0].name).toBe("Item do scheduler");
  });
});

describe("PUT /api/state — concorrência otimista (baseUpdatedAt)", () => {
  it("save sem baseUpdatedAt passa direto (primeiro save / retrocompat)", async () => {
    const { auth } = await createTestUser({ plan: "pro" });
    const r = await auth("put", "/api/state").send({ groups: [makeGroup({ id: 1, name: "A" })] });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.updatedAt).toBeTruthy(); // vira a versão atual do estado
  });

  it("save com baseUpdatedAt IGUAL à versão atual → 200 e avança a versão", async () => {
    const { auth } = await createTestUser({ plan: "pro" });
    const first = await auth("put", "/api/state").send({ groups: [makeGroup({ id: 1, name: "A" })] });
    const v1 = first.body.updatedAt;

    const ok = await auth("put", "/api/state").send({
      groups: [makeGroup({ id: 1, name: "B" })],
      baseUpdatedAt: v1,
    });
    expect(ok.status).toBe(200);
    expect(ok.body.updatedAt).toBeTruthy();
    expect(ok.body.updatedAt).not.toBe(v1); // versão nova

    const get = await auth("get", "/api/state");
    expect(get.body.groups[0].name).toBe("B");
    expect(get.body.updatedAt).toBe(ok.body.updatedAt);
  });

  it("save com baseUpdatedAt DEFASADO → 409 STALE_STATE e NÃO sobrescreve", async () => {
    const { auth } = await createTestUser({ plan: "pro" });
    const first = await auth("put", "/api/state").send({ groups: [makeGroup({ id: 1, name: "atual" })] });
    expect(first.status).toBe(200);

    // Cliente tenta salvar baseado numa versão antiga que já não bate mais.
    const stale = await auth("put", "/api/state").send({
      groups: [makeGroup({ id: 1, name: "defasado" })],
      baseUpdatedAt: "2000-01-01T00:00:00.000Z",
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("STALE_STATE");

    // O estado no banco continua sendo o mais novo — a escrita velha foi barrada.
    const get = await auth("get", "/api/state");
    expect(get.body.groups[0].name).toBe("atual");
  });

  it("depois de um 409, recarregar a versão e reenviar → 200 (fluxo de recuperação)", async () => {
    const { auth } = await createTestUser({ plan: "pro" });
    await auth("put", "/api/state").send({ groups: [makeGroup({ id: 1, name: "atual" })] });

    const stale = await auth("put", "/api/state").send({
      groups: [makeGroup({ id: 1, name: "x" })],
      baseUpdatedAt: "2000-01-01T00:00:00.000Z",
    });
    expect(stale.status).toBe(409);

    // Recupera: lê a versão real e reenvia com ela.
    const get = await auth("get", "/api/state");
    const fresh = get.body.updatedAt;
    const retry = await auth("put", "/api/state").send({
      groups: [makeGroup({ id: 1, name: "resolvido" })],
      baseUpdatedAt: fresh,
    });
    expect(retry.status).toBe(200);

    const final = await auth("get", "/api/state");
    expect(final.body.groups[0].name).toBe("resolvido");
  });
});

describe("GET /api/state/ops — polling do frontend", () => {
  it("devolve so os campos operacionais por grupo", async () => {
    const { user, auth } = await createTestUser({ plan: "pro" });
    await auth("put", "/api/state").send({ groups: [makeGroup({ id: 9 })] });
    await storage.updateGroupOps(user.id, 9, {
      queue: [{ key: "k", name: "X" }],
      sentToday: 2,
    });
    const ops = await auth("get", "/api/state/ops");
    expect(ops.status).toBe(200);
    expect(ops.body.groups).toHaveLength(1);
    expect(ops.body.groups[0].id).toBe(9);
    expect(ops.body.groups[0].queue).toHaveLength(1);
    expect(ops.body.groups[0].sentToday).toBe(2);
    expect(ops.body.groups[0].name).toBeUndefined();
  });
});

describe("POST/DELETE pending — fluxo de revisao", () => {
  it("aprova pending → move pra queue", async () => {
    const { user, auth } = await createTestUser({ plan: "pro" });
    await auth("put", "/api/state").send({ groups: [makeGroup({ id: 10 })] });
    await storage.updateGroupOps(user.id, 10, {
      pending: [{ id: "p1", key: "p1", name: "Pendente" }],
      queue: [],
    });
    const ap = await auth("post", "/api/state/groups/10/pending/p1/approve");
    expect(ap.status).toBe(200);
    expect(ap.body.queueSize).toBe(1);
    expect(ap.body.pendingSize).toBe(0);
  });

  it("rejeita pending → remove", async () => {
    const { user, auth } = await createTestUser({ plan: "pro" });
    await auth("put", "/api/state").send({ groups: [makeGroup({ id: 11 })] });
    await storage.updateGroupOps(user.id, 11, {
      pending: [{ id: "p1", key: "p1", name: "X" }, { id: "p2", key: "p2", name: "Y" }],
    });
    const r = await auth("delete", "/api/state/groups/11/pending/p1");
    expect(r.status).toBe(200);
    expect(r.body.pendingSize).toBe(1);
  });

  it("404 quando pid nao existe", async () => {
    const { auth } = await createTestUser({ plan: "pro" });
    await auth("put", "/api/state").send({ groups: [makeGroup({ id: 12 })] });
    const r = await auth("delete", "/api/state/groups/12/pending/inexistente");
    expect(r.status).toBe(404);
  });
});

describe("DELETE /api/state/groups/:gid/history — reset", () => {
  it("limpa history, sentToday, sentWeek, lastSend", async () => {
    const { user, auth } = await createTestUser({ plan: "pro" });
    await auth("put", "/api/state").send({ groups: [makeGroup({ id: 13 })] });
    await storage.updateGroupOps(user.id, 13, {
      history: [{ key: "h", name: "Antigo", sentAt: new Date().toISOString() }],
      sentToday: 5,
      sentWeek: 10,
      lastSend: new Date().toISOString(),
    });
    const r = await auth("delete", "/api/state/groups/13/history");
    expect(r.status).toBe(200);
    const ops = await auth("get", "/api/state/ops");
    const g = ops.body.groups.find(g => g.id === 13);
    expect(g.history).toHaveLength(0);
    expect(g.sentToday).toBe(0);
    expect(g.sentWeek).toBe(0);
    expect(g.lastSend).toBe("—");
  });
});
