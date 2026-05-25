// Filtros de qualidade do admin aplicados aos produtos scrapeados (ML e Amazon).
// Funções puras — sem rede, sem DB. Passamos os filtros explicitamente.

import "../helpers/env.js";
import { describe, it, expect } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const affiliate = require(path.resolve(__dirname, "..", "..", "backend", "scraping", "affiliate.js"));

const ML_DEFAULTS = affiliate.ML_FILTERS_DEFAULTS;
const AMZ_DEFAULTS = affiliate.AMAZON_FILTERS_DEFAULTS;

// Produto típico de oferta do ML (formato pós-scrapeML)
const mlProduct = (over = {}) => ({
  name: "Carregador 120w",
  link: "https://www.mercadolivre.com.br/x",
  price: 24.7,
  originalPrice: 78.9,
  discount: 68,
  rating: 4.4,
  reviewsCount: "1620",
  sold: "+50 vendidos",
  ...over,
});

const amzProduct = (over = {}) => ({
  name: "Echo Dot",
  link: "https://www.amazon.com.br/x",
  price: 199.0,
  originalPrice: 349.0,
  discount: 43,
  rating: 4.6,
  reviewsCount: "12.345",
  ...over,
});

describe("passesMLFilters", () => {
  it("defaults (tudo 0) deixam passar qualquer produto — inclusive sem rating/vendas/desconto", () => {
    expect(affiliate.passesMLFilters(mlProduct(), ML_DEFAULTS)).toBe(true);
    expect(affiliate.passesMLFilters(
      mlProduct({ rating: null, sold: null, discount: null }), ML_DEFAULTS
    )).toBe(true);
  });

  it("minRating corta abaixo do mínimo e produto sem rating", () => {
    const f = { ...ML_DEFAULTS, minRating: 4 };
    expect(affiliate.passesMLFilters(mlProduct({ rating: 4.4 }), f)).toBe(true);
    expect(affiliate.passesMLFilters(mlProduct({ rating: 3.5 }), f)).toBe(false);
    expect(affiliate.passesMLFilters(mlProduct({ rating: null }), f)).toBe(false);
  });

  it("minSales parseia '+50 vendidos' e '1 mil vendidos'", () => {
    expect(affiliate.passesMLFilters(mlProduct({ sold: "+50 vendidos" }), { ...ML_DEFAULTS, minSales: 50 })).toBe(true);
    expect(affiliate.passesMLFilters(mlProduct({ sold: "+50 vendidos" }), { ...ML_DEFAULTS, minSales: 100 })).toBe(false);
    expect(affiliate.passesMLFilters(mlProduct({ sold: "1 mil vendidos" }), { ...ML_DEFAULTS, minSales: 500 })).toBe(true);
    // Sem rótulo de vendas conta como 0 → cortado quando minSales > 0
    expect(affiliate.passesMLFilters(mlProduct({ sold: null }), { ...ML_DEFAULTS, minSales: 1 })).toBe(false);
  });

  it("minPrice e maxPrice delimitam a faixa de preço", () => {
    expect(affiliate.passesMLFilters(mlProduct({ price: 24.7 }), { ...ML_DEFAULTS, minPrice: 30 })).toBe(false);
    expect(affiliate.passesMLFilters(mlProduct({ price: 24.7 }), { ...ML_DEFAULTS, minPrice: 20 })).toBe(true);
    expect(affiliate.passesMLFilters(mlProduct({ price: 100 }), { ...ML_DEFAULTS, maxPrice: 50 })).toBe(false);
    expect(affiliate.passesMLFilters(mlProduct({ price: 100 }), { ...ML_DEFAULTS, maxPrice: 200 })).toBe(true);
  });

  it("maxDiscount corta desconto fake mas não corta itens sem desconto", () => {
    expect(affiliate.passesMLFilters(mlProduct({ discount: 68 }), { ...ML_DEFAULTS, maxDiscount: 95 })).toBe(true);
    expect(affiliate.passesMLFilters(mlProduct({ discount: 99 }), { ...ML_DEFAULTS, maxDiscount: 95 })).toBe(false);
    expect(affiliate.passesMLFilters(mlProduct({ discount: null }), { ...ML_DEFAULTS, maxDiscount: 95 })).toBe(true);
  });

  it("combina filtros: precisa passar em todos", () => {
    const f = { minRating: 4, minSales: 50, minPrice: 10, maxPrice: 500, maxDiscount: 90 };
    expect(affiliate.passesMLFilters(mlProduct(), f)).toBe(true);
    expect(affiliate.passesMLFilters(mlProduct({ discount: 95 }), f)).toBe(false);
  });
});

describe("passesAmazonFilters", () => {
  it("defaults (tudo 0) deixam passar qualquer produto", () => {
    expect(affiliate.passesAmazonFilters(amzProduct(), AMZ_DEFAULTS)).toBe(true);
    expect(affiliate.passesAmazonFilters(
      amzProduct({ rating: null, reviewsCount: null, discount: null }), AMZ_DEFAULTS
    )).toBe(true);
  });

  it("minReviews parseia reviewsCount com separador de milhar", () => {
    expect(affiliate.passesAmazonFilters(amzProduct({ reviewsCount: "12.345" }), { ...AMZ_DEFAULTS, minReviews: 1000 })).toBe(true);
    expect(affiliate.passesAmazonFilters(amzProduct({ reviewsCount: "50" }), { ...AMZ_DEFAULTS, minReviews: 100 })).toBe(false);
    expect(affiliate.passesAmazonFilters(amzProduct({ reviewsCount: null }), { ...AMZ_DEFAULTS, minReviews: 1 })).toBe(false);
  });

  it("minRating corta abaixo do mínimo e sem rating", () => {
    const f = { ...AMZ_DEFAULTS, minRating: 4.5 };
    expect(affiliate.passesAmazonFilters(amzProduct({ rating: 4.6 }), f)).toBe(true);
    expect(affiliate.passesAmazonFilters(amzProduct({ rating: 4.0 }), f)).toBe(false);
    expect(affiliate.passesAmazonFilters(amzProduct({ rating: null }), f)).toBe(false);
  });

  it("maxPrice e maxDiscount", () => {
    expect(affiliate.passesAmazonFilters(amzProduct({ price: 199 }), { ...AMZ_DEFAULTS, maxPrice: 150 })).toBe(false);
    expect(affiliate.passesAmazonFilters(amzProduct({ discount: 43 }), { ...AMZ_DEFAULTS, maxDiscount: 90 })).toBe(true);
    expect(affiliate.passesAmazonFilters(amzProduct({ discount: 95 }), { ...AMZ_DEFAULTS, maxDiscount: 90 })).toBe(false);
  });
});
