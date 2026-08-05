// Catalogo: upsert, query (filtros, sort), prune, /api/ofertas.

import { describe, it, expect, beforeAll } from "vitest";
import { request, app, createTestUser, catalog } from "../helpers/app.js";
import { mlProduct, amazonProduct, shopeeProduct } from "../helpers/fixtures.js";

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

  it("filtra por sources (so shopee) — devolve apenas Shopee, NÃO todos", async () => {
    // Regressão: storeToId não reconhecia 'shopee' → produtos com store=Shopee eram
    // salvos como _null, e o filtro de source no PG não tinha branch pra shopee →
    // o WHERE de store era pulado, retornando TODO o catálogo. Bug clássico de
    // "filtro silenciosamente ignorado".
    await catalog.upsertProducts([
      shopeeProduct(801, { category: "beleza", discount: 40 }),
      shopeeProduct(802, { category: "beleza", discount: 60 }),
    ]);
    const items = await catalog.query({ sources: ["shopee"], limit: 100 });
    expect(items.length).toBeGreaterThan(0);
    expect(items.every(p => p.store === "Shopee")).toBe(true);
  });

  it("source desconhecida devolve lista vazia (não 'todos os produtos')", async () => {
    // Outro caso do mesmo bug: se a source não normaliza pra nada conhecido,
    // o filtro tem que retornar vazio, não ignorar e devolver tudo.
    const items = await catalog.query({ sources: ["loja-inexistente"], limit: 100 });
    expect(items).toHaveLength(0);
  });

  it("sort discount_desc ordena do maior pro menor", async () => {
    const items = await catalog.query({ limit: 100, sortBy: "discount_desc" });
    for (let i = 1; i < items.length; i++) {
      expect((items[i - 1].discount || 0) >= (items[i].discount || 0)).toBe(true);
    }
  });

  it("produto sem desconto vai pro fim do discount_desc, não pro topo", async () => {
    // No Postgres, ORDER BY discount DESC joga NULL na frente: "maior desconto"
    // abria a lista com os produtos que não têm desconto nenhum.
    await catalog.upsertProducts([
      mlProduct(910, { category: "livros", discount: null, price: 50 }),
      mlProduct(911, { category: "livros", discount: 70, price: 50 }),
      mlProduct(912, { category: "livros", discount: 20, price: 50 }),
    ]);
    const items = await catalog.query({ categories: ["livros"], limit: 100, sortBy: "discount_desc" });
    expect(items.map(p => p.discount)).toEqual([70, 20, null]);
  });

  it("preço nulo também não fura a fila do price_desc", async () => {
    await catalog.upsertProducts([
      mlProduct(920, { category: "pet", price: null, discount: 10 }),
      mlProduct(921, { category: "pet", price: 300, discount: 10 }),
    ]);
    const items = await catalog.query({ categories: ["pet"], limit: 100, sortBy: "price_desc" });
    expect(items.map(p => p.price)).toEqual([300, null]);
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

// Modo paginado: é o que a aba "Busca de Produtos" da campanha usa pra mostrar
// a prévia — mesmos filtros e mesma ordem que o refill da fila.
describe("GET /api/ofertas — navegação paginada do catálogo", () => {
  // O catálogo é truncado entre os testes (helpers/setup-each.js), então cada
  // teste semeia o que precisa.
  const seed = () => catalog.upsertProducts([
    mlProduct(401, { category: "gamer", discount: 15, price: 90, name: "Teclado Nimbus 401" }),
    mlProduct(402, { category: "gamer", discount: 55, price: 250, name: "Mouse Nimbus 402" }),
    mlProduct(403, { category: "gamer", discount: 35, price: 700, name: "Monitor Nimbus 403" }),
  ]);

  it("pagina os resultados e devolve o total de matches (não o da página)", async () => {
    await seed();
    const { auth } = await createTestUser();
    const res = await auth("get", "/api/ofertas?categories=gamer&page=1&pageSize=2");
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeLessThanOrEqual(2);
    expect(res.body.page).toBe(1);
    expect(res.body.pageSize).toBe(2);
    expect(res.body.total).toBe(3);

    const p2 = await auth("get", "/api/ofertas?categories=gamer&page=2&pageSize=2");
    expect(p2.status).toBe(200);
    // Página 2 não repete nada da página 1
    const keys1 = res.body.items.map(p => p.key);
    expect(p2.body.items.every(p => !keys1.includes(p.key))).toBe(true);
  });

  it("q filtra pelo nome (vários termos = OR) e sortBy ordena", async () => {
    await seed();
    const { auth } = await createTestUser();
    const q = encodeURIComponent("Mouse Nimbus 402, Monitor Nimbus 403");
    const res = await auth("get", `/api/ofertas?q=${q}&page=1&pageSize=20&sortBy=price_asc`);
    expect(res.status).toBe(200);
    const names = res.body.items.map(p => p.name);
    expect(names).toContain("Mouse Nimbus 402");
    expect(names).toContain("Monitor Nimbus 403");
    expect(names).not.toContain("Teclado Nimbus 401");
    const prices = res.body.items.map(p => p.price ?? 0);
    for (let i = 1; i < prices.length; i++) expect(prices[i - 1] <= prices[i]).toBe(true);
  });

  it("sortBy inválido cai no padrão em vez de estourar", async () => {
    await seed();
    const { auth } = await createTestUser();
    const res = await auth("get", "/api/ofertas?page=1&pageSize=5&sortBy=drop-table");
    expect(res.status).toBe(200);
    expect(res.body.sortBy).toBe("discount_desc");
  });

  it("pageSize tem teto (não dá pra pedir o catálogo inteiro numa página)", async () => {
    await seed();
    const { auth } = await createTestUser();
    const res = await auth("get", "/api/ofertas?page=1&pageSize=5000");
    expect(res.status).toBe(200);
    expect(res.body.pageSize).toBe(60);
    expect(res.body.items.length).toBeLessThanOrEqual(60);
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
