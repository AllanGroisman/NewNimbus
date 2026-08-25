// Catalogo: upsert, query (filtros, sort), prune, /api/ofertas.

import { describe, it, expect, beforeAll } from "vitest";
import { request, app, createTestUser, catalog, storage, scheduler } from "../helpers/app.js";
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

describe("catalog.getByLink", () => {
  it("acha o produto pelo link colado, mesmo com query de tracking", async () => {
    await catalog.upsertProducts([
      { name: "Direto MLB5550001", link: "https://www.mercadolivre.com.br/x/p/MLB5550001", store: "Mercado Livre", category: "casa", price: 120, discount: 10 },
    ]);
    const p = await catalog.getByLink("https://www.mercadolivre.com.br/x/p/MLB5550001?matt_word=abc");
    expect(p).toBeTruthy();
    expect(p.name).toBe("Direto MLB5550001");
  });

  it("recusa linha velha: preço de dias atrás não vai pro grupo de um cliente", async () => {
    await catalog.upsertProducts([
      { name: "Velho MLB5550002", link: "https://www.mercadolivre.com.br/x/p/MLB5550002", store: "Mercado Livre", category: "casa", price: 10, discount: 10 },
    ]);
    expect(await catalog.getByLink("https://www.mercadolivre.com.br/x/p/MLB5550002", { maxAgeMs: 1 })).toBeNull();
    // Sem limite de idade a mesma linha continua servindo.
    expect(await catalog.getByLink("https://www.mercadolivre.com.br/x/p/MLB5550002", { maxAgeMs: null })).toBeTruthy();
  });

  it("número de anúncio ≠ número de catálogo: não entrega o produto errado", async () => {
    // A chave funde as duas numerações do ML. A linha gravada é /MLB-5550003-,
    // e quem pede é /p/MLB5550003 — mesmo número, produtos diferentes.
    await catalog.upsertProducts([
      { name: "Anúncio 5550003", link: "https://produto.mercadolivre.com.br/MLB-5550003-algo-_JM", store: "Mercado Livre", category: "casa", price: 30, discount: 10 },
    ]);
    expect(await catalog.getByLink("https://www.mercadolivre.com.br/x/p/MLB5550003")).toBeNull();
  });

  it("link que não está no catálogo devolve null", async () => {
    expect(await catalog.getByLink("https://www.mercadolivre.com.br/x/p/MLB9990009")).toBeNull();
    expect(await catalog.getByLink(null)).toBeNull();
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

// Os filtros de faixa (preço, nota, vendas) e as ordenações que faltavam:
// cada um com um produto que passa, um que não passa e um com o campo nulo —
// coluna opcional é onde o filtro costuma escorregar.
// O catálogo é truncado entre os testes (helpers/setup-each.js), então cada
// teste semeia o próprio cenário.
describe("catalog.query — preço, nota e vendas", () => {
  const seed = () => catalog.upsertProducts([
    mlProduct(601, { category: "casa", name: "Barato 601", price: 20, rating: 3.0, sold: "10 vendidos" }),
    mlProduct(602, { category: "casa", name: "Medio 602", price: 150, rating: 4.2, sold: "1,5 mil vendidos" }),
    mlProduct(603, { category: "casa", name: "Caro 603", price: 900, rating: 5.0, sold: "+2 mi vendidos" }),
    mlProduct(604, { category: "casa", name: "Sem dados 604", price: null, rating: null, sold: null }),
  ]);
  const names = (items) => items.map(p => p.name).sort();

  it("minPrice corta o que está abaixo (e o preço nulo)", async () => {
    await seed();
    const items = await catalog.query({ categories: ["casa"], filters: { minPrice: 100 }, limit: 100 });
    expect(names(items)).toEqual(["Caro 603", "Medio 602"]);
  });

  it("maxPrice corta o que está acima — e produto sem preço não passa", async () => {
    await seed();
    // O `not: null` do maxPrice existe pra isso: sem ele, "até R$ 200" traria
    // junto todo produto de preço desconhecido.
    const items = await catalog.query({ categories: ["casa"], filters: { maxPrice: 200 }, limit: 100 });
    expect(names(items)).toEqual(["Barato 601", "Medio 602"]);
  });

  it("minPrice + maxPrice viram faixa, e faixa invertida devolve vazio", async () => {
    await seed();
    const faixa = await catalog.query({ categories: ["casa"], filters: { minPrice: 100, maxPrice: 200 }, limit: 100 });
    expect(names(faixa)).toEqual(["Medio 602"]);

    const invertida = await catalog.query({ categories: ["casa"], filters: { minPrice: 500, maxPrice: 100 }, limit: 100 });
    expect(invertida).toHaveLength(0);
  });

  it("minRating corta nota menor e nota ausente", async () => {
    await seed();
    const items = await catalog.query({ categories: ["casa"], filters: { minRating: 4.2 }, limit: 100 });
    expect(names(items)).toEqual(["Caro 603", "Medio 602"]);
  });

  it("minSales entende o texto de vendas (mil, mi) e descarta quem não diz", async () => {
    await seed();
    const mil = await catalog.query({ categories: ["casa"], filters: { minSales: 1000 }, limit: 100 });
    expect(names(mil)).toEqual(["Caro 603", "Medio 602"]);

    const milhao = await catalog.query({ categories: ["casa"], filters: { minSales: 1000000 }, limit: 100 });
    expect(names(milhao)).toEqual(["Caro 603"]);
  });

  it("minSales usa o número exato da Shopee quando ele existe", async () => {
    // Shopee manda soldCount (número); ML só tem o texto. Os dois têm que cair
    // na mesma coluna, senão o filtro vale só pra metade do catálogo.
    await catalog.upsertProducts([
      shopeeProduct(611, { category: "pet", name: "Shopee 611", soldCount: 30 }),
      shopeeProduct(612, { category: "pet", name: "Shopee 612", soldCount: 4000 }),
    ]);
    const items = await catalog.query({ categories: ["pet"], filters: { minSales: 1000 }, limit: 100 });
    expect(names(items)).toEqual(["Shopee 612"]);
  });

  it("filtros combinados se somam (categoria + loja + desconto + palavra)", async () => {
    await catalog.upsertProducts([
      mlProduct(621, { category: "gamer", name: "Teclado gamer 621", discount: 60, price: 300 }),
      mlProduct(622, { category: "gamer", name: "Mouse gamer 622", discount: 60, price: 300 }),
      mlProduct(623, { category: "casa", name: "Teclado casa 623", discount: 60, price: 300 }),
      amazonProduct(624, { category: "gamer", name: "Teclado amazon 624", discount: 60, price: 300 }),
      mlProduct(625, { category: "gamer", name: "Teclado barato 625", discount: 10, price: 300 }),
    ]);
    const items = await catalog.query({
      categories: ["gamer"], sources: ["ml"],
      filters: { minDiscount: 50, keywords: "teclado" }, limit: 100,
    });
    expect(names(items)).toEqual(["Teclado gamer 621"]);
  });

  it("palavras-chave ignoram maiúsculas, espaços em volta e casam em OR", async () => {
    await catalog.upsertProducts([
      mlProduct(631, { category: "casa", name: "Cafeteira Expressa" }),
      mlProduct(632, { category: "casa", name: "Liquidificador Turbo" }),
      mlProduct(633, { category: "casa", name: "Ferro de passar" }),
    ]);
    const items = await catalog.query({
      categories: ["casa"], filters: { keywords: "  CAFETEIRA , liquidificador  " }, limit: 100,
    });
    expect(names(items)).toEqual(["Cafeteira Expressa", "Liquidificador Turbo"]);

    const nada = await catalog.query({ categories: ["casa"], filters: { keywords: "geladeira" }, limit: 100 });
    expect(nada).toHaveLength(0);
  });
});

describe("catalog.query — ordenações", () => {
  const seed = () => catalog.upsertProducts([
    mlProduct(701, { category: "casa", name: "A 701", price: 10, rating: 3.1, discount: 10 }),
    mlProduct(702, { category: "casa", name: "B 702", price: 90, rating: 4.9, discount: 80 }),
    mlProduct(703, { category: "casa", name: "C 703", price: null, rating: null, discount: null }),
  ]);

  it("price_asc vai do mais barato ao mais caro, com o preço nulo no fim", async () => {
    await seed();
    const items = await catalog.query({ categories: ["casa"], limit: 100, sortBy: "price_asc" });
    expect(items.map(p => p.price)).toEqual([10, 90, null]);
  });

  it("rating_desc vai da melhor nota pra pior, com a nota ausente no fim", async () => {
    await seed();
    const items = await catalog.query({ categories: ["casa"], limit: 100, sortBy: "rating_desc" });
    expect(items.map(p => p.rating)).toEqual([4.9, 3.1, null]);
  });

  it("lastSeen_desc traz o visto mais recentemente primeiro", async () => {
    // Upserts separados: o lastSeenAt é o momento da gravação.
    await catalog.upsertProducts([mlProduct(711, { category: "livros", name: "Antigo 711" })]);
    await new Promise(r => setTimeout(r, 20));
    await catalog.upsertProducts([mlProduct(712, { category: "livros", name: "Novo 712" })]);
    const items = await catalog.query({ categories: ["livros"], limit: 100, sortBy: "lastSeen_desc" });
    expect(items.map(p => p.name)).toEqual(["Novo 712", "Antigo 711"]);
  });

  it("empate na ordenação não repete nem some com produto entre as páginas", async () => {
    // Regressão: sem critério de desempate, o Postgres não promete a mesma ordem
    // em duas queries. Com o catálogo inteiro empatado em 50% de desconto (o
    // caso real de "Maior desconto"), a página 2 podia repetir uma linha da 1.
    const empatados = Array.from({ length: 30 }, (_, i) =>
      mlProduct(730 + i, { category: "esportes", name: `Empatado ${730 + i}`, discount: 50, price: 100 }));
    await catalog.upsertProducts(empatados);

    const vistos = [];
    for (let page = 0; page < 3; page++) {
      const items = await catalog.query({
        categories: ["esportes"], limit: 10, offset: page * 10, sortBy: "discount_desc",
      });
      expect(items).toHaveLength(10);
      vistos.push(...items.map(p => p.key));
    }
    expect(new Set(vistos).size).toBe(30);
    // E a ordem entre empatados é a da key: é o critério que torna as páginas
    // reproduzíveis, não uma coincidência do plano de execução.
    expect(vistos).toEqual([...vistos].sort());
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

  // A lista de ordenações existe em três lugares: SORT_OPTIONS (a aba),
  // OFERTAS_SORTS (a rota) e SORT_MODES (o preenchimento). Renomear um id em um
  // só faz a aba pedir "melhor avaliação" e receber "maior desconto" sem erro
  // nenhum — este teste é o que grita.
  it.each(["discount_desc", "price_asc", "price_desc", "rating_desc", "lastSeen_desc"])(
    "a ordem '%s' é aceita pela rota e pelo preenchimento",
    async (sortBy) => {
      await seed();
      const { auth } = await createTestUser();
      const res = await auth("get", `/api/ofertas?page=1&pageSize=5&sortBy=${sortBy}`);
      expect(res.status).toBe(200);
      expect(res.body.sortBy).toBe(sortBy);
      expect(scheduler.sortMode({ sortBy })).toBe(sortBy);
    },
  );

  it("sortBy inválido cai no padrão em vez de estourar", async () => {
    await seed();
    const { auth } = await createTestUser();
    const res = await auth("get", "/api/ofertas?page=1&pageSize=5&sortBy=drop-table");
    expect(res.status).toBe(200);
    expect(res.body.sortBy).toBe("discount_desc");
  });

  it("com minSales o total conta só quem passou, e a última página vem cheia", async () => {
    // Regressão: o corte de vendas rodava em JS depois da query, então o count()
    // do banco não o enxergava — o total contava o catálogo inteiro e as últimas
    // páginas vinham vazias. Agora o filtro está no WHERE (coluna soldCount).
    await catalog.upsertProducts([
      ...Array.from({ length: 5 }, (_, i) =>
        mlProduct(410 + i, { category: "brinquedos", name: `Vendido ${i}`, sold: "2mil vendidos" })),
      ...Array.from({ length: 20 }, (_, i) =>
        mlProduct(430 + i, { category: "brinquedos", name: `Parado ${i}`, sold: "3 vendidos" })),
    ]);
    const { auth } = await createTestUser();
    const res = await auth("get", "/api/ofertas?categories=brinquedos&minSales=1000&page=1&pageSize=3");
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(5);

    const ultima = await auth("get", "/api/ofertas?categories=brinquedos&minSales=1000&page=2&pageSize=3");
    expect(ultima.body.items).toHaveLength(2);
    expect(ultima.body.items.every(p => p.name.startsWith("Vendido"))).toBe(true);
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

// A aba "Busca de Produtos" manda o groupId pra lista já vir sem o que a
// campanha tem na fila / mandou há pouco — é o que faz cada página vir cheia,
// em vez de encolher depois de carregada no navegador.
describe("GET /api/ofertas — exclusão por campanha (groupId)", () => {
  const GID = 7001;
  const seed = () => catalog.upsertProducts([
    mlProduct(501, { category: "gamer", discount: 15, price: 90, name: "Teclado Nimbus 501" }),
    mlProduct(502, { category: "gamer", discount: 55, price: 250, name: "Mouse Nimbus 502" }),
    mlProduct(503, { category: "gamer", discount: 35, price: 700, name: "Monitor Nimbus 503" }),
  ]);

  // Grupo com cooldown de 24h. O item que entra na fila/history é escolhido
  // pela key real do catálogo, senão nada casaria.
  async function setup({ queue = [], history = [] } = {}) {
    const { user, auth } = await createTestUser({ plan: "pro" });
    await storage.saveState(user.id, {
      groups: [{
        id: GID, name: "Campanha", paused: false,
        categories: ["gamer"], whatsappGroupIds: [], messageTemplate: "{link}",
        scraping: { auto: true, sources: ["Mercado Livre"], filters: {} },
        schedule: { windows: [], cooldownValue: 24, cooldownUnit: "horas" },
        queue: [], pending: [], history: [],
        sentToday: 0, sentWeek: 0, weekData: [0, 0, 0, 0, 0, 0, 0], lastSend: "—",
      }],
    });
    // Fila e histórico são campos de "ops" — o saveState (config do usuário) não
    // escreve neles de propósito; quem grava é o scheduler, por aqui.
    await storage.updateGroupOps(user.id, GID, { queue, pending: [], history });
    return auth;
  }

  const itemFor = (p) => ({ key: p.key, id: p.key, name: p.name, link: p.link, store: p.store, price: p.price });

  it("tira da lista (e do total) o que já está na fila da campanha", async () => {
    await seed();
    const todos = await catalog.query({ categories: ["gamer"], limit: 100 });
    const naFila = todos.find(p => p.name === "Mouse Nimbus 502");
    const auth = await setup({ queue: [itemFor(naFila)] });

    const res = await auth("get", `/api/ofertas?categories=gamer&page=1&pageSize=24&groupId=${GID}`);
    expect(res.status).toBe(200);
    expect(res.body.items.map(p => p.name)).not.toContain("Mouse Nimbus 502");
    // O total tem que descontar junto, senão a paginação criaria página vazia.
    expect(res.body.total).toBe(2);

    // hideQueued=0 traz de volta — é a chave "Já na fila" da aba.
    const comFila = await auth("get", `/api/ofertas?categories=gamer&page=1&pageSize=24&groupId=${GID}&hideQueued=0`);
    expect(comFila.body.items.map(p => p.name)).toContain("Mouse Nimbus 502");
    expect(comFila.body.total).toBe(3);
  });

  it("tira o enviado dentro do cooldown, mas não o enviado há muito tempo", async () => {
    await seed();
    const todos = await catalog.query({ categories: ["gamer"], limit: 100 });
    const recente = todos.find(p => p.name === "Mouse Nimbus 502");
    const antigo = todos.find(p => p.name === "Teclado Nimbus 501");
    const auth = await setup({
      history: [
        { ...itemFor(recente), sentAt: new Date().toISOString() },
        { ...itemFor(antigo), sentAt: new Date(Date.now() - 5 * 86400000).toISOString() },
      ],
    });

    const res = await auth("get", `/api/ofertas?categories=gamer&page=1&pageSize=24&groupId=${GID}`);
    const nomes = res.body.items.map(p => p.name);
    expect(nomes).not.toContain("Mouse Nimbus 502");
    // Passou o cooldown de 24h: volta a ser elegível.
    expect(nomes).toContain("Teclado Nimbus 501");
    expect(res.body.total).toBe(2);

    const comRecentes = await auth("get", `/api/ofertas?categories=gamer&page=1&pageSize=24&groupId=${GID}&hideRecent=0`);
    expect(comRecentes.body.items.map(p => p.name)).toContain("Mouse Nimbus 502");
  });

  it("exclusão e filtros valem juntos, no total também", async () => {
    // A fila corta um produto e o desconto mínimo corta outro: o total tem que
    // refletir os dois, senão a paginação promete página que não existe.
    await seed();
    const todos = await catalog.query({ categories: ["gamer"], limit: 100 });
    const naFila = todos.find(p => p.name === "Mouse Nimbus 502");   // 55% off
    const auth = await setup({ queue: [itemFor(naFila)] });

    const res = await auth("get", `/api/ofertas?categories=gamer&minDiscount=30&page=1&pageSize=24&groupId=${GID}`);
    expect(res.status).toBe(200);
    // Sobra só o Monitor (35%): o Teclado tem 15% e o Mouse está na fila.
    expect(res.body.items.map(p => p.name)).toEqual(["Monitor Nimbus 503"]);
    expect(res.body.total).toBe(1);
  });

  it("groupId de outro usuário (ou inexistente) é ignorado, não vaza nem estoura", async () => {
    await seed();
    const todos = await catalog.query({ categories: ["gamer"], limit: 100 });
    const naFila = todos.find(p => p.name === "Mouse Nimbus 502");
    await setup({ queue: [itemFor(naFila)] });

    // Outro usuário pedindo o MESMO groupId: a fila do dono não pode filtrar
    // (nem vazar) a lista dele.
    const { auth: outro } = await createTestUser({ plan: "pro" });
    const res = await outro("get", `/api/ofertas?categories=gamer&page=1&pageSize=24&groupId=${GID}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);

    const bobo = await outro("get", "/api/ofertas?categories=gamer&page=1&pageSize=24&groupId=nao-numerico");
    expect(bobo.status).toBe(200);
    expect(bobo.body.total).toBe(3);
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
