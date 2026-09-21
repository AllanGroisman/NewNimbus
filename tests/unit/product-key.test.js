// Hash de produto — chave critica do catalogo (dedup, cooldown, history).
// Mudar a funcao quebra dados em producao, entao garantimos estabilidade.

import "../helpers/env.js";
import { describe, it, expect } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const { productKey, mlItemIdFromUrl, mlUrlSpace, mlAnuncioIdFromUrl } = require(path.resolve(__dirname, "..", "..", "backend", "catalog", "product-key.js"));

describe("productKey", () => {
  it("usa MLB id da URL quando disponivel (formato /p/MLB...)", () => {
    const a = { link: "https://www.mercadolivre.com.br/produto/p/MLB1234567" };
    const b = { link: "https://www.mercadolivre.com.br/produto/p/MLB1234567?utm=foo&ref=bar" };
    expect(productKey(a)).toBe(productKey(b));
  });

  it("usa MLB id mesmo quando ha tracking diferente na URL", () => {
    const a = { link: "https://produto.mercadolivre.com.br/MLB-1234567890-nome-do-produto" };
    const b = { link: "https://produto.mercadolivre.com.br/MLB1234567890-outro-nome" };
    expect(productKey(a)).toBe(productKey(b));
  });

  it("usa o ASIN como chave da Amazon, independente do formato da URL", () => {
    const canonico = { link: "https://www.amazon.com.br/dp/B07YT1GLV9" };
    const comSlugERef = { link: "https://www.amazon.com.br/God-War-Hits-PlayStation-4/dp/B07YT1GLV9/ref=sr_1_1?keywords=god+of+war" };
    const gpProduct = { link: "https://www.amazon.com.br/gp/product/B07YT1GLV9" };
    const comTag = { link: "https://www.amazon.com.br/dp/B07YT1GLV9?tag=foo&ref=bar" };
    expect(productKey(comSlugERef)).toBe(productKey(canonico));
    expect(productKey(gpProduct)).toBe(productKey(canonico));
    expect(productKey(comTag)).toBe(productKey(canonico));
  });

  it("cai pra origin+pathname quando nao ha id conhecido", () => {
    const a = { link: "https://www.lojaqualquer.com.br/produto/xyz" };
    const b = { link: "https://www.lojaqualquer.com.br/produto/xyz?utm=foo&ref=bar" };
    expect(productKey(a)).toBe(productKey(b));
  });

  it("usa o padrão i.<sellerId>.<itemId> da Shopee como chave estável", () => {
    const a = { link: "https://shopee.com.br/produto-nome-i.123456.7890123" };
    const b = { link: "https://shopee.com.br/produto-nome-i.123456.7890123?sp_atk=abc&af_siteid=xyz" };
    const c = { link: "https://shopee.com.br/outro-titulo-i.123456.7890123" };
    expect(productKey(a)).toBe(productKey(b));
    // Mesmo seller+item, título diferente — ainda é o mesmo produto
    expect(productKey(a)).toBe(productKey(c));
  });

  it("difere produtos Shopee com sellerId/itemId distintos", () => {
    const a = { link: "https://shopee.com.br/x-i.111.222" };
    const b = { link: "https://shopee.com.br/x-i.111.333" };
    const c = { link: "https://shopee.com.br/x-i.999.222" };
    expect(productKey(a)).not.toBe(productKey(b));
    expect(productKey(a)).not.toBe(productKey(c));
  });

  it("difere entre URLs distintas", () => {
    const a = { link: "https://www.amazon.com.br/dp/B000000001" };
    const b = { link: "https://www.amazon.com.br/dp/B000000002" };
    expect(productKey(a)).not.toBe(productKey(b));
  });

  it("usa nome+store como fallback se nao houver link", () => {
    const a = { name: "Mouse Gamer", store: "Amazon" };
    const b = { name: "Mouse Gamer", store: "Amazon" };
    const c = { name: "Teclado Gamer", store: "Amazon" };
    expect(productKey(a)).toBe(productKey(b));
    expect(productKey(a)).not.toBe(productKey(c));
  });

  it("mlItemIdFromUrl le o numero do ML nos tres formatos", () => {
    expect(mlItemIdFromUrl("https://www.mercadolivre.com.br/x/p/MLB1040287986")).toBe("MLB1040287986");
    expect(mlItemIdFromUrl("https://produto.mercadolivre.com.br/MLB-1234567-algo-_JM")).toBe("MLB1234567");
    expect(mlItemIdFromUrl("https://www.amazon.com.br/dp/B000000001")).toBeNull();
    expect(mlItemIdFromUrl(null)).toBeNull();
  });

  it("mlUrlSpace separa catalogo de anuncio (numeros distintos podem coincidir)", () => {
    expect(mlUrlSpace("https://www.mercadolivre.com.br/x/p/MLB1234567")).toBe("catalogo");
    expect(mlUrlSpace("https://www.mercadolivre.com.br/x/up/MLBU3987817684")).toBe("catalogo");
    expect(mlUrlSpace("https://produto.mercadolivre.com.br/MLB-1234567-algo-_JM")).toBe("anuncio");
    expect(mlUrlSpace("https://www.mercadolivre.com.br/ofertas")).toBeNull();
  });

  it("e deterministico (hash hex 32 chars)", () => {
    const k = productKey({ link: "https://example.com/x" });
    expect(k).toMatch(/^[a-f0-9]{32}$/);
  });
});

// O nº do ANÚNCIO é o que junta o mesmo produto vindo da vitrine do cupom (nº de
// catálogo no caminho, anúncio no `wid`) e do scraping (anúncio no caminho). Os
// links abaixo são formas reais vistas no catálogo em 21/09/2026.
describe("mlAnuncioIdFromUrl", () => {
  it("/p/ da vitrine: o anúncio vem do wid (depois do #)", () => {
    expect(mlAnuncioIdFromUrl(
      "https://www.mercadolivre.com.br/10-galhos/p/MLB44567438?pdp_filters=seller_id%3A143398856#polycard_client=search-desktop&type=product&wid=MLB5212859628&sid=search",
    )).toBe("MLB5212859628");
  });

  it("/up/ com wid e com pdp_filters=item_id", () => {
    expect(mlAnuncioIdFromUrl("https://www.mercadolivre.com.br/x/up/MLBU3773562568?pdp_filters=deal%3AMLB1772605-1#a=1&wid=MLB4456745231"))
      .toBe("MLB4456745231");
    expect(mlAnuncioIdFromUrl("https://www.mercadolivre.com.br/x/up/MLBU1?pdp_filters=item_id%3AMLB7330057970"))
      .toBe("MLB7330057970");
  });

  it("URL de anúncio do scraping, com e sem slug", () => {
    expect(mlAnuncioIdFromUrl("https://produto.mercadolivre.com.br/MLB-5212859628")).toBe("MLB5212859628");
    expect(mlAnuncioIdFromUrl("https://produto.mercadolivre.com.br/MLB-5054604344-chinelo-melissa-_JM")).toBe("MLB5054604344");
  });

  it("vitrine e scraping do mesmo produto dão o mesmo anúncio (e chaves diferentes)", () => {
    const vitrine = "https://www.mercadolivre.com.br/x/p/MLB44567438#wid=MLB5212859628";
    const scraping = "https://produto.mercadolivre.com.br/MLB-5212859628";
    expect(mlAnuncioIdFromUrl(vitrine)).toBe(mlAnuncioIdFromUrl(scraping));
    expect(productKey({ link: vitrine })).not.toBe(productKey({ link: scraping }));
  });

  it("/p/ e /up/ sem pista na query não têm anúncio — o número ali é de catálogo", () => {
    expect(mlAnuncioIdFromUrl("https://www.mercadolivre.com.br/x/p/MLB43949832")).toBe(null);
    expect(mlAnuncioIdFromUrl("https://www.mercadolivre.com.br/x/up/MLBU4120669935")).toBe(null);
    expect(mlAnuncioIdFromUrl("https://www.mercadolivre.com.br/x/p/MLB123?pdp_filters=deal%3AMLB1772605-1")).toBe(null);
  });

  it("outra loja ou lixo → null", () => {
    expect(mlAnuncioIdFromUrl("https://www.amazon.com.br/dp/B0ABCDEFGH?wid=MLB5212859628")).toBe(null);
    expect(mlAnuncioIdFromUrl("nao-e-url")).toBe(null);
    expect(mlAnuncioIdFromUrl(null)).toBe(null);
  });
});
