// Fluxo do scrapeShopee com a API e o enriquecimento de reviews MOCKADOS (sem rede).
// Cobre: paginação, aplicação dos filtros, repasse do listType, mapeamento pro
// formato Nimbus e enriquecimento de reviewsCount.
//
// Como o scraper faz `require("./affiliate")` lazy, o módulo é o mesmo singleton
// do cache CJS — então vi.spyOn(affiliate, "fetchShopeeOffers") intercepta a
// chamada de dentro do scrapeShopee. O fetchShopeeReviewCount interno usa o
// `fetch` global, que mockamos diretamente.

import "../helpers/env.js";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const scraper = require(path.resolve(__dirname, "..", "..", "backend", "scraping", "scraper.js"));
const affiliate = require(path.resolve(__dirname, "..", "..", "backend", "scraping", "affiliate.js"));

const realFetch = globalThis.fetch;

// Node CRU como a API productOfferV2 devolve (antes do shopeeNodeToProduct).
const apiNode = (over = {}) => ({
  itemId: 1,
  shopId: 2,
  productName: "Produto Teste",
  productLink: "https://shopee.com.br/produto-i.2.1",
  offerLink: "https://s.shopee.com.br/abc",
  imageUrl: "https://cf.shopee.com.br/file/xyz",
  price: 99.9,
  priceDiscountRate: 40,
  sales: 1000,
  commissionRate: 0.08,
  ratingStar: 4.7,
  ...over,
});

let offersSpy;

beforeEach(() => {
  // app_config já foi truncado pelo setup-each (beforeEach global roda antes).
  offersSpy = vi.spyOn(affiliate, "fetchShopeeOffers");
  // Enriquecimento de reviews (fetchShopeeReviewCount) → cmt_count fixo, sem rede.
  globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ data: { cmt_count: 42 } }) }));
});

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = realFetch;
});

describe("scrapeShopee (fluxo, fetch mockado)", () => {
  it("pagina: junta nodes das páginas até hasNextPage:false", async () => {
    // "beleza" tem um único shopeeCatId → uma fonte, paginação simples.
    offersSpy
      .mockResolvedValueOnce({ nodes: [apiNode({ itemId: 1 }), apiNode({ itemId: 2 })], pageInfo: { hasNextPage: true } })
      .mockResolvedValueOnce({ nodes: [apiNode({ itemId: 3 })], pageInfo: { hasNextPage: false } });

    const items = await scraper.scrapeShopee({ category: "beleza", limit: 10 });

    expect(items).toHaveLength(3);
    expect(offersSpy).toHaveBeenCalledTimes(2);
  });

  it("eletronicos: distribui a busca entre os vários shopeeCatIds (categoria ampla)", async () => {
    // 4 catIds (celulares, computador, áudio, eletrodomésticos). Cada fonte
    // devolve 1 node único → uma chamada por catId, sem keyword.
    let id = 0;
    offersSpy.mockImplementation(async ({ productCatId }) => ({
      nodes: [apiNode({ itemId: ++id, shopId: id })],
      pageInfo: { hasNextPage: false },
    }));

    const items = await scraper.scrapeShopee({ category: "eletronicos", limit: 12 });

    const cats = offersSpy.mock.calls.map(c => c[0].productCatId);
    expect(cats).toEqual([100013, 100644, 100535, 100010]);
    expect(offersSpy).toHaveBeenCalledWith(expect.objectContaining({ productCatId: 100013 }));
    offersSpy.mock.calls.forEach(c => expect(c[0].keyword).toBeUndefined());
    expect(items).toHaveLength(4);
  });

  it("aplica minDiscount: descarta nodes sem promoção", async () => {
    await affiliate.writeShopeeScraperFilters({ minDiscount: 10 });
    offersSpy.mockResolvedValue({
      nodes: [apiNode({ itemId: 1, priceDiscountRate: 40 }), apiNode({ itemId: 2, priceDiscountRate: 0 })],
      pageInfo: { hasNextPage: false },
    });

    const items = await scraper.scrapeShopee({ category: "eletronicos", limit: 10 });

    expect(items).toHaveLength(1);
    expect(items[0].discount).toBe(40);
  });

  it("repassa o listType/sortType salvos nos filtros e busca por productCatId", async () => {
    await affiliate.writeShopeeScraperFilters({ listType: 2, sortType: 1 });
    offersSpy.mockResolvedValue({ nodes: [apiNode()], pageInfo: { hasNextPage: false } });

    await scraper.scrapeShopee({ category: "beleza", limit: 5 });

    // "beleza" → shopeeCatIds [100630] (CATEGORIES no scraper.js), sem keyword.
    expect(offersSpy).toHaveBeenCalledWith(expect.objectContaining({ listType: 2, sortType: 1, productCatId: 100630 }));
  });

  it("mapeia pro formato Nimbus e enriquece reviewsCount, removendo campos temporários", async () => {
    offersSpy.mockResolvedValue({ nodes: [apiNode({ itemId: 7, shopId: 9 })], pageInfo: { hasNextPage: false } });

    const items = await scraper.scrapeShopee({ category: "gamer", limit: 5 });

    expect(items).toHaveLength(1);
    const p = items[0];
    expect(p.store).toBe("Shopee");
    expect(p.category).toBe("gamer");
    expect(p.price).toBe(99.9);
    expect(p.discount).toBe(40);
    expect(p.link).toBe("https://shopee.com.br/produto-i.2.1"); // productLink, não o offerLink do sistema
    expect(p.reviewsCount).toBe(42);                    // veio do mock de fetch
    expect(p).not.toHaveProperty("_shopeeItemId");
    expect(p).not.toHaveProperty("_shopeeShopId");
  });
});
