// Apagar todos os cupons: o que some e, principalmente, o que NÃO some.
//
// A promessa do botão é que as PALAVRAS testadas sobrevivem — cada uma custou um
// Chrome aberto com a conta do sistema. Se isso quebrar, o prejuízo só aparece
// horas depois, quando alguém for testar a mesma palavra de novo.

import { describe, it, expect, beforeEach } from "vitest";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { catalog } from "../helpers/app.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const backendDir = path.resolve(__dirname, "..", "..", "backend");
const coupons = require(path.join(backendDir, "coupons"));
const { productKey } = require(path.join(backendDir, "catalog", "product-key"));

const CAMPANHA = "9900001";
const PALAVRA = `TESTE${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
const produto = {
  name: "Produto do cupom", link: "https://www.mercadolivre.com.br/produto/p/MLB7770001",
  store: "Mercado Livre", category: "gamer", price: 100, discount: 40,
};

async function semear() {
  await catalog.upsertProducts([produto]);
  await coupons.upsertCoupons([{
    campaignId: CAMPANHA, title: "20% OFF TESTE", kind: "percent", value: 20,
    scope: "campaign", containerUrl: "https://lista.mercadolivre.com.br/_Container_9900001",
    activated: true, expiresAt: new Date(Date.now() + 864e5).toISOString(),
  }]);
  await coupons.replaceCouponProducts(CAMPANHA, [{ productKey: productKey(produto), productUrl: produto.link }]);
  await coupons.syncCatalogCoupons();
}

describe("clearAll — apagar todos os cupons", () => {
  // Semeia a cada teste: o `truncateAll` do setup roda antes de CADA um.
  beforeEach(async () => {
    await semear();
    await coupons.recordCodeCheck({ code: PALAVRA, verdict: "valid", campaignId: CAMPANHA, source: "admin" });
  });

  it("a semeadura vale: cupom, vínculo e carimbo no catálogo", async () => {
    const s = await coupons.stats();
    expect(s.cupons).toBeGreaterThan(0);
    expect(s.vinculos).toBeGreaterThan(0);
    expect(s.catalogo).toBeGreaterThan(0);
  });

  it("apaga cupons, vínculos e o carimbo — e mantém as palavras testadas", async () => {
    const r = await coupons.clearAll();
    expect(r.cupons).toBeGreaterThan(0);
    expect(r.vinculos).toBeGreaterThan(0);

    const s = await coupons.stats();
    expect(s.cupons).toBe(0);
    expect(s.vinculos).toBe(0);
    // O carimbo é coluna solta em catalog_products, sem FK: se a purga não o
    // limpasse, sobrariam produtos apontando pra cupom que não existe mais.
    expect(s.catalogo).toBe(0);

    const palavras = await coupons.listCodeChecks({ limit: 50 });
    expect(palavras.some(p => p.code === PALAVRA)).toBe(true);
  });

  it("a palavra volta a carimbar o cupom quando ele é re-raspado", async () => {
    await coupons.clearAll();
    await coupons.upsertCoupons([{ campaignId: CAMPANHA, title: "20% OFF TESTE", kind: "percent", value: 20, scope: "campaign" }]);
    expect((await coupons.getCoupon(CAMPANHA)).code).toBe(null);

    const r = await coupons.restampCodesFromChecks();
    expect(r.recarimbados).toBeGreaterThan(0);
    expect((await coupons.getCoupon(CAMPANHA)).code).toBe(PALAVRA);
  });
});
