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

const { parseMLReviewCompacted, parseAmazonSold, parseRatingText, parseReviewsCount, reconcilePricing, normalizeSoldText, applyFilters } = scraper;

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

// Caminho do link colado / repasse: antes o texto virava número e a mensagem
// perdia o "+" ("+1.000 vendidos" → "1000 vendidos").
describe("normalizeSoldText", () => {
  it("preserva o + e o formato da loja", () => {
    expect(normalizeSoldText("+1.000 vendidos")).toBe("+1.000 vendidos");
    expect(normalizeSoldText("+ 500 vendidos")).toBe("+500 vendidos");
    expect(normalizeSoldText("+10mil vendidos")).toBe("+10mil vendidos");
  });

  it("sem 'mais de', não inventa o +", () => {
    expect(normalizeSoldText("2 mil vendidos")).toBe("2 mil vendidos");
    expect(normalizeSoldText("37 vendidos")).toBe("37 vendidos");
  });

  it("descarta o que vier grudado antes do trecho de vendas", () => {
    expect(normalizeSoldText("Novo | +5mil vendidos")).toBe("+5mil vendidos");
    expect(normalizeSoldText("  Novo   |   +5 mil vendidos  ")).toBe("+5 mil vendidos");
  });

  it("aceita número (compatibilidade com o formato antigo)", () => {
    expect(normalizeSoldText(1000)).toBe("1000 vendidos");
    expect(normalizeSoldText(0)).toBeNull();
  });

  it("devolve nulo pra vazio ou texto sem vendas", () => {
    expect(normalizeSoldText(null)).toBeNull();
    expect(normalizeSoldText("")).toBeNull();
    expect(normalizeSoldText("Frete grátis")).toBeNull();
  });

  it("o texto normalizado continua legível pelos filtros existentes", () => {
    const produtos = [{ sold: normalizeSoldText("+1.000 vendidos"), price: 10 }];
    expect(applyFilters(produtos, { minSales: 500 })).toHaveLength(1);
    expect(applyFilters(produtos, { minSales: 5000 })).toHaveLength(0);
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

describe("parseRatingText", () => {
  it("lê a nota nos formatos das três lojas", () => {
    expect(parseRatingText("4,8 de 5 estrelas")).toBe(4.8);           // Amazon
    expect(parseRatingText("Classificação 4.9 de 5 estrelas")).toBe(4.9); // ML
    expect(parseRatingText("4.6 out of 5 stars")).toBe(4.6);
    expect(parseRatingText("4.7")).toBe(4.7);
    expect(parseRatingText("5")).toBe(5);
  });

  it("descarta número que não pode ser nota", () => {
    expect(parseRatingText("1.234 avaliações")).toBeNull();
    expect(parseRatingText("0 de 5 estrelas")).toBeNull();
  });

  it("devolve nulo pra vazio ou texto sem número", () => {
    expect(parseRatingText(null)).toBeNull();
    expect(parseRatingText("")).toBeNull();
    expect(parseRatingText("sem avaliações")).toBeNull();
  });
});

describe("reconcilePricing", () => {
  it("produto sem promoção sai sem original e sem desconto", () => {
    expect(reconcilePricing({ price: 194.20, originalPrice: null, discount: null }))
      .toEqual({ price: 194.20, originalPrice: null, discount: null });
  });

  it("original brigando com o rótulo: o rótulo vence e o original é recalculado", () => {
    // Caso real: 194,20 com "19% OFF", mas o riscado (499,99) veio de outro produto.
    const r = reconcilePricing({ price: 194.20, originalPrice: 499.99, discount: 19 });
    expect(r.price).toBe(194.20);
    expect(r.discount).toBe(19);
    expect(r.originalPrice).toBeCloseTo(239.75, 2);
  });

  it("par coerente passa intacto", () => {
    expect(reconcilePricing({ price: 100, originalPrice: 200, discount: 50 }))
      .toEqual({ price: 100, originalPrice: 200, discount: 50 });
  });

  it("riscado absurdo (mais de 20x o preço) é descartado", () => {
    expect(reconcilePricing({ price: 10, originalPrice: 5000, discount: null }))
      .toEqual({ price: 10, originalPrice: null, discount: null });
  });

  it("só o riscado → calcula o desconto; só o rótulo → calcula o original", () => {
    expect(reconcilePricing({ price: 150, originalPrice: 200, discount: null }))
      .toEqual({ price: 150, originalPrice: 200, discount: 25 });
    const r = reconcilePricing({ price: 81, originalPrice: null, discount: 19 });
    expect(r.discount).toBe(19);
    expect(r.originalPrice).toBeCloseTo(100, 2);
  });

  it("desconto fora da faixa vira nulo e riscado quase igual ao preço não vira promoção", () => {
    expect(reconcilePricing({ price: 100, originalPrice: null, discount: 0 }).discount).toBeNull();
    expect(reconcilePricing({ price: 100, originalPrice: null, discount: 100 }).discount).toBeNull();
    expect(reconcilePricing({ price: 100, originalPrice: 100.4, discount: null }))
      .toEqual({ price: 100, originalPrice: null, discount: null });
  });

  it("sem preço não há promoção", () => {
    expect(reconcilePricing({ price: null, originalPrice: 200, discount: 30 }))
      .toEqual({ price: null, originalPrice: null, discount: null });
  });
});

describe("parseReviewsCount", () => {
  it("extrai só os dígitos da contagem", () => {
    expect(parseReviewsCount("1.234 avaliações")).toBe("1234");
    expect(parseReviewsCount("(89)")).toBe("89");
  });

  it("devolve nulo pra vazio ou texto sem número", () => {
    expect(parseReviewsCount(null)).toBeNull();
    expect(parseReviewsCount("  ")).toBeNull();
    expect(parseReviewsCount("sem avaliações")).toBeNull();
  });
});
