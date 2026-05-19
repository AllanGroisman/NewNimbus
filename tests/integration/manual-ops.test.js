// Endpoints HTTP de operações manuais: refill, manual-add (com cooldown/force),
// pending approve/reject, history clear. Complementa scheduler.test.js que cobre
// a função pura; aqui é o flow HTTP + edge cases (404, 409, isolamento por user).

import { describe, it, expect, beforeEach } from "vitest";
import { app, request, createTestUser, storage, catalog, affiliate, scheduler } from "../helpers/app.js";
import { mlProduct, amazonProduct, makeGroup, makeWhatsAppGroup } from "../helpers/fixtures.js";

async function userWithGroup(opts = {}) {
  const { user, auth, email } = await createTestUser();
  // Cada usuário tem afiliado próprio — configura aqui pra desbloquear gating ML.
  affiliate.writeConfig(user.id, { tag: "t", cookie: "c-sessid" });
  const group = makeGroup({
    id: opts.id ?? 700,
    sources: opts.sources || ["amazon"],
    auto: opts.auto !== undefined ? opts.auto : true,
    filters: opts.filters,
    schedule: opts.schedule,
    ...opts.group,
  });
  await auth("put", "/api/state").send({ groups: [group] });
  return { user, auth, email, group };
}

describe("POST /refill — endpoint HTTP", () => {
  beforeEach(async () => {
    await catalog.upsertProducts([
      mlProduct(10, { category: "gamer", discount: 30 }),
      mlProduct(11, { category: "gamer", discount: 60 }),
      mlProduct(12, { category: "casa",  discount: 80 }),
    ]);
  });

  it("popa a queue do grupo (auto=true)", async () => {
    const { auth } = await userWithGroup({ id: 401, sources: ["ml"], group: { categories: ["gamer"] } });
    const r = await auth("post", "/api/state/groups/401/refill").send({});
    expect(r.status).toBe(200);
    expect(r.body.target).toBe("queue");
    expect(r.body.queueSize).toBeGreaterThan(0);
  });

  it("popa pending quando auto=false", async () => {
    const { auth } = await userWithGroup({ id: 402, sources: ["ml"], auto: false, group: { categories: ["gamer"] } });
    const r = await auth("post", "/api/state/groups/402/refill").send({});
    expect(r.status).toBe(200);
    expect(r.body.target).toBe("pending");
    expect(r.body.pendingSize).toBeGreaterThan(0);
  });

  it("overrides de filtros (ainda não persistidos no group) aplicam", async () => {
    const { auth } = await userWithGroup({ id: 403, sources: ["ml"], group: { categories: ["gamer"] } });
    const r = await auth("post", "/api/state/groups/403/refill").send({
      filters: { minDiscount: 99 },
    });
    expect(r.status).toBe(200);
    expect(r.body.added).toBe(0);
  });

  it("404 quando o grupo não existe", async () => {
    const { auth } = await createTestUser();
    const r = await auth("post", "/api/state/groups/999/refill").send({});
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/encontrad/i);
  });
});

describe("POST /manual-add — endpoint HTTP", () => {
  const baseBody = {
    url: "https://www.amazon.com.br/dp/B0CMANUAL123",
    overrides: { name: "Item Manual", price: 99, originalPrice: 199, discount: 50, store: "Amazon" },
  };

  it("adiciona com sucesso na queue", async () => {
    const { auth } = await userWithGroup({ id: 501 });
    const r = await auth("post", "/api/state/groups/501/manual-add").send(baseBody);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.target).toBe("queue");
  });

  it("retorna 409 em duplicata na mesma queue", async () => {
    const { auth } = await userWithGroup({ id: 502 });
    await auth("post", "/api/state/groups/502/manual-add").send(baseBody);
    const dup = await auth("post", "/api/state/groups/502/manual-add").send(baseBody);
    expect(dup.status).toBe(409);
    expect(dup.body.code).toMatch(/duplicate_queue/);
  });

  it("retorna {inCooldown:true} quando produto saiu recentemente", async () => {
    const { user, auth } = await userWithGroup({
      id: 503,
      schedule: { windows: [{ from: "00:00", to: "23:59", interval: 0 }], cooldownValue: 24, cooldownUnit: "horas" },
    });
    const first = await auth("post", "/api/state/groups/503/manual-add").send(baseBody);
    expect(first.status).toBe(200);
    const itemKey = first.body.item.key;

    await storage.updateGroupOps(user.id, 503, {
      queue: [],
      history: [{ key: itemKey, name: "Item Manual", link: baseBody.url, sentAt: new Date().toISOString() }],
    });

    const cooldown = await auth("post", "/api/state/groups/503/manual-add").send(baseBody);
    expect(cooldown.status).toBe(200);
    expect(cooldown.body.inCooldown).toBe(true);
    expect(cooldown.body.cooldownMinutes).toBeGreaterThan(0);
  });

  it("force=true ignora cooldown e adiciona mesmo assim", async () => {
    const { user, auth } = await userWithGroup({
      id: 504,
      schedule: { windows: [{ from: "00:00", to: "23:59", interval: 0 }], cooldownValue: 24, cooldownUnit: "horas" },
    });
    const first = await auth("post", "/api/state/groups/504/manual-add").send(baseBody);
    const itemKey = first.body.item.key;
    await storage.updateGroupOps(user.id, 504, {
      queue: [],
      history: [{ key: itemKey, name: "Item Manual", link: baseBody.url, sentAt: new Date().toISOString() }],
    });

    const forced = await auth("post", "/api/state/groups/504/manual-add").send({ ...baseBody, force: true });
    expect(forced.status).toBe(200);
    expect(forced.body.ok).toBe(true);
    expect(forced.body.inCooldown).toBeUndefined();
  });

  it("rejeita url e name vazios", async () => {
    const { auth } = await userWithGroup({ id: 505 });
    const r1 = await auth("post", "/api/state/groups/505/manual-add").send({ url: "", overrides: { name: "x" } });
    expect(r1.status).toBe(400);
    const r2 = await auth("post", "/api/state/groups/505/manual-add").send({ url: "https://x.com", overrides: { name: "" } });
    expect(r2.status).toBe(400);
  });
});

describe("POST/DELETE /pending — aprovar/rejeitar", () => {
  it("approve move pending → queue", async () => {
    const { user, auth } = await userWithGroup({ id: 601, auto: false });
    await storage.updateGroupOps(user.id, 601, {
      pending: [{ id: "p1", key: "p1", name: "Pendente A" }],
      queue: [],
    });
    const r = await auth("post", "/api/state/groups/601/pending/p1/approve");
    expect(r.status).toBe(200);
    expect(r.body.queueSize).toBe(1);
    expect(r.body.pendingSize).toBe(0);
  });

  it("reject remove só o item solicitado", async () => {
    const { user, auth } = await userWithGroup({ id: 602, auto: false });
    await storage.updateGroupOps(user.id, 602, {
      pending: [
        { id: "p1", key: "p1", name: "A" },
        { id: "p2", key: "p2", name: "B" },
      ],
    });
    const r = await auth("delete", "/api/state/groups/602/pending/p1");
    expect(r.status).toBe(200);
    expect(r.body.pendingSize).toBe(1);
    const ops = await auth("get", "/api/state/ops");
    const g = ops.body.groups.find(g => g.id === 602);
    expect(g.pending[0].id).toBe("p2");
  });

  it("404 quando pid não existe (approve)", async () => {
    const { user, auth } = await userWithGroup({ id: 603, auto: false });
    await storage.updateGroupOps(user.id, 603, { pending: [] });
    const r = await auth("post", "/api/state/groups/603/pending/inexistente/approve");
    expect(r.status).toBe(404);
  });

  it("404 quando pid não existe (reject)", async () => {
    const { user, auth } = await userWithGroup({ id: 604, auto: false });
    await storage.updateGroupOps(user.id, 604, { pending: [{ id: "outro", key: "outro", name: "X" }] });
    const r = await auth("delete", "/api/state/groups/604/pending/inexistente");
    expect(r.status).toBe(404);
  });

  it("404 quando grupo não existe", async () => {
    const { auth } = await createTestUser();
    const r = await auth("post", "/api/state/groups/9999/pending/p1/approve");
    expect(r.status).toBe(404);
  });
});

describe("DELETE /history — limpa cooldown", () => {
  it("zera history, sentToday, sentWeek, weekData e lastSend", async () => {
    const { user, auth } = await userWithGroup({ id: 701 });
    await storage.updateGroupOps(user.id, 701, {
      history: [{ key: "h", name: "Antigo", sentAt: new Date().toISOString() }],
      sentToday: 5,
      sentWeek: 10,
      weekData: [1, 1, 1, 1, 1, 1, 1],
      lastSend: new Date().toISOString(),
    });

    const r = await auth("delete", "/api/state/groups/701/history");
    expect(r.status).toBe(200);

    const ops = await auth("get", "/api/state/ops");
    const g = ops.body.groups.find(g => g.id === 701);
    expect(g.history).toHaveLength(0);
    expect(g.sentToday).toBe(0);
    expect(g.sentWeek).toBe(0);
    expect(g.weekData).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(g.lastSend).toBe("—");
  });

  it("404 em grupo inexistente", async () => {
    const { auth } = await createTestUser();
    const r = await auth("delete", "/api/state/groups/9999/history");
    expect(r.status).toBe(404);
  });
});

describe("Isolamento entre usuários", () => {
  it("user A não consegue mexer no grupo de user B", async () => {
    const A = await userWithGroup({ id: 801 });
    const B = await createTestUser();

    // B tenta refillar grupo de A
    const r = await B.auth("post", "/api/state/groups/801/refill").send({});
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/encontrad/i);

    // B tenta limpar histórico de grupo de A
    const h = await B.auth("delete", "/api/state/groups/801/history");
    expect(h.status).toBe(404);
  });
});
