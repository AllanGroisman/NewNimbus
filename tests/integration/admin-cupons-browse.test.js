// Admin › Cupons (task 17): navegar pelos cupons guardados — resumo, lista
// filtrável e os produtos de cada cupom (backend/coupons/browse.js).
import { describe, it, expect, beforeEach } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { createTestUser, auth as authMod, catalog } from "../helpers/app.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const backendDir = path.resolve(__dirname, "..", "..", "backend");
const coupons = require(path.join(backendDir, "coupons"));
const { productKey } = require(path.join(backendDir, "catalog", "product-key"));

const em = (h) => new Date(Date.now() + h * 36e5).toISOString();

const P = "Navcupom";
const prod = (n, extra = {}) => ({
  name: `${P} ${n}`, store: "Mercado Livre", category: "casa", discount: 10,
  link: `https://produto.mercadolivre.com.br/MLB-99100000${n}`, ...extra,
});
const A = prod(1, { name: "Navcupom Cadeira gamer", price: 500, discount: 30 });
const B = prod(2, { name: "Navcupom Mesa escritorio", price: 80 });
const C = prod(3, { name: "Navcupom Luminaria", price: 150 });

let admin;
const get = (url) => admin.auth("get", url);
const ids = (r) => r.body.items.map(i => i.campaignId);

beforeEach(async () => {
  admin = await createTestUser();
  await authMod.setUserRole(admin.user.id, "admin");
  await catalog.upsertProducts([A, B, C]);
  await coupons.upsertCoupons([
    { campaignId: "9960001", title: "Casa 15", kind: "percent", value: 15, minPurchase: 100, maxDiscount: 50, expiresAt: em(24 * 10), codeFromTitle: "CASA15", groupings: ["home"] },
    { campaignId: "9960002", title: "Moveis fixo", kind: "fixed", value: 20, expiresAt: em(24), groupings: ["home", "office"] },
    { campaignId: "9960003", title: "Antigo", kind: "percent", value: 40, expiresAt: em(-24), codeFromTitle: "VELHO40" },
    { campaignId: "9960004", title: "Loja do Ze", kind: "percent", value: 5, scope: "store", sellerName: "Ze Moveis", expiresAt: null },
  ]);
  const par = (...ps) => ps.map(p => ({ productKey: productKey(p), productUrl: p.link }));
  await coupons.replaceCouponProducts("9960001", par(A, B, C), { origem: "vitrine" });
  await coupons.replaceCouponProducts("9960002", par(B), { origem: "parcial" });
  // Vínculo para um produto que não está no catálogo.
  await coupons.replaceCouponProducts("9960004", [{ productKey: "chave-fora", productUrl: "https://produto.mercadolivre.com.br/MLB-1" }], { origem: "checkout" });
});

describe("GET /api/admin/cupons", () => {
  it("só admin", async () => {
    const comum = await createTestUser();
    expect((await comum.auth("get", "/api/admin/cupons")).status).toBe(403);
  });

  it("resumo conta vigentes, vencendo, com palavra e com produtos", async () => {
    const r = await get("/api/admin/cupons/resumo");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ total: 4, vigentes: 3, vencidos: 1, vencendo: 1, comPalavra: 1, comProdutos: 3, deLoja: 1, vinculos: 5 });
    expect(r.body.categorias).toEqual(expect.arrayContaining([{ chave: "home", n: 2 }, { chave: "office", n: 1 }]));
    expect(r.body.destaques.map(d => d.code)).toEqual(["CASA15"]);   // o vencido não entra
  });

  it("a lista abre nos vigentes e filtra por situação, palavra, tipo, escopo, categoria e produtos", async () => {
    expect(ids(await get("/api/admin/cupons")).sort()).toEqual(["9960001", "9960002", "9960004"]);
    expect(ids(await get("/api/admin/cupons?situacao=vencidos"))).toEqual(["9960003"]);
    expect(ids(await get("/api/admin/cupons?situacao=vencendo"))).toEqual(["9960002"]);
    expect(ids(await get("/api/admin/cupons?situacao=todos")).length).toBe(4);
    expect(ids(await get("/api/admin/cupons?palavra=com"))).toEqual(["9960001"]);
    expect(ids(await get("/api/admin/cupons?palavra=sem")).sort()).toEqual(["9960002", "9960004"]);
    expect(ids(await get("/api/admin/cupons?tipo=fixed"))).toEqual(["9960002"]);
    expect(ids(await get("/api/admin/cupons?escopo=store"))).toEqual(["9960004"]);
    expect(ids(await get("/api/admin/cupons?categoria=office"))).toEqual(["9960002"]);
    expect(ids(await get("/api/admin/cupons?produtos=com&situacao=todos")).sort()).toEqual(["9960001", "9960002", "9960004"]);
    expect(ids(await get("/api/admin/cupons?produtos=sem&situacao=todos"))).toEqual(["9960003"]);
    expect(ids(await get("/api/admin/cupons?q=ze%20moveis"))).toEqual(["9960004"]);
    expect(ids(await get("/api/admin/cupons?q=casa15"))).toEqual(["9960001"]);
  });

  it("ordena por desconto, vencimento e número de produtos, e traz o rótulo", async () => {
    expect(ids(await get("/api/admin/cupons?sortBy=desconto"))).toEqual(["9960001", "9960004", "9960002"]);
    expect(ids(await get("/api/admin/cupons?sortBy=vence"))).toEqual(["9960002", "9960001", "9960004"]);
    const r = await get("/api/admin/cupons?sortBy=produtos");
    expect(ids(r)[0]).toBe("9960001");
    expect(r.body.items[0]).toMatchObject({ produtos: 3, rotulo: "15% OFF", code: "CASA15", vigente: true });
  });

  it("detalhe traz as origens dos vínculos e quantos estão no catálogo", async () => {
    const r = await get("/api/admin/cupons/9960004");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ campaignId: "9960004", produtos: 1, noCatalogo: 0, origens: [{ origem: "checkout", n: 1, noCatalogo: 0 }] });
    expect((await get("/api/admin/cupons/nao-existe")).status).toBe(404);
  });
});

describe("GET /api/admin/cupons/:id/produtos", () => {
  const url = (qs = "") => `/api/admin/cupons/9960001/produtos?${qs}`;
  const nomes = (r) => r.body.items.map(i => i.name);

  it("lista com o preço do cupom — nulo abaixo da compra mínima, com o teto aplicado", async () => {
    const r = await get(url("sortBy=preco_asc"));
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(3);
    expect(nomes(r)).toEqual([B.name, C.name, A.name]);
    const porNome = Object.fromEntries(r.body.items.map(i => [i.name, i]));
    expect(porNome[B.name].priceWithCoupon).toBe(null);        // 80 < mínimo de 100
    expect(porNome[C.name].priceWithCoupon).toBe(127.5);       // 15% de 150
    expect(porNome[A.name].priceWithCoupon).toBe(450);         // 15% de 500 = 75, teto 50
  });

  it("filtra por nome, faixa de preço, desconto e 'cupom valendo'", async () => {
    expect(nomes(await get(url("q=cadeira")))).toEqual([A.name]);
    expect(nomes(await get(url("q=luminária")))).toEqual([C.name]);   // acento não importa
    expect(nomes(await get(url("minPrice=100&maxPrice=200")))).toEqual([C.name]);
    expect(nomes(await get(url("minDiscount=20")))).toEqual([A.name]);
    expect(nomes(await get(url("valendo=1&sortBy=preco_asc")))).toEqual([C.name, A.name]);
  });

  it("filtra por origem e por estar no catálogo", async () => {
    const r = await get("/api/admin/cupons/9960004/produtos?catalogo=sem");
    expect(r.body.items).toEqual([expect.objectContaining({ productKey: "chave-fora", inCatalog: false, origem: "checkout" })]);
    expect((await get("/api/admin/cupons/9960004/produtos?catalogo=com")).body.total).toBe(0);
    expect((await get("/api/admin/cupons/9960002/produtos?origem=parcial")).body.total).toBe(1);
    expect((await get("/api/admin/cupons/9960002/produtos?origem=vitrine")).body.total).toBe(0);
  });

  it("cupom inexistente é 404", async () => {
    expect((await get("/api/admin/cupons/0/produtos")).status).toBe(404);
  });
});
