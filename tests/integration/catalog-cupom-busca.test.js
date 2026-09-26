// Busca de produtos da campanha com cupom (task 19): filtrar por cupom e ordenar
// pelo preço que o cliente paga de fato.
//
// O que está sendo protegido aqui é a régua do SQL (catalog/pg.js:PRECO_COM_CUPOM)
// bater com a do JavaScript (coupons/price.js:precoComCupom + melhorCupom). Se as
// duas divergirem, a lista ordena por um preço e o card mostra outro.
import { describe, it, expect, beforeEach } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { createTestUser, catalog } from "../helpers/app.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const backendDir = path.resolve(__dirname, "..", "..", "backend");
const coupons = require(path.join(backendDir, "coupons"));
const { productKey } = require(path.join(backendDir, "catalog", "product-key"));

const AMANHA = new Date(Date.now() + 864e5).toISOString();
const ONTEM = new Date(Date.now() - 864e5).toISOString();

// Prefixo no nome para isolar das outras linhas do banco (`q=` filtra por ele).
const P = "Cupbusca";
const prod = (n, extra = {}) => ({
  name: `${P} ${n}`, store: "Mercado Livre", category: "casa", discount: 10,
  link: `https://produto.mercadolivre.com.br/MLB-88000000${n}`, ...extra,
});
const A = prod(1, { price: 200 });   // DEZ (10%) → 180
const B = prod(2, { price: 150 });   // TRINTA (R$ 30) → 120; DEZ também cobre → 135
const C = prod(3, { price: 130 });   // sem cupom
const D = prod(4, { price: 100 });   // MIN300: compra mínima não atingida → vale 100
const E = prod(5, { price: 90 });    // cupom sem palavra (50%) → não anuncia, vale 90
const F = prod(6, { price: 400 });   // só cupom vencido → vale 400

let user;
const get = (qs) => user.auth("get", `/api/ofertas?q=${P}&page=1&pageSize=20&${qs}`);
const nomes = (r) => r.body.items.map(i => i.name);
const ordenados = (r) => nomes(r).slice().sort();

beforeEach(async () => {
  user = await createTestUser();
  await catalog.upsertProducts([A, B, C, D, E, F]);
  await coupons.upsertCoupons([
    { campaignId: "9950001", title: "Dez por cento", kind: "percent", value: 10, expiresAt: AMANHA, codeFromTitle: "DEZ" },
    { campaignId: "9950002", title: "Trinta reais", kind: "fixed", value: 30, expiresAt: AMANHA, codeFromTitle: "TRINTA" },
    { campaignId: "9950003", title: "Minimo alto", kind: "percent", value: 20, minPurchase: 300, expiresAt: AMANHA, codeFromTitle: "MIN300" },
    { campaignId: "9950004", title: "Metade sem palavra", kind: "percent", value: 50, expiresAt: AMANHA },
    { campaignId: "9950005", title: "Vencido", kind: "percent", value: 40, expiresAt: ONTEM, codeFromTitle: "VELHO" },
  ]);
  const par = (...ps) => ps.map(p => ({ productKey: productKey(p), productUrl: p.link }));
  await coupons.replaceCouponProducts("9950001", par(A, B), { origem: "vitrine" });
  await coupons.replaceCouponProducts("9950002", par(B), { origem: "vitrine" });
  await coupons.replaceCouponProducts("9950003", par(D), { origem: "vitrine" });
  await coupons.replaceCouponProducts("9950004", par(E), { origem: "vitrine" });
  await coupons.replaceCouponProducts("9950005", par(F), { origem: "vitrine" });
});

describe("GET /api/ofertas — cupom na busca", () => {
  it("filtro coupon: com / com-palavra / valendo", async () => {
    expect(ordenados(await get("coupon=com"))).toEqual([A.name, B.name, D.name, E.name]);
    expect(ordenados(await get("coupon=com-palavra"))).toEqual([A.name, B.name, D.name]);
    // D tem palavra, mas a compra mínima não bate: não desconta neste preço.
    expect(ordenados(await get("coupon=valendo"))).toEqual([A.name, B.name]);
    // hasCoupon (o filtro antigo) continua sendo o "com".
    expect(ordenados(await get("hasCoupon=1"))).toEqual([A.name, B.name, D.name, E.name]);
  });

  it("couponSearch acha pela palavra, pelo id e pelo título — só cupom vigente", async () => {
    expect(ordenados(await get("couponSearch=trinta"))).toEqual([B.name]);
    expect(ordenados(await get("couponSearch=9950001"))).toEqual([A.name, B.name]);
    expect(ordenados(await get("couponSearch=sem%20palavra"))).toEqual([E.name]);
    expect(ordenados(await get("couponSearch=VELHO"))).toEqual([]);
  });

  it("final_price_asc ordena pelo preço com o melhor cupom anunciável", async () => {
    // Finais: A 180, B 120, C 130, D 100, E 90, F 400.
    const r = await get("sortBy=final_price_asc");
    expect(r.status).toBe(200);
    expect(r.body.sortBy).toBe("final_price_asc");
    expect(nomes(r)).toEqual([E.name, D.name, B.name, C.name, A.name, F.name]);
  });

  it("o card mostra o mesmo cupom que a ordem usou", async () => {
    const r = await get("sortBy=final_price_asc");
    const b = r.body.items.find(i => i.name === B.name);
    // B tem DEZ e TRINTA; o melhor em R$ 150 é o TRINTA (120 × 135).
    const comPalavra = b.coupons.filter(c => c.code);
    const melhor = comPalavra.reduce((m, c) => (c.priceWithCoupon < m.priceWithCoupon ? c : m));
    expect(melhor).toMatchObject({ code: "TRINTA", priceWithCoupon: 120 });
  });

  it("coupon_off_desc põe na frente quem o cupom mais desconta, em %", async () => {
    // A: 10%, B: 20% (TRINTA em 150). Sem cupom valendo vai para o fim.
    const r = await get("sortBy=coupon_off_desc&coupon=valendo");
    expect(nomes(r)).toEqual([B.name, A.name]);
  });

  it("minCouponPct corta pelo desconto do cupom neste produto", async () => {
    expect(ordenados(await get("minCouponPct=15"))).toEqual([B.name]);
    expect(ordenados(await get("minCouponPct=5"))).toEqual([A.name, B.name]);
  });

  it("priceWithCoupon faz a faixa de preço valer sobre o preço final", async () => {
    // Sem a opção, A (200) fica de fora de "até 190"; com ela, A sai a 180 e entra.
    expect(ordenados(await get("maxPrice=190"))).not.toContain(A.name);
    expect(ordenados(await get("maxPrice=190&priceWithCoupon=1"))).toContain(A.name);
    // E o mínimo também: B (150) sai a 120 e cai fora de "a partir de 125".
    expect(ordenados(await get("minPrice=125&priceWithCoupon=1"))).not.toContain(B.name);
  });

  it("valores de filtro inválidos não quebram a busca", async () => {
    const r = await get("coupon=drop-table&minCouponPct=abc&couponSearch=");
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(6);
  });
});
