// Repasse Shopee — preço escrito na legenda do grupo líder. A API da Shopee só
// dá o preço de vitrine; o preço com Pix + cupom vem do texto ("R$ 1.520 no Pix").
// extractPrice acha o valor, textPriceFor decide se ele troca o da API.

import "../helpers/env.js";
import { describe, it, expect } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const capture = require(path.resolve(__dirname, "..", "..", "backend", "repasse", "capture.js"));
const priceWords = require(path.resolve(__dirname, "..", "..", "backend", "repasse", "price-words.js"));
const cfg = priceWords.DEFAULTS;
const ext = t => capture.extractPrice(t, cfg);

describe("extractPrice", () => {
  it("o caso do combo Pokémon: vale o menor (Pix + cupom)", () => {
    const t = "🔥 OFERTA!\n📦 Combo Pokémon\n✅ Por: R$ 1.739,90\n💰 R$ 1.520 no Pix com cupom\nhttps://s.shopee.com.br/2gCSVqswQV";
    expect(capture.extractPriceCandidates(t, cfg)).toEqual([1739.9, 1520]);
    expect(ext(t)).toBe(1520);
  });

  it("formatos brasileiros de valor", () => {
    expect(ext("R$1.520,90")).toBe(1520.9);
    expect(ext("R$ 99,90")).toBe(99.9);
    expect(ext("por 1520")).toBe(1520);
    expect(ext("Por *R$ 1.520*")).toBe(1520);
    expect(ext("Só R$ 89,90")).toBe(89.9);
    expect(ext("De R$ 1.999 Por R$ 1.739")).toBe(1739);
    expect(ext("Com cupom: R$ 1.520")).toBe(1520);
    expect(ext("50% OFF por R$ 99,90")).toBe(99.9);
  });

  it("descarta o que não é preço", () => {
    expect(ext("12x de R$ 145 sem juros")).toBeNull();
    expect(ext("10x R$ 99")).toBeNull();
    expect(ext("cupom de R$ 20 OFF")).toBeNull();
    expect(ext("R$ 20 de desconto")).toBeNull();
    expect(ext("desconto de R$ 50")).toBeNull();
    expect(ext("Frete R$ 15")).toBeNull();
    expect(ext("Economize R$ 200")).toBeNull();
    expect(ext("compor 300")).toBeNull();
  });

  it("número sem gatilho e números de link não contam", () => {
    expect(ext("Kit com 6 unidades https://shopee.com.br/x-i.454657733.58270097180")).toBeNull();
    expect(ext("https://shopee.com.br/product/454657733/58270097180?por=1520")).toBeNull();
    expect(ext("")).toBeNull();
    expect(ext(null)).toBeNull();
  });

  it("palavra de outra linha não interfere", () => {
    expect(ext("Frete grátis\nR$ 1.520")).toBe(1520);
  });

  it("gatilho novo do admin passa a valer", () => {
    expect(capture.extractPrice("valor 1520", cfg)).toBeNull();
    expect(capture.extractPrice("valor 1520", { ...cfg, triggers: [...cfg.triggers, "valor"] })).toBe(1520);
  });
});

describe("textPriceFor", () => {
  const shopee = { store: "Shopee", price: 1739.9, originalPrice: null };

  it("troca pelo menor e o da API vira o De", () => {
    expect(capture.textPriceFor(shopee, 1520, cfg)).toEqual({ price: 1520, originalPrice: 1739.9, discount: 13 });
  });

  it("De fica com o maior entre API e originalPrice antigo", () => {
    const r = capture.textPriceFor({ ...shopee, originalPrice: 2000 }, 1520, cfg);
    expect(r).toEqual({ price: 1520, originalPrice: 2000, discount: 24 });
  });

  it("não troca: maior/igual à API, abaixo do mínimo, outra loja, sem preço", () => {
    expect(capture.textPriceFor(shopee, 1800, cfg)).toBeNull();
    expect(capture.textPriceFor(shopee, 1739.9, cfg)).toBeNull();
    expect(capture.textPriceFor(shopee, 800, cfg)).toBeNull();
    expect(capture.textPriceFor({ ...shopee, store: "Mercado Livre" }, 1520, cfg)).toBeNull();
    expect(capture.textPriceFor({ ...shopee, price: null }, 1520, cfg)).toBeNull();
  });

  it("minPct do admin muda o limite", () => {
    expect(capture.textPriceFor(shopee, 800, { ...cfg, minPct: 40 })).not.toBeNull();
  });
});

describe("price-words sanitize", () => {
  it("lista vazia cai no padrão; minPct fica entre 1 e 99", () => {
    expect(priceWords.sanitize({ triggers: [] }).triggers).toEqual(priceWords.DEFAULTS.triggers);
    expect(priceWords.sanitize({ minPct: 0 }).minPct).toBe(1);
    expect(priceWords.sanitize({ minPct: 150 }).minPct).toBe(99);
    expect(priceWords.sanitize({ minPct: "x" }).minPct).toBe(50);
  });

  it("minúsculas, sem repetida, acento não importa no gatilho", () => {
    expect(priceWords.sanitize({ triggers: ["POR", "por", " Pix "] }).triggers).toEqual(["por", "pix"]);
    expect(capture.extractPrice("Só 89,90", { ...cfg, triggers: ["so"] })).toBe(89.9);
  });

  it("caractere de regex digitado pelo admin não quebra", () => {
    expect(() => capture.extractPrice("c+ 10", { ...cfg, triggers: ["c+"] })).not.toThrow();
  });
});
