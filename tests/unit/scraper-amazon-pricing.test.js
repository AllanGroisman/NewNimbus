// Preço da Amazon — leitura da página do produto e o portão que decide quem entra
// no catálogo. Task 68: o cliente abria o link do card e via outro valor.
// Funções puras — sem rede, sem browser.

import "../helpers/env.js";
import { describe, it, expect } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const scraper = require(path.resolve(__dirname, "..", "..", "backend", "scraping", "scraper.js"));
const affiliate = require(path.resolve(__dirname, "..", "..", "backend", "scraping", "affiliate.js"));

const { parseBrlPrice, parseDiscountLabel, parseAmazonPdpPricing, selectVerifiedAmazonProducts } = scraper;

describe("parseBrlPrice", () => {
  it("lê o formato brasileiro com milhar e centavos", () => {
    expect(parseBrlPrice("R$ 1.234,56")).toBe(1234.56);
  });

  it("ignora o prefixo de acessibilidade da Amazon", () => {
    expect(parseBrlPrice("Preço da Oferta: R$ 99,90")).toBe(99.9);
  });

  it("aceita preço sem centavos e sem espaço", () => {
    expect(parseBrlPrice("R$199")).toBe(199);
  });

  it("devolve null pra texto sem preço", () => {
    expect(parseBrlPrice("Em até 10x sem juros")).toBeNull();
    expect(parseBrlPrice("")).toBeNull();
    expect(parseBrlPrice(null)).toBeNull();
  });
});

describe("parseDiscountLabel", () => {
  it("lê o selo nos formatos da Amazon", () => {
    expect(parseDiscountLabel("57% off")).toBe(57);
    expect(parseDiscountLabel("-57%")).toBe(57);
    expect(parseDiscountLabel("57% de desconto")).toBe(57);
  });

  it("NÃO trata promoção de cupom/bundle como desconto do produto", () => {
    expect(parseDiscountLabel("Economize 10% com cupom")).toBeNull();
    expect(parseDiscountLabel("Compre 2, ganhe 5% off")).toBeNull();
    expect(parseDiscountLabel("Economize 15% na assinatura")).toBeNull();
  });

  it("descarta percentual fora da faixa plausível", () => {
    expect(parseDiscountLabel("0%")).toBeNull();
    expect(parseDiscountLabel("99%")).toBeNull();
  });
});

describe("parseAmazonPdpPricing", () => {
  it("fecha preço, riscado e desconto quando são coerentes", () => {
    const r = parseAmazonPdpPricing({
      container: "#corePriceDisplay_desktop_feature_div",
      priceText: "R$ 99,90",
      originalText: "R$ 199,90",
      discountText: "-50%",
    });
    expect(r.price).toBe(99.9);
    expect(r.originalPrice).toBe(199.9);
    expect(r.discount).toBe(50);
    expect(r.priceSource).toBe("pdp:#corePriceDisplay_desktop_feature_div");
  });

  it("descarta riscado absurdo (veio de outro bloco da página)", () => {
    const r = parseAmazonPdpPricing({
      container: "#corePrice_feature_div",
      priceText: "R$ 10,00",
      originalText: "R$ 5.000,00",
      discountText: null,
    });
    expect(r.price).toBe(10);
    expect(r.originalPrice).toBeNull();
    expect(r.discount).toBeNull();
  });

  it("produto indisponível sai sem preço — não tem valor a anunciar", () => {
    const r = parseAmazonPdpPricing({
      container: "#buybox",
      priceText: "R$ 99,90",
      originalText: null,
      discountText: null,
      unavailable: true,
    });
    expect(r.price).toBeNull();
    expect(r.originalPrice).toBeNull();
  });

  it("marca a leitura como fora do bloco de compra quando não achou container", () => {
    const r = parseAmazonPdpPricing({ container: null, priceText: "R$ 50,00" });
    expect(r.price).toBe(50);
    expect(r.priceSource).toBe("pdp-unscoped");
  });
});

describe("selectVerifiedAmazonProducts", () => {
  const cfg = { ...affiliate.AMAZON_FILTERS_DEFAULTS, minRating: 0, minReviews: 0, minPrice: 0, maxPrice: 0 };
  const passes = affiliate.passesAmazonFilters;

  it("descarta quem não teve o preço confirmado na página", () => {
    const pool = [
      { name: "a", price: 10, discount: 50, priceVerified: true },
      { name: "b", price: 20, discount: 40, priceVerified: true },
      { name: "c", price: 30, discount: 30, priceVerified: false },
      { name: "d", price: 40, discount: 20 },
      { name: "e", price: 50, discount: 10, priceVerified: true },
    ];
    const r = selectVerifiedAmazonProducts(pool, cfg, 10, passes);
    expect(r.kept.map(p => p.name)).toEqual(["a", "b", "e"]);
    expect(r.discardedUnverified).toBe(2);
    expect(r.discardedByFilter).toBe(0);
  });

  it("aplica o filtro sobre o preço REAL, não sobre o do card", () => {
    const caro = { ...cfg, maxPrice: 100 };
    // Passaria com o preço do card (R$ 80); na página custa R$ 300.
    const pool = [{ name: "x", price: 300, _cardPrice: 80, discount: 10, priceVerified: true }];
    const r = selectVerifiedAmazonProducts(pool, caro, 10, passes);
    expect(r.kept).toHaveLength(0);
    expect(r.discardedByFilter).toBe(1);
  });

  it("ordena por desconto, respeita o limite e limpa os campos internos", () => {
    const pool = [
      { name: "a", price: 10, discount: 20, priceVerified: true, _cardPrice: 9, _attempts: 1 },
      { name: "b", price: 10, discount: 70, priceVerified: true },
      { name: "c", price: 10, discount: 40, priceVerified: true },
    ];
    const r = selectVerifiedAmazonProducts(pool, cfg, 2, passes);
    expect(r.kept.map(p => p.name)).toEqual(["b", "c"]);
    expect(r.kept[0]).not.toHaveProperty("_cardPrice");
    expect(r.kept[0]).not.toHaveProperty("_attempts");
  });

  it("pool vazio não quebra", () => {
    expect(selectVerifiedAmazonProducts([], cfg, 10, passes).kept).toEqual([]);
    expect(selectVerifiedAmazonProducts(null, cfg, 10, passes).kept).toEqual([]);
  });
});
