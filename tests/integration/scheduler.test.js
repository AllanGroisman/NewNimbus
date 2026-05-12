// Scheduler: refill, manualAdd, sendNextNow (com WhatsApp mockado).
// Esse arquivo cobre o miolo do negocio: catalogo -> queue -> envio.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { app, createTestUser, catalog, scheduler, storage, affiliate, waCalls, resetWa } from "../helpers/app.js";
import { mlProduct, amazonProduct, makeGroup, makeWhatsAppGroup } from "../helpers/fixtures.js";

describe("scheduler.refillNow — popa do catalogo", () => {
  beforeAll(async () => {
    await catalog.upsertProducts([
      mlProduct(401, { category: "gamer", discount: 30 }),
      mlProduct(402, { category: "gamer", discount: 50 }),
      mlProduct(403, { category: "casa", discount: 60 }),
    ]);
    affiliate.writeConfig({ tag: "test-tag", cookie: "test-cookie" });
  });

  beforeEach(() => {
    resetWa();
  });

  it("preenche queue com produtos da categoria + sources do grupo", async () => {
    const { user, auth } = await createTestUser();
    const group = makeGroup({ id: 100, categories: ["gamer"], sources: ["ml"], auto: true });
    await auth("put", "/api/state").send({ groups: [group] });

    const r = await scheduler.refillNow(user.id, 100);
    expect(r.target).toBe("queue");
    expect(r.queueSize).toBeGreaterThan(0);

    const state = await storage.loadState(user.id);
    const g = state.groups.find(g => g.id === 100);
    expect(g.queue.length).toBeGreaterThan(0);
    for (const item of g.queue) {
      expect(item.store === "Mercado Livre" || item.store === "ml").toBe(true);
    }
  });

  it("auto=false manda items pra PENDING em vez de queue", async () => {
    const { user, auth } = await createTestUser();
    const group = makeGroup({ id: 101, categories: ["gamer"], sources: ["ml"], auto: false });
    await auth("put", "/api/state").send({ groups: [group] });

    const r = await scheduler.refillNow(user.id, 101);
    expect(r.target).toBe("pending");
    expect(r.pendingSize).toBeGreaterThan(0);

    const state = await storage.loadState(user.id);
    const g = state.groups.find(g => g.id === 101);
    expect(g.pending.length).toBeGreaterThan(0);
    expect(g.queue).toEqual([]);
  });

  it("aplica overrides de filtros (UI ainda nao persistiu)", async () => {
    const { user, auth } = await createTestUser();
    const group = makeGroup({ id: 102, categories: ["gamer"], sources: ["ml"] });
    await auth("put", "/api/state").send({ groups: [group] });

    const r = await scheduler.refillNow(user.id, 102, { filters: { minDiscount: 99 } });
    expect(r.added).toBe(0);
  });
});

describe("scheduler.manualAdd — adicionar produto via URL", () => {
  it("adiciona na queue quando auto=true", async () => {
    const { user, auth } = await createTestUser();
    await auth("put", "/api/state").send({ groups: [makeGroup({ id: 200, auto: true })] });
    const r = await scheduler.manualAdd(user.id, 200, {
      url: "https://www.amazon.com.br/dp/B0CMANUALADD",
      overrides: { name: "Produto Manual", price: 99, originalPrice: 199, discount: 50, store: "Amazon" },
    });
    expect(r.ok).toBe(true);
    expect(r.target).toBe("queue");
    expect(r.queueSize).toBe(1);
  });

  it("bloqueia duplicata na queue", async () => {
    const { user, auth } = await createTestUser();
    await auth("put", "/api/state").send({ groups: [makeGroup({ id: 201, auto: true })] });
    await scheduler.manualAdd(user.id, 201, {
      url: "https://www.amazon.com.br/dp/B0CDUP12345",
      overrides: { name: "X", price: 10, discount: 10, store: "Amazon" },
    });
    let err;
    try {
      await scheduler.manualAdd(user.id, 201, {
        url: "https://www.amazon.com.br/dp/B0CDUP12345",
        overrides: { name: "X", price: 10, discount: 10, store: "Amazon" },
      });
    } catch (e) { err = e; }
    expect(err).toBeDefined();
    expect(err.code).toBe("duplicate_queue");
  });

  it("exige name e url", async () => {
    const { user, auth } = await createTestUser();
    await auth("put", "/api/state").send({ groups: [makeGroup({ id: 202, auto: true })] });
    await expect(scheduler.manualAdd(user.id, 202, { url: "", overrides: { name: "X" } })).rejects.toThrow();
    await expect(scheduler.manualAdd(user.id, 202, { url: "https://x.com", overrides: { name: "" } })).rejects.toThrow();
  });
});

describe("scheduler.sendNextNow — envia primeiro item da queue", () => {
  beforeEach(() => resetWa());

  it("dispara wa.sendImage (item tem img) e move pra history", async () => {
    const { user, auth } = await createTestUser();
    const numbers = [{ id: "num-1", phone: "5511..." }];
    const waGroups = [makeWhatsAppGroup({ id: "wa-1", numberId: "num-1", jid: "fake@g.us" })];
    const group = makeGroup({
      id: 300,
      whatsappGroupIds: ["wa-1"],
    });
    await auth("put", "/api/state").send({ groups: [group], numbers, whatsappGroups: waGroups });

    // queue precisa ser populada via updateGroupOps (frontend PUT nao mexe em ops fields)
    await storage.updateGroupOps(user.id, 300, {
      queue: [{
        id: "i1", key: "i1", name: "Produto Envio", link: "https://www.amazon.com.br/dp/B0CSEND1234",
        img: "https://example.com/img.jpg", price: 100, originalPrice: 200, discount: 50, store: "Amazon",
      }],
    });

    const r = await scheduler.sendNextNow(user.id, 300);
    expect(r.sent).toBeGreaterThanOrEqual(1);
    expect(waCalls.sendImage.length).toBe(1);
    expect(waCalls.sendImage[0].jid).toBe("fake@g.us");
    expect(waCalls.sendImage[0].caption).toContain("Produto Envio");

    const st = await storage.loadState(user.id);
    const g = st.groups.find(g => g.id === 300);
    expect(g.queue).toHaveLength(0);
    expect(g.history).toHaveLength(1);
    expect(g.history[0].name).toBe("Produto Envio");
    expect(g.sentToday).toBe(1);
    expect(g.sentWeek).toBe(1);
  });

  it("dispara wa.sendText quando item nao tem img", async () => {
    const { user, auth } = await createTestUser();
    const waGroups = [makeWhatsAppGroup({ id: "wa-2", numberId: "num-2", jid: "fake2@g.us" })];
    const group = makeGroup({ id: 301, whatsappGroupIds: ["wa-2"] });
    await auth("put", "/api/state").send({ groups: [group], whatsappGroups: waGroups });
    await storage.updateGroupOps(user.id, 301, {
      queue: [{ id: "i", key: "i", name: "Sem Imagem", link: "https://x.com/a", img: null, price: 10, discount: 10, store: "Amazon" }],
    });

    await scheduler.sendNextNow(user.id, 301);
    expect(waCalls.sendText.length).toBe(1);
    expect(waCalls.sendImage.length).toBe(0);
  });

  it("falha quando campanha pausada", async () => {
    const { user, auth } = await createTestUser();
    const group = makeGroup({ id: 302 });
    group.paused = true;
    await auth("put", "/api/state").send({ groups: [group] });
    await expect(scheduler.sendNextNow(user.id, 302)).rejects.toThrow(/pausada/i);
  });

  it("falha quando ML afiliado nao configurado e grupo usa ML", async () => {
    affiliate.clearConfig();
    const { user, auth } = await createTestUser();
    const group = makeGroup({ id: 303, sources: ["ml"] });
    await auth("put", "/api/state").send({ groups: [group] });
    await expect(scheduler.sendNextNow(user.id, 303)).rejects.toThrow(/afiliado/i);
    affiliate.writeConfig({ tag: "t", cookie: "c" });
  });

  it("falha quando queue vazia e refill nao traz nada", async () => {
    affiliate.writeConfig({ tag: "t", cookie: "c" });
    const { user, auth } = await createTestUser();
    const group = makeGroup({ id: 304, filters: { minDiscount: 999 } });
    await auth("put", "/api/state").send({ groups: [group] });
    await expect(scheduler.sendNextNow(user.id, 304)).rejects.toThrow();
  });
});

describe("scheduler.tick — loop periodico", () => {
  beforeEach(() => resetWa());

  it("processa todos os users + popula queue em janela ativa", async () => {
    await catalog.upsertProducts([
      mlProduct(901, { category: "beleza", discount: 40 }),
      mlProduct(902, { category: "beleza", discount: 60 }),
    ]);
    affiliate.writeConfig({ tag: "t", cookie: "c" });

    const { user, auth } = await createTestUser();
    const waGroups = [makeWhatsAppGroup({ id: "wa-tick", numberId: "num-tick", jid: "tick@g.us" })];
    const group = makeGroup({
      id: 999,
      categories: ["beleza"],
      sources: ["ml"],
      whatsappGroupIds: ["wa-tick"],
      schedule: { windows: [{ from: "00:00", to: "23:59", interval: 0 }], cooldownValue: 24, cooldownUnit: "horas" },
    });
    await auth("put", "/api/state").send({ groups: [group], whatsappGroups: waGroups });

    await scheduler.tick();

    const state = await storage.loadState(user.id);
    const g = state.groups.find(g => g.id === 999);
    expect(g.queue.length + g.history.length).toBeGreaterThan(0);
  });
});

describe("POST /api/state/groups/:gid/refill — endpoint HTTP", () => {
  it("forca refill via HTTP", async () => {
    await catalog.upsertProducts([mlProduct(801, { category: "casa", discount: 40 })]);
    affiliate.writeConfig({ tag: "t", cookie: "c" });
    const { auth } = await createTestUser();
    const group = makeGroup({ id: 800, categories: ["casa"], sources: ["ml"] });
    await auth("put", "/api/state").send({ groups: [group] });

    const r = await auth("post", "/api/state/groups/800/refill").send({});
    expect(r.status).toBe(200);
    expect(r.body.queueSize).toBeGreaterThan(0);
  });
});

describe("POST /api/state/groups/:gid/manual-add — endpoint HTTP", () => {
  it("retorna 409 em duplicata", async () => {
    affiliate.writeConfig({ tag: "t", cookie: "c" });
    const { auth } = await createTestUser();
    await auth("put", "/api/state").send({ groups: [makeGroup({ id: 700 })] });
    const body = {
      url: "https://www.amazon.com.br/dp/B0CMANDUP01",
      overrides: { name: "Dup", price: 50, discount: 10, store: "Amazon" },
    };
    await auth("post", "/api/state/groups/700/manual-add").send(body);
    const dup = await auth("post", "/api/state/groups/700/manual-add").send(body);
    expect(dup.status).toBe(409);
  });
});

describe("POST /api/state/groups/:gid/send-now — endpoint HTTP", () => {
  it("dispara wa.sendText via HTTP", async () => {
    resetWa();
    affiliate.writeConfig({ tag: "t", cookie: "c" });
    const { user, auth } = await createTestUser();
    const waGroups = [makeWhatsAppGroup({ id: "wa-sn", numberId: "num-sn", jid: "sn@g.us" })];
    const group = makeGroup({ id: 600, whatsappGroupIds: ["wa-sn"] });
    await auth("put", "/api/state").send({ groups: [group], whatsappGroups: waGroups });
    await storage.updateGroupOps(user.id, 600, {
      queue: [{ id: "x", key: "x", name: "Manual Send", link: "https://x.com/a", img: null, price: 10, discount: 50, store: "Amazon" }],
    });
    const r = await auth("post", "/api/state/groups/600/send-now");
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(waCalls.sendText.length).toBeGreaterThan(0);
  });
});
