// Desempenho de afiliado do ML (backend/affiliate-reports/ml.js).
//
// O que importa aqui:
//   - o período vira o MESMO filtro que o painel do ML manda (senão os números
//     não batem com o que o usuário vê lá);
//   - as respostas da API do painel viram cards, dias e etiquetas sem quebrar
//     quando um campo falta;
//   - cookie vencido (302 pro login) é "cole um cookie novo", não "erro";
//   - o cache e o freio do "Atualizar" poupam o ML.
import "../helpers/env.js";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const backend = (...p) => path.resolve(__dirname, "..", "..", "backend", ...p);

const ml = require(backend("affiliate-reports", "ml.js"));
const affiliate = require(backend("scraping", "affiliate.js"));
const affiliateAlert = require(backend("notifications", "affiliate-alert.js"));
const FX = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "fixtures", "ml-desempenho.json"), "utf8"));
const LISTAS = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "fixtures", "ml-desempenho-listas.json"), "utf8"));

const USER = "u-desempenho";
const COOKIE = "ssid=cookie-de-teste";

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

// Responde cada endpoint do painel pelo caminho, como o ML faz.
function painelFake({ diario = [FX.detalheDiarioPagina1, FX.detalheDiarioPagina2] } = {}) {
  return vi.fn(async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/dashboard/general")) return json(FX.general);
    if (u.pathname.endsWith("/dashboard/ganancias")) return json(FX.ganancias);
    if (u.pathname.endsWith("/dashboard/detalle-diario/general")) {
      const page = Number(u.searchParams.get("page"));
      return json(typeof diario === "function" ? diario(page) : diario[page - 1] || { item_list: [], total_results: 0 });
    }
    return new Response("not found", { status: 404 });
  });
}

let fetchMock, cookieState;

beforeEach(() => {
  ml._resetCache();
  vi.spyOn(affiliate, "readMLConfig").mockReturnValue({ tag: "minha-tag", cookie: COOKIE, source: "file", updatedAt: null });
  cookieState = vi.spyOn(affiliateAlert, "mlCookieState").mockImplementation(() => {});
  fetchMock = painelFake();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("período", () => {
  it("vira o mesmo filtro que o painel do ML manda (fim exclusivo, no dia seguinte)", () => {
    // O painel mostra "1/jul até 28/set" e pede exatamente isto.
    expect(ml.filtroPeriodo("2026-07-01", "2026-09-28"))
      .toBe("2026-07-01T00:00:00.000-03:00--2026-09-29T00:00:00.000-03:00");
    expect(ml.filtroPeriodo("2026-12-31", "2026-12-31"))
      .toBe("2026-12-31T00:00:00.000-03:00--2027-01-01T00:00:00.000-03:00");
  });

  it("recusa formato errado, início depois do fim e período maior que o ML aceita", () => {
    expect(ml.validaPeriodo("01/07/2026", "2026-09-28")).toMatch(/AAAA-MM-DD/);
    expect(ml.validaPeriodo("2026-09-28", "2026-07-01")).toMatch(/depois/);
    expect(ml.validaPeriodo("2026-01-01", "2026-09-28")).toMatch(/180 dias/);
    expect(ml.validaPeriodo("2026-04-02", "2026-09-28")).toBeNull();   // 180 dias exatos
  });
});

describe("normalização", () => {
  it("resumo: cada card sai do id certo e `requests` fica de fora", () => {
    const r = ml.normalizaResumo(FX.general);
    expect(r).toEqual({
      clicks: 20,
      clicksVariation: { pct: 100, direction: "increase" },
      buyers: 3,
      orders: 4,
      units: 5,
      earnings: { total: 18.5, marketplace: 12, seller: 4.5, brand: 2 },
      grossSales: 310.9,
      estimatedSales: 250.9,
      notEffectiveSales: 60,
      notEffectiveCount: 1,
      lastUpdate: "2026-09-29T13:26:24Z",
    });
  });

  it("resumo vazio ou torto não quebra: tudo zero", () => {
    const r = ml.normalizaResumo({ data: "x", commissions: null });
    expect(r.clicks).toBe(0);
    expect(r.clicksVariation).toBeNull();
    expect(r.earnings).toEqual({ total: 0, marketplace: 0, seller: 0, brand: 0 });
    expect(r.lastUpdate).toBeNull();
  });

  it("dias: um por data do período, em ordem, zero onde o ML não mandou nada", () => {
    const itens = [...FX.detalheDiarioPagina1.item_list, ...FX.detalheDiarioPagina2.item_list];
    const dias = ml.normalizaDias(itens, "2026-09-20", "2026-09-25");
    expect(dias.map(d => d.date)).toEqual(["2026-09-20", "2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25"]);
    expect(dias[0]).toEqual({ date: "2026-09-20", clicks: 0, orders: 0, units: 0, earnings: 0, coupons: 0 });
    // `touchpoints` é o clique do dia.
    expect(dias.find(d => d.date === "2026-09-24")).toEqual({ date: "2026-09-24", clicks: 4, orders: 2, units: 3, earnings: 11.5, coupons: 1 });
    expect(dias.find(d => d.date === "2026-09-22").clicks).toBe(14);
  });

  it("etiquetas: a que mais rendeu primeiro, e item sem tag é descartado", () => {
    const t = ml.normalizaEtiquetas([...FX.ganancias.item_list, { clicks: 3 }]);
    expect(t.map(x => x.tag)).toEqual(["minha-tag", "tag-secundaria"]);
    expect(t[0]).toEqual({ tag: "minha-tag", clicks: 15, units: 4, earnings: 15.5, conversion: 0.27 });
  });
});

describe("desempenhoDoUsuario", () => {
  const P = { from: "2026-09-20", to: "2026-09-25" };

  it("sem cookie não chama o ML e aponta pra aba Mercado Livre", async () => {
    affiliate.readMLConfig.mockReturnValue({ tag: null, cookie: null });
    await expect(ml.desempenhoDoUsuario(USER, P)).rejects.toMatchObject({ kind: "afiliado-ausente", status: 409 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("período inválido é 400 antes de qualquer chamada", async () => {
    await expect(ml.desempenhoDoUsuario(USER, { from: "2026-09-25", to: "2026-09-20" })).rejects.toMatchObject({ kind: "periodo-invalido", status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("junta resumo, todas as páginas do diário e as etiquetas, com o cookie do usuário", async () => {
    const r = await ml.desempenhoDoUsuario(USER, P);

    expect(r.summary.clicks).toBe(20);
    expect(r.days).toHaveLength(6);
    expect(r.days.reduce((a, d) => a + d.clicks, 0)).toBe(20);   // as duas páginas entraram
    expect(r.tags[0].tag).toBe("minha-tag");
    expect(r.cached).toBe(false);

    const urls = fetchMock.mock.calls.map(([u]) => new URL(u));
    const diario = urls.filter(u => u.pathname.endsWith("/detalle-diario/general"));
    expect(diario.map(u => u.searchParams.get("page"))).toEqual(["1", "2"]);
    for (const u of urls) {
      expect(u.searchParams.get("filter_time_range")).toBe("2026-09-20T00:00:00.000-03:00--2026-09-26T00:00:00.000-03:00");
      expect(u.searchParams.get("type")).toBe("GENERAL");
    }
    for (const [, opts] of fetchMock.mock.calls) {
      expect(opts.headers.Cookie).toBe(COOKIE);
      expect(opts.redirect).toBe("manual");
    }
    expect(cookieState).toHaveBeenCalledWith(USER, true, "minha-tag");
  });

  it("302 pro login é cookie vencido: 409 com kind login-wall, e o aviso do admin é acionado", async () => {
    fetchMock.mockImplementation(async () => new Response(null, {
      status: 302,
      headers: { location: "https://www.mercadolivre.com/jms/mlb/lgz/login?platform_id=ML&go=x" },
    }));
    await expect(ml.desempenhoDoUsuario(USER, P)).rejects.toMatchObject({ kind: "login-wall", status: 409 });
    expect(cookieState).toHaveBeenCalledWith(USER, false, "minha-tag");
  });

  it("403 também é cookie vencido; 500 é erro do ML, sem aviso de cookie", async () => {
    fetchMock.mockImplementation(async () => new Response("", { status: 403 }));
    await expect(ml.desempenhoDoUsuario(USER, P)).rejects.toMatchObject({ kind: "login-wall" });

    ml._resetCache();
    cookieState.mockClear();
    fetchMock.mockImplementation(async () => new Response("", { status: 500 }));
    await expect(ml.desempenhoDoUsuario(USER, P)).rejects.toMatchObject({ kind: "desconhecido", status: 502 });
    expect(cookieState).not.toHaveBeenCalled();
  });

  it("o diário para mesmo se o total vier errado: página vazia ou teto de páginas", async () => {
    // Total mentiroso + página 2 vazia → para na 2.
    fetchMock = painelFake({ diario: (page) => (page === 1 ? { ...FX.detalheDiarioPagina1, total_results: 999 } : { item_list: [], total_results: 999 }) });
    vi.stubGlobal("fetch", fetchMock);
    await ml.desempenhoDoUsuario(USER, P);
    const paginas = () => fetchMock.mock.calls.filter(([u]) => u.includes("detalle-diario")).length;
    expect(paginas()).toBe(2);

    // Toda página cheia e total infinito → para no teto.
    ml._resetCache();
    fetchMock = painelFake({ diario: () => ({ ...FX.detalheDiarioPagina1, total_results: 1e9 }) });
    vi.stubGlobal("fetch", fetchMock);
    await ml.desempenhoDoUsuario(USER, P);
    expect(paginas()).toBe(8);
  });

  it("sem antFrom/antTo não busca anterior (anterior: null)", async () => {
    const r = await ml.desempenhoDoUsuario(USER, P);
    expect(r.anterior).toBeNull();
    const filtros = new Set(fetchMock.mock.calls.map(([u]) => new URL(u).searchParams.get("filter_time_range")));
    expect(filtros.size).toBe(1);
  });

  it("com antFrom/antTo devolve o resumo e as etiquetas do período anterior, pelo mesmo cache", async () => {
    const A = { antFrom: "2026-09-14", antTo: "2026-09-19" };
    const r = await ml.desempenhoDoUsuario(USER, { ...P, ...A });
    expect(r.summary.clicks).toBe(20);
    expect(r.anterior).toMatchObject({ from: "2026-09-14", to: "2026-09-19" });
    expect(r.anterior.summary.clicks).toBe(20);
    expect(r.anterior.tags[0].tag).toBe("minha-tag");
    const filtros = new Set(fetchMock.mock.calls.map(([u]) => new URL(u).searchParams.get("filter_time_range")));
    expect(filtros).toContain("2026-09-14T00:00:00.000-03:00--2026-09-20T00:00:00.000-03:00");

    // A seta ‹ da tela pede depois o anterior como período atual: já está no cache.
    const chamadas = fetchMock.mock.calls.length;
    const seta = await ml.desempenhoDoUsuario(USER, { from: A.antFrom, to: A.antTo });
    expect(seta.cached).toBe(true);
    expect(fetchMock.mock.calls.length).toBe(chamadas);
  });

  it("erro no período anterior vira anterior: null, sem derrubar o atual", async () => {
    const certo = painelFake();
    fetchMock = vi.fn(async (url) => {
      const f = new URL(url).searchParams.get("filter_time_range");
      if (f.startsWith("2026-09-14")) return new Response("", { status: 500 });
      return certo(url);
    });
    vi.stubGlobal("fetch", fetchMock);
    const r = await ml.desempenhoDoUsuario(USER, { ...P, antFrom: "2026-09-14", antTo: "2026-09-19" });
    expect(r.summary.clicks).toBe(20);
    expect(r.anterior).toBeNull();
  });

  it("período anterior inválido é ignorado", async () => {
    const r = await ml.desempenhoDoUsuario(USER, { ...P, antFrom: "ontem", antTo: "2026-09-19" });
    expect(r.anterior).toBeNull();
  });

  it("cache de 15 min; o Atualizar fura, mas no máximo uma vez por minuto", async () => {
    const t0 = 1_790_000_000_000;
    await ml.desempenhoDoUsuario(USER, { ...P, now: t0 });
    const chamadas = fetchMock.mock.calls.length;

    const deCache = await ml.desempenhoDoUsuario(USER, { ...P, now: t0 + 10 * 60 * 1000 });
    expect(deCache.cached).toBe(true);
    expect(deCache.fetchedAt).toBe(new Date(t0).toISOString());

    const refreshCedo = await ml.desempenhoDoUsuario(USER, { ...P, refresh: true, now: t0 + 30 * 1000 });
    expect(refreshCedo.cached).toBe(true);
    expect(fetchMock.mock.calls.length).toBe(chamadas);

    const refresh = await ml.desempenhoDoUsuario(USER, { ...P, refresh: true, now: t0 + 2 * 60 * 1000 });
    expect(refresh.cached).toBe(false);
    expect(fetchMock.mock.calls.length).toBe(chamadas * 2);

    // Outro período não usa o cache deste.
    await ml.desempenhoDoUsuario(USER, { from: "2026-09-01", to: "2026-09-25", now: t0 + 3 * 60 * 1000 });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(chamadas * 2);
  });
});

// As abas de baixo (Vendas, Produtos vendidos, Categorias, Não efetivadas,
// Audiências): uma lista por vez, sob demanda, com as mesmas regras do resumo.
describe("listas das abas", () => {
  const P = { from: "2026-09-20", to: "2026-09-25" };
  const CAMINHO = {
    vendas: ["sales/general", LISTAS.vendas],
    produtos: ["ordenes/general", LISTAS.produtos],
    categorias: ["categories-products", LISTAS.categorias],
    "nao-efetivadas": ["orders-cancelled", LISTAS.naoEfetivadas],
    audiencias: ["audiences/general", LISTAS.audiencias],
  };
  const listasFake = () => vi.fn(async (url) => {
    const u = new URL(url);
    const achado = Object.values(CAMINHO).find(([c]) => u.pathname.endsWith(`/dashboard/${c}`));
    return achado ? json(achado[1]) : new Response("not found", { status: 404 });
  });

  beforeEach(() => {
    fetchMock = listasFake();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("venda: os campos que o painel lê viram produto, loja, valor, comissão e status", async () => {
    const r = await ml.listaDoUsuario(USER, { aba: "vendas", ...P });
    expect(r).toMatchObject({ aba: "vendas", page: 1, total: 12, hasMore: true });
    expect(r.items[0]).toEqual({
      id: "2000012345",
      date: "2026-10-12",
      product: "Fone de Ouvido Bluetooth XYZ",
      image: "https://http2.mlstatic.com/D_000000-MLA00000000000_000000-O.webp",
      link: "https://produto.mercadolivre.com.br/MLB-0000000000-fone",
      category: "Eletrônicos",
      store: "Loja ABC",
      value: 89.9,
      units: 1,
      commission: 7.19,
      commissionPct: 8,
      saleType: "DIRECT",
      status: "IN_REVIEW",
      statusDetail: null,
      statusUntil: "2026-12-11",
    });
    expect(r.items[1]).toMatchObject({ link: null, image: null, status: "REJECTED", statusDetail: "PERSONAL_PURCHASE", saleType: "INDIRECT" });
  });

  it("produtos e categorias: o `fee` do ML (fração) sai em %", async () => {
    const prod = await ml.listaDoUsuario(USER, { aba: "produtos", ...P });
    expect(prod.items[0]).toMatchObject({ product: "Fone de Ouvido Bluetooth XYZ", units: 3, sales: 269.7, feePct: 8, earnings: 21.58 });
    expect(prod.hasMore).toBe(false);

    const cat = await ml.listaDoUsuario(USER, { aba: "categorias", ...P });
    expect(cat.items).toEqual([
      { category: "Eletrônicos", units: 3, feePct: 8, earnings: 21.58 },
      { category: "Acessórios", units: 2, feePct: 12.5, earnings: 3.59 },   // sem `category`, vale o `name`
    ]);
  });

  it("não efetivadas: canceladas, não aprovadas e o ganho perdido", async () => {
    const r = await ml.listaDoUsuario(USER, { aba: "nao-efetivadas", ...P });
    expect(r.items[0]).toEqual({ product: "Capa de Celular", image: null, link: null, category: "Acessórios", canceled: 1, notApproved: 1, lostEarnings: 3.59 });
  });

  it("audiências: idade na ordem do ML, gênero traduzido, local do maior pro menor", async () => {
    const r = await ml.listaDoUsuario(USER, { aba: "audiencias", ...P });
    expect(r.age.map(x => x.label)).toEqual(["0-17", "18-24", "25-34", "35-44", "+45", "Sem dados"]);
    expect(r.gender).toEqual([
      { label: "Não especificado", value: 1 },
      { label: "Feminino", value: 6 },
      { label: "Masculino", value: 3 },
    ]);
    expect(r.location).toEqual([{ label: "São Paulo", value: 5 }, { label: "Rio de Janeiro", value: 2 }]);
    expect(r.items).toBeUndefined();
  });

  it("cada aba pede o endpoint dela, de 10 em 10, na ordem fixa e com o cookie do usuário", async () => {
    await ml.listaDoUsuario(USER, { aba: "vendas", ...P, page: 3 });
    await ml.listaDoUsuario(USER, { aba: "produtos", ...P });
    await ml.listaDoUsuario(USER, { aba: "nao-efetivadas", ...P });
    const [vendas, produtos, canceladas] = fetchMock.mock.calls.map(([u]) => new URL(u));
    expect(vendas.pathname).toMatch(/\/dashboard\/sales\/general$/);
    expect(Object.fromEntries(vendas.searchParams)).toMatchObject({
      page: "3", items_per_page: "10", order_by: "ord_date_created", sort: "desc", type: "GENERAL",
      filter_time_range: "2026-09-20T00:00:00.000-03:00--2026-09-26T00:00:00.000-03:00",
    });
    expect(produtos.searchParams.get("order_by")).toBe("earnings");
    expect(canceladas.searchParams.get("order_by")).toBe("earnings_cancelled");
    for (const [, opts] of fetchMock.mock.calls) expect(opts.headers.Cookie).toBe(COOKIE);
  });

  it("lista vazia ou torta não quebra", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});   // o item torto dispara o aviso de formato
    fetchMock.mockImplementation(async () => json({ item_list: [null, "x", { quantity: "muitos" }], total_results: "?" }));
    const r = await ml.listaDoUsuario(USER, { aba: "produtos", ...P });
    expect(r.items).toEqual([{ product: null, image: null, link: null, category: null, units: 0, sales: 0, feePct: null, earnings: 0 }]);
    expect(r).toMatchObject({ total: 0, hasMore: false });

    ml._resetCache();
    fetchMock.mockImplementation(async () => json({}));
    const aud = await ml.listaDoUsuario(USER, { aba: "audiencias", ...P });
    expect(aud).toMatchObject({ age: [], gender: [], location: [] });
  });

  it("item sem o campo principal avisa as chaves no log, uma vez por aba", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockImplementation(async () => json({ item_list: [{ titulo: "Fone", preco: 10 }], total_results: 1 }));
    await ml.listaDoUsuario(USER, { aba: "vendas", ...P });
    await ml.listaDoUsuario(USER, { aba: "vendas", ...P, page: 2 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("titulo,preco");
    expect(warn.mock.calls[0][0]).not.toContain("Fone");
  });

  it("aba desconhecida e período inválido são 400, sem chamar o ML; sem cookie é 409", async () => {
    await expect(ml.listaDoUsuario(USER, { aba: "redes", ...P })).rejects.toMatchObject({ kind: "aba-invalida", status: 400 });
    await expect(ml.listaDoUsuario(USER, { aba: "toString", ...P })).rejects.toMatchObject({ kind: "aba-invalida" });
    await expect(ml.listaDoUsuario(USER, { aba: "vendas", from: "2026-09-25", to: "2026-09-20" })).rejects.toMatchObject({ kind: "periodo-invalido", status: 400 });
    affiliate.readMLConfig.mockReturnValue({ tag: null, cookie: null });
    await expect(ml.listaDoUsuario(USER, { aba: "vendas", ...P })).rejects.toMatchObject({ kind: "afiliado-ausente", status: 409 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cookie vencido é login-wall e aciona o aviso", async () => {
    fetchMock.mockImplementation(async () => new Response("", { status: 403 }));
    await expect(ml.listaDoUsuario(USER, { aba: "vendas", ...P })).rejects.toMatchObject({ kind: "login-wall", status: 409 });
    expect(cookieState).toHaveBeenCalledWith(USER, false, "minha-tag");
  });

  it("cache por aba, período e página; o Atualizar fura com o mesmo freio", async () => {
    const t0 = 1_790_000_000_000;
    await ml.listaDoUsuario(USER, { aba: "vendas", ...P, now: t0 });
    const deCache = await ml.listaDoUsuario(USER, { aba: "vendas", ...P, now: t0 + 60 * 1000 });
    expect(deCache.cached).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await ml.listaDoUsuario(USER, { aba: "vendas", ...P, page: 2, now: t0 });
    await ml.listaDoUsuario(USER, { aba: "produtos", ...P, now: t0 });
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const refresh = await ml.listaDoUsuario(USER, { aba: "vendas", ...P, refresh: true, now: t0 + 2 * 60 * 1000 });
    expect(refresh.cached).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("página fora do normal vira 1 (ou o teto)", async () => {
    await ml.listaDoUsuario(USER, { aba: "vendas", ...P, page: "abc" });
    await ml.listaDoUsuario(USER, { aba: "vendas", ...P, page: 9999 });
    expect(fetchMock.mock.calls.map(([u]) => new URL(u).searchParams.get("page"))).toEqual(["1", "50"]);
  });
});
