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
const { productKey } = require(path.resolve(__dirname, "..", "..", "backend", "catalog", "product-key.js"));

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

  it("cai pra origin+pathname quando nao ha MLB id", () => {
    const a = { link: "https://www.amazon.com.br/dp/B0CXXX12345" };
    const b = { link: "https://www.amazon.com.br/dp/B0CXXX12345?tag=foo&ref=bar" };
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

  it("e deterministico (hash hex 32 chars)", () => {
    const k = productKey({ link: "https://example.com/x" });
    expect(k).toMatch(/^[a-f0-9]{32}$/);
  });
});
