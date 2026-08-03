// Teste avulso de UM link no ScrapTester (testLink).
// O scraper e a medição de imagem são trocados por fakes via require.cache —
// nada de navegador nem de rede aqui.

import "../helpers/env.js";
import { describe, it, expect, beforeEach } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const backend = path.resolve(__dirname, "..", "..", "backend");

// ── fakes ──────────────────────────────────────────────────────────────────
const calls = { single: [], image: [] };
let nextProduct = null;
let nextImage = null;

const scraperPath = require.resolve(path.join(backend, "scraping", "scraper.js"));
require.cache[scraperPath] = {
  id: scraperPath, filename: scraperPath, loaded: true,
  exports: {
    scrapeOfertas: async () => [],
    scrapeSingleProduct: async (url, opts) => { calls.single.push([url, opts]); return nextProduct; },
    normalizeSource: (s) => {
      const k = String(s || "").toLowerCase().replace(/\s+/g, "");
      if (k === "ml" || k === "mercadolivre") return "ml";
      if (k === "amazon") return "amazon";
      if (k === "shopee") return "shopee";
      return null;
    },
    CATEGORIES: { eletronicos: { label: "Eletrônicos" } },
    STORES: {
      ml: { id: "ml", label: "Mercado Livre" },
      amazon: { id: "amazon", label: "Amazon" },
      shopee: { id: "shopee", label: "Shopee" },
    },
  },
};

const imgPath = require.resolve(path.join(backend, "scraping", "image-quality.js"));
require.cache[imgPath] = {
  id: imgPath, filename: imgPath, loaded: true,
  exports: {
    inspectImages: async (urls) => urls.map(() => nextImage),
    inspectImage: async (url) => { calls.image.push(url); return nextImage; },
  },
};

const tester = require(path.join(backend, "scraping", "tester.js"));

const produto = (over = {}) => ({
  name: "Fone Bluetooth",
  link: "https://produto.mercadolivre.com.br/MLB-123",
  finalUrl: "https://produto.mercadolivre.com.br/MLB-123",
  img: "https://http2.mlstatic.com/foto-F.jpg",
  price: 99.9,
  originalPrice: 199.9,
  discount: 50,
  rating: 4.6,
  reviewsCount: "1.2mil",
  sold: "+500 vendidos",
  store: "Mercado Livre",
  ...over,
});

const fotoBoa = { ok: true, width: 1200, height: 1200, bytes: 90000, error: null };

beforeEach(() => {
  calls.single = [];
  calls.image = [];
  nextProduct = produto();
  nextImage = fotoBoa;
});

describe("testLink", () => {
  it("recusa link vazio sem abrir o scraper", async () => {
    await expect(tester.testLink("   ")).rejects.toThrow(/link/i);
    expect(calls.single).toHaveLength(0);
  });

  it("produto completo com foto grande passa em tudo", async () => {
    const r = await tester.testLink("  https://produto.mercadolivre.com.br/MLB-123  ", { userId: 7 });
    expect(calls.single[0]).toEqual(["https://produto.mercadolivre.com.br/MLB-123", { userId: 7 }]);
    expect(r.status).toBe("ok");
    expect(r.missing).toEqual([]);
    expect(r.source).toBe("ml");
    expect(r.sourceLabel).toBe("Mercado Livre");
    expect(r.image).toEqual(fotoBoa);
  });

  it("foto pequena vira alerta, não falha grave", async () => {
    nextImage = { ok: true, width: 90, height: 90, bytes: 1200, error: null };
    const r = await tester.testLink("https://x/produto");
    expect(r.missing).toEqual(["imgQuality"]);
    expect(r.status).toBe("warn");
    const foto = r.checks.find(c => c.key === "imgQuality");
    expect(foto.value).toBe("90×90px");
    expect(foto.ok).toBe(false);
  });

  it("foto que não abre entra com o motivo do erro", async () => {
    nextImage = { ok: false, width: null, height: null, bytes: null, error: "HTTP 404" };
    const r = await tester.testLink("https://x/produto");
    expect(r.checks.find(c => c.key === "imgQuality").value).toBe("HTTP 404");
  });

  it("campo essencial faltando é falha grave", async () => {
    nextProduct = produto({ price: null });
    const r = await tester.testLink("https://x/produto");
    expect(r.missing).toContain("price");
    expect(r.status).toBe("fail");
    expect(r.checks.find(c => c.key === "price").critical).toBe(true);
  });

  it("não cobra vendedor, frete nem comissão (a página do produto não traz)", async () => {
    const r = await tester.testLink("https://x/produto");
    const keys = r.checks.map(c => c.key);
    expect(keys).not.toContain("seller");
    expect(keys).not.toContain("freeShipping");
    expect(keys).not.toContain("commission");
  });

  it("usa os campos da loja detectada (Shopee não tem nº de avaliações)", async () => {
    nextProduct = produto({ store: "Shopee", reviewsCount: null });
    const r = await tester.testLink("https://s.shopee.com.br/abc");
    expect(r.source).toBe("shopee");
    expect(r.checks.map(c => c.key)).not.toContain("reviewsCount");
    expect(r.status).toBe("ok");
  });
});

describe("sourceIdForStore", () => {
  it("traduz o nome da loja pro id da fonte", () => {
    expect(tester.sourceIdForStore("Mercado Livre")).toBe("ml");
    expect(tester.sourceIdForStore("Amazon")).toBe("amazon");
    expect(tester.sourceIdForStore("Shopee")).toBe("shopee");
    expect(tester.sourceIdForStore(null)).toBe("ml");   // fallback
  });
});
