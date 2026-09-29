// Desempenho de afiliado do Mercado Livre (cliques, pedidos, ganhos), por usuário.
//
// O ML não tem API pública de afiliados — a api.mercadolibre.com com OAuth só
// cobre vendedor. O que existe é a API JSON que o próprio painel de Métricas
// (mercadolivre.com.br/afiliados/dashboard) chama: `/affiliate-program/api/dashboard/*`.
// Ela aceita um fetch cru só com o cookie de sessão, igual ao createLink — medido
// pela sonda scripts/ml-afiliados-desempenho-probe.js em 29/09/2026. Nada aqui lê
// HTML.
//
// O cookie é o que cada usuário cola na aba Mercado Livre (affiliate_config.ml),
// o MESMO do createLink. Nunca o da conta do sistema.
//
// Os números não são guardados no banco: o painel calcula no servidor dele o
// resumo do período (compradores únicos, ganho por tipo de parceria, vendas não
// efetivadas), e isso não se remonta somando dias. Então a gente pergunta ao ML
// o período que a tela pediu e segura a resposta num cache curto.
const affiliate = require("../scraping/affiliate");
const { UA } = require("../scraping/scraper");
const { DesempenhoError, DIA_RE, somaDias, diasEntre, validaFormato, criaCache } = require("./comum");

const BASE = "https://www.mercadolivre.com.br/affiliate-program/api/dashboard";
const REFERER = "https://www.mercadolivre.com.br/afiliados/dashboard";

// O ML recusa (HTTP 400) um período de 1 ano; 6 meses passa.
const MAX_DIAS = 180;
const TIMEOUT_MS = 20000;
const POR_PAGINA = 50;
const MAX_PAGINAS = 8;   // 8 × 50 dias cobre com folga os 180

// O painel atualiza uma vez por dia (ver criaCache em ./comum).
const cacheado = criaCache();

const KIND = affiliate.ML_LINK_KIND;

// ────────────────────────────────────────────────────────────────────────
// Datas
// ────────────────────────────────────────────────────────────────────────

// Valida o período pedido pela tela. Devolve null quando está ok, ou o motivo.
function validaPeriodo(from, to) {
  const invalido = validaFormato(from, to);
  if (invalido) return invalido;
  if (diasEntre(from, to) + 1 > MAX_DIAS) return `O Mercado Livre só responde períodos de até ${MAX_DIAS} dias.`;
  return null;
}

// O filtro que o painel manda: dia inicial à meia-noite de Brasília até a
// meia-noite do dia SEGUINTE ao final. O próprio painel faz assim — "1/jul até
// 28/set" sai como `2026-07-01T00:00…--2026-09-29T00:00…`.
function filtroPeriodo(from, to) {
  return `${from}T00:00:00.000-03:00--${somaDias(to, 1)}T00:00:00.000-03:00`;
}

// ────────────────────────────────────────────────────────────────────────
// Normalização (pura)
// ────────────────────────────────────────────────────────────────────────

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function porId(lista) {
  const out = {};
  for (const x of Array.isArray(lista) ? lista : []) if (x && x.id) out[x.id] = x;
  return out;
}

// Resposta de `/dashboard/general` → o resumo do período.
//
// Os quatro cards de contagem do painel são "Cliques totais", "Compradores
// totais", "Ordens estimadas" e "Prod. estimados", e a API manda cinco ids
// (clicks, buyers, requests, orders, sales). `orders` → Ordens e `sales` →
// Produtos é dedução pelo nome, feita com uma conta sem venda nenhuma: quando
// aparecer a primeira venda, confira contra o painel. `requests` não aparece em
// card nenhum e fica de fora.
function normalizaResumo(json) {
  const data = porId(json?.data);
  const com = porId(json?.commissions);
  const sales = porId(json?.sales);
  const clicks = data.clicks || {};
  return {
    clicks: num(clicks.current_amount),
    clicksVariation: typeof clicks.variation === "number"
      ? { pct: clicks.variation, direction: String(clicks.variation_indicator || "").toLowerCase() || null }
      : null,
    buyers: num(data.buyers?.current_amount),
    orders: num(data.orders?.current_amount),
    units: num(data.sales?.current_amount),
    earnings: {
      total: num(com.summary?.current_amount),
      marketplace: num(com.marketplace?.current_amount),
      seller: num(com.seller?.current_amount),
      brand: num(com.brand?.current_amount),
    },
    grossSales: num(sales.total_gross_sales?.current_amount),
    estimatedSales: num(sales.total_estimated_sales?.current_amount),
    notEffectiveSales: num(sales.total_not_effective_sales?.current_amount),
    notEffectiveCount: num(sales.count_not_effective_sales?.current_amount),
    lastUpdate: json?.last_update || null,
  };
}

// Itens de `/dashboard/detalle-diario/general` → um dia por data, do primeiro ao
// último do período, com zero nos dias sem movimento (o ML só manda os que tiveram).
// `touchpoints` é o clique do dia: a soma deles bate com o `clicks` do resumo.
function normalizaDias(itens, from, to) {
  const porData = new Map();
  for (const it of Array.isArray(itens) ? itens : []) {
    if (it && DIA_RE.test(String(it.date))) porData.set(it.date, it);
  }
  const out = [];
  for (let d = from; d <= to; d = somaDias(d, 1)) {
    const it = porData.get(d) || {};
    out.push({
      date: d,
      clicks: num(it.touchpoints),
      orders: num(it.orders),
      units: num(it.quantity),
      earnings: num(it.earnings),
      coupons: num(it.coupons),
    });
  }
  return out;
}

// Itens de `/dashboard/ganancias` → uma linha por etiqueta de afiliado. A conta
// pode ter várias etiquetas, e é por elas que o painel separa a origem da venda.
function normalizaEtiquetas(itens) {
  return (Array.isArray(itens) ? itens : [])
    .filter(it => it && it.tag)
    .map(it => ({
      tag: String(it.tag),
      clicks: num(it.clicks ?? it.touchpoints),
      units: num(it.quantity),
      earnings: num(it.earnings),
      conversion: num(it.cvr),
    }))
    .sort((a, b) => b.earnings - a.earnings || b.clicks - a.clicks);
}

// ────────────────────────────────────────────────────────────────────────
// Chamadas ao ML
// ────────────────────────────────────────────────────────────────────────

// GET num endpoint do painel. Cookie vencido aparece de dois jeitos: 401/403 ou
// 302 pro login (é o que o ML faz hoje) — os dois viram KIND.COOKIE.
async function getPainel(caminho, params, cookie) {
  const qs = new URLSearchParams(params).toString();
  let res;
  try {
    res = await fetch(`${BASE}/${caminho}?${qs}`, {
      headers: {
        "Cookie": cookie,
        "User-Agent": UA,
        "Accept": "application/json, text/plain, */*",
        "Referer": REFERER,
      },
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new DesempenhoError(KIND.ERRO, `O Mercado Livre não respondeu (${err.name === "TimeoutError" ? "tempo esgotado" : err.message}).`);
  }
  const location = res.headers.get("location") || "";
  if (res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400 && /login/i.test(location))) {
    throw new DesempenhoError(KIND.COOKIE, "O cookie do Mercado Livre venceu — cole um novo na aba Mercado Livre.", 409);
  }
  if (!res.ok) {
    throw new DesempenhoError(KIND.ERRO, `O Mercado Livre respondeu HTTP ${res.status} ao buscar as métricas.`);
  }
  try {
    return await res.json();
  } catch {
    throw new DesempenhoError(KIND.ERRO, "O Mercado Livre devolveu uma resposta que não é JSON.");
  }
}

// O detalhe diário vem paginado (e ordenado por ganho, não por data): junta
// todas as páginas. O teto de páginas garante fim mesmo se o total vier errado.
async function buscaDias(filtro, cookie) {
  const itens = [];
  for (let page = 1; page <= MAX_PAGINAS; page++) {
    const json = await getPainel("detalle-diario/general", {
      metric_tab: "general", filter_time_range: filtro, type: "GENERAL",
      items_per_page: String(POR_PAGINA), page: String(page),
    }, cookie);
    const lista = Array.isArray(json?.item_list) ? json.item_list : [];
    itens.push(...lista);
    const total = num(json?.total_results);
    if (!lista.length || itens.length >= total) break;
  }
  return itens;
}

// Busca o período no ML, sem cache. Lança DesempenhoError.
async function buscaDesempenho({ cookie, from, to }) {
  const filtro = filtroPeriodo(from, to);
  const base = { metric_tab: "general", filter_time_range: filtro, type: "GENERAL" };
  const [geral, dias, ganhos] = await Promise.all([
    getPainel("general", base, cookie),
    buscaDias(filtro, cookie),
    getPainel("ganancias", { ...base, items_per_page: String(POR_PAGINA), page: "1" }, cookie),
  ]);
  return {
    from,
    to,
    summary: normalizaResumo(geral),
    days: normalizaDias(dias, from, to),
    tags: normalizaEtiquetas(ganhos?.item_list),
  };
}

// Aviso de cookie vencido: o mesmo do createLink (o cookie é o mesmo). Lazy e
// em silêncio, pelo mesmo motivo de lá — a notificação é acessório.
function avisaCookie(userId, ok, tag) {
  try { require("../notifications/affiliate-alert").mlCookieState(userId, ok, tag); }
  catch { /* notificação é acessório */ }
}

// O que a rota chama. `refresh` fura o cache, mas não mais que uma vez por
// minuto por período — o botão da tela não vira martelo no ML.
async function desempenhoDoUsuario(userId, { from, to, refresh = false, now = Date.now() } = {}) {
  const invalido = validaPeriodo(from, to);
  if (invalido) throw new DesempenhoError("periodo-invalido", invalido, 400);

  // Só o cookie importa aqui: o painel responde pela sessão. A tag vai só pro aviso.
  const { tag, cookie } = affiliate.readMLConfig(userId);
  if (!cookie) {
    throw new DesempenhoError(KIND.SEM_CONFIG, "Cole o cookie de afiliado na aba Mercado Livre pra ver o desempenho.", 409);
  }

  return cacheado(`${userId}|${from}|${to}`, { refresh, now }, async () => {
    let data;
    try {
      data = await buscaDesempenho({ cookie, from, to });
    } catch (err) {
      if (err instanceof DesempenhoError && err.kind === KIND.COOKIE) avisaCookie(userId, false, tag);
      throw err;
    }
    avisaCookie(userId, true, tag);
    return data;
  });
}

function _resetCache() { cacheado.reset(); }

module.exports = {
  desempenhoDoUsuario,
  buscaDesempenho,
  DesempenhoError,
  // puras, exportadas pros testes
  validaPeriodo,
  filtroPeriodo,
  normalizaResumo,
  normalizaDias,
  normalizaEtiquetas,
  MAX_DIAS,
  _resetCache,
};
