// O mesmo anúncio do ML vindo por dois caminhos vira UMA linha no catálogo, e o
// cupom fica nela.
//
// A vitrine/landing do cupom entrega `/p/MLB<catálogo>?…&wid=MLB<anúncio>` e o
// scraping entrega `produto.mercadolivre.com.br/MLB-<anúncio>`. O productKey dos
// dois é diferente (é a PK e não muda), então quem junta é a coluna `mlAnuncioId`:
// o upsert grava o anúncio repetido na linha que já existe, e os vínculos de cupom
// apontam para ela. Antes disso o catálogo tinha 204 pares assim, 49 com o cupom
// carimbado só numa das linhas.
import { describe, it, expect } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { catalog } from "../helpers/app.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const backendDir = path.resolve(__dirname, "..", "..", "backend");
const coupons = require(path.join(backendDir, "coupons"));
const { prisma } = require(path.join(backendDir, "db"));
const { productKey } = require(path.join(backendDir, "catalog", "product-key"));
const { mergeDuplicates } = require(path.join(backendDir, "scripts", "merge-ml-duplicates.js"));

const AMANHA = () => new Date(Date.now() + 864e5).toISOString();

const vitrine = (cat, anuncio, extra = {}) => ({
  name: `Produto ${anuncio}`, store: "Mercado Livre", category: "casa", price: 100, discount: 10,
  link: `https://www.mercadolivre.com.br/produto-x/p/MLB${cat}?pdp_filters=seller_id%3A1#polycard_client=search-desktop&wid=MLB${anuncio}&sid=search`,
  ...extra,
});
const scraping = (anuncio, extra = {}) => ({
  name: `Produto ${anuncio}`, store: "Mercado Livre", category: "casa", price: 90, discount: 20,
  link: `https://produto.mercadolivre.com.br/MLB-${anuncio}`,
  ...extra,
});

async function linhasDoAnuncio(anuncio) {
  return prisma().catalogProduct.findMany({ where: { mlAnuncioId: `MLB${anuncio}` } });
}

async function cupomComVitrine(campaignId, produtos) {
  await coupons.upsertCoupons([{ campaignId, title: `Cupom ${campaignId}`, kind: "percent", value: 15, expiresAt: AMANHA() }]);
  await catalog.upsertProducts(produtos);
  await coupons.replaceCouponProducts(campaignId, produtos.map(p => ({ productKey: productKey(p), productUrl: p.link })));
  await coupons.syncCatalogCoupons();
}

describe("mesmo anúncio pela vitrine do cupom e pelo scraping", () => {
  it("vitrine primeiro, scraping depois: uma linha, com o cupom e o preço novo", async () => {
    const v = vitrine("71000001", "5100000001");
    await cupomComVitrine("9930001", [v]);

    const r = await catalog.upsertProducts([scraping("5100000001", { price: 80 })]);
    expect(r.fundidos).toBe(1);

    const linhas = await linhasDoAnuncio("5100000001");
    expect(linhas).toHaveLength(1);
    expect(linhas[0].key).toBe(productKey(v));
    expect(linhas[0].link).toBe(v.link);           // link coerente com a key
    expect(linhas[0].price).toBe(80);               // o preço é o do scraping
    expect(linhas[0].couponCampaignId).toBe("9930001");
  });

  it("scraping primeiro, vitrine depois: uma linha, e o cupom cai nela", async () => {
    const s = scraping("5100000002");
    await catalog.upsertProducts([s]);

    await cupomComVitrine("9930002", [vitrine("71000002", "5100000002")]);

    const linhas = await linhasDoAnuncio("5100000002");
    expect(linhas).toHaveLength(1);
    expect(linhas[0].key).toBe(productKey(s));
    expect(linhas[0].couponCampaignId).toBe("9930002");
    const vinc = await prisma().mlCouponProduct.findMany({ where: { campaignId: "9930002" } });
    expect(vinc.map(x => x.productKey)).toEqual([productKey(s)]);
  });

  it("os dois caminhos na MESMA chamada viram uma linha só", async () => {
    await catalog.upsertProducts([vitrine("71000003", "5100000003"), scraping("5100000003")]);
    expect(await linhasDoAnuncio("5100000003")).toHaveLength(1);
  });

  it("anúncios diferentes com o mesmo nome continuam separados", async () => {
    await catalog.upsertProducts([
      scraping("5100000005", { name: "Mesmo nome" }),
      scraping("5100000006", { name: "Mesmo nome" }),
    ]);
    const n = await prisma().catalogProduct.count({ where: { name: "Mesmo nome" } });
    expect(n).toBe(2);
  });

  it("getByLink acha pelo anúncio o produto que veio pela vitrine", async () => {
    const v = vitrine("71000007", "5100000007");
    await catalog.upsertProducts([v]);
    const p = await catalog.getByLink("https://produto.mercadolivre.com.br/MLB-5100000007");
    expect(p?.key).toBe(productKey(v));
  });
});

describe("scripts/merge-ml-duplicates.js — o que ficou de antes da coluna", () => {
  it("junta as linhas antigas, leva o vínculo do cupom e é idempotente", async () => {
    // Duas linhas gravadas como era antes: sem mlAnuncioId, chaves diferentes.
    const v = vitrine("71000008", "5100000008");
    const s = scraping("5100000008");
    const antiga = new Date(Date.now() - 864e5);
    for (const [p, quando] of [[v, antiga], [s, new Date()]]) {
      await prisma().catalogProduct.create({ data: {
        key: productKey(p), name: p.name, link: p.link, store: p.store, price: p.price,
        firstSeenAt: quando, lastSeenAt: quando,
      } });
    }
    await coupons.upsertCoupons([{ campaignId: "9930008", title: "Cupom velho", kind: "percent", value: 10, expiresAt: AMANHA() }]);
    await prisma().mlCouponProduct.create({ data: { campaignId: "9930008", productKey: productKey(s), productUrl: s.link, origem: "parcial" } });

    const r = await mergeDuplicates({ apply: true, log: () => {} });
    expect(r.grupos).toBeGreaterThanOrEqual(1);

    const linhas = await prisma().catalogProduct.findMany({ where: { key: { in: [productKey(v), productKey(s)] } } });
    expect(linhas).toHaveLength(1);
    expect(linhas[0].key).toBe(productKey(v));      // a mais antiga fica
    expect(linhas[0].price).toBe(s.price);          // com o preço mais fresco
    expect(linhas[0].couponCampaignId).toBe("9930008");

    const again = await mergeDuplicates({ apply: false, log: () => {} });
    expect(again.grupos).toBe(0);
  });
});
