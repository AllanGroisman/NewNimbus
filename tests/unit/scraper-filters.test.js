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
const scraper = require(path.resolve(__dirname, "..", "..", "backend", "scraping", "scraper.js"));

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

  it("minReviews parseia reviewsCount; ausente (null) NÃO corta", () => {
    expect(affiliate.passesAmazonFilters(amzProduct({ reviewsCount: "12.345" }), { ...AMZ_DEFAULTS, minReviews: 1000 })).toBe(true);
    expect(affiliate.passesAmazonFilters(amzProduct({ reviewsCount: "50" }), { ...AMZ_DEFAULTS, minReviews: 100 })).toBe(false);
    // Sem reviews (não enriquecido / CAPTCHA) passa — minReviews só filtra quem tem o dado.
    expect(affiliate.passesAmazonFilters(amzProduct({ reviewsCount: null }), { ...AMZ_DEFAULTS, minReviews: 1 })).toBe(true);
  });

  it("minRating corta abaixo do mínimo; ausente (null) NÃO corta", () => {
    const f = { ...AMZ_DEFAULTS, minRating: 4.5 };
    expect(affiliate.passesAmazonFilters(amzProduct({ rating: 4.6 }), f)).toBe(true);
    expect(affiliate.passesAmazonFilters(amzProduct({ rating: 4.0 }), f)).toBe(false);
    // Sem rating passa — só vale o filtro pra quem foi enriquecido.
    expect(affiliate.passesAmazonFilters(amzProduct({ rating: null }), f)).toBe(true);
  });

  it("preço/desconto ainda cortam mesmo sem rating", () => {
    const f = { ...AMZ_DEFAULTS, minRating: 4.5, maxPrice: 150 };
    // sem rating mas preço acima do teto → corta por preço
    expect(affiliate.passesAmazonFilters(amzProduct({ rating: null, price: 199 }), f)).toBe(false);
    // sem rating e preço ok → passa
    expect(affiliate.passesAmazonFilters(amzProduct({ rating: null, price: 99 }), f)).toBe(true);
  });

  it("maxPrice e maxDiscount", () => {
    expect(affiliate.passesAmazonFilters(amzProduct({ price: 199 }), { ...AMZ_DEFAULTS, maxPrice: 150 })).toBe(false);
    expect(affiliate.passesAmazonFilters(amzProduct({ discount: 43 }), { ...AMZ_DEFAULTS, maxDiscount: 90 })).toBe(true);
    expect(affiliate.passesAmazonFilters(amzProduct({ discount: 95 }), { ...AMZ_DEFAULTS, maxDiscount: 90 })).toBe(false);
  });
});

describe("buildAmazonDealsUrl", () => {
  it("sem departamento (ou 'all') devolve a URL base de ofertas", () => {
    expect(scraper.buildAmazonDealsUrl()).toBe("https://www.amazon.com.br/deals");
    expect(scraper.buildAmazonDealsUrl("all")).toBe("https://www.amazon.com.br/deals");
  });

  it("com departamento codifica refinementFilters.departments no discounts-widget", () => {
    const url = scraper.buildAmazonDealsUrl("16194415011");
    expect(url.startsWith("https://www.amazon.com.br/deals?discounts-widget=")).toBe(true);
    // O param é JSON serializado 2x e URL-encodado 2x; URL.get() decodifica uma vez.
    const param = new URL(url).searchParams.get("discounts-widget");
    const obj = JSON.parse(JSON.parse(decodeURIComponent(param)));
    expect(obj).toEqual({ state: { refinementFilters: { departments: ["16194415011"] } }, version: 1 });
  });

  it("toda categoria do catálogo tem um amzDept mapeado", () => {
    for (const [id, cat] of Object.entries(scraper.CATEGORIES)) {
      expect(cat.amzDept, `categoria ${id} sem amzDept`).toMatch(/^\d+$/);
    }
  });
});
