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

const { isPresent, evaluateSample, worstStatus, imageStatsFor, specsForSource, FIELD_SPECS, AVAILABLE_SOURCES } = tester;
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

// Produto do Hub de Afiliados: sem vendedor, sem nº de avaliações, sem frete,
// e com a comissão que só existe lá.
const hubProduct = (over = {}) => ({
  name: "Fone Bluetooth",
  link: "https://www.mercadolivre.com.br/p/MLB123",
  img: "https://http2.mlstatic.com/D_Q_NP_123-F.webp",
  price: 99.9,
  originalPrice: 199.9,
  discount: 50,
  rating: 4.6,
  reviewsCount: null,
  seller: null,
  freeShipping: false,
  sold: "+500 vendidos",
  store: "Mercado Livre",
  hub: true,
  commission: "12%",
  ...over,
});

// Config com a conferência de fotos ligada.
const withImages = { thresholds: {}, checkImages: true, imageMinPx: 500 };
const imgInfo = (width, height) => ({ ok: true, width, height, bytes: 1000, error: null });

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

  it("qualidade da foto: usa a medição, não o campo img", () => {
    const q = spec("imgQuality");
    const ctx = { imageMinPx: 500 };
    expect(isPresent({ _imgInfo: imgInfo(1200, 1200) }, q, ctx)).toBe(true);
    expect(isPresent({ _imgInfo: imgInfo(500, 500) }, q, ctx)).toBe(true);     // no limite passa
    expect(isPresent({ _imgInfo: imgInfo(1200, 90) }, q, ctx)).toBe(false);    // uma dimensão pequena reprova
    expect(isPresent({ _imgInfo: { ok: false, error: "HTTP 404" } }, q, ctx)).toBe(false);
    expect(isPresent({ img: "https://x/foto.jpg" }, q, ctx)).toBe(false);      // sem medição = reprovado
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
    // 50% de cobertura de vendas: reprova no ML (70%) e passa na Amazon (30%,
    // porque a prova social de compras nem sempre existe lá).
    const half = (make) => [make(), make({ sold: null, soldCount: null })];
    expect(evaluateSample("ml", half(mlProduct), noThresholds).missing).toContain("sold");
    expect(evaluateSample("amazon", half(mlProduct), noThresholds).missing).not.toContain("sold");
  });

  it("Amazon reprova quando o preço não foi confirmado na página do produto", () => {
    const semConferir = [mlProduct({ priceVerified: true }), mlProduct({ priceVerified: false })];
    const r = evaluateSample("amazon", semConferir, noThresholds);
    expect(r.missing).toContain("priceVerified");
    // Campo crítico: reprova a amostra inteira, não é só um aviso.
    expect(r.status).toBe("fail");
    // O ML não tem esse campo — a conferência é específica da Amazon.
    expect(evaluateSample("ml", semConferir, noThresholds).fields.priceVerified).toBeUndefined();
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

describe("fonte ml-hub", () => {
  it("aparece como fonte testável separada do ML", () => {
    expect(AVAILABLE_SOURCES.map(s => s.id)).toContain("ml-hub");
  });

  it("amostra completa do Hub passa em tudo", () => {
    const r = evaluateSample("ml-hub", [hubProduct(), hubProduct()], noThresholds);
    expect(r.status).toBe("ok");
    expect(r.missing).toEqual([]);
  });

  it("não cobra vendedor, nº de avaliações nem frete (o card do Hub não traz)", () => {
    const r = evaluateSample("ml-hub", [hubProduct(), hubProduct()], noThresholds);
    expect(r.fields.seller).toBeUndefined();
    expect(r.fields.reviewsCount).toBeUndefined();
    expect(r.fields.freeShipping).toBeUndefined();
  });

  it("cobra a comissão, que só existe no Hub", () => {
    expect(specsForSource("ml").map(s => s.key)).not.toContain("commission");
    const r = evaluateSample("ml-hub", [hubProduct(), hubProduct({ commission: null })], noThresholds);
    expect(r.fields.commission.pct).toBe(50);
    expect(r.missing).toContain("commission");
    expect(r.status).toBe("warn");
  });

  it("aceita limiar personalizado da fonte com hífen no nome", () => {
    const products = [hubProduct(), hubProduct({ commission: null })];
    expect(evaluateSample("ml-hub", products, { thresholds: { "ml-hub.commission": 40 } }).missing)
      .not.toContain("commission");
  });
});

describe("qualidade da foto na avaliação", () => {
  it("entra como linha própria quando a conferência está ligada", () => {
    const products = [
      { ...mlProduct(), _imgInfo: imgInfo(1200, 1200) },
      { ...mlProduct(), _imgInfo: imgInfo(90, 90) },
    ];
    const r = evaluateSample("ml", products, withImages);
    expect(r.fields.imgQuality.pct).toBe(50);
    expect(r.missing).toContain("imgQuality");
    expect(r.status).toBe("warn");     // foto pequena é alerta, não falha grave
    expect(r.fields.img.pct).toBe(100);  // a URL existe nas duas
  });

  it("respeita a resolução mínima configurada", () => {
    const products = [{ ...mlProduct(), _imgInfo: imgInfo(600, 600) }];
    expect(evaluateSample("ml", products, { ...withImages, imageMinPx: 500 }).missing).not.toContain("imgQuality");
    expect(evaluateSample("ml", products, { ...withImages, imageMinPx: 1000 }).missing).toContain("imgQuality");
  });

  it("some do relatório com a conferência desligada", () => {
    const r = evaluateSample("ml", [mlProduct()], { thresholds: {}, checkImages: false });
    expect(r.fields.imgQuality).toBeUndefined();
    expect(r.status).toBe("ok");
  });
});

describe("imageStatsFor", () => {
  it("separa fotos boas, pequenas e quebradas", () => {
    const products = [
      { ...mlProduct({ name: "boa" }), _imgInfo: imgInfo(1200, 1200) },
      { ...mlProduct({ name: "pequena" }), _imgInfo: imgInfo(200, 200) },
      { ...mlProduct({ name: "minúscula" }), _imgInfo: imgInfo(80, 80) },
      { ...mlProduct({ name: "quebrada" }), _imgInfo: { ok: false, error: "HTTP 404" } },
    ];
    const st = imageStatsFor(products, { imageMinPx: 500 });
    expect(st).toMatchObject({ minPx: 500, checked: 4, good: 1, small: 2, broken: 1 });
    // As piores primeiro: a quebrada, depois a menor de todas.
    expect(st.worst[0].name).toBe("quebrada");
    expect(st.worst[1].name).toBe("minúscula");
    expect(st.worst.length).toBe(3);
  });

  it("ignora produtos sem medição", () => {
    const st = imageStatsFor([mlProduct()], { imageMinPx: 500 });
    expect(st.checked).toBe(0);
    expect(st.worst).toEqual([]);
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
