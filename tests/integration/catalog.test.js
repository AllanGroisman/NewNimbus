// Catalogo: upsert, query (filtros, sort), prune, /api/ofertas.

import { describe, it, expect, beforeAll } from "vitest";
import { request, app, createTestUser, catalog } from "../helpers/app.js";
import { mlProduct, amazonProduct } from "../helpers/fixtures.js";

describe("catalog.upsertProducts", () => {
  it("insere novos e atualiza existentes (lastSeenAt move)", async () => {
    const r1 = await catalog.upsertProducts([mlProduct(101), mlProduct(102)]);
    expect(r1.inserted + r1.updated).toBeGreaterThanOrEqual(2);

    const r2 = await catalog.upsertProducts([mlProduct(101, { price: 999 })]);
    expect(r2.updated).toBeGreaterThanOrEqual(1);

    const all = await catalog.listAll();
    const p = all.find(x => x.name === "Produto ML 101");
    expect(p).toBeDefined();
    expect(p.price).toBe(999);
  });

  it("indexa por productKey — dois produtos com MLB id igual sao o mesmo", async () => {
    await catalog.upsertProducts([
      { name: "ProdA", link: "https://www.mercadolivre.com.br/produto/p/MLB9999999", store: "Mercado Livre", category: "gamer", price: 100, discount: 50 },
      { name: "ProdA-mesma-MLB", link: "https://www.mercadolivre.com.br/produto/p/MLB9999999?utm=x", store: "Mercado Livre", category: "gamer", price: 200, discount: 50 },
    ]);
    const all = await catalog.listAll();
    const matching = all.filter(p => p.name && p.name.includes("ProdA"));
    expect(matching).toHaveLength(1);
  });
});

describe("catalog.query — filtros", () => {
  beforeAll(async () => {
    await catalog.upsertProducts([
      mlProduct(201, { discount: 10, price: 50, category: "gamer" }),
      mlProduct(202, { discount: 40, price: 200, category: "gamer" }),
      mlProduct(203, { discount: 70, price: 500, category: "casa" }),
      amazonProduct(204, { discount: 60, price: 150, category: "gamer" }),
    ]);
  });

  it("filtra por categoria", async () => {
    const items = await catalog.query({ categories: ["gamer"], limit: 100 });
    expect(items.every(p => (typeof p.category === "string" ? p.category : p.category?.id) === "gamer")).toBe(true);
  });

  it("filtra por minDiscount", async () => {
    const items = await catalog.query({ filters: { minDiscount: 50 }, limit: 100 });
    expect(items.every(p => p.discount >= 50)).toBe(true);
  });

  it("filtra por sources (so amazon)", async () => {
    const items = await catalog.query({ sources: ["amazon"], limit: 100 });
    expect(items.every(p => p.store === "Amazon")).toBe(true);
  });

  it("sort discount_desc ordena do maior pro menor", async () => {
    const items = await catalog.query({ limit: 100, sortBy: "discount_desc" });
    for (let i = 1; i < items.length; i++) {
      expect((items[i - 1].discount || 0) >= (items[i].discount || 0)).toBe(true);
    }
  });

  it("excludeKeys remove produtos especificos", async () => {
    const all = await catalog.query({ limit: 5 });
    if (all.length === 0) return;
    const excluded = await catalog.query({ excludeKeys: new Set([all[0].key]), limit: 100 });
    expect(excluded.find(p => p.key === all[0].key)).toBeUndefined();
  });
});

describe("GET /api/ofertas — endpoint HTTP", () => {
  it("retorna produtos do catalogo", async () => {
    await catalog.upsertProducts([mlProduct(301, { category: "eletronicos", discount: 30 })]);
    const { auth } = await createTestUser();
    const res = await auth("get", "/api/ofertas?category=eletronicos");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.products)).toBe(true);
    expect(res.body.total).toBeGreaterThan(0);
    expect(res.body.products.every(p => (typeof p.category === "string" ? p.category : p.category?.id) === "eletronicos")).toBe(true);
  });

  it("respeita minDiscount na query", async () => {
    const { auth } = await createTestUser();
    const res = await auth("get", "/api/ofertas?minDiscount=99");
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
  });

  it("sem token retorna 401", async () => {
    const res = await request(app).get("/api/ofertas");
    expect(res.status).toBe(401);
  });
});

describe("GET /api/categories", () => {
  it("devolve a lista de categorias estaticas", async () => {
    const res = await request(app).get("/api/categories");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const ids = res.body.map(c => c.id);
    expect(ids).toContain("gamer");
    expect(ids).toContain("eletronicos");
  });
});

describe("GET /api/status", () => {
  it("retorna status do catalogo (publico, sem auth)", async () => {
    const res = await request(app).get("/api/status");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.catalog).toBeDefined();
    expect(typeof res.body.catalog.total).toBe("number");
  });
});
