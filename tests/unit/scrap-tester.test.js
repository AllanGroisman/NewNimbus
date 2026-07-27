// ScrapTester — lógica de cobertura de campos. Funções puras, sem rede e sem DB.

import "../helpers/env.js";
import { describe, it, expect } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const tester = require(path.resolve(__dirname, "..", "..", "backend", "scraping", "tester.js"));

const { isPresent, evaluateSample, worstStatus, FIELD_SPECS } = tester;
const spec = (key) => FIELD_SPECS.find(s => s.key === key);
const noThresholds = { thresholds: {} };

// Produto completo do ML — base pra variar campo a campo.
const mlProduct = (over = {}) => ({
  name: "Fone Bluetooth",
  link: "https://produto.mercadolivre.com.br/MLB-123-fone",
  img: "https://http2.mlstatic.com/x.jpg",
  price: 99.9,
  originalPrice: 199.9,
  discount: 50,
  rating: 4.6,
  reviewsCount: "1.2mil",
  seller: "Loja X",
  freeShipping: true,
  sold: "+500 vendidos",
  store: "Mercado Livre",
  ...over,
});

const shopeeProduct = (over = {}) => ({
  name: "Smartphone",
  link: "https://s.shopee.com.br/abc",
  img: "https://cf.shopee.com.br/file/xyz",
  price: 999.9,
  originalPrice: 1428.4,
  discount: 30,
  rating: 4.5,
  reviewsCount: 42,
  seller: "Loja Oficial XPTO",   // vem do shopName da Affiliate API
  freeShipping: false,
  soldCount: 1234,
  store: "Shopee",
  ...over,
});

describe("isPresent", () => {
  it("aceita string preenchida e rejeita vazia/nula", () => {
    expect(isPresent({ name: "Fone" }, spec("name"))).toBe(true);
    expect(isPresent({ name: "   " }, spec("name"))).toBe(false);
    expect(isPresent({ name: null }, spec("name"))).toBe(false);
    expect(isPresent({}, spec("name"))).toBe(false);
  });

  it("trata preço 0 como ausente (scraper não conseguiu extrair)", () => {
    expect(isPresent({ price: 99.9 }, spec("price"))).toBe(true);
    expect(isPresent({ price: 0 }, spec("price"))).toBe(false);
    expect(isPresent({ price: null }, spec("price"))).toBe(false);
  });

  it("trata desconto 0 e vendas 0 como valores legítimos", () => {
    expect(isPresent({ discount: 0 }, spec("discount"))).toBe(true);
    expect(isPresent({ soldCount: 0 }, spec("sold"))).toBe(true);
  });

  it("resolve o campo alternativo (sold ↔ soldCount)", () => {
    expect(isPresent({ soldCount: 1234 }, spec("sold"))).toBe(true);
    expect(isPresent({ sold: "+500 vendidos" }, spec("sold"))).toBe(true);
    expect(isPresent({}, spec("sold"))).toBe(false);
  });

  it("campo booleano: presente quando definido, mesmo sendo false", () => {
    expect(isPresent({ freeShipping: false }, spec("freeShipping"))).toBe(true);
    expect(isPresent({ freeShipping: true }, spec("freeShipping"))).toBe(true);
    expect(isPresent({}, spec("freeShipping"))).toBe(false);
  });

  it("reviewsCount aceita tanto string do ML quanto número da Shopee", () => {
    expect(isPresent({ reviewsCount: "1.2mil" }, spec("reviewsCount"))).toBe(true);
    expect(isPresent({ reviewsCount: 42 }, spec("reviewsCount"))).toBe(true);
    expect(isPresent({ reviewsCount: null }, spec("reviewsCount"))).toBe(false);
  });
});

describe("evaluateSample", () => {
  it("amostra completa do ML passa em tudo", () => {
    const r = evaluateSample("ml", [mlProduct(), mlProduct(), mlProduct()], noThresholds);
    expect(r.status).toBe("ok");
    expect(r.missing).toEqual([]);
    expect(r.fields.rating.pct).toBe(100);
    expect(r.fields.rating.present).toBe(3);
  });

  it("calcula a porcentagem de cobertura por campo", () => {
    const products = [mlProduct(), mlProduct({ rating: null }), mlProduct({ rating: null }), mlProduct()];
    const r = evaluateSample("ml", products, noThresholds);
    expect(r.fields.rating.pct).toBe(50);
    expect(r.fields.rating.present).toBe(2);
    expect(r.missing).toContain("rating");
    expect(r.status).toBe("warn");   // avaliação não é campo crítico
  });

  it("campo essencial faltando vira falha grave", () => {
    const r = evaluateSample("ml", [mlProduct(), mlProduct({ price: null })], noThresholds);
    expect(r.criticalMissing).toContain("price");
    expect(r.status).toBe("fail");
  });

  it("ignora campos que não se aplicam à loja", () => {
    const r = evaluateSample("shopee", [shopeeProduct(), shopeeProduct()], noThresholds);
    // A Affiliate API da Shopee não expõe frete nem nº de avaliações.
    expect(r.fields.freeShipping).toBeUndefined();
    expect(r.fields.reviewsCount).toBeUndefined();
    expect(r.fields.seller.pct).toBe(100);   // via shopName
    expect(r.fields.sold.pct).toBe(100);     // via soldCount
    expect(r.status).toBe("ok");
  });

  it("o ML não é cobrado por nº de avaliações (o card não traz mais)", () => {
    const r = evaluateSample("ml", [mlProduct({ reviewsCount: null })], noThresholds);
    expect(r.fields.reviewsCount).toBeUndefined();
    expect(r.status).toBe("ok");
  });

  it("limiar padrão pode variar por loja (minPctBy)", () => {
    // 50% de cobertura de nota: reprova no ML (80%) e passa na Amazon (40%).
    const half = (make) => [make(), make({ rating: null })];
    expect(evaluateSample("ml", half(mlProduct), noThresholds).missing).toContain("rating");
    expect(evaluateSample("amazon", half(mlProduct), noThresholds).missing).not.toContain("rating");
  });

  it("respeita limiar personalizado por loja+campo", () => {
    const products = [mlProduct(), mlProduct({ rating: null })];   // 50% de cobertura
    expect(evaluateSample("ml", products, { thresholds: {} }).missing).toContain("rating");
    expect(evaluateSample("ml", products, { thresholds: { "ml.rating": 40 } }).missing).not.toContain("rating");
  });

  it("amostra vazia zera todas as coberturas", () => {
    const r = evaluateSample("ml", [], noThresholds);
    expect(r.fields.price.pct).toBe(0);
    expect(r.status).toBe("fail");
  });
});

describe("worstStatus", () => {
  it("agrega pegando o pior resultado", () => {
    expect(worstStatus(["ok", "ok"])).toBe("ok");
    expect(worstStatus(["ok", "warn"])).toBe("warn");
    expect(worstStatus(["warn", "fail", "ok"])).toBe("fail");
    expect(worstStatus([])).toBe("ok");
  });
});
