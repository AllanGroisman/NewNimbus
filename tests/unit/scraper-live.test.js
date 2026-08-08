// Smoke test REAL do scraper do Mercado Livre — abre o Chromium e bate na
// página de ofertas de verdade. É lento (~30-60s) e depende de rede, então
// fica PULADO por padrão. Para rodar:
//
//   RUN_LIVE_SCRAPE=1 npx vitest run unit/scraper-live.test.js
//
// Serve pra confirmar "o scraping está 100%": valida que vêm itens com
// nome/link/preço válidos e que os filtros default não derrubam tudo.

import "../helpers/env.js";
import { describe, it, expect } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const scraper = require(path.resolve(__dirname, "..", "..", "backend", "scraping", "scraper.js"));

const LIVE = process.env.RUN_LIVE_SCRAPE === "1";

describe("scrapeML (live)", () => {
  it.skipIf(!LIVE)("traz itens reais com nome, link e preço válidos", async () => {
    const items = await scraper.scrapeML({ category: "eletronicos", limit: 8 });
    expect(items.length).toBeGreaterThan(0);
    for (const p of items) {
      expect(typeof p.name).toBe("string");
      expect(p.name.length).toBeGreaterThan(0);
      expect(p.link).toMatch(/^https?:\/\//);
      expect(typeof p.price).toBe("number");
      expect(p.price).toBeGreaterThan(0);
      expect(p.store).toBe("Mercado Livre");
    }
  }, 90000);

  it.skipIf(!LIVE)("scrapeOfertas agrega ML sem derrubar tudo nos filtros default", async () => {
    const items = await scraper.scrapeOfertas({ category: "gamer", sources: ["ml"], limit: 8 });
    expect(items.length).toBeGreaterThan(0);
  }, 90000);
});

describe("scrapeAmazon (live — página de ofertas por departamento)", () => {
  it.skipIf(!LIVE)("traz ofertas com nome, link canônico /dp/ASIN e preço confirmado", async () => {
    const items = await scraper.scrapeAmazon({ category: "beleza", limit: 8 });
    expect(items.length).toBeGreaterThan(0);
    for (const p of items) {
      expect(typeof p.name).toBe("string");
      expect(p.name.length).toBeGreaterThan(0);
      // Link canônico: sem slug de nome, sem /ref= de campanha, sem tracking.
      expect(p.link).toMatch(/^https:\/\/www\.amazon\.com\.br\/dp\/[A-Z0-9]{10}$/);
      expect(typeof p.price).toBe("number");
      expect(p.price).toBeGreaterThan(0);
      expect(p.store).toBe("Amazon");
      // Task 68: nada entra no catálogo sem preço conferido na página do produto.
      expect(p.priceVerified).toBe(true);
    }
  }, 180000);

  // O teste que reproduz a reclamação da task 68: "abri o link do card e o preço
  // era outro". Compara o que o catálogo guardaria com o que a página do produto
  // mostra AGORA — se divergir, o bug voltou.
  it.skipIf(!LIVE)("o preço do catálogo bate com o da página do produto", async () => {
    const items = await scraper.scrapeAmazon({ category: "beleza", limit: 3 });
    expect(items.length).toBeGreaterThan(0);
    for (const p of items.slice(0, 3)) {
      const single = await scraper.scrapeSingleProduct(p.link);
      expect(single.price).not.toBeNull();
      expect(Math.abs(single.price - p.price)).toBeLessThan(0.01);
    }
  }, 300000);
});
