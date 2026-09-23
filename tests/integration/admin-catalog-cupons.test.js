// Admin › Produtos: filtrar o catálogo por cupom e ver os cupons de cada produto.
//
// É a tela de CONFERÊNCIA do vínculo cupom ↔ produto: quem tem cupom, quem tem
// cupom com palavra, qual produto está na campanha X e de onde veio o vínculo
// (vitrine, parcial, checkout). Tudo só com cupom VIGENTE — o card mostra
// o que o `couponsListForKeys` devolve, e o filtro não pode discordar dele.
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

const AMANHA = new Date(Date.now() + 864e5).toISOString();
const ONTEM = new Date(Date.now() - 864e5).toISOString();

// Prefixo no nome para isolar das outras linhas do banco (`q=` filtra por ele).
const P = "CupFiltro";
const prod = (n, extra = {}) => ({
  name: `${P} ${n}`, store: "Mercado Livre", category: "casa", price: 100, discount: 10,
  link: `https://produto.mercadolivre.com.br/MLB-77000000${n}`, ...extra,
});
const A = prod(1, { discount: 40 });   // cupom com palavra, vitrine
const B = prod(2);                      // cupom sem palavra, vitrine parcial
const C = prod(3);                      // só cupom vencido
const D = prod(4);                      // sem cupom nenhum

let admin;
const get = (qs) => admin.auth("get", `/api/admin/catalog?q=${P}&${qs}`);
const nomes = (r) => r.body.items.map(i => i.name).sort();

// O banco é zerado a cada teste (helpers de setup), então a semente é por teste.
beforeEach(async () => {
  admin = await createTestUser();
  await authMod.setUserRole(admin.user.id, "admin");
  await catalog.upsertProducts([A, B, C, D]);
  await coupons.upsertCoupons([
    { campaignId: "9940001", title: "Cupom Casa Bonita", kind: "percent", value: 15, expiresAt: AMANHA, codeFromTitle: "CASA15" },
    { campaignId: "9940002", title: "Cupom Ferramentas", kind: "percent", value: 10, expiresAt: AMANHA },
    { campaignId: "9940003", title: "Cupom Velho", kind: "percent", value: 30, expiresAt: ONTEM },
  ]);
  const par = (p) => [{ productKey: productKey(p), productUrl: p.link }];
  await coupons.replaceCouponProducts("9940001", par(A), { origem: "vitrine" });
  await coupons.replaceCouponProducts("9940002", par(B), { origem: "parcial" });
  await coupons.replaceCouponProducts("9940003", par(C), { origem: "vitrine" });
});

describe("GET /api/admin/catalog — filtros de cupom", () => {
  it("sem filtro traz os quatro, e só os vigentes vêm como cupom no item", async () => {
    const r = await get("");
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(4);
    const porNome = Object.fromEntries(r.body.items.map(i => [i.name, i]));
    expect(porNome[A.name].coupons).toEqual([
      expect.objectContaining({ campaignId: "9940001", code: "CASA15", origem: "vitrine", title: "Cupom Casa Bonita" }),
    ]);
    expect(porNome[B.name].coupons[0]).toMatchObject({ campaignId: "9940002", code: null, origem: "parcial" });
    expect(porNome[C.name].coupons).toBeUndefined();   // vencido não aparece
    expect(porNome[D.name].coupons).toBeUndefined();
  });

  it("status: com / com-palavra / sem-palavra / sem", async () => {
    expect(nomes(await get("cupom=com"))).toEqual([A.name, B.name]);
    expect(nomes(await get("cupom=com-palavra"))).toEqual([A.name]);
    expect(nomes(await get("cupom=sem-palavra"))).toEqual([B.name]);
    expect(nomes(await get("cupom=sem"))).toEqual([C.name, D.name]);
  });

  it("busca por id da campanha, palavra ou trecho do título", async () => {
    expect(nomes(await get("cupomBusca=9940002"))).toEqual([B.name]);
    expect(nomes(await get("cupomBusca=casa15"))).toEqual([A.name]);
    expect(nomes(await get("cupomBusca=ferrament"))).toEqual([B.name]);
    // O vencido não filtra: buscar por ele não acha nada.
    expect(nomes(await get("cupomBusca=9940003"))).toEqual([]);
  });

  it("origem do vínculo", async () => {
    expect(nomes(await get("cupomOrigem=parcial"))).toEqual([B.name]);
    expect(nomes(await get("cupomOrigem=vitrine"))).toEqual([A.name]);
  });

  it("desconto mínimo vai pro SQL — o total acompanha", async () => {
    const r = await get("minDiscount=30");
    expect(nomes(r)).toEqual([A.name]);
    expect(r.body.total).toBe(1);
  });

  it("status inválido é ignorado", async () => {
    expect((await get("cupom=qualquer")).body.total).toBe(4);
  });
});
