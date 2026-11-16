// "Validar cupom" na mão: o admin liga uma palavra a um cupom quando o teste no
// checkout não conseguiu (o DEZOFF voltou "indeterminado" e o "10% OFF com DEZOFF"
// ficou sem palavra, então os itens da fila com "só cupom válido" ficaram presos).
import { describe, it, expect, beforeEach } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const backendDir = path.resolve(__dirname, "..", "..", "backend");
const coupons = require(path.join(backendDir, "coupons"));
const scheduler = require(path.join(backendDir, "scheduler.js"));

const AMANHA = () => new Date(Date.now() + 864e5).toISOString();
const CUPOM = "9930001";
const OUTRO = "9930002";

beforeEach(async () => {
  await coupons.upsertCoupons([
    { campaignId: CUPOM, title: "10% OFF", kind: "percent", value: 10, maxDiscount: 30, minPurchase: 79, scope: "campaign", activated: true, expiresAt: AMANHA() },
    { campaignId: OUTRO, title: "Outro", kind: "percent", value: 5, scope: "campaign", activated: true, expiresAt: AMANHA() },
  ]);
  await coupons.recordCodeCheck({ code: "DEZOFF", verdict: "indeterminado", source: "repasse-checkout-auto" });
});

describe("vincularPalavraManual", () => {
  it("carimba a palavra no cupom e marca a palavra como valid/manual", async () => {
    await coupons.vincularPalavraManual("dezoff", CUPOM);
    expect((await coupons.findCouponByCode("DEZOFF"))?.campaignId).toBe(CUPOM);
    const linha = await coupons.findCodeCheck("DEZOFF", { maxAgeHours: Infinity });
    expect(linha).toMatchObject({ verdict: "valid", campaignId: CUPOM, source: "manual" });
  });

  it("tira a palavra do cupom que a tinha antes", async () => {
    await coupons.vincularPalavraManual("DEZOFF", OUTRO);
    await coupons.vincularPalavraManual("DEZOFF", CUPOM);
    expect((await coupons.getCoupon(OUTRO)).code).toBeNull();
    expect((await coupons.getCoupon(CUPOM)).code).toBe("DEZOFF");
  });

  it("um teste indeterminado depois não desfaz o vínculo", async () => {
    await coupons.vincularPalavraManual("DEZOFF", CUPOM);
    await coupons.recordCodeCheck({ code: "DEZOFF", verdict: "indeterminado", source: "repasse-checkout-auto" });
    expect((await coupons.findCouponByCode("DEZOFF"))?.campaignId).toBe(CUPOM);
  });

  it("recusa cupom que não existe e palavra vazia", async () => {
    await expect(coupons.vincularPalavraManual("DEZOFF", "0000")).rejects.toThrow(/não existe/);
    await expect(coupons.vincularPalavraManual("", CUPOM)).rejects.toThrow(/palavra/);
  });

  it("o item da fila com a palavra passa a ser válido e ganha o preço com cupom", async () => {
    const item = { store: "Mercado Livre", source: "repasse", coupon: "DEZOFF", price: 200 };
    expect(await scheduler.estadoCupomDoItem(item)).toBe("testando");
    await coupons.vincularPalavraManual("DEZOFF", CUPOM);
    expect(await scheduler.estadoCupomDoItem(item)).toBe("valido");
    expect((await scheduler.cupomCalculadoDoItem(item)).priceWithCoupon).toBe(180);
  });
});
