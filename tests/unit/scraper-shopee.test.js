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
    // Prefere offerLink (link de afiliado) sobre productLink
    expect(p.link).toBe("https://s.shopee.com.br/abc");
    expect(p.img).toBe("https://cf.shopee.com.br/file/xyz");
    expect(p.store).toBe("Shopee");
    expect(p.category).toBe("eletronicos");
    expect(p.price).toBe(999.9);
    expect(p.discount).toBe(30);
    expect(p.rating).toBe(4.5);
    expect(p.soldCount).toBe(1234);
    expect(p.commissionRate).toBe(5);
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

  it("usa productLink quando offerLink não veio", () => {
    const p = scraper.shopeeNodeToProduct({
      productName: "x", productLink: "https://shopee.com.br/x-i.1.2",
    });
    expect(p.link).toBe("https://shopee.com.br/x-i.1.2");
  });
});
