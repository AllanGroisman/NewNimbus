// Extracao de ASIN da URL Amazon — pura, sem IO. Cobre os formatos mais comuns.

import "../helpers/env.js";
import { describe, it, expect } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const affiliate = require(path.resolve(__dirname, "..", "..", "backend", "affiliate.js"));

describe("extractASIN", () => {
  it("formato /dp/ASIN", () => {
    expect(affiliate.extractASIN("https://www.amazon.com.br/dp/B0CXXX1234")).toBe("B0CXXX1234");
  });

  it("formato /gp/product/ASIN", () => {
    expect(affiliate.extractASIN("https://www.amazon.com.br/gp/product/B0CXXX1234")).toBe("B0CXXX1234");
  });

  it("preserva ASIN mesmo com query string", () => {
    expect(affiliate.extractASIN("https://www.amazon.com.br/dp/B0CXXX1234?tag=ref&ref=foo")).toBe("B0CXXX1234");
  });

  it("URL invalida devolve null", () => {
    expect(affiliate.extractASIN("https://www.amazon.com.br/")).toBeNull();
    expect(affiliate.extractASIN("https://outraloja.com/dp/B0CXXX1234")).toBe("B0CXXX1234");
    expect(affiliate.extractASIN("")).toBeNull();
    expect(affiliate.extractASIN(null)).toBeNull();
  });

  it("normaliza pra maiusculas", () => {
    expect(affiliate.extractASIN("https://www.amazon.com.br/dp/b0cxxx1234")).toBe("B0CXXX1234");
  });
});

describe("gerarLinkAfiliadoAmazon", () => {
  it("retorna null quando nao ha tag configurada", () => {
    affiliate.clearAmazonConfig();
    const r = affiliate.gerarLinkAfiliadoAmazon("https://www.amazon.com.br/dp/B0CXXX1234");
    expect(r).toBeNull();
  });

  it("gera link com tag quando configurado", () => {
    affiliate.writeAmazonConfig({ tag: "minha-tag-20" });
    const r = affiliate.gerarLinkAfiliadoAmazon("https://www.amazon.com.br/dp/B0CXXX1234");
    expect(r).toBe("https://www.amazon.com.br/dp/B0CXXX1234?tag=minha-tag-20");
    affiliate.clearAmazonConfig();
  });

  it("rejeita tag invalida", () => {
    expect(() => affiliate.writeAmazonConfig({ tag: "tag com espaco" })).toThrow();
    expect(() => affiliate.writeAmazonConfig({ tag: "a" })).toThrow();
  });
});
