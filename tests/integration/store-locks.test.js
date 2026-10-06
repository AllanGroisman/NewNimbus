// Rotas de trava de loja: admin tranca/destranca + edita a mensagem; usuário
// comum só lê o estado e fica bloqueado de configurar afiliado da loja trancada.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { createTestUser, auth as authMod, catalog, scheduler, storage, affiliate, billing } from "../helpers/app.js";
import { mlProduct, amazonProduct, makeGroup } from "../helpers/fixtures.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const storeLocks = require(path.resolve(__dirname, "..", "..", "backend", "scraping", "store-locks.js"));
const appConfig = require(path.resolve(__dirname, "..", "..", "backend", "config"));

// Conta com plano pro: campanha com scraping automático exige plano pago, e
// esses testes são sobre a trava de loja, não sobre billing.
async function createProUser() {
  const u = await createTestUser();
  await billing.update(u.user.id, { planId: "pro", status: "active" });
  affiliate.writeConfig(u.user.id, { tag: "test-tag", cookie: "test-cookie-sessid" });
  return u;
}

// Sem rede nos testes: o cookie de teste é inválido e itens cuja conversão de
// afiliado falha seriam descartados antes de chegar na fila.
vi.spyOn(affiliate, "gerarLinkAfiliadoML").mockImplementation(async (_userId, url) =>
  url ? `https://s.mercadolivre.com.br/test-short?url=${encodeURIComponent(url)}` : null
);

async function makeAdmin() {
  const u = await createTestUser();
  await authMod.setUserRole(u.user.id, "admin");
  return u;
}

beforeEach(() => {
  appConfig.set(storeLocks.STORE_LOCKS_KEY, {});
});

describe("Travas de loja — gating", () => {
  it("user comum recebe 403 nas rotas admin de trava", async () => {
    const { auth } = await createTestUser();
    expect((await auth("get", "/api/admin/stores/locks")).status).toBe(403);
    expect((await auth("put", "/api/admin/stores/ml/lock")).status).toBe(403);
  });

  it("user comum LÊ o estado das travas em /api/stores/locks", async () => {
    const { auth } = await createTestUser();
    const res = await auth("get", "/api/stores/locks");
    expect(res.status).toBe(200);
    expect(res.body.locks.ml).toEqual({ locked: false, message: null });
  });
});

describe("PUT /api/admin/stores/:store/lock", () => {
  it("tranca a loja e a mensagem chega ao usuário comum", async () => {
    const admin = await makeAdmin();
    const res = await admin.auth("put", "/api/admin/stores/shopee/lock")
      .send({ locked: true, message: "Shopee em manutenção" });
    expect(res.status).toBe(200);
    expect(res.body.lock.locked).toBe(true);

    const { auth } = await createTestUser();
    const view = await auth("get", "/api/stores/locks");
    expect(view.body.locks.shopee).toEqual({ locked: true, message: "Shopee em manutenção" });
    // Loja liberada não vaza mensagem
    expect(view.body.locks.ml.message).toBe(null);
  });

  it("destrancar volta a esconder a mensagem", async () => {
    const admin = await makeAdmin();
    await admin.auth("put", "/api/admin/stores/ml/lock").send({ locked: true, message: "Em breve" });
    await admin.auth("put", "/api/admin/stores/ml/lock").send({ locked: false });
    const { auth } = await createTestUser();
    const view = await auth("get", "/api/stores/locks");
    expect(view.body.locks.ml).toEqual({ locked: false, message: null });
  });

  it("loja desconhecida devolve 400", async () => {
    const admin = await makeAdmin();
    const res = await admin.auth("put", "/api/admin/stores/magalu/lock").send({ locked: true });
    expect(res.status).toBe(400);
  });

  it("GET admin devolve travas + quantas campanhas usam cada loja", async () => {
    const admin = await makeAdmin();
    const res = await admin.auth("get", "/api/admin/stores/locks");
    expect(res.status).toBe(200);
    expect(res.body.locks.ml.locked).toBe(false);
    expect(res.body.usage).toMatchObject({ ml: expect.any(Number), amazon: expect.any(Number), shopee: expect.any(Number) });
  });
});

describe("Afiliado de loja trancada", () => {
  // Salvar o cookie do ML já o testa no ML (busca as etiquetas da conta).
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([{ tag: "minha-tag", in_use: true }]), { status: 200 })));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("user comum não consegue salvar credenciais da loja trancada", async () => {
    const admin = await makeAdmin();
    await admin.auth("put", "/api/admin/stores/shopee/lock").send({ locked: true, message: "Voltamos já" });

    const { auth } = await createTestUser();
    const res = await auth("put", "/api/affiliate/shopee").send({ appId: "123", appSecret: "abc" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Voltamos já");
    expect(res.body.storeLocked).toBe(true);
  });

  it("loja liberada continua aceitando credenciais normalmente", async () => {
    const admin = await makeAdmin();
    await admin.auth("put", "/api/admin/stores/shopee/lock").send({ locked: true });

    const { auth } = await createTestUser();
    const res = await auth("put", "/api/affiliate").send({ cookie: "abc123sessionid" });
    expect(res.status).toBe(200);
  });

  it("admin segue configurando a loja trancada (pra validar antes de liberar)", async () => {
    const admin = await makeAdmin();
    await admin.auth("put", "/api/admin/stores/ml/lock").send({ locked: true });
    const res = await admin.auth("put", "/api/affiliate").send({ cookie: "abc123sessionid" });
    expect(res.status).toBe(200);
  });
});

describe("Campanha com loja trancada", () => {
  // Loja trancada não pode alimentar a fila; se era a única da campanha, o
  // gate pausa com a mensagem do admin em vez de deixar a campanha muda.
  it("refill pula a loja trancada e usa as outras", async () => {
    const admin = await makeAdmin();
    await admin.auth("put", "/api/admin/stores/amazon/lock").send({ locked: true });

    await catalog.upsertProducts([
      mlProduct(9101, { category: "gamer", discount: 40 }),
      amazonProduct(9102, { category: "gamer", discount: 40 }),
    ]);

    const { user, auth } = await createProUser();
    const group = makeGroup({ id: 9100, categories: ["gamer"], sources: ["ml", "amazon"], auto: true });
    await auth("put", "/api/state").send({ groups: [group] });

    await scheduler.refillNow(user.id, 9100);
    const state = await storage.loadState(user.id);
    const g = state.groups.find(x => x.id === 9100);
    expect(g.queue.length).toBeGreaterThan(0);
    expect(g.queue.some(i => i.store === "Amazon")).toBe(false);
  });

  it("campanha cuja única loja trancou pausa com a mensagem do admin", async () => {
    const admin = await makeAdmin();
    await admin.auth("put", "/api/admin/stores/ml/lock").send({ locked: true, message: "ML em manutenção" });

    const { user, auth } = await createProUser();
    const group = makeGroup({ id: 9110, categories: ["gamer"], sources: ["ml"], auto: true });
    await auth("put", "/api/state").send({ groups: [group] });

    await expect(scheduler.sendNextNow(user.id, 9110)).rejects.toThrow(/ML em manutenção/);
  });

  // A trava impede BUSCAR naquela loja, não entregar o que já foi buscado — é a
  // mesma regra que faz o repasse enviar um link capturado de loja trancada. E
  // fila só encolhe por envio ou por decisão do usuário (task 20).
  it("o que já estava na fila continua lá quando a loja tranca", async () => {
    await catalog.upsertProducts([mlProduct(9121, { category: "gamer", discount: 40 })]);
    const { user, auth } = await createProUser();
    const group = makeGroup({ id: 9120, categories: ["gamer"], sources: ["ml", "amazon"], auto: true });
    await auth("put", "/api/state").send({ groups: [group] });
    await scheduler.refillNow(user.id, 9120);
    const before = await storage.loadState(user.id);
    expect(before.groups.find(x => x.id === 9120).queue.length).toBeGreaterThan(0);

    const admin = await makeAdmin();
    await admin.auth("put", "/api/admin/stores/ml/lock").send({ locked: true });

    await scheduler.refillNow(user.id, 9120);
    const after = await storage.loadState(user.id);
    const g = after.groups.find(x => x.id === 9120);
    expect(g.queue.some(i => i.store === "Mercado Livre")).toBe(true);
    // Mas nada NOVO daquela loja entra: o refill acima não somou mais nenhum ML.
    expect(g.queue.length).toBe(before.groups.find(x => x.id === 9120).queue.length);
  });
});
