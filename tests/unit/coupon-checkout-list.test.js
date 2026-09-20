// A leitura dos cupons que o CHECKOUT do ML lista para um carrinho
// (coupons/checkout-list.js), sobre a captura real da sonda de 19/09/2026 — porteiro
// Intelbras, campanha 14167118 "25% OFF em Itens para Casa", aplicada, R$ 20 de
// desconto (bateu no teto). A fixture é só o modelo do iframe `/cupons/cho`, sem
// dado da conta.
//
// O que custa caro errar aqui: marcar como "vale neste produto" um cupom que o ML só
// listou sem aplicar nem calcular desconto — o selo iria parar num produto onde o
// cliente não ganha nada.

import "../helpers/env.js";
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { parseCheckoutCupons, cuponsQueValem } = require(path.resolve(__dirname, "..", "..", "backend", "coupons", "checkout-list.js"));
const html = fs.readFileSync(path.resolve(__dirname, "..", "fixtures", "ml-checkout-cupons-iframe.html"), "utf8");

describe("parseCheckoutCupons (captura real)", () => {
  it("lê o cupom aplicado, com o desconto que o ML calculou neste carrinho", () => {
    const r = parseCheckoutCupons(html);
    expect(r.ok).toBe(true);
    expect(r.economia).toBe(20);
    expect(r.cupons).toHaveLength(1);
    expect(r.cupons[0]).toMatchObject({
      campaignId: "14167118",
      titulo: "25% OFF em Itens para Casa",
      categoria: "Itens para Casa",
      grupo: "meli",
      status: "ACTIVE",
      aplicado: true,
      kind: "percent",
      value: 25,
      descontoNoCarrinho: 20,
      minPurchase: 25,
      maxDiscount: 20,
      expiresAt: "2026-11-01T02:59Z",
    });
  });

  it("HTML sem o modelo (iframe que não carregou) não inventa nada", () => {
    expect(parseCheckoutCupons("<html><body>Cupons</body></html>")).toMatchObject({ ok: false, cupons: [] });
    expect(parseCheckoutCupons("")).toMatchObject({ ok: false });
  });
});

describe("cuponsQueValem", () => {
  const base = { campaignId: "1", status: "ACTIVE", aplicado: false, descontoNoCarrinho: null };
  it("vale: o aplicado, ou o que tem desconto calculado pra este carrinho", () => {
    expect(cuponsQueValem([{ ...base, aplicado: true }])).toHaveLength(1);
    expect(cuponsQueValem([{ ...base, descontoNoCarrinho: 12.5 }])).toHaveLength(1);
  });
  it("não vale: só listado, sem aplicar nem calcular desconto — ou inativo", () => {
    expect(cuponsQueValem([{ ...base }])).toHaveLength(0);
    expect(cuponsQueValem([{ ...base, descontoNoCarrinho: 0 }])).toHaveLength(0);
    expect(cuponsQueValem([{ ...base, aplicado: true, status: "INACTIVE" }])).toHaveLength(0);
  });
});
