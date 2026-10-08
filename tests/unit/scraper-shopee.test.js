// Mapeamento de nodes da Shopee API → formato Nimbus.
// Função pura, sem rede.

import "../helpers/env.js";
import { describe, it, expect } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const scraper = require(path.resolve(__dirname, "..", "..", "backend", "scraping", "scraper.js"));

describe("shopeeNodeToProduct", () => {
  it("mapeia campos básicos pro formato Nimbus", () => {
    const node = {
      itemId: 7890123,
      shopId: 123456,
      productName: "Smartphone Galaxy",
      productLink: "https://shopee.com.br/smartphone-i.123456.7890123",
      offerLink: "https://s.shopee.com.br/abc",
      imageUrl: "https://cf.shopee.com.br/file/xyz",
      price: 999.90,
      priceDiscountRate: 30,
      sales: 1234,
      commissionRate: 5,
      ratingStar: 4.5,
    };
    const p = scraper.shopeeNodeToProduct(node, "eletronicos");
    expect(p.name).toBe("Smartphone Galaxy");
    // Prefere o productLink: o offerLink é o link de afiliado da conta do
    // SISTEMA, e o link do usuário é gerado em cima do que fica no catálogo
    expect(p.link).toBe("https://shopee.com.br/smartphone-i.123456.7890123");
    expect(p.img).toBe("https://cf.shopee.com.br/file/xyz");
    expect(p.store).toBe("Shopee");
    expect(p.category).toBe("eletronicos");
    expect(p.price).toBe(999.9);
    expect(p.discount).toBe(30);
    expect(p.rating).toBe(4.5);
    expect(p.soldCount).toBe(1234);
    expect(p.commissionRate).toBe(5);
  });

  it("usa shopName como vendedor (campo novo da query GraphQL)", () => {
    const base = { productName: "x", productLink: "/x", price: 50 };
    expect(scraper.shopeeNodeToProduct({ ...base, shopName: "Loja Oficial XPTO" }).seller).toBe("Loja Oficial XPTO");
    expect(scraper.shopeeNodeToProduct({ ...base, shopName: "  " }).seller).toBeNull();
    expect(scraper.shopeeNodeToProduct(base).seller).toBeNull();
  });

  it("calcula originalPrice a partir do desconto", () => {
    const p = scraper.shopeeNodeToProduct({
      productName: "x", productLink: "https://shopee.com.br/x", price: 70, priceDiscountRate: 30,
    });
    // 70 / (1 - 0.30) = 100
    expect(p.originalPrice).toBe(100);
  });

  it("originalPrice = null quando desconto é 0 ou 100", () => {
    const p1 = scraper.shopeeNodeToProduct({ productName: "x", productLink: "/x", price: 50, priceDiscountRate: 0 });
    const p2 = scraper.shopeeNodeToProduct({ productName: "x", productLink: "/x", price: 50, priceDiscountRate: 100 });
    expect(p1.originalPrice).toBeNull();
    expect(p2.originalPrice).toBeNull();
  });

  it("normaliza preço em centavos (inteiro >= 1000) pra decimal", () => {
    // Shopee às vezes manda 1990 (centavos) em vez de 19.90
    const p = scraper.shopeeNodeToProduct({ productName: "x", productLink: "/x", price: 1990 });
    expect(p.price).toBe(19.9);
  });

  it("aceita preço já em decimal", () => {
    const p = scraper.shopeeNodeToProduct({ productName: "x", productLink: "/x", price: 19.9 });
    expect(p.price).toBe(19.9);
  });

  it("price null quando vier inválido", () => {
    expect(scraper.shopeeNodeToProduct({ productName: "x", productLink: "/x", price: null }).price).toBeNull();
    expect(scraper.shopeeNodeToProduct({ productName: "x", productLink: "/x", price: 0 }).price).toBeNull();
    expect(scraper.shopeeNodeToProduct({ productName: "x", productLink: "/x", price: "lixo" }).price).toBeNull();
  });

  it("usa priceMin como fallback se price ausente", () => {
    const p = scraper.shopeeNodeToProduct({ productName: "x", productLink: "/x", priceMin: 49.9 });
    expect(p.price).toBe(49.9);
  });

  it("usa offerLink quando productLink não veio", () => {
    const p = scraper.shopeeNodeToProduct({
      productName: "x", offerLink: "https://s.shopee.com.br/abc",
    });
    expect(p.link).toBe("https://s.shopee.com.br/abc");
  });
});

// O repasse depende disso: sem os IDs, o caminho pela Affiliate API é pulado e
// sobra o navegador — que na PDP da Shopee não enxerga preço.
describe("extractShopeeIds", () => {
  it("lê o formato antigo -i.<shopId>.<itemId>", () => {
    expect(scraper.extractShopeeIds("https://shopee.com.br/calca-wide-i.306423459.20046202534"))
      .toEqual({ shopId: "306423459", itemId: "20046202534" });
  });

  it("lê o destino do link curto (/opaanlp/<shopId>/<itemId>), com query atrás", () => {
    expect(scraper.extractShopeeIds("https://shopee.com.br/opaanlp/306423459/20046202534?__mobile__=1&utm_source=x"))
      .toEqual({ shopId: "306423459", itemId: "20046202534" });
  });

  it("lê o permalink /product/<shopId>/<itemId> que a própria API devolve", () => {
    expect(scraper.extractShopeeIds("https://shopee.com.br/product/306423459/20046202534"))
      .toEqual({ shopId: "306423459", itemId: "20046202534" });
  });

  it("ignora barra sobrando no fim", () => {
    expect(scraper.extractShopeeIds("https://shopee.com.br/product/306423459/20046202534/"))
      .toEqual({ shopId: "306423459", itemId: "20046202534" });
  });

  it("null quando não é página de produto", () => {
    expect(scraper.extractShopeeIds("https://shopee.com.br/search?keyword=fone")).toBeNull();
    expect(scraper.extractShopeeIds("https://shopee.com.br/mall/12/34")).toBeNull(); // números curtos demais
    expect(scraper.extractShopeeIds("não é url")).toBeNull();
  });
});
