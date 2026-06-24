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
const SHOPEE_DEFAULTS = affiliate.SHOPEE_FILTERS_DEFAULTS;

// Node CRU da Shopee API (antes do shopeeNodeToProduct). passesShopeeFilters lê
// os campos brutos: ratingStar, sales, price, commissionRate, priceDiscountRate.
const shopeeNode = (over = {}) => ({
  ratingStar: 4.6,
  sales: 1200,
  price: 99.9,
  commissionRate: 0.08,   // 8%
  priceDiscountRate: 40,
  ...over,
});

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

describe("passesShopeeFilters", () => {
  it("defaults (tudo 0) deixam passar qualquer node — inclusive sem rating/vendas/desconto", () => {
    expect(affiliate.passesShopeeFilters(shopeeNode(), SHOPEE_DEFAULTS)).toBe(true);
    expect(affiliate.passesShopeeFilters(
      shopeeNode({ ratingStar: 0, sales: 0, priceDiscountRate: 0, commissionRate: 0 }), SHOPEE_DEFAULTS
    )).toBe(true);
  });

  it("minRating corta abaixo do mínimo", () => {
    const f = { ...SHOPEE_DEFAULTS, minRating: 4.5 };
    expect(affiliate.passesShopeeFilters(shopeeNode({ ratingStar: 4.6 }), f)).toBe(true);
    expect(affiliate.passesShopeeFilters(shopeeNode({ ratingStar: 4.0 }), f)).toBe(false);
  });

  it("minSales corta abaixo do mínimo", () => {
    const f = { ...SHOPEE_DEFAULTS, minSales: 1000 };
    expect(affiliate.passesShopeeFilters(shopeeNode({ sales: 1200 }), f)).toBe(true);
    expect(affiliate.passesShopeeFilters(shopeeNode({ sales: 50 }), f)).toBe(false);
  });

  it("minPrice e maxPrice delimitam a faixa", () => {
    expect(affiliate.passesShopeeFilters(shopeeNode({ price: 99.9 }), { ...SHOPEE_DEFAULTS, minPrice: 150 })).toBe(false);
    expect(affiliate.passesShopeeFilters(shopeeNode({ price: 99.9 }), { ...SHOPEE_DEFAULTS, minPrice: 50 })).toBe(true);
    expect(affiliate.passesShopeeFilters(shopeeNode({ price: 300 }), { ...SHOPEE_DEFAULTS, maxPrice: 200 })).toBe(false);
    expect(affiliate.passesShopeeFilters(shopeeNode({ price: 100 }), { ...SHOPEE_DEFAULTS, maxPrice: 200 })).toBe(true);
  });

  it("minCommissionRate corta comissão baixa (fração 0..1)", () => {
    const f = { ...SHOPEE_DEFAULTS, minCommissionRate: 0.05 };
    expect(affiliate.passesShopeeFilters(shopeeNode({ commissionRate: 0.08 }), f)).toBe(true);
    expect(affiliate.passesShopeeFilters(shopeeNode({ commissionRate: 0.02 }), f)).toBe(false);
  });

  it("maxDiscount corta '99% off' fake mas não corta item sem desconto", () => {
    const f = { ...SHOPEE_DEFAULTS, maxDiscount: 95 };
    expect(affiliate.passesShopeeFilters(shopeeNode({ priceDiscountRate: 40 }), f)).toBe(true);
    expect(affiliate.passesShopeeFilters(shopeeNode({ priceDiscountRate: 99 }), f)).toBe(false);
    expect(affiliate.passesShopeeFilters(shopeeNode({ priceDiscountRate: 0 }), f)).toBe(true);
  });

  it("minDiscount: só deixa passar itens em promoção (corta desconto 0)", () => {
    const f = { ...SHOPEE_DEFAULTS, minDiscount: 10 };
    expect(affiliate.passesShopeeFilters(shopeeNode({ priceDiscountRate: 40 }), f)).toBe(true);
    expect(affiliate.passesShopeeFilters(shopeeNode({ priceDiscountRate: 10 }), f)).toBe(true);
    expect(affiliate.passesShopeeFilters(shopeeNode({ priceDiscountRate: 5 }), f)).toBe(false);
    // O caso de uso principal: minDiscount > 0 derruba item sem desconto.
    expect(affiliate.passesShopeeFilters(shopeeNode({ priceDiscountRate: 0 }), { ...SHOPEE_DEFAULTS, minDiscount: 1 })).toBe(false);
  });

  it("combina filtros: precisa passar em todos", () => {
    const f = { minRating: 4.5, minSales: 100, minPrice: 20, maxPrice: 500, minCommissionRate: 0.05, maxDiscount: 95, minDiscount: 10 };
    expect(affiliate.passesShopeeFilters(shopeeNode(), f)).toBe(true);
    expect(affiliate.passesShopeeFilters(shopeeNode({ priceDiscountRate: 0 }), f)).toBe(false);
    expect(affiliate.passesShopeeFilters(shopeeNode({ commissionRate: 0.01 }), f)).toBe(false);
  });
});

describe("writeShopeeScraperFilters / readShopeeScraperFilters", () => {
  it("persiste minDiscount e volta no read", () => {
    affiliate.writeShopeeScraperFilters({ minDiscount: 15 });
    expect(affiliate.readShopeeScraperFilters().minDiscount).toBe(15);
  });

  it("listType aceita 0/1/2", () => {
    expect(affiliate.writeShopeeScraperFilters({ listType: 2 }).listType).toBe(2);
    expect(affiliate.writeShopeeScraperFilters({ listType: 1 }).listType).toBe(1);
    expect(affiliate.writeShopeeScraperFilters({ listType: 0 }).listType).toBe(0);
  });

  it("listType inválido NÃO sobrescreve o valor atual (whitelist)", () => {
    affiliate.writeShopeeScraperFilters({ listType: 2 });
    expect(affiliate.writeShopeeScraperFilters({ listType: 3 }).listType).toBe(2);
    expect(affiliate.writeShopeeScraperFilters({ listType: "x" }).listType).toBe(2);
    expect(affiliate.writeShopeeScraperFilters({ listType: -1 }).listType).toBe(2);
  });

  it("clampa minDiscount em 100 e converte comissão '5' → 0.05", () => {
    const saved = affiliate.writeShopeeScraperFilters({ minDiscount: 150, minCommissionRate: 5 });
    expect(saved.minDiscount).toBe(100);
    expect(saved.minCommissionRate).toBe(0.05);
  });

  it("read mescla defaults: config sem os campos novos retorna minDiscount:0 e listType:0", () => {
    const f = affiliate.readShopeeScraperFilters();
    expect(f).toHaveProperty("minDiscount");
    expect(f).toHaveProperty("listType");
    expect(SHOPEE_DEFAULTS.minDiscount).toBe(0);
    expect(SHOPEE_DEFAULTS.listType).toBe(0);
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

describe("amzBackoffMs — retry da Amazon", () => {
  // Bases: [3000, 8000, 20000] com jitter ±30%.
  const inRange = (v, base) => v >= base * 0.7 - 1 && v <= base * 1.3 + 1;

  it("respeita a base de cada tentativa dentro do jitter ±30%", () => {
    for (let i = 0; i < 50; i++) {
      expect(inRange(scraper.amzBackoffMs(1), 3000)).toBe(true);
      expect(inRange(scraper.amzBackoffMs(2), 8000)).toBe(true);
      expect(inRange(scraper.amzBackoffMs(3), 20000)).toBe(true);
    }
  });

  it("tentativas além do array usam a última base (clamp)", () => {
    for (let i = 0; i < 50; i++) {
      expect(inRange(scraper.amzBackoffMs(4), 20000)).toBe(true);
      expect(inRange(scraper.amzBackoffMs(99), 20000)).toBe(true);
    }
  });

  it("nunca devolve negativo", () => {
    for (let i = 0; i < 100; i++) {
      expect(scraper.amzBackoffMs(1)).toBeGreaterThanOrEqual(0);
    }
  });
});
