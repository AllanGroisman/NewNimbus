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
  it.skipIf(!LIVE)("traz ofertas do departamento com nome, link /dp/ e preço", async () => {
    const items = await scraper.scrapeAmazon({ category: "beleza", limit: 8 });
    expect(items.length).toBeGreaterThan(0);
    for (const p of items) {
      expect(typeof p.name).toBe("string");
      expect(p.name.length).toBeGreaterThan(0);
      expect(p.link).toMatch(/amazon\.com\.br/);
      expect(typeof p.price).toBe("number");
      expect(p.price).toBeGreaterThan(0);
      expect(p.store).toBe("Amazon");
    }
  }, 120000);
});
