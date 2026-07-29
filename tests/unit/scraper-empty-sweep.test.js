// Detecção de varredura vazia / loja fora do ar.
//
// Contexto: scrapeOfertas engole o erro de cada loja e devolve [] — então uma
// loja quebrada (Chrome sumido, layout mudado, bloqueio) ficava indistinguível
// de "não tinha oferta hoje", e o admin gravava sucesso com 0 produtos. O param
// de saída `errors` existe pra quem monitora conseguir separar os dois casos.
//
// Sem rede: as lojas são stubadas em STORES.

import "../helpers/env.js";
import { describe, it, expect, afterEach } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const scraper = require(path.resolve(__dirname, "..", "..", "backend", "scraping", "scraper.js"));
const { summarizeDeadStores } = require(path.resolve(__dirname, "..", "..", "backend", "scraping", "admin.js"));

const { STORES, scrapeOfertas } = scraper;
const originalScrape = { ml: STORES.ml.scrape, shopee: STORES.shopee.scrape };

afterEach(() => {
  STORES.ml.scrape = originalScrape.ml;
  STORES.shopee.scrape = originalScrape.shopee;
});

const produto = (over = {}) => ({
  name: "Fone Bluetooth",
  link: "https://www.mercadolivre.com.br/x",
  price: 99.9,
  discount: 30,
  ...over,
});

describe("scrapeOfertas — saída `errors`", () => {
  it("coleta o erro da loja que falhou, em vez de devolver [] em silêncio", async () => {
    STORES.ml.scrape = async () => { throw new Error("Could not find Chrome (ver. 147.0.7727.57)"); };

    const errors = [];
    const out = await scrapeOfertas({ category: "eletronicos", sources: ["ml"], errors });

    expect(out).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0].source).toBe("ml");
    expect(errors[0].label).toBe("Mercado Livre");
    expect(errors[0].error).toMatch(/Could not find Chrome/);
  });

  it("não reporta erro quando a loja responde normalmente", async () => {
    STORES.ml.scrape = async () => [produto()];

    const errors = [];
    const out = await scrapeOfertas({ category: "eletronicos", sources: ["ml"], errors });

    expect(out).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  it("distingue loja quebrada de loja que só não tinha oferta", async () => {
    STORES.ml.scrape = async () => [];

    const errors = [];
    const out = await scrapeOfertas({ category: "eletronicos", sources: ["ml"], errors });

    // Zero produtos, mas SEM erro — é o caso legítimo de "não achou nada".
    expect(out).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("isola a loja que caiu sem derrubar a que funciona", async () => {
    STORES.ml.scrape = async () => { throw new Error("bloqueado"); };
    STORES.shopee.scrape = async () => [produto({ name: "Item Shopee" })];

    const errors = [];
    const out = await scrapeOfertas({ category: "eletronicos", sources: ["ml", "shopee"], errors });

    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("Item Shopee");
    expect(errors.map(e => e.source)).toEqual(["ml"]);
  });

  it("funciona sem o param (chamadores antigos não quebram)", async () => {
    STORES.ml.scrape = async () => { throw new Error("qualquer coisa"); };

    await expect(scrapeOfertas({ category: "eletronicos", sources: ["ml"] })).resolves.toEqual([]);
  });
});

describe("summarizeDeadStores — resumo da rodada", () => {
  const ok = (count = 10) => ({ ok: true, count, inserted: 1, updated: 2 });
  const falhou = (error = "nenhum produto retornado") => ({ ok: false, error });

  it("acusa a loja que falhou em TODAS as categorias", () => {
    const msg = summarizeDeadStores({
      "eletronicos-ml": falhou("Could not find Chrome"),
      "casa-ml": falhou("Could not find Chrome"),
      "eletronicos-shopee": ok(),
      "casa-shopee": ok(),
    });
    expect(msg).toMatch(/ml: Could not find Chrome/);
    expect(msg).not.toMatch(/shopee/);
  });

  it("fica quieto quando a loja falhou só em parte das categorias (oscilação)", () => {
    expect(summarizeDeadStores({
      "eletronicos-ml": falhou(),
      "casa-ml": ok(),
    })).toBeNull();
  });

  it("fica quieto quando está tudo certo", () => {
    expect(summarizeDeadStores({
      "eletronicos-ml": ok(),
      "casa-shopee": ok(),
    })).toBeNull();
  });

  it("acusa as duas quando as duas lojas caem", () => {
    const msg = summarizeDeadStores({
      "eletronicos-ml": falhou("bloqueado"),
      "eletronicos-shopee": falhou("timeout"),
    });
    expect(msg).toMatch(/ml: bloqueado/);
    expect(msg).toMatch(/shopee: timeout/);
  });

  it("trata rodada vazia sem quebrar", () => {
    expect(summarizeDeadStores({})).toBeNull();
    expect(summarizeDeadStores(null)).toBeNull();
  });
});
