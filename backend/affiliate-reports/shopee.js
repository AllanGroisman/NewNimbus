// Desempenho de afiliado da Shopee (pedidos, vendas, comissão), por usuário.
//
// Aqui é API oficial: a mesma Affiliate Open API (GraphQL) que já gera os links
// (scraping/affiliate.js), com o App ID e a senha que cada usuário cola na aba
// Shopee — nunca as credenciais do admin/scraper. A query é `conversionReport`,
// que devolve uma linha por conversão, com os pedidos e itens dentro.
//
// Medido com a conta real em 29/09/2026 (introspecção + chamadas):
//   - não existe relatório de cliques na API — só conversões;
//   - valores de dinheiro vêm como string ("11.5854");
//   - mais recente primeiro, paginado por `scrollId` (o período vai junto em
//     toda página; a última pode vir vazia);
//   - início há mais de ~3 meses → erro 11001 "can only query data for the last
//     3 months" (120 dias passou, 125 não). O início é cortado no limite antes.
//
// Como no ML, nada vai pro banco: a tela pede um período, a gente pergunta à
// Shopee e segura a resposta num cache curto. Os presets da tela cabem todos no
// limite da Shopee; histórico mais velho que isso pediria guardar os dados.
const affiliate = require("../scraping/affiliate");
const db = require("../db");
const { UA } = require("../scraping/scraper");
const { DesempenhoError, DIA_RE, somaDias, validaFormato, criaCache } = require("./comum");

const TZ_BR = "America/Sao_Paulo";
const TIMEOUT_MS = 20000;
const POR_PAGINA = 500;      // o máximo que a Shopee aceita
const MAX_PAGINAS = 10;      // 5.000 conversões num período é folga de sobra
const MAX_VENDAS = 500;      // linhas da lista de vendas devolvidas à tela
const LIMITE_DIAS = 120;

const cacheado = criaCache();

const KIND = {
  SEM_CONFIG: affiliate.ML_LINK_KIND.SEM_CONFIG,   // "afiliado-ausente", o mesmo do ML
  CREDENCIAL: "credencial-recusada",
  PERIODO: "periodo-invalido",
  LIMITE: "limite-shopee",
  ERRO: affiliate.ML_LINK_KIND.ERRO,
};

// Códigos de `errors[].extensions.code` da Open API.
const COD_CREDENCIAL = new Set([10020, 10031, 10032, 10033, 10034, 10035]);
const COD_LIMITE = 10030;
const COD_PARAMETRO = 11001;

// ────────────────────────────────────────────────────────────────────────
// Datas
// ────────────────────────────────────────────────────────────────────────

function hojeBR(now = Date.now()) {
  return new Date(now).toLocaleDateString("en-CA", { timeZone: TZ_BR });
}

// O dia mais antigo que a Shopee ainda responde. A regra dela é "últimos 3
// meses", e com o que dá pra medir hoje não se distingue "120 dias" de "desde o
// dia 1º de 3 meses atrás" — então vale o mais recente dos dois.
function inicioMinimo(hoje) {
  const [a, m] = hoje.split("-").map(Number);
  const d = new Date(Date.UTC(a, m - 1 - 3, 1, 12));
  const primeiroDoMes = d.toISOString().slice(0, 10);
  const porDias = somaDias(hoje, -LIMITE_DIAS);
  return primeiroDoMes > porDias ? primeiroDoMes : porDias;
}

// Formato, ordem e se sobra algum dia dentro do limite. Devolve null quando
// está ok, ou o motivo.
function validaPeriodo(from, to, hoje = hojeBR()) {
  const invalido = validaFormato(from, to);
  if (invalido) return invalido;
  if (to < inicioMinimo(hoje)) return "A Shopee só mostra as vendas dos últimos 3 meses.";
  return null;
}

// Início que passa do limite é cortado nele, em vez de recusado: em alguns dias
// do ano o "últimos 90 dias" começa um ou dois dias antes do dia 1º de 3 meses
// atrás, e perder esses dias é melhor que não mostrar nada. A tela mostra as
// datas que voltaram e avisa do corte.
function ajustaPeriodo(from, to, hoje = hojeBR()) {
  const minimo = inicioMinimo(hoje);
  return from < minimo ? { from: minimo, to, requestedFrom: from } : { from, to, requestedFrom: null };
}

// Período em segundos Unix: meia-noite de Brasília do primeiro dia até o
// último segundo do último dia.
function janela(from, to) {
  return {
    inicio: Date.parse(`${from}T00:00:00-03:00`) / 1000,
    fim: Date.parse(`${somaDias(to, 1)}T00:00:00-03:00`) / 1000 - 1,
  };
}

// Dia (AAAA-MM-DD) de Brasília de um instante em segundos. O Brasil não tem
// mais horário de verão, então −3h fixo basta.
function diaBR(segundos) {
  return new Date((segundos - 3 * 3600) * 1000).toISOString().slice(0, 10);
}

// ────────────────────────────────────────────────────────────────────────
// Normalização (pura)
// ────────────────────────────────────────────────────────────────────────

const valor = (v) => {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};
const centavos = (n) => Math.round(n * 100) / 100;

// Status de um item, nos três baldes que a tela mostra. Fraude conta como
// cancelada: a Shopee não paga a comissão.
function statusDoItem(item) {
  const s = String(item?.displayItemStatus || "").toUpperCase();
  if (s.includes("CANCEL") || String(item?.fraudStatus || "").toUpperCase() === "FRAUD") return "cancelada";
  if (s === "COMPLETED") return "concluida";
  return "pendente";
}

// `utmContent` são os 5 sub_ids unidos por "-" ("g123----"). O primeiro é o
// grupo que mandou o link (affiliate.subIdDoGrupo).
function grupoDoUtm(utm) {
  const m = affiliate.SUBID_GRUPO_RE.exec(String(utm || "").split("-")[0]);
  return m && m[1].length <= 18 ? m[1] : null;
}

// Conversões → um item por produto vendido, mais recente primeiro.
function normalizaItens(nodes) {
  const out = [];
  for (const c of Array.isArray(nodes) ? nodes : []) {
    if (!c) continue;
    const t = valor(c.purchaseTime);
    const groupId = grupoDoUtm(c.utmContent);
    for (const o of Array.isArray(c.orders) ? c.orders : []) {
      (Array.isArray(o?.items) ? o.items : []).forEach((it, i) => {
        out.push({
          id: `${c.conversionId}-${o.orderId}-${it.itemId}-${i}`,
          orderId: String(o.orderId ?? ""),
          purchaseTime: t ? new Date(t * 1000).toISOString() : null,
          date: t ? diaBR(t) : null,
          status: statusDoItem(it),
          name: String(it.itemName || ""),
          image: it.imageUrl || null,
          shopName: it.shopName || null,
          qty: valor(it.qty),
          amount: centavos(valor(it.actualAmount)),
          commission: centavos(valor(it.itemTotalCommission)),
          groupId,
        });
      });
    }
  }
  return out.sort((a, b) => String(b.purchaseTime).localeCompare(String(a.purchaseTime)));
}

// Totais do período. Cancelado não entra em pedido, venda nem comissão: aparece
// à parte. A taxa de MCN (agência) é da conversão, não do item.
function normalizaResumo(itens, nodes = []) {
  const validos = itens.filter(i => i.status !== "cancelada");
  const cancelados = itens.filter(i => i.status === "cancelada");
  const pedidosValidos = new Set(validos.map(i => i.orderId));
  const soma = (lista, campo) => centavos(lista.reduce((a, i) => a + i[campo], 0));
  const concluida = soma(validos.filter(i => i.status === "concluida"), "commission");
  const pendente = soma(validos.filter(i => i.status === "pendente"), "commission");
  return {
    orders: pedidosValidos.size,
    units: validos.reduce((a, i) => a + i.qty, 0),
    sales: soma(validos, "amount"),
    commission: { total: centavos(concluida + pendente), concluida, pendente },
    cancelled: {
      // Pedido cancelado = nenhum item dele sobrou.
      orders: new Set(cancelados.map(i => i.orderId).filter(id => !pedidosValidos.has(id))).size,
      commission: soma(cancelados, "commission"),
    },
    mcnFee: centavos((Array.isArray(nodes) ? nodes : []).reduce((a, c) => a + valor(c?.mcnManagementFee), 0)),
  };
}

// Um dia por data do período, zero nos dias sem venda.
function normalizaDias(itens, from, to) {
  const porData = new Map();
  for (const i of itens) {
    if (i.status === "cancelada" || !DIA_RE.test(String(i.date))) continue;
    const d = porData.get(i.date) || { pedidos: new Set(), units: 0, sales: 0, commission: 0 };
    d.pedidos.add(i.orderId);
    d.units += i.qty;
    d.sales += i.amount;
    d.commission += i.commission;
    porData.set(i.date, d);
  }
  const out = [];
  for (let d = from; d <= to; d = somaDias(d, 1)) {
    const x = porData.get(d);
    out.push({
      date: d,
      orders: x ? x.pedidos.size : 0,
      units: x ? x.units : 0,
      sales: x ? centavos(x.sales) : 0,
      commission: x ? centavos(x.commission) : 0,
    });
  }
  return out;
}

// Vendas por grupo (sub_id). `nomes` = { [groupId]: nome } dos grupos DO
// usuário: marca de grupo que não está ali (apagado, ou de outra pessoa com a
// mesma conta Shopee) vira "Grupo removido", sem expor nome nenhum.
function normalizaGrupos(itens, nomes = {}) {
  const porGrupo = new Map();
  for (const i of itens) {
    if (i.status === "cancelada") continue;
    const chave = i.groupId || "";
    const g = porGrupo.get(chave) || { groupId: i.groupId, pedidos: new Set(), units: 0, sales: 0, commission: 0 };
    g.pedidos.add(i.orderId);
    g.units += i.qty;
    g.sales += i.amount;
    g.commission += i.commission;
    porGrupo.set(chave, g);
  }
  return [...porGrupo.values()]
    .map(g => ({
      groupId: g.groupId,
      name: g.groupId ? nomes[g.groupId] || "Grupo removido" : "Sem grupo",
      orders: g.pedidos.size,
      units: g.units,
      sales: centavos(g.sales),
      commission: centavos(g.commission),
    }))
    .sort((a, b) => b.commission - a.commission || b.orders - a.orders);
}

// ────────────────────────────────────────────────────────────────────────
// Chamadas à Shopee
// ────────────────────────────────────────────────────────────────────────

const CAMPOS = "nodes{conversionId purchaseTime utmContent mcnManagementFee orders{orderId items{itemId itemName imageUrl shopName qty actualAmount itemTotalCommission displayItemStatus fraudStatus}}} pageInfo{hasNextPage scrollId}";

function queryConversoes({ inicio, fim }, scrollId = null) {
  const args = [`purchaseTimeStart:${inicio}`, `purchaseTimeEnd:${fim}`, `limit:${POR_PAGINA}`];
  if (scrollId) args.push(`scrollId:"${String(scrollId).replace(/[^A-Za-z0-9_-]/g, "")}"`);
  return `{conversionReport(${args.join(",")}){${CAMPOS}}}`;
}

function erroDaApi(e) {
  const code = Number(e?.extensions?.code);
  const msg = String(e?.extensions?.message || e?.message || "erro desconhecido").slice(0, 160);
  if (COD_CREDENCIAL.has(code)) {
    return new DesempenhoError(KIND.CREDENCIAL, `A Shopee recusou o App ID/senha pra ler o relatório (${msg}). Confira na aba Shopee.`, 409);
  }
  if (code === COD_LIMITE) return new DesempenhoError(KIND.LIMITE, "A Shopee pediu pra esperar um pouco antes de consultar de novo.", 503);
  if (code === COD_PARAMETRO) return new DesempenhoError(KIND.PERIODO, `A Shopee recusou o período: ${msg}`, 400);
  return new DesempenhoError(KIND.ERRO, `A Shopee respondeu com erro: ${msg}`);
}

async function postShopee(query, { appId, appSecret }) {
  const payload = JSON.stringify({ query });
  const timestamp = Math.floor(Date.now() / 1000);
  let res;
  try {
    res = await fetch(affiliate.SHOPEE_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": affiliate.signShopeeRequest({ appId, appSecret, timestamp, payload }),
        "User-Agent": UA,
      },
      body: payload,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new DesempenhoError(KIND.ERRO, `A Shopee não respondeu (${err.name === "TimeoutError" ? "tempo esgotado" : err.message}).`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new DesempenhoError(KIND.CREDENCIAL, "A Shopee recusou o App ID/senha pra ler o relatório. Confira na aba Shopee.", 409);
  }
  if (!res.ok) throw new DesempenhoError(KIND.ERRO, `A Shopee respondeu HTTP ${res.status} ao buscar o relatório.`);
  let json;
  try {
    json = await res.json();
  } catch {
    throw new DesempenhoError(KIND.ERRO, "A Shopee devolveu uma resposta que não é JSON.");
  }
  if (Array.isArray(json?.errors) && json.errors.length) throw erroDaApi(json.errors[0]);
  return json?.data;
}

// Todas as conversões do período. O teto de páginas garante fim mesmo se a
// Shopee insistir em `hasNextPage`.
async function buscaConversoes(periodo, creds) {
  const nodes = [];
  let scrollId = null;
  for (let pagina = 1; pagina <= MAX_PAGINAS; pagina++) {
    const data = await postShopee(queryConversoes(periodo, scrollId), creds);
    const rel = data?.conversionReport;
    const lista = Array.isArray(rel?.nodes) ? rel.nodes : [];
    nodes.push(...lista);
    scrollId = rel?.pageInfo?.hasNextPage ? rel.pageInfo.scrollId : null;
    if (!lista.length || !scrollId) break;
  }
  return nodes;
}

// Nomes dos grupos do usuário que aparecem nas vendas. O filtro por userId é o
// que impede o nome do grupo de outra pessoa (mesma conta Shopee) de vazar.
async function nomesDosGrupos(userId, ids) {
  const unicos = [...new Set(ids.filter(Boolean))];
  if (!unicos.length) return {};
  const rows = await db.prisma().group.findMany({
    where: { userId, id: { in: unicos.map(id => BigInt(id)) } },
    select: { id: true, name: true },
  });
  return Object.fromEntries(rows.map(r => [String(r.id), r.name]));
}

// Busca o período na Shopee, sem cache. Lança DesempenhoError.
async function buscaDesempenho({ userId, creds, from, to }) {
  const nodes = await buscaConversoes(janela(from, to), creds);
  const itens = normalizaItens(nodes);
  const nomes = await nomesDosGrupos(userId, itens.map(i => i.groupId));
  return {
    from,
    to,
    summary: normalizaResumo(itens, nodes),
    days: normalizaDias(itens, from, to),
    groups: normalizaGrupos(itens, nomes),
    sales: itens.slice(0, MAX_VENDAS).map(i => ({ ...i, group: i.groupId ? nomes[i.groupId] || "Grupo removido" : null })),
    totalSales: itens.length,
  };
}

// O que a rota chama. Mesmo cache e mesmo freio do "Atualizar" do ML.
async function desempenhoDoUsuario(userId, { from, to, refresh = false, now = Date.now() } = {}) {
  const hoje = hojeBR(now);
  const invalido = validaPeriodo(from, to, hoje);
  if (invalido) throw new DesempenhoError(KIND.PERIODO, invalido, 400);
  const periodo = ajustaPeriodo(from, to, hoje);

  const { appId, appSecret } = affiliate.readShopeeConfig(userId);
  if (!appId || !appSecret) {
    throw new DesempenhoError(KIND.SEM_CONFIG, "Configure o App ID e a senha da API na aba Shopee pra ver o desempenho.", 409);
  }

  const data = await cacheado(`${userId}|${appId}|${periodo.from}|${to}`, { refresh, now }, () =>
    buscaDesempenho({ userId, creds: { appId, appSecret }, from: periodo.from, to }));
  return { ...data, requestedFrom: periodo.requestedFrom };
}

function _resetCache() { cacheado.reset(); }

module.exports = {
  desempenhoDoUsuario,
  buscaDesempenho,
  DesempenhoError,
  KIND,
  // puras, exportadas pros testes
  validaPeriodo,
  ajustaPeriodo,
  inicioMinimo,
  janela,
  normalizaItens,
  normalizaResumo,
  normalizaDias,
  normalizaGrupos,
  queryConversoes,
  _resetCache,
};
