// Leitura de nota/vendas dos cards de ofertas — layout novo do ML (bloco compacto)
// e da Amazon (prova social). Textos capturados das páginas reais. Funções puras.

import "../helpers/env.js";
import { describe, it, expect } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const scraper = require(path.resolve(__dirname, "..", "..", "backend", "scraping", "scraper.js"));

const { parseMLReviewCompacted, parseAmazonSold, applyFilters } = scraper;

describe("parseMLReviewCompacted", () => {
  // Textos reais do card de Eletrônicos (julho/2026).
  const ALT = "Classificação 4.9 de 5 estrelas. Mais de 10mil produtos vendidos.";
  const VIS = "4.9 | +10mil vendidos";

  it("lê nota e vendas do texto de acessibilidade", () => {
    expect(parseMLReviewCompacted(ALT, VIS)).toEqual({ rating: 4.9, sold: "+10mil vendidos" });
  });

  it("cai pro texto visível quando o span de acessibilidade não existe", () => {
    expect(parseMLReviewCompacted(null, VIS)).toEqual({ rating: 4.9, sold: "+10mil vendidos" });
  });

  it("aceita nota com vírgula", () => {
    expect(parseMLReviewCompacted("Classificação 4,7 de 5 estrelas.", null).rating).toBe(4.7);
  });

  it("sem 'mais de', não põe o + na frente", () => {
    const r = parseMLReviewCompacted("Classificação 4.5 de 5 estrelas. 250 produtos vendidos.", null);
    expect(r).toEqual({ rating: 4.5, sold: "250 vendidos" });
  });

  it("card sem avaliação nenhuma devolve tudo nulo", () => {
    expect(parseMLReviewCompacted(null, null)).toEqual({ rating: null, sold: null });
    expect(parseMLReviewCompacted("", "")).toEqual({ rating: null, sold: null });
  });

  it("card só com vendas (sem nota) não inventa nota", () => {
    expect(parseMLReviewCompacted(null, "+500 vendidos")).toEqual({ rating: null, sold: "+500 vendidos" });
  });

  it("descarta nota fora da faixa 0-5 (texto colhido errado)", () => {
    expect(parseMLReviewCompacted(null, "1234 | +10 vendidos").rating).toBeNull();
  });

  it("o formato de vendas continua legível pelos filtros existentes", () => {
    const { sold } = parseMLReviewCompacted(ALT, VIS);
    const produtos = [{ sold, price: 10, discount: 5 }];
    expect(applyFilters(produtos, { minSales: 5000 })).toHaveLength(1);   // 10mil >= 5000
    expect(applyFilters(produtos, { minSales: 50000 })).toHaveLength(0);
  });
});

describe("parseAmazonSold", () => {
  it("converte a prova social pro formato de vendas do ML", () => {
    expect(parseAmazonSold("Mais de 2 mil compras no mês passado")).toBe("+2 mil vendidos");
    expect(parseAmazonSold("500+ compras no mês passado")).toBe("+500 vendidos");
    expect(parseAmazonSold("50 compras no mês passado")).toBe("50 vendidos");
  });

  it("ignora texto que fala de compra mas não traz número de compras", () => {
    expect(parseAmazonSold("Frete GRÁTIS na sua primeira compra")).toBeNull();
    expect(parseAmazonSold("Adicionar ao carrinho")).toBeNull();
  });

  it("devolve nulo pra vazio ou texto sem número", () => {
    expect(parseAmazonSold(null)).toBeNull();
    expect(parseAmazonSold("")).toBeNull();
    expect(parseAmazonSold("compras no mês passado")).toBeNull();
  });

  it("o resultado é legível pelos filtros existentes", () => {
    const produtos = [{ sold: parseAmazonSold("Mais de 2 mil compras no mês passado"), price: 10 }];
    expect(applyFilters(produtos, { minSales: 1500 })).toHaveLength(1);
    expect(applyFilters(produtos, { minSales: 5000 })).toHaveLength(0);
  });
});
