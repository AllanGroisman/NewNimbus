// Purge diário do scraping (catalog.pruneBeforeDate com keepCouponLinked).
//
// Os produtos das vitrines de cupons entram no catálogo com o lastSeenAt da
// colheita de cupons — o purge do scraping ("apaga o que não foi visto hoje")
// levava todos embora: -89.524 numa rodada. Aqui: o vínculo a cupom válido
// segura o produto; cupom vencido ou sem vínculo, não.

import { describe, it, expect, beforeEach } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { catalog, prisma } from "../helpers/app.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const backendDir = path.resolve(__dirname, "..", "..", "backend");
const coupons = require(path.join(backendDir, "coupons"));
const { productKey } = require(path.join(backendDir, "catalog", "product-key"));

const ml = (n) => ({
  name: `Produto ${n}`, link: `https://www.mercadolivre.com.br/produto/p/MLB88800${n}`,
  store: "Mercado Livre", category: "gamer", price: 100, discount: 30,
});
const VALIDO = ml(1), VENCIDO = ml(2), SOLTO = ml(3), DE_HOJE = ml(4);
const ONTEM = new Date(Date.now() - 2 * 864e5);

async function cupom(campaignId, expiresAt, produto) {
  await coupons.upsertCoupons([{
    campaignId, title: `CUPOM ${campaignId}`, kind: "percent", value: 10, scope: "campaign",
    containerUrl: `https://lista.mercadolivre.com.br/_Container_${campaignId}`,
    activated: true, expiresAt: expiresAt.toISOString(),
  }]);
  await coupons.replaceCouponProducts(campaignId, [{ productKey: productKey(produto), productUrl: produto.link }]);
}

const existe = async (p) => !!(await prisma().catalogProduct.findUnique({ where: { key: productKey(p) } }));

describe("pruneBeforeDate({ keepCouponLinked })", () => {
  beforeEach(async () => {
    await catalog.upsertProducts([VALIDO, VENCIDO, SOLTO, DE_HOJE]);
    await cupom("9900101", new Date(Date.now() + 864e5), VALIDO);
    await cupom("9900102", new Date(Date.now() - 3600e3), VENCIDO);
    // Os três primeiros "foram vistos" antes de ontem; DE_HOJE fica com agora.
    await prisma().catalogProduct.updateMany({
      where: { key: { in: [VALIDO, VENCIDO, SOLTO].map(productKey) } },
      data: { lastSeenAt: ONTEM },
    });
  });

  it("mantém produto de cupom válido; apaga o de cupom vencido e o sem vínculo", async () => {
    const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
    const r = await catalog.pruneBeforeDate(hoje, { keepCouponLinked: true });

    expect(r.removed).toBe(2);
    expect(r.kept).toBe(1);
    expect(await existe(VALIDO)).toBe(true);
    expect(await existe(DE_HOJE)).toBe(true);
    expect(await existe(VENCIDO)).toBe(false);
    expect(await existe(SOLTO)).toBe(false);
  });

  it("sem a opção, continua apagando tudo antes do corte", async () => {
    const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
    const r = await catalog.pruneBeforeDate(hoje);
    expect(r.removed).toBe(3);
    expect(await existe(VALIDO)).toBe(false);
  });
});
