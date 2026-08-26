// A aba de CUPONS do Mercado Livre (mercadolivre.com.br/cupons).
//
// Não confundir com o ml-coupon.js (singular): aquele testa UM código num produto
// levando o item até o checkout. Este aqui é a outra ponta — a lista de cupons que
// o ML oferece para a conta do sistema, com os produtos de cada um.
//
// A página só existe logada, então tudo depende da SESSÃO DO SISTEMA
// (affiliate.getScraperMLSession) — a mesma do Hub, nunca o cookie de um usuário.
//
// Como a página é por dentro (comprovado pelos dumps de 12/08 em logs/ml-coupons):
// ela é renderizada pelo framework "nordic" do ML e traz o conteúdo inteiro num
// JSON embutido — `window._n.ctx.r.appProps.pageProps`. Ou seja: NÃO se raspa DOM
// aqui. Lê-se o modelo, que já vem com campaign_id, valor, validade, tipo de
// ativação e a URL da vitrine de cada cupom. São dois pedaços: `landingData` (a
// vitrine da aba, ~6 cupons por categoria) e `filteredCouponsData` (a lista cheia
// de /cupons/filter, 30 por página) — é dessa segunda que sai o grosso da coleta.
//
// Duas coisas que o modelo ensina e mudam tudo:
//
//   1. Cupom ATIVO (`status.id === "ACTIVE"`) tem `action.type === "link"` e a URL
//      da vitrine dele. Cupom NÃO ativado (`INACTIVE`) tem `action.type === "button"`
//      ("Aplicar") e NENHUMA URL — em compensação é ele que traz o `code`.
//      Essa URL não é montável: ela usa um slug do ML (`_Container_toys-e-babys`),
//      não o id da campanha, e montar na mão devolve lista vazia (sonda de 18/08).
//      Ou seja: cupom não ativado NÃO tem produto pra raspar, e o único jeito de
//      ver a vitrine dele seria clicar "Aplicar" — o que ATIVA o cupom na conta do
//      sistema. É escrita, não leitura, e por isso o robô nunca faz.
//   2. O `code` NÃO é uma palavra tipo CUPOM100: é um token base64 de ativação,
//      amarrado à conta logada. A palavra digitável existe em outro lugar — o campo
//      "Inserir código do cupom" da mesma página —, e ela não pode ser ENUMERADA,
//      só TESTADA: o ML responde com a campanha a que a palavra pertence. É o que
//      liga a palavra que veio na legenda do grupo líder (repasse/capture.js) à
//      lista de produtos daquela campanha.
const fs = require("fs");
const path = require("path");
const { withMLSessionPage, snapshotPage, classifyMLWall, clickByPattern } = require("./ml-session-page");
const { autoScroll, detectBlockPage, harvestMLCards, upgradeMLImageUrl, applyAmazonStealth } = require("./scraper");
const { productKey } = require("../catalog/product-key");

const CUPONS_URL = "https://www.mercadolivre.com.br/cupons";
// A lista CHEIA de uma categoria. Descoberto na sonda: o botão "Ver mais 368
// cupons" da aba não abre modal nem busca por XHR — ele NAVEGA para cá
// (`/cupons/filter?all=true&ce_vertical=true&source_page=int_view_more_grouping`).
// Essa página traz 30 cupons por vez em `pageProps.filteredCouponsData`, com
// `pagination.total` dizendo quantas páginas existem, e aceita `&page=N`. É por
// aqui que se passa dos ~42 cupons da vitrine inicial para os milhares da conta.
const FILTER_URL = "https://www.mercadolivre.com.br/cupons/filter";
const FILTER_PAGE_SIZE = 30;
const MAX_FILTER_PAGES = 40;      // teto de segurança: 40 × 30 = 1.200 cupons por categoria
// Com o filtro de cupom de loja ligado, uma página inteira pode não render nada
// aproveitável — e aí o `porId.size < limit` deixaria a rodada varrer as 40
// páginas do teto de graça, com a conta do sistema. Cinco páginas seguidas sem
// novidade (~150 cupons lidos) é sinal de que não vem mais.
const MAX_PAGINAS_SEM_NOVIDADE = 5;
const FILTER_PAUSE_MS = 900;      // entre páginas da lista
const LISTA_BASE = "https://lista.mercadolivre.com.br";
const MAX_BODY_CHARS = 200 * 1024;   // corpo de XHR guardado no dump

// Contagem grosseira de blocos, só pra dizer "a página tem conteúdo" no teste de acesso.
const CARD_SELECTORS = ["[class*='coupon' i]", ".andes-card", "[class*='card' i]"];

// Ritmo. A conta é a MESMA do Hub e do testador de checkout: rajada aqui derruba
// os três de uma vez (CAPTCHA/verificação vale pra conta, não pra página).
const NAV_TIMEOUT_MS = 45000;
const COUPON_PAUSE_MS = 2000;        // entre a vitrine de um cupom e a do próximo
const PAGE_PAUSE_MS = 400;           // entre páginas da mesma vitrine
const CONTAINER_MAX_PAGES = 3;
const CONTAINER_PAGE_SIZE = 48;      // o `_Desde_` do ML anda de 48 em 48 (1, 49, 97...)

// Textos do fluxo do campo de palavra. Regex e não texto exato: o ML já chamou o
// botão de "Adicionar cupom" e de "Inserir cupom" em versões diferentes.
const CODE_OPEN_RE = /^(inserir|adicionar) c[óo]digo( do cupom)?$/i;
const CODE_APPLY_RE = /^(adicionar|inserir|aplicar) cupom$/i;

// Respostas que interessam guardar no dump: as que falam de cupom. Filtro largo de
// propósito — o nome exato da API interna só se descobre olhando o dump (o front
// da página se chama "smart-coupons-frontend" e o baseURL do app é "/coupons").
const COUPON_API_RE = /(coupon|cupon|smart-coupons)/i;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ────────────────────────────────────────────────────────────────────────
// Parte pura — é o que os testes cobrem, sem navegador
// ────────────────────────────────────────────────────────────────────────

// "R$ 1.234,56" / "1.900" → número. O modelo manda o valor em dois lugares: no
// texto ("Compra mínima R$ 1.900") e em `accessibility.fractional_amount` ("1900").
// O segundo é o bom; este parse existe pro primeiro, que é o fallback.
function parseAmount(v) {
  if (v == null) return null;
  const s = String(v).replace(/\s/g, "");
  const m = s.match(/(\d[\d.]*)(?:,(\d{1,2}))?/);
  if (!m) return null;
  const n = parseFloat(`${m[1].replace(/\./g, "")}.${m[2] || "0"}`);
  return Number.isFinite(n) ? n : null;
}

// O ML manda as miniaturas em http:// no JSON cru. Servir isso numa página https
// vira imagem quebrada por mixed content.
function toHttps(url) {
  return typeof url === "string" ? url.replace(/^http:\/\//i, "https://") : null;
}

function isoOrNull(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// A vitrine do cupom — a lista de produtos que ele cobre.
//
// Só existe para cupom ATIVADO, e a URL tem que vir do próprio modelo
// (`action.value`): ela usa um SLUG que o ML escolhe, não o id da campanha
// (`_Container_toys-e-babys?coupon_campaign_id=13471229`), então não dá pra
// montar na mão. A sonda testou os dois caminhos: com a URL do modelo vieram 52
// produtos; com `_Container_<campaignId>` montado, zero.
//
// Cupom NÃO ativado, portanto, não tem produto pra raspar — o ML só mostra a
// vitrine depois do "Eu quero", e clicar nisso ATIVA o cupom na conta do sistema
// (escrita, não leitura). Devolver null aqui é o que impede a rodada de gastar
// uma página por cupom para receber lista vazia.
function containerUrlFor(coupon) {
  return coupon?.containerUrl || null;
}

// Página N da vitrine. O `lista.mercadolivre.com.br` não pagina com `?page=`: ele
// põe `_Desde_<offset+1>` no CAMINHO, antes da query.
function containerPageUrl(url, pageNum) {
  if (pageNum <= 1) return url;
  const desde = (pageNum - 1) * CONTAINER_PAGE_SIZE + 1;
  const u = new URL(url);
  u.pathname = `${u.pathname.replace(/_Desde_\d+/i, "")}_Desde_${desde}`;
  return u.href;
}

// Cupom de LOJA (de um vendedor) × cupom de CAMPANHA (do ML). Três sinais, do mais
// confiável para o mais frágil:
//   1. `icon: "store"` — o próprio ML classifica o card, e nas duas fixtures isso
//      bate 100% com o `_CustId_` e com o subtítulo de loja. É o sinal bom, e ele
//      SÓ chega aqui porque o `camelToRaw` passou a preservar o campo.
//   2. `_CustId_<sellerId>` na URL da vitrine (campanha usa `_Container_`).
//   3. o subtítulo "Em produtos de <Loja>" — o único sinal que o cupom NÃO ativado
//      tem, já que ele não vem com URL nenhuma.
// O nome da loja só existe no subtítulo: o modelo não traz campo de vendedor.
function detectScope(raw, containerUrl, subtitulo) {
  const sellerName = (subtitulo || "").match(/em produtos de (.+)$/i)?.[1]?.trim() || null;
  const daLoja = raw?.icon === "store"
    || raw?.is_new_follower_coupon === true
    || (containerUrl ? /_CustId_/i.test(containerUrl) : false)
    || /em produtos de /i.test(subtitulo || "");
  return { scope: daLoja ? "store" : "campaign", sellerName: daLoja ? sellerName : null };
}

// Um cupom do modelo do ML → a linha que o sistema guarda.
// `raw` é o item de `groupings[].rawCoupons[]` (snake_case, que é o formato do ML;
// o camelCase da mesma lista é conversão do front deles e pode sumir sem aviso).
function parseCoupon(raw, groupings = []) {
  if (!raw || !raw.campaign_id) return null;

  const titulo = raw.title?.text || "";
  const acc = raw.title?.accessibility?.title || {};
  const subtitulo = raw.initial_subtitle?.text || null;

  // "50% OFF" × "R$ 90 OFF". O número vem do accessibility (já sem formatação);
  // o texto só diz QUAL dos dois é.
  const percentual = /%/.test(titulo);
  const value = parseAmount(acc.fractional_amount) ?? parseAmount(titulo);

  const minAcc = raw.amount?.accessibility?.min_amount || {};
  const capAcc = raw.amount?.accessibility?.cap_amount || {};
  // "Sem compra mínima." vem com fractional_amount "1" — ler o número ali daria
  // "mínimo de R$ 1", que é mentira. Quem manda é o rótulo.
  const semMinimo = /sem compra m[íi]nima/i.test(minAcc.label || raw.amount?.min_amount || "");

  const containerUrl = raw.action?.type === "link" && raw.action?.value ? raw.action.value : null;
  const { scope, sellerName } = detectScope(raw, containerUrl, subtitulo);

  return {
    campaignId: String(raw.campaign_id),
    title: titulo || null,
    subtitle: subtitulo,
    kind: percentual ? "percent" : (value != null ? "fixed" : "desconhecido"),
    value,
    minPurchase: semMinimo ? null : (parseAmount(minAcc.fractional_amount) ?? null),
    maxDiscount: parseAmount(capAcc.fractional_amount) ?? null,
    scope,
    sellerName,
    containerUrl,
    activated: raw.status?.id === "ACTIVE",
    activationType: raw.activation_type || null,
    // O token de ativação, quando o cupom ainda não foi aceito. NÃO é uma palavra
    // digitável — guardado só pra diagnóstico, nunca mostrado como "o código".
    activationToken: raw.code || null,
    startsAt: isoOrNull(raw.future_coupon_info?.start_date),
    expiresAt: isoOrNull(raw.future_coupon_info?.expiration_date),
    expiresText: raw.expiration_date?.text || null,
    iconUrl: toHttps(raw.icon_url),
    sampleItems: (raw.items || []).map(it => ({ img: toHttps(it.image_url), name: it.alt_text || null })).filter(x => x.img),
    groupings: [...groupings],
    // O que o ML disse sobre o card. É o que sustenta o `scope` acima, e responde
    // "por que esse virou loja?" meses depois — a coluna `ml_coupons.raw` existe
    // desde sempre e vinha gravando `{}`.
    raw: { icon: raw.icon ?? null, isNewFollowerCoupon: raw.is_new_follower_coupon ?? null },
    source: "ml-cupons",
  };
}

// O modelo inteiro da página → { total, bundlers, categories, coupons }.
//
// O mesmo cupom aparece em vários grupos (o 13907402 estava em 7), então a lista
// sai desduplicada por campaignId, guardando em que grupos ele apareceu — é o que
// permite depois dizer "esse cupom é de eletrônicos" sem abrir a página de novo.
function parseLanding(landing) {
  if (!landing || typeof landing !== "object") {
    return { total: null, bundlers: [], categories: [], coupons: [], groupings: [] };
  }

  const evt = landing.tracking?.view?.eventData || {};
  const porId = new Map();
  const grupos = [];

  for (const g of landing.groupings || []) {
    const crus = Array.isArray(g.rawCoupons) && g.rawCoupons.length ? g.rawCoupons : (g.coupons || []);
    grupos.push({ key: g.key || null, title: g.title || null, count: crus.length, more: g.moreCoupons?.text || null });
    for (const raw of crus) {
      // O camelCase (`coupons[]`) e o snake_case (`rawCoupons[]`) descrevem o mesmo
      // cupom; parseCoupon lê o snake, então normaliza o camelCase que sobrar.
      const item = raw.campaign_id ? raw : camelToRaw(raw);
      const c = parseCoupon(item, g.key ? [g.key] : []);
      if (!c) continue;
      const anterior = porId.get(c.campaignId);
      if (anterior) {
        if (g.key && !anterior.groupings.includes(g.key)) anterior.groupings.push(g.key);
        // O cupom pode vir ATIVO num grupo e não ativo em outro (o ML repete o card
        // em estados diferentes). Fica o que tem vitrine: é o único que serve.
        if (!anterior.containerUrl && c.containerUrl) Object.assign(anterior, c, { groupings: anterior.groupings });
        continue;
      }
      porId.set(c.campaignId, c);
    }
  }

  return {
    total: evt.paging?.total_coupons ?? landing.totalCouponsQuantity?.number ?? null,
    bundlers: Array.isArray(evt.bundlers) ? evt.bundlers : [],
    categories: (landing.shortcuts || []).find(s => s.key === "category")?.values || [],
    groupings: grupos,
    coupons: [...porId.values()],
  };
}

// O cupom camelCase de volta pro formato do ML (snake_case), que é o que o
// parseCoupon lê. Precisa existir por dois motivos: um grupo da aba pode vir sem
// `rawCoupons`, e a página /cupons/filter — de onde vem o grosso da coleta — só
// serve o camelCase.
function camelToRaw(c) {
  if (!c) return c;
  return {
    campaign_id: c.campaignId,
    // O `icon` é o que diz se o cupom é de loja, e a /cupons/filter (que é a origem
    // do grosso da coleta) só serve camelCase: perder o campo aqui era perder o
    // sinal justamente no caminho que importa.
    icon: c.icon,
    is_new_follower_coupon: c.isNewFollowerCoupon,
    title: c.title,
    initial_subtitle: c.initialSubtitle,
    amount: c.amount,
    action: c.action,
    code: c.code,
    status: c.status,
    activation_type: c.activationType,
    icon_url: c.iconUrl,
    items: (c.items || []).map(i => ({ image_url: i.imageUrl, alt_text: i.altText })),
    expiration_date: c.expirationDate,
    future_coupon_info: c.futureCouponInfo,
  };
}

// A URL da lista cheia. `grouping` é a chave do ML (ce_vertical, tb_vertical…),
// que é a mesma que aparece em `groupings[].key` da aba e em
// `availableGroupingsKeys`. Sem grouping, lista TODOS os cupons da conta.
function filterUrl({ grouping = null, page = 1 } = {}) {
  const u = new URL(FILTER_URL);
  u.searchParams.set("all", "true");
  if (grouping) u.searchParams.set(grouping, "true");
  if (page > 1) u.searchParams.set("page", String(page));
  return u.href;
}

// Uma página da lista cheia → { total, page, pages, coupons }. Pura.
//
// `filteredCouponsData` é o que o ML monta com os filtros aplicados;
// `activeCouponsData` é a listinha "seus cupons ativos" do topo — os dois trazem
// cupom, e o segundo costuma repetir o primeiro, então entram juntos e a
// desduplicação por campaignId resolve.
function parseFilterProps(props, grouping = null) {
  const d = props?.filteredCouponsData;
  if (!d) return { total: null, page: 1, pages: 1, coupons: [] };

  const porId = new Map();
  for (const bloco of [d, props.activeCouponsData]) {
    for (const c of bloco?.coupons || []) {
      const item = parseCoupon(c.campaign_id ? c : camelToRaw(c), grouping ? [grouping] : []);
      if (!item || porId.has(item.campaignId)) continue;
      porId.set(item.campaignId, item);
    }
  }

  return {
    total: d.totalCouponsQuantity?.number ?? null,
    page: d.pagination?.page ?? 1,
    pages: d.pagination?.total ?? 1,
    coupons: [...porId.values()],
  };
}

// Plano B do `extractLanding`: achar o modelo no HTML cru. O global é o caminho
// bom; isto aqui é o que salva o dump quando a página carregou pela metade.
function extractLandingFromHtml(html) {
  const s = String(html || "");
  const marca = s.indexOf("landingData");
  if (marca === -1) return null;
  // Anda pra trás até o `{` que abre o objeto que contém o landingData e tenta
  // parsear cada candidato — barato o suficiente e sem regex adivinhando aspas.
  for (const inicio of ["_n.ctx.r=", "__PRELOADED_STATE__=", "window.__NORDIC_RENDERING_CTX__="]) {
    const i = s.indexOf(inicio);
    if (i === -1) continue;
    const json = fatiaJson(s, s.indexOf("{", i + inicio.length));
    if (!json) continue;
    try {
      const found = findLanding(JSON.parse(json));
      if (found) return found;
    } catch { /* candidato não era JSON inteiro — segue */ }
  }
  return null;
}

// Recorta o objeto JSON que começa em `start`, contando chaves e respeitando
// string/escape. É o que permite pegar o modelo de dentro de um <script>.
function fatiaJson(s, start) {
  if (start < 0) return null;
  let nivel = 0, dentroDeString = false, escapado = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (escapado) { escapado = false; continue; }
    if (ch === "\\") { escapado = true; continue; }
    if (ch === '"') { dentroDeString = !dentroDeString; continue; }
    if (dentroDeString) continue;
    if (ch === "{") nivel++;
    else if (ch === "}") { nivel--; if (nivel === 0) return s.slice(start, i + 1); }
  }
  return null;
}

// Acha o landingData dentro de um objeto qualquer. O caminho conhecido é
// `appProps.pageProps.landingData`, mas o nordic já mudou de forma antes — a
// varredura curta custa nada e evita quebrar por causa de um nível a mais.
function findLanding(obj, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 6) return null;
  if (obj.landingData && typeof obj.landingData === "object") return obj.landingData;
  if (Array.isArray(obj.groupings) && (obj.totalCouponsQuantity || obj.header)) return obj;
  for (const v of Object.values(obj)) {
    const found = findLanding(v, depth + 1);
    if (found) return found;
  }
  return null;
}

// Decide o que aconteceu a partir do que a página mostrou. Pura → testável sem
// navegador. Devolve { ok, kind, reason } com kind ∈
// login | verificacao | captcha | sem-modelo | empty | ok.
//
// `sem-modelo` é um desfecho legítimo e separado de `empty`: "a página abriu e o
// JSON não estava lá" é mudança de layout (conserta-se no código); "abriu e veio
// zero cupom" é a conta não ter cupom nenhum hoje (não se conserta em lugar nenhum).
function classifyCuponsResult({ finalUrl = "", title = "", bodyText = "", modelFound = false, couponCount = 0 } = {}) {
  const url = String(finalUrl);
  const hay = `${title}\n${bodyText}`;

  const muro = classifyMLWall({ finalUrl: url, bodyText: hay });
  if (muro) return { ok: false, kind: muro.status, reason: muro.reason };

  if (!/\/cupons|\/coupons/i.test(url)) {
    return { ok: false, kind: "login", reason: `O Mercado Livre desviou para outra página (${url}) — provavelmente a sessão não vale mais.` };
  }
  if (!modelFound) {
    return { ok: false, kind: "sem-modelo", reason: "A página de cupons abriu, mas o JSON com os cupons não estava nela — o layout do ML provavelmente mudou. Rode o scripts/ml-cupons-dump.js e olhe o cupons.html salvo." };
  }
  if (!couponCount) {
    return { ok: true, kind: "empty", reason: "Entrou na página de cupons, mas nenhum cupom veio no modelo." };
  }
  return { ok: true, kind: "ok", reason: `Entrou na página de cupons (${couponCount} cupons no modelo).` };
}

// Veredito final: a leitura específica tem precedência sobre o detectBlockPage
// genérico, pelo mesmo motivo do Hub (o muro de login do ML tem palavras que o
// detector confunde com CAPTCHA, e "cole um cookie novo" orienta melhor).
function verdictFor({ finalUrl, title, bodyText, modelFound, couponCount, blocked }) {
  const v = classifyCuponsResult({ finalUrl, title, bodyText, modelFound, couponCount });
  if (v.ok && blocked?.blocked) {
    return { ok: false, kind: blocked.captcha ? "captcha" : "login", reason: blocked.reason };
  }
  return v;
}

// A resposta do ML a uma PALAVRA digitada no "Inserir código do cupom".
// Pura → testável com o JSON salvo (é o formato das linhas de ml_coupon_codes).
//
// Devolve { verdict, campaignId, message, responseCode } com verdict ∈
// valid | invalid | indeterminado. `valid` aqui significa "a palavra EXISTE e o ML
// disse a que campanha ela pertence" — inclusive quando a campanha está vencida,
// que é informação boa: a palavra é real, só chegou tarde.
function classifyCodeCheck(json) {
  if (!json || typeof json !== "object") {
    return { verdict: "indeterminado", campaignId: null, message: null, responseCode: null };
  }
  const evt = json.tracking?.event?.eventData || json.tracking?.eventData || {};
  const responseCode = evt.response_code || json.response_code || null;
  const message = json.responseMessage?.text || json.message || null;
  const campaignRaw = json.coupon?.campaignId ?? json.coupon?.campaign_id ?? evt.coupon?.campaign_id ?? null;
  // "0" é o campaign_id que o ML manda quando não reconheceu a palavra.
  const campaignId = campaignRaw && String(campaignRaw) !== "0" ? String(campaignRaw) : null;

  const tipo = evt.response_type || json.responseMessage?.type || null;

  // O ML tem DUAS respostas negativas, e confundi-las põe na tela o oposto da
  // verdade. "Confira se o cupom está correto" vem com response_code INVALID_1 e
  // coupon.campaign_id "0": ele avaliou a palavra e ela não existe. "Tivemos um
  // problema" vem sozinho — sem tracking, sem coupon, sem código nenhum: ele nem
  // chegou a avaliar. O segundo é engasgo do ML, não veredito sobre a palavra.
  const avaliou = !!responseCode || !!(json.coupon || evt.coupon);

  let verdict = "indeterminado";
  if (/^INVALID/i.test(responseCode || "")) verdict = "invalid";
  else if (campaignId) verdict = "valid";
  else if (tipo === "error") verdict = avaliou ? "invalid" : "indeterminado";
  else if (tipo === "success") verdict = "valid";

  return { verdict, campaignId, message, responseCode };
}

// ────────────────────────────────────────────────────────────────────────
// Parte com navegador
// ────────────────────────────────────────────────────────────────────────

// Escuta o que a página busca. `state.all` só é preenchido no dump; `state.coupon`
// guarda as respostas que falam de cupom — é o que revela a API interna quando o
// "Ver mais" passar a trazer lote novo por XHR em vez de re-renderizar.
function collectCouponResponses(page, state, { captureAll = false } = {}) {
  page.on("response", async (res) => {
    try {
      const url = res.url();
      if (!/mercadolivre\.com\.br|mercadolibre\.com/i.test(url)) return;
      if (!/json/i.test(res.headers()["content-type"] || "")) return;
      const body = await res.text();
      const entry = { url, status: res.status(), body: body.slice(0, MAX_BODY_CHARS), truncated: body.length > MAX_BODY_CHARS };
      if (captureAll) state.all.push(entry);
      if (COUPON_API_RE.test(url)) state.coupon.push(entry);
    } catch { /* resposta descartada pelo Chrome — ignora */ }
  });
}

// O modelo da página, lido de dentro do navegador. É o global do nordic; o HTML
// cru fica como plano B (extractLandingFromHtml).
async function readLanding(page) {
  const doGlobal = await page.evaluate(() => {
    const buscar = (obj, depth = 0) => {
      if (!obj || typeof obj !== "object" || depth > 6) return null;
      if (obj.landingData && typeof obj.landingData === "object") return obj.landingData;
      if (Array.isArray(obj.groupings) && (obj.totalCouponsQuantity || obj.header)) return obj;
      for (const v of Object.values(obj)) {
        const f = buscar(v, depth + 1);
        if (f) return f;
      }
      return null;
    };
    const raiz = window._n?.ctx?.r || window.__PRELOADED_STATE__ || window.__NORDIC_RENDERING_CTX__;
    try { return JSON.parse(JSON.stringify(buscar(raiz) || null)); } catch { return null; }
  }).catch(() => null);
  if (doGlobal) return doGlobal;
  return extractLandingFromHtml(await page.content().catch(() => ""));
}

// O `pageProps` inteiro do nordic. O landingData é um pedaço dele (a aba); a
// lista paginada é outro (`filteredCouponsData`), e quem lê cada um é o parse.
function readPageProps(page) {
  return page.evaluate(() => {
    try { return JSON.parse(JSON.stringify(window._n?.ctx?.r?.appProps?.pageProps || null)); } catch { return null; }
  }).catch(() => null);
}

// Abre a aba de cupons com o cookie dado. O trabalho pesado (stealth, cookie,
// ordem dos listeners) mora no ml-session-page.js, como no Hub.
function withCuponsPage(cookie, onPage) {
  return withMLSessionPage(cookie, CUPONS_URL, onPage, {
    scrollAfterLoad: true,
    countSelectors: CARD_SELECTORS,
    timeout: NAV_TIMEOUT_MS,
  });
}

// Varre a lista cheia (uma categoria, ou todas) até juntar `limit` cupons ou
// acabar a paginação. Uma página por vez, com pausa: são 30 cupons por página e
// a conta é a mesma do Hub.
//
// Não existe clique nenhum aqui de propósito — a sonda mostrou que o "Ver mais"
// só navega para esta URL, e navegar direto é mais firme do que caçar botão.
//
// `findCampaignId` é a varredura de UMA campanha: para na página em que ela
// aparecer, em vez de ir até o `limit`. Sem isso, procurar um cupom que está na
// página 2 custaria as 40 páginas do teto — navegação com a conta do Hub, que é
// justamente o que se economiza aqui.
async function crawlFilter(page, { grouping = null, limit = 200, skipStore = false, onProgress = null, findCampaignId = null } = {}) {
  const alvo = findCampaignId ? String(findCampaignId) : null;
  const porId = new Map();
  let total = null;
  let pages = 1;
  let ignoradosLoja = 0;
  let paginasSemNovidade = 0;
  let achou = false;

  for (let n = 1; n <= MAX_FILTER_PAGES && porId.size < limit; n++) {
    await page.goto(filterUrl({ grouping, page: n }), { waitUntil: "networkidle2", timeout: NAV_TIMEOUT_MS });
    await sleep(800);

    const props = await readPageProps(page);
    const parsed = parseFilterProps(props, grouping);
    total = parsed.total ?? total;
    pages = parsed.pages || 1;

    // Página sem cupom nenhum: ou acabou a lista, ou o ML mudou a página. Parar
    // aqui é melhor que insistir — quem chama compara com `pages` e sabe qual dos
    // dois foi.
    if (!parsed.coupons.length) break;

    let novosNaPagina = 0;
    for (const c of parsed.coupons) {
      // Cupom de loja fora ANTES de entrar na lista: é aqui que ele deixa de custar
      // uma aba do Chrome mais tarde, no laço de vitrines. Ele também não conta pro
      // `limit`, então a rodada vai mais fundo na paginação pra fechar a cota —
      // o teto continua sendo o MAX_FILTER_PAGES.
      if (skipStore && c.scope === "store") { ignoradosLoja++; continue; }
      const anterior = porId.get(c.campaignId);
      if (anterior) {
        for (const g of c.groupings) if (!anterior.groupings.includes(g)) anterior.groupings.push(g);
        // Fica a versão que TEM vitrine: é a única que serve pra raspar produto.
        if (!anterior.containerUrl && c.containerUrl) Object.assign(anterior, c, { groupings: anterior.groupings });
        continue;
      }
      porId.set(c.campaignId, c);
      novosNaPagina++;
      if (alvo && c.campaignId === alvo) { achou = true; break; }
      if (porId.size >= limit) break;
    }

    if (onProgress) await onProgress({ etapa: "cupons", pagina: n, de: pages, cupons: porId.size, ignoradosLoja, grouping });
    if (achou) break;
    paginasSemNovidade = novosNaPagina ? 0 : paginasSemNovidade + 1;
    if (paginasSemNovidade >= MAX_PAGINAS_SEM_NOVIDADE) break;
    if (n >= pages) break;
    await sleep(FILTER_PAUSE_MS + Math.floor(Math.random() * 500));
  }

  return { total, pages, ignoradosLoja, achou, coupons: [...porId.values()] };
}

// A vitrine de UM cupom: os produtos que aquele cupom cobre.
//
// É uma página de listagem normal do ML, então quem lê os cards é o harvestMLCards
// do scraper.js — o mesmo código da vitrine pública e do teste de produto. Escrever
// leitura de card nova aqui seria uma terceira cópia dos mesmos seletores.
async function scrapeCouponProducts(browser, coupon, { maxProducts = 100, maxPages = CONTAINER_MAX_PAGES } = {}) {
  const url = containerUrlFor(coupon);
  if (!url) {
    return {
      ok: false,
      reason: coupon.activated
        ? "cupom ativado, mas o ML não deu a URL da vitrine dele"
        : "cupom não ativado — o ML só mostra a vitrine depois do \"Eu quero\", e ativar mexeria na conta do sistema",
      products: [], url: null,
    };
  }

  const vistos = new Set();
  const products = [];
  let blocked = null;

  for (let pageNum = 1; pageNum <= maxPages && products.length < maxProducts; pageNum++) {
    const page = await browser.newPage();
    try {
      // Aba nova NÃO herda o disfarce da primeira (o stealth é por página), e sem
      // ele o lista.mercadolivre.com.br devolve "Hubo un error accediendo a esta
      // pagina" em vez da lista — foi exatamente assim que a primeira sonda leu
      // "0 produtos" numa vitrine que, clicada à mão, mostrava 48.
      await applyAmazonStealth(page);
      await page.goto(containerPageUrl(url, pageNum), { waitUntil: "networkidle2", timeout: NAV_TIMEOUT_MS, referer: CUPONS_URL });
      blocked = await detectBlockPage(page, "Mercado Livre");
      // Bloqueio é estado da SESSÃO, não daquela vitrine: continuar rodando os
      // outros cupons só queima a conta mais rápido. Quem chamou aborta a rodada.
      if (blocked?.blocked) return { ok: false, reason: blocked.reason, blocked, products, url };

      await autoScroll(page);
      const cards = await harvestMLCards(page, null);
      if (!cards.length) break;   // passou da última página

      let novos = 0;
      for (const p of cards) {
        if (!p.link || vistos.has(p.link)) continue;
        vistos.add(p.link);
        p.img = upgradeMLImageUrl(p.img);
        p.store = "Mercado Livre";
        products.push(p);
        novos++;
        if (products.length >= maxProducts) break;
      }
      if (!novos) break;   // o ML começou a repetir
    } catch (err) {
      return { ok: false, reason: err.message, products, url };
    } finally {
      await page.close().catch(() => {});
    }
    await sleep(PAGE_PAUSE_MS + Math.floor(Math.random() * 400));
  }

  return { ok: true, reason: null, products, url };
}

// Digita UMA palavra no campo "Inserir código do cupom" e lê o que o ML responde.
// É a única forma de descobrir a que campanha uma palavra pertence — a página não
// lista as palavras em lugar nenhum.
async function checkCouponWord(cookie, word) {
  const state = { coupon: [], all: [] };
  const r = await withCuponsPage(cookie, (page) => collectCouponResponses(page, state));
  try {
    const landing = await readLanding(r.page);
    const v = verdictFor({ ...r, modelFound: !!landing, couponCount: parseLanding(landing).coupons.length });
    if (!v.ok && v.kind !== "empty") return { ...v, word, verdict: "indeterminado" };

    const antes = state.coupon.length;
    if (!await clickByPattern(r.page, CODE_OPEN_RE, { maxLen: 40 })) {
      return { ok: false, kind: "sem-campo", word, verdict: "indeterminado", reason: "Não achei o \"Inserir código do cupom\" na página." };
    }
    await sleep(1500);

    const digitou = await r.page.evaluate((valor) => {
      const campos = Array.from(document.querySelectorAll("input"))
        .filter(el => el.offsetParent !== null && !el.disabled && el.type !== "hidden");
      const alvo = campos.find(el => /cupom|c[óo]digo|coupon/i.test(`${el.name || ""} ${el.id || ""} ${el.placeholder || ""} ${el.getAttribute("aria-label") || ""}`))
                || (campos.length === 1 ? campos[0] : null);
      if (!alvo) return false;
      alvo.focus();
      // Como no checkout: o React do ML não enxerga `el.value = x`.
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(alvo, valor);
      alvo.dispatchEvent(new Event("input", { bubbles: true }));
      alvo.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }, word).catch(() => false);
    if (!digitou) {
      return { ok: false, kind: "sem-campo", word, verdict: "indeterminado", reason: "Abri o \"Inserir código\" mas não achei onde digitar." };
    }

    if (!await clickByPattern(r.page, CODE_APPLY_RE, { maxLen: 30 })) await r.page.keyboard.press("Enter");

    // A resposta chega por XHR; o texto na tela é o segundo palpite.
    let resposta = null;
    for (let i = 0; i < 12 && !resposta; i++) {
      await sleep(500);
      for (const e of state.coupon.slice(antes)) {
        try {
          const json = JSON.parse(e.body);
          const c = classifyCodeCheck(json);
          if (c.verdict !== "indeterminado" || c.message) { resposta = { json, ...c }; break; }
        } catch { /* corpo não-JSON — ignora */ }
      }
    }

    if (!resposta) {
      const { bodyText } = await snapshotPage(r.page);
      return { ok: true, kind: "ok", word, verdict: "indeterminado", campaignId: null, responseCode: null,
        message: null, reason: "O ML não respondeu nada reconhecível para essa palavra.", bodyText: bodyText?.slice(0, 500) || "" };
    }

    return {
      ok: true, kind: "ok", word,
      verdict: resposta.verdict,
      campaignId: resposta.campaignId,
      responseCode: resposta.responseCode,
      message: resposta.message,
      raw: resposta.json,
      // "Não reconheceu" só vale quando o ML de fato avaliou a palavra. No engasgo
      // (verdict indeterminado) a mensagem dele — "Tivemos um problema" — sozinha
      // parece veredito sobre a palavra, então vem acompanhada do que ela é.
      reason: resposta.verdict === "indeterminado"
        ? `O ML respondeu ${resposta.message ? `"${resposta.message}"` : "com um erro"} — ele não chegou a avaliar a palavra.`
        : (resposta.message || (resposta.verdict === "valid" ? "O ML reconheceu a palavra." : "O ML não reconheceu a palavra.")),
    };
  } finally {
    await r.browser.close().catch(() => {});
  }
}

// Acha UMA campanha na lista da conta e, se pedido, raspa a vitrine dela.
//
// É o par do `checkCouponWord`: ele descobre QUE campanha a palavra é, este traz a
// campanha. Vale a pena procurar na lista de verdade em vez de montar a linha com o
// JSON da resposta porque digitar a palavra ATIVA o cupom na conta — e cupom ativado
// é o único que vem com `containerUrl`, que é o que permite ler os produtos.
//
// Não mexe no `_running` da rodada, mesmo padrão do `syncOneCoupon`: abre o próprio
// Chrome e fecha no fim. Quem chama é que decide não fazer isso no meio de uma rodada.
//
// `onProgress(parcial)` é o mesmo do `runPull`: a varredura pode levar minutos e é
// por ele que a tela mostra onde ela está.
async function findCampaign(cookie, campaignId, { withProducts = true, maxProducts = 100, onProgress = null } = {}) {
  const alvo = String(campaignId || "").trim();
  if (!alvo) throw new Error("Sem campanha para buscar.");

  if (onProgress) await onProgress({ etapa: "abrindo" });
  const r = await withCuponsPage(cookie, null);
  try {
    // 1. A aba: os ~40 cupons que ela mostra de cara. O cupom recém-ativado pela
    //    palavra costuma estar aqui, e esta parada não custa navegação nenhuma —
    //    a página já está aberta.
    const landing = await readLanding(r.page);
    const daAba = parseLanding(landing);
    const snap = await snapshotPage(r.page);
    const veredito = verdictFor({
      finalUrl: r.page.url(), title: snap.title, bodyText: snap.bodyText,
      modelFound: !!landing, couponCount: daAba.coupons.length, blocked: r.blocked,
    });
    if (!veredito.ok && veredito.kind !== "empty") {
      return { coupon: null, blocked: true, reason: veredito.reason };
    }

    let cupom = daAba.coupons.find(c => c.campaignId === alvo) || null;

    // 2. A lista cheia, parando na página em que ele aparecer. `skipStore: false`
    //    porque a campanha pedida PODE ser de loja — descartá-la aqui responderia
    //    "não achei" para algo que estava na página.
    if (!cupom) {
      const lista = await crawlFilter(r.page, {
        grouping: null,
        limit: MAX_FILTER_PAGES * 30,
        skipStore: false,
        findCampaignId: alvo,
        onProgress,
      });
      cupom = lista.coupons.find(c => c.campaignId === alvo) || null;
    }

    if (!cupom) {
      return {
        coupon: null,
        reason: "O ML reconheceu a palavra, mas essa campanha não aparece na lista de cupons da conta — ela pode ter vencido ou não valer para esta conta.",
      };
    }

    // 3. A vitrine. Falhar aqui NÃO invalida a importação: a campanha em si já é
    //    ganho, e o botão "Sincronizar produtos" da linha tenta de novo depois.
    let products = [];
    let reasonVitrine = null;
    if (withProducts) {
      if (onProgress) await onProgress({ etapa: "vitrine", campaignId: alvo, title: cupom.title });
      const res = await scrapeCouponProducts(r.browser, cupom, { maxProducts });
      if (res.ok) products = res.products || [];
      else reasonVitrine = res.reason;
    }

    return { coupon: cupom, products, reasonVitrine };
  } finally {
    await r.browser.close().catch(() => {});
  }
}

// ────────────────────────────────────────────────────────────────────────
// A rodada
// ────────────────────────────────────────────────────────────────────────

// Um Chrome por vez na conta do sistema. Duas rodadas simultâneas dobram a chance
// de CAPTCHA — e o CAPTCHA vale pra CONTA, ou seja, derruba o Hub junto.
let _running = null;
let _cancel = false;

function isRunning() { return !!_running; }
function cancel() { _cancel = true; }

// Puxa os cupons e, se pedido, a vitrine de cada um.
//
// `groupings` são as chaves de categoria do ML (ce_vertical, tb_vertical…); lista
// vazia = todos os cupons da conta. `limit` é por categoria — é o teto que segura
// a rodada, porque a conta tem milhares de cupons e cada vitrine é uma página a
// mais aberta com a mesma sessão do Hub.
//
// `skipStore` descarta o cupom de UMA loja já na leitura da lista, antes de ele
// virar página aberta no Chrome: ele não serve pra fila do repasse (vale só pros
// produtos daquele vendedor) e é o mais caro da rodada, porque é AUTOMATIC — ou
// seja, sempre ativado e sempre com vitrine pra raspar. Com ele ligado o `limit`
// passa a contar só cupom de campanha.
//
// `onProgress(parcial)` é chamado a cada etapa — é por onde a tela do admin
// acompanha uma rodada que dura minutos.
async function runPull({ groupings = [], limit = 60, withProducts = true, maxProductsPerCoupon = 100, skipStore = true } = {}, { onProgress = null } = {}) {
  if (_running) throw new Error("Já tem uma rodada de cupons rodando — espere ela terminar.");

  const affiliate = require("./affiliate");   // lazy: evita ciclo no boot
  const session = affiliate.getScraperMLSession();
  if (!session) throw new Error("Sem sessão do Mercado Livre do sistema — cole o cookie em Admin › Mercado Livre.");

  _cancel = false;
  _running = (async () => {
    const t0 = Date.now();
    const alvos = groupings.length ? groupings : [null];
    const porId = new Map();
    const avisos = [];
    let totalNoML = null;
    let categoriasDoML = [];

    const state = { coupon: [], all: [] };
    const r = await withCuponsPage(session.cookie, (page) => collectCouponResponses(page, state));
    const vitrines = [];
    let produtosVinculados = 0;
    let cuponsComVitrine = 0;
    let ignoradosLoja = 0;

    try {
      // A primeira parada é a aba em si: é ela que diz se a sessão vale, quantos
      // cupons a conta enxerga e quais categorias o ML oferece hoje.
      const landing = await readLanding(r.page);
      const snap = await snapshotPage(r.page);
      const daAba = parseLanding(landing);
      const veredito = verdictFor({
        finalUrl: r.page.url(), title: snap.title, bodyText: snap.bodyText,
        modelFound: !!landing, couponCount: daAba.coupons.length, blocked: r.blocked,
      });
      if (!veredito.ok) {
        affiliate.recordMLHubCheck({ ok: false, reason: veredito.reason, kind: veredito.kind });
        throw new Error(veredito.reason);
      }
      totalNoML = daAba.total;
      categoriasDoML = daAba.groupings;
      // Os ~40 cupons que a aba mostra de cara NÃO entram na coleta: a lista
      // paginada (`all=true`) já traz todos eles, e somar os dois faria o limite
      // da rodada mentir — e o limite é justamente o que segura quantas vitrines
      // serão abertas com a conta do sistema.

      for (const g of alvos) {
        if (_cancel) { avisos.push("Rodada cancelada."); break; }
        const chave = g?.key ?? g ?? null;
        const lista = await crawlFilter(r.page, { grouping: chave, limit, skipStore, onProgress });
        ignoradosLoja += lista.ignoradosLoja || 0;
        if (!lista.coupons.length) {
          avisos.push(lista.ignoradosLoja
            ? `A lista de "${chave || "todos"}" só trouxe cupom de loja (${lista.ignoradosLoja} ignorados).`
            : `A lista de "${chave || "todos"}" não devolveu cupom nenhum — pode ser categoria vazia ou a página ter mudado.`);
        }
        for (const c of lista.coupons) {
          const anterior = porId.get(c.campaignId);
          if (anterior) {
            for (const k of c.groupings) if (!anterior.groupings.includes(k)) anterior.groupings.push(k);
            if (!anterior.containerUrl && c.containerUrl) Object.assign(anterior, c, { groupings: anterior.groupings });
            continue;
          }
          porId.set(c.campaignId, c);
        }
      }

      const cupons = [...porId.values()];

      if (withProducts) {
        for (const cupom of cupons) {
          if (_cancel) { avisos.push("Rodada cancelada antes de terminar as vitrines."); break; }
          const res = await scrapeCouponProducts(r.browser, cupom, { maxProducts: maxProductsPerCoupon });
          // Bloqueio é estado da SESSÃO: seguir para o próximo cupom só queima a
          // conta mais rápido, e a conta é a mesma do Hub.
          if (res.blocked) {
            affiliate.recordMLHubCheck({ ok: false, reason: res.reason, kind: res.blocked?.kind });
            avisos.push(`Parei nas vitrines: ${res.reason}`);
            break;
          }
          vitrines.push({ campaignId: cupom.campaignId, url: res.url, ok: res.ok, reason: res.reason, products: res.products });
          if (res.ok) {
            cuponsComVitrine++;
            produtosVinculados += res.products.length;
          }
          if (onProgress) await onProgress({ etapa: "vitrines", cupons: cupons.length, vitrines: vitrines.length, produtos: produtosVinculados });
          await sleep(COUPON_PAUSE_MS + Math.floor(Math.random() * 800));
        }
      }

      affiliate.recordMLHubCheck({ ok: true, reason: `Última rodada de cupons: ${cupons.length} cupons, ${produtosVinculados} produtos.` });

      return {
        at: new Date().toISOString(),
        durationMs: Date.now() - t0,
        totalNoML,
        categoriasDoML,
        cupons,
        vitrines,
        cuponsComVitrine,
        ignoradosLoja,
        produtosVinculados,
        avisos,
        cancelada: _cancel,
      };
    } finally {
      await r.browser.close().catch(() => {});
    }
  })();

  try {
    return await _running;
  } finally {
    _running = null;
    _cancel = false;
  }
}

// Deixa só as `keep` sondas mais novas. Cada rodada larga ~2,5 MB (duas páginas
// inteiras em HTML e dois prints), e ninguém lembra de limpar — mesma disciplina
// do pruneRuns do ml-coupon.js.
function pruneRuns(baseDir, keep = 5) {
  try {
    const dirs = fs.readdirSync(baseDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .sort();
    for (const nome of dirs.slice(0, Math.max(0, dirs.length - keep))) {
      fs.rmSync(path.join(baseDir, nome), { recursive: true, force: true });
    }
  } catch { /* limpeza é best-effort */ }
}

// ────────────────────────────────────────────────────────────────────────
// Dump — a sonda que se roda quando o ML muda a página
// ────────────────────────────────────────────────────────────────────────

// Salva em disco tudo que a página mostrou: HTML, print, o modelo cru, os cupons
// já convertidos, TODAS as respostas JSON e um resumo. NUNCA grava o cookie.
async function dumpCupons(cookie, outDir, { grouping = null, limit = 60, container = null, word = null } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  pruneRuns(path.dirname(outDir));
  const state = { coupon: [], all: [] };
  const r = await withCuponsPage(cookie, (page) => collectCouponResponses(page, state, { captureAll: true }));

  const salvar = (nome, conteudo) => fs.writeFileSync(path.join(outDir, nome), typeof conteudo === "string" ? conteudo : JSON.stringify(conteudo, null, 2));

  try {
    // 1. A aba: o modelo com as categorias, o total da conta e os ~40 cupons da vitrine.
    const landing = await readLanding(r.page);
    const daAba = parseLanding(landing);
    salvar("cupons.html", await r.page.content());
    await r.page.screenshot({ path: path.join(outDir, "cupons.png"), fullPage: true }).catch(() => {});
    salvar("cupons-model.json", landing);

    // 2. A lista cheia, paginada — é de onde sai o grosso da coleta.
    const lista = await crawlFilter(r.page, { grouping, limit });
    salvar("filter-props.json", await readPageProps(r.page));
    salvar("filter.html", await r.page.content());
    await r.page.screenshot({ path: path.join(outDir, "filter.png"), fullPage: true }).catch(() => {});
    salvar("cupons-parsed.json", lista.coupons);
    salvar("cupons-xhr.json", state.all);
    salvar("cupons-api.json", state.coupon);

    // 3. A vitrine de um cupom. Por padrão pega um NÃO ativado quando existir: é o
    //    que responde se dá pra ler os produtos sem clicar "Aplicar" (ou seja, sem
    //    escrever nada na conta do sistema).
    const alvo = container
      ? lista.coupons.find(c => c.campaignId === String(container))
      : (lista.coupons.find(c => c.containerUrl && c.scope === "campaign") || lista.coupons.find(c => c.containerUrl));
    let vitrine = null;
    if (alvo) {
      const res = await scrapeCouponProducts(r.browser, alvo, { maxProducts: 120, maxPages: 2 });
      vitrine = {
        campaignId: alvo.campaignId, activated: alvo.activated, scope: alvo.scope,
        url: res.url, ok: res.ok, reason: res.reason, count: res.products.length,
      };
      salvar("container-items.json", { coupon: alvo, ...res });
    }

    // 4. Uma PALAVRA no campo "Inserir código do cupom", quando pedida.
    let codeCheck = null;
    if (word) {
      codeCheck = await checkCouponWord(cookie, word);
      salvar("code-check.json", codeCheck);
    }

    const meta = {
      at: new Date().toISOString(),
      cuponsUrl: CUPONS_URL,
      filterUrl: filterUrl({ grouping }),
      finalUrl: r.page.url(),
      title: r.title,
      grouping,
      modelFound: !!landing,
      totalNoML: daAba.total,
      bundlers: daAba.bundlers,
      categoriasDoML: daAba.categories,
      groupings: daAba.groupings,
      cuponsNaAba: daAba.coupons.length,
      cuponsNaLista: lista.coupons.length,
      paginasDaLista: lista.pages,
      totalDaLista: lista.total,
      ativados: lista.coupons.filter(c => c.activated).length,
      comVitrineNoModelo: lista.coupons.filter(c => c.containerUrl).length,
      xhrTotal: state.all.length,
      xhrDeCupom: [...new Set(state.coupon.map(e => e.url.split("?")[0]))],
      vitrine,
      codeCheck: codeCheck ? { word: codeCheck.word, verdict: codeCheck.verdict, campaignId: codeCheck.campaignId, responseCode: codeCheck.responseCode, message: codeCheck.message } : null,
      verdict: verdictFor({
        finalUrl: r.page.url(), title: r.title, bodyText: r.bodyText,
        modelFound: !!landing, couponCount: lista.coupons.length, blocked: r.blocked,
      }),
    };
    salvar("cupons-meta.json", meta);
    return { outDir, ...meta };
  } finally {
    await r.browser.close().catch(() => {});
  }
}

module.exports = {
  runPull,
  withCuponsPage,
  scrapeCouponProducts,
  checkCouponWord,
  findCampaign,
  dumpCupons,
  isRunning,
  cancel,
  CUPONS_URL,
  // puros — expostos pros testes
  parseAmount,
  detectScope,
  camelToRaw,
  parseCoupon,
  parseLanding,
  parseFilterProps,
  filterUrl,
  crawlFilter,
  containerUrlFor,
  containerPageUrl,
  extractLandingFromHtml,
  classifyCuponsResult,
  verdictFor,
  classifyCodeCheck,
  productKey,
};
