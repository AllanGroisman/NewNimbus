// Desempenho de afiliado da Shopee (backend/affiliate-reports/shopee.js).
//
// O que importa aqui:
//   - o período respeita o limite da Shopee ("últimos 3 meses") e todo preset da
//     tela cabe nele, qualquer que seja o dia;
//   - as conversões (dinheiro em string, pedidos com vários itens) viram totais,
//     dias, grupos e a lista de vendas — cancelado fica de fora dos totais;
//   - a marca do grupo no link (sub_id "g<id>") vira o nome do grupo SÓ quando o
//     grupo é do próprio usuário;
//   - a paginação por scrollId, os erros da API e o cache.
import "../helpers/env.js";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const backend = (...p) => path.resolve(__dirname, "..", "..", "backend", ...p);

const shopee = require(backend("affiliate-reports", "shopee.js"));
const affiliate = require(backend("scraping", "affiliate.js"));
const db = require(backend("db.js"));
const FX = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "fixtures", "shopee-desempenho.json"), "utf8"));

const USER = "u-shopee";
const CREDS = { appId: "app-do-usuario", appSecret: "segredo-do-usuario-123" };
const P = { from: "2026-09-20", to: "2026-09-25", now: Date.parse("2026-09-29T15:00:00Z") };
const NODES = [...FX.pagina1.data.conversionReport.nodes, ...FX.pagina2.data.conversionReport.nodes];

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const queryDe = (opts) => JSON.parse(opts.body).query;

// Responde como a Shopee: a página sai do scrollId que veio na query.
function shopeeFake() {
  return vi.fn(async (_url, opts) => {
    const q = queryDe(opts);
    if (q.includes('scrollId:"scroll-2"')) return json(FX.pagina3);
    if (q.includes('scrollId:"scroll-1"')) return json(FX.pagina2);
    return json(FX.pagina1);
  });
}

let fetchMock, findMany;

beforeEach(() => {
  shopee._resetCache();
  vi.spyOn(affiliate, "readShopeeConfig").mockReturnValue({ ...CREDS, source: "file", updatedAt: null });
  findMany = vi.fn(async () => [{ id: 123n, name: "Ofertas Tech" }]);
  vi.spyOn(db, "prisma").mockReturnValue({ group: { findMany } });
  fetchMock = shopeeFake();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("período", () => {
  it("o início mais antigo é o mais recente entre 120 dias e o dia 1º de 3 meses atrás", () => {
    expect(shopee.inicioMinimo("2026-09-29")).toBe("2026-06-01");   // o que foi medido: 1º/jun passa
    expect(shopee.inicioMinimo("2026-10-31")).toBe("2026-07-03");   // 120 dias é mais recente
    expect(shopee.inicioMinimo("2026-10-01")).toBe("2026-07-01");   // o dia 1º é mais recente
    expect(shopee.inicioMinimo("2027-01-15")).toBe("2026-10-01");   // vira o ano
  });

  it("recusa formato errado, início depois do fim e período todo fora do limite", () => {
    expect(shopee.validaPeriodo("2026-04-01", "2026-05-31", "2026-09-29")).toMatch(/3 meses/);
    expect(shopee.validaPeriodo("2026-05-20", "2026-09-28", "2026-09-29")).toBeNull();   // corta, não recusa
    expect(shopee.validaPeriodo("20/09/2026", "2026-09-28", "2026-09-29")).toMatch(/AAAA-MM-DD/);
    expect(shopee.validaPeriodo("2026-09-28", "2026-09-20", "2026-09-29")).toMatch(/depois/);
  });

  it("início antes do limite é cortado nele, e o pedido original volta pra tela avisar", () => {
    expect(shopee.ajustaPeriodo("2026-05-20", "2026-09-28", "2026-09-29")).toEqual({ from: "2026-06-01", to: "2026-09-28", requestedFrom: "2026-05-20" });
    expect(shopee.ajustaPeriodo("2026-07-01", "2026-09-28", "2026-09-29")).toEqual({ from: "2026-07-01", to: "2026-09-28", requestedFrom: null });
  });

  it("todo preset da tela passa, em qualquer dia do ano; o mês passado nunca é cortado", () => {
    const soma = (d, n) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
    for (let i = 0; i < 366; i++) {
      const hoje = soma("2026-01-01", i);
      const d90 = soma(hoje, -90);
      expect(shopee.validaPeriodo(d90, soma(hoje, -1), hoje), `90d em ${hoje}`).toBeNull();
      // Quando corta, são no máximo 2 dias (fevereiro curto).
      const { from } = shopee.ajustaPeriodo(d90, soma(hoje, -1), hoje);
      expect(Math.round((Date.parse(from) - Date.parse(d90)) / 86400000), `corte em ${hoje}`).toBeLessThanOrEqual(2);
      const [a, m] = hoje.split("-").map(Number);
      const inicioMesPassado = new Date(Date.UTC(a, m - 2, 1, 12)).toISOString().slice(0, 10);
      expect(shopee.ajustaPeriodo(inicioMesPassado, soma(hoje, -1), hoje).requestedFrom, `mês passado em ${hoje}`).toBeNull();
    }
  });

  it("a janela vai da meia-noite de Brasília do início ao último segundo do fim", () => {
    expect(shopee.janela("2026-09-20", "2026-09-25")).toEqual({
      inicio: Date.parse("2026-09-20T03:00:00Z") / 1000,
      fim: Date.parse("2026-09-26T03:00:00Z") / 1000 - 1,
    });
  });
});

describe("normalização", () => {
  const itens = () => shopee.normalizaItens(NODES);

  it("um item por produto, mais recente primeiro, com dinheiro em número", () => {
    const r = itens();
    expect(r.map(i => i.name)).toEqual(["Relógio Masculino", "Cartas Colecionáveis", "Envelopes de Figurinhas", "Álbum de Figurinhas", "Caneca Cancelada"]);
    expect(r[0]).toMatchObject({
      orderId: "PEDIDO-A", date: "2026-09-25", status: "concluida", qty: 1,
      amount: 386.18, commission: 11.59, groupId: "123", shopName: "Loja Relógios",
      purchaseTime: "2026-09-25T10:22:11.000Z",
    });
  });

  it("o dia é o de Brasília: 23h30 do dia 20 continua dia 20", () => {
    expect(itens().find(i => i.orderId === "PEDIDO-C").date).toBe("2026-09-20");
  });

  it("status: concluída, pendente, cancelada — e fraude conta como cancelada", () => {
    expect(itens().map(i => i.status)).toEqual(["concluida", "pendente", "pendente", "pendente", "cancelada"]);
    const [fraude] = shopee.normalizaItens([{ ...NODES[0], orders: [{ orderId: "X", items: [{ ...NODES[0].orders[0].items[0], displayItemStatus: "COMPLETED", fraudStatus: "FRAUD" }] }] }]);
    expect(fraude.status).toBe("cancelada");
  });

  it("marca de grupo só vale no formato g<número>; campo faltando não quebra", () => {
    const r = shopee.normalizaItens([
      { conversionId: 1, purchaseTime: 1790331731, utmContent: "campanha-x---", orders: [{ orderId: "Y", items: [{}] }] },
      { conversionId: 2, purchaseTime: 1790331731 },
      null,
    ]);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ groupId: null, qty: 0, amount: 0, commission: 0, status: "pendente", name: "" });
  });

  it("resumo: cancelado fora dos totais e contado à parte; taxa de MCN somada", () => {
    expect(shopee.normalizaResumo(itens(), NODES)).toEqual({
      orders: 3,
      units: 14,
      sales: 730.75,
      commission: { total: 21.93, concluida: 11.59, pendente: 10.34 },
      cancelled: { orders: 1, commission: 1.5 },
      mcnFee: 0.5,
    });
  });

  it("dias: um por data do período, zero onde não teve venda (nem a cancelada)", () => {
    const dias = shopee.normalizaDias(itens(), "2026-09-20", "2026-09-25");
    expect(dias.map(d => d.date)).toEqual(["2026-09-20", "2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25"]);
    expect(dias[0]).toEqual({ date: "2026-09-20", orders: 0, units: 0, sales: 0, commission: 0 });
    expect(dias[2]).toEqual({ date: "2026-09-22", orders: 1, units: 3, sales: 60.52, commission: 1.82 });
  });

  it("grupos: nome só dos grupos do usuário; sem marca é 'Sem grupo'; o que mais rendeu primeiro", () => {
    expect(shopee.normalizaGrupos(itens(), { 123: "Ofertas Tech" })).toEqual([
      { groupId: "123", name: "Ofertas Tech", orders: 1, units: 1, sales: 386.18, commission: 11.59 },
      { groupId: "999", name: "Grupo removido", orders: 1, units: 10, sales: 284.05, commission: 8.52 },
      { groupId: null, name: "Sem grupo", orders: 1, units: 3, sales: 60.52, commission: 1.82 },
    ]);
  });
});

describe("desempenhoDoUsuario", () => {
  it("sem App ID/senha não chama a Shopee e aponta pra aba Shopee", async () => {
    affiliate.readShopeeConfig.mockReturnValue({ appId: null, appSecret: null });
    await expect(shopee.desempenhoDoUsuario(USER, P)).rejects.toMatchObject({ kind: "afiliado-ausente", status: 409 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("período todo fora do limite é 400 antes de qualquer chamada", async () => {
    await expect(shopee.desempenhoDoUsuario(USER, { ...P, from: "2026-04-01", to: "2026-05-15" })).rejects.toMatchObject({ kind: "periodo-invalido", status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("início velho demais é cortado no limite: a Shopee recebe o limite, a tela recebe o aviso", async () => {
    const r = await shopee.desempenhoDoUsuario(USER, { ...P, from: "2026-05-20" });
    expect(r.from).toBe("2026-06-01");
    expect(r.requestedFrom).toBe("2026-05-20");
    expect(queryDe(fetchMock.mock.calls[0][1])).toContain(`purchaseTimeStart:${shopee.janela("2026-06-01", P.to).inicio}`);
    expect((await shopee.desempenhoDoUsuario(USER, P)).requestedFrom).toBeNull();
  });

  it("segue o scrollId até a última página, assinando com o App ID do usuário", async () => {
    const r = await shopee.desempenhoDoUsuario(USER, P);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const { inicio, fim } = shopee.janela(P.from, P.to);
    const queries = fetchMock.mock.calls.map(([, o]) => queryDe(o));
    for (const q of queries) {
      expect(q).toContain(`purchaseTimeStart:${inicio}`);
      expect(q).toContain(`purchaseTimeEnd:${fim}`);
      expect(q).toContain("limit:500");
    }
    expect(queries[0]).not.toContain("scrollId:");
    expect(queries[1]).toContain('scrollId:"scroll-1"');
    expect(queries[2]).toContain('scrollId:"scroll-2"');
    for (const [url, o] of fetchMock.mock.calls) {
      expect(url).toBe(affiliate.SHOPEE_ENDPOINT);
      expect(o.headers.Authorization).toMatch(/^SHA256 Credential=app-do-usuario, /);
    }

    expect(r.summary.orders).toBe(3);
    expect(r.days).toHaveLength(6);
    expect(r.groups.map(g => g.name)).toEqual(["Ofertas Tech", "Grupo removido", "Sem grupo"]);
    expect(r.sales).toHaveLength(5);
    expect(r.sales[0].group).toBe("Ofertas Tech");
    expect(r.sales.find(s => s.orderId === "PEDIDO-D").group).toBe("Grupo removido");
    expect(r.sales.find(s => s.orderId === "PEDIDO-B").group).toBeNull();
    expect(r.totalSales).toBe(5);
    expect(r.cached).toBe(false);
  });

  it("os nomes dos grupos são buscados só entre os grupos DO usuário", async () => {
    await shopee.desempenhoDoUsuario(USER, P);
    expect(findMany).toHaveBeenCalledTimes(1);
    const { where } = findMany.mock.calls[0][0];
    expect(where.userId).toBe(USER);
    expect(where.id.in.sort()).toEqual([123n, 999n]);
  });

  it("sem venda marcada, nem consulta o banco", async () => {
    fetchMock.mockImplementation(async () => json({ data: { conversionReport: { nodes: [NODES[1]], pageInfo: { hasNextPage: false } } } }));
    const r = await shopee.desempenhoDoUsuario(USER, P);
    expect(findMany).not.toHaveBeenCalled();
    expect(r.groups).toEqual([expect.objectContaining({ name: "Sem grupo" })]);
  });

  it("para no teto de páginas mesmo se a Shopee insistir em hasNextPage", async () => {
    let n = 0;
    fetchMock.mockImplementation(async () => json({ data: { conversionReport: { nodes: [NODES[1]], pageInfo: { hasNextPage: true, scrollId: `s${++n}` } } } }));
    await shopee.desempenhoDoUsuario(USER, P);
    expect(fetchMock).toHaveBeenCalledTimes(10);
  });

  it("erros da API viram motivos que a tela sabe mostrar", async () => {
    const casos = [
      [json({ errors: [{ message: "error [10020]: Invalid Signature", extensions: { code: 10020, message: "Invalid Signature" } }] }), { kind: "credencial-recusada", status: 409 }],
      [json({ errors: [{ message: "x", extensions: { code: 10035, message: "no access" } }] }), { kind: "credencial-recusada", status: 409 }],
      [json({ errors: [{ message: "x", extensions: { code: 10030, message: "rate limit" } }] }), { kind: "limite-shopee", status: 503 }],
      [json({ errors: [{ message: "x", extensions: { code: 11001, message: "Params Error : can only query data for the last 3 months" } }] }), { kind: "periodo-invalido", status: 400 }],
      [json({ errors: [{ message: "x", extensions: { code: 10000, message: "System error" } }] }), { kind: "desconhecido", status: 502 }],
      [new Response("", { status: 403 }), { kind: "credencial-recusada", status: 409 }],
      [new Response("", { status: 500 }), { kind: "desconhecido", status: 502 }],
      [new Response("<html>", { status: 200 }), { kind: "desconhecido", status: 502 }],
    ];
    for (const [resposta, esperado] of casos) {
      shopee._resetCache();
      fetchMock.mockImplementationOnce(async () => resposta);
      await expect(shopee.desempenhoDoUsuario(USER, P)).rejects.toMatchObject(esperado);
    }
    shopee._resetCache();
    fetchMock.mockImplementationOnce(async () => json({ errors: [{ message: "x", extensions: { code: 10000, message: "System error" } }] }));
    await expect(shopee.desempenhoDoUsuario(USER, P)).rejects.toThrow(/System error/);
  });

  it("cache de 15 min com freio no Atualizar; trocar a credencial não usa o cache velho", async () => {
    const t0 = P.now;
    await shopee.desempenhoDoUsuario(USER, P);
    const chamadas = fetchMock.mock.calls.length;

    const deCache = await shopee.desempenhoDoUsuario(USER, { ...P, now: t0 + 10 * 60 * 1000 });
    expect(deCache.cached).toBe(true);
    expect(fetchMock.mock.calls.length).toBe(chamadas);

    expect((await shopee.desempenhoDoUsuario(USER, { ...P, refresh: true, now: t0 + 30 * 1000 })).cached).toBe(true);
    expect((await shopee.desempenhoDoUsuario(USER, { ...P, refresh: true, now: t0 + 2 * 60 * 1000 })).cached).toBe(false);

    affiliate.readShopeeConfig.mockReturnValue({ appId: "outra-conta", appSecret: "outro-segredo-1234567" });
    expect((await shopee.desempenhoDoUsuario(USER, { ...P, now: t0 + 3 * 60 * 1000 })).cached).toBe(false);
  });
});
