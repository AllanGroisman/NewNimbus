// Hub de Afiliados do Mercado Livre (mercadolivre.com.br/afiliados/hub).
//
// A página só existe logado, então tudo aqui depende da SESSÃO DO SISTEMA
// (affiliate.getScraperMLSession) — nunca do cookie de um usuário.
//
// O Hub NÃO é raspado do HTML: a própria página busca as ofertas numa API interna
// (`/affiliate-program/api/hub/search`) que devolve os cards prontos em JSON, no
// formato "polycard". Chamar essa API por fora não funciona (GET dá 404, POST dá
// 403 — falta o CSRF e os cabeçalhos que o ML monta no navegador), então abrimos o
// Hub no Chrome e ESCUTAMOS as respostas que a página busca sozinha, rolando pra
// carregar mais. O que a gente lê é exatamente o que o navegador recebeu.
const fs = require("fs");
const path = require("path");
const { autoScroll, parseMLReviewCompacted } = require("./scraper");
const { withMLSessionPage, clickByText } = require("./ml-session-page");

const HUB_URL = "https://www.mercadolivre.com.br/afiliados/hub";
const MAX_BODY_CHARS = 200 * 1024;   // corpo de XHR guardado no dump

// A API interna que serve os cards do Hub.
const HUB_SEARCH_RE = /affiliate-program\/api\/hub\/search/i;

// Rolagem: cada resposta traz ~18 cards. Paramos ao bater o limite, quando duas
// rodadas seguidas não trazem card novo, ou no teto de segurança.
const MAX_SCROLL_ROUNDS = 15;
const IDLE_ROUNDS_TO_STOP = 2;
const SCROLL_WAIT_MS = 1500;

// Contagem grosseira de cards, só pra dizer "a página tem conteúdo" no teste de acesso.
const CARD_SELECTORS = [".poly-card", "[class*='card']", "[data-testid*='card']"];

// Nossas categorias → categoria do filtro do Hub. Os ids são os mesmos MLB que o
// ML usa em todo lugar; o rótulo é o texto do item no menu, que é por onde a gente
// clica. Fica aqui (e não em CATEGORIES, no scraper.js) porque o frontend mantém
// uma cópia manual daquela lista — mexer lá obrigaria mexer nos dois.
const HUB_CATEGORIES = {
  bebe:        { id: "MLB1384", label: "Bebês" },
  gamer:       { id: "MLB1144", label: "Games" },
  eletronicos: { id: "MLB1000", label: "Eletrônicos, Áudio e Vídeo" },
  casa:        { id: "MLB1574", label: "Casa, Móveis e Decoração" },
  beleza:      { id: "MLB1246", label: "Beleza e Cuidado Pessoal" },
  brinquedos:  { id: "MLB1132", label: "Brinquedos e Hobbies" },
  roupas:      { id: "MLB1430", label: "Calçados, Roupas e Bolsas" },
  esportes:    { id: "MLB1276", label: "Esportes e Fitness" },
  informatica: { id: "MLB1648", label: "Informática" },
  pet:         { id: "MLB1071", label: "Pet Shop" },
};

// Decide o que aconteceu a partir do que a página mostrou. Pura → testável sem navegador.
// Devolve { ok, reason, kind } com kind ∈ login | captcha | empty | ok.
function classifyHubResult({ finalUrl = "", title = "", bodyText = "", cardCount = 0 } = {}) {
  const url = String(finalUrl);
  const hay = `${title}\n${bodyText}`;

  if (/\/gz\/|\/lgz\/|account-verification|\/login|signin/i.test(url) ||
      /acesse sua conta|para continuar, acesse|informe seu e-mail ou telefone/i.test(hay)) {
    return {
      ok: false,
      kind: "login",
      reason: "O Mercado Livre pediu login — a sessão da conta do sistema expirou. Cole um cookie novo.",
    };
  }

  if (/\/captcha\/wall/i.test(url) || /seguridad|captcha|n[ãa]o sou um rob[ôo]|no soy un robot/i.test(hay)) {
    return {
      ok: false,
      kind: "captcha",
      reason: "O Mercado Livre pediu verificação (CAPTCHA) — tente de novo daqui a alguns minutos.",
    };
  }

  if (!/\/afiliados/i.test(url)) {
    return {
      ok: false,
      kind: "login",
      reason: `O Mercado Livre desviou para outra página (${url}) — provavelmente a sessão não vale mais.`,
    };
  }

  if (!cardCount) {
    return {
      ok: true,
      kind: "empty",
      reason: "Entrou no Hub, mas nenhuma oferta apareceu — pode ser mudança de layout ou conta sem programa de afiliados ativo.",
    };
  }

  return { ok: true, kind: "ok", reason: `Entrou no Hub (${cardCount} blocos de oferta visíveis).` };
}

// Veredito final: a leitura específica do Hub tem precedência sobre o detectBlockPage
// genérico — o muro de login do ML tem palavras que o detector genérico confunde com
// CAPTCHA, e "revise o cookie" é uma orientação melhor que "tente daqui a pouco".
// O detector genérico só entra quando o Hub abriu e mesmo assim há bloqueio.
function verdictFor({ finalUrl, title, bodyText, cardCount, blocked }) {
  const v = classifyHubResult({ finalUrl, title, bodyText, cardCount });
  if (v.ok && blocked?.blocked) {
    return { ok: false, kind: blocked.captcha ? "captcha" : "login", reason: blocked.reason };
  }
  return v;
}

// ────────────────────────────────────────────────────────────────────────
// polycard (JSON do ML) → produto do catálogo
// ────────────────────────────────────────────────────────────────────────

function componentOf(card, type) {
  return (card?.components || []).find(c => c?.type === type) || null;
}

// Monta a URL da imagem a partir do template do ML
// ("https://http2.mlstatic.com/D_{square}_NP{2x}_{id}-{size}{sanitized_title}.webp").
// Tamanho F = a maior versão, a mesma que a vitrine usa (upgradeMLImageUrl).
function buildPictureUrl(card, context) {
  const tpl = context?.picture_template;
  const id = card?.pictures?.pictures?.[0]?.id;
  if (!tpl || !id) return null;
  return tpl
    .replace("{square}", card?.pictures?.square || context?.picture_square_default || "Q")
    .replace("{2x}", "")
    .replace("{id}", id)
    .replace("{size}", "F")
    .replace("{sanitized_title}", "");
}

// Converte um card do Hub num produto no mesmo formato da vitrine (harvestMLCards).
// Pura → testável sem navegador. Card sem título ou sem preço devolve null.
function polycardToProduct(card, context = {}, category = null) {
  const title = componentOf(card, "title")?.title?.text;
  const priceComp = componentOf(card, "price")?.price;
  const price = priceComp?.current_price?.value;
  if (!title || typeof price !== "number") return null;

  const url = card?.metadata?.url;
  if (!url) return null;
  // Só a URL canônica do produto: os url_params são rastreamento da sessão do Hub
  // e a chave do catálogo sai do MLB de qualquer jeito (catalog/product-key.js).
  const link = /^https?:\/\//i.test(url) ? url : `${context?.url_prefix || "https://"}${url}`;

  const originalPrice = typeof priceComp?.previous_price?.value === "number"
    ? priceComp.previous_price.value
    : null;

  let discount = null;
  const label = priceComp?.discount_label?.text || "";
  const m = label.match(/(\d+)\s*%/);
  if (m) discount = parseInt(m[1], 10);
  if (discount == null && originalPrice && price && originalPrice > price) {
    discount = Math.round((1 - price / originalPrice) * 100);
  }

  // Mesmo formato de texto da vitrine ("Classificação 4.5 de 5 estrelas. Mais de
  // 5mil produtos vendidos."), então reusamos o parser de lá.
  const review = componentOf(card, "review_compacted")?.review_compacted;
  const visible = (review?.values || [])
    .filter(v => v?.type === "label")
    .map(v => v?.label?.text)
    .filter(Boolean)
    .join(" ");
  const { rating, sold } = parseMLReviewCompacted(review?.alt_text, visible);

  // A comissão — o que o Hub tem de diferente da vitrine — aparece em dois formatos:
  // "GANHOS 12%" solto no pill, ou "GANHOS EXTRAS" no pill e o "22%" num rótulo ao
  // lado. Juntamos os textos do chip e pegamos a primeira porcentagem.
  const chip = (card?.components || []).find(c => c?.type === "chip" && /commission/i.test(c?.id || ""));
  const chipTexts = [
    chip?.chip?.pill?.text,
    ...(chip?.chip?.pill?.values || []).map(v => v?.label?.text),
    chip?.chip?.label?.text,
  ].filter(t => typeof t === "string");
  const commission = (chipTexts.join(" ").match(/([\d.,]+\s*%)/) || [])[1] || null;

  const highlight = componentOf(card, "highlight")?.highlight?.text || null;

  return {
    name: String(title).trim(),
    link,
    img: buildPictureUrl(card, context),
    price,
    originalPrice,
    discount,
    category: category || null,
    rating: Number.isFinite(rating) ? rating : null,
    reviewsCount: null,          // o card do Hub não traz o nº de avaliações
    seller: null,                // nem o vendedor
    freeShipping: false,
    sold,
    store: "Mercado Livre",
    // Extras — vão pro payload jsonb do catálogo (catalog/pg.js:INDEXED_FIELDS).
    hub: true,
    commission,
    extraCommission: card?.metadata?.extra_commission === "true" || card?.metadata?.extra_commission === true,
    bestSeller: /mais vendido/i.test(highlight || ""),
    mlItemId: card?.metadata?.id || null,
    scrapedAt: new Date().toISOString(),
  };
}

// Abre o Hub com o cookie dado e chama `onPage(page)` antes de navegar (é onde
// os listeners de resposta são instalados). O trabalho pesado — cookie, stealth,
// muro de login/CAPTCHA — é o mesmo de qualquer página logada do ML e mora no
// ml-session-page.js; aqui sobra só o que é do Hub: a URL e a contagem de cards.
// Devolve { finalUrl, title, bodyText, cardCount, blocked } + o que onPage retornar em `extra`.
function withHubPage(cookie, onPage) {
  return withMLSessionPage(cookie, HUB_URL, onPage, {
    scrollAfterLoad: true,
    countSelectors: CARD_SELECTORS,
  });
}

// ────────────────────────────────────────────────────────────────────────
// Coleta das ofertas
// ────────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Escuta as respostas da API interna e vai acumulando os cards em `state`.
// Precisa ser instalado ANTES do goto — a primeira leva chega junto com a página.
function collectHubCards(page, state) {
  page.on("response", async (res) => {
    if (!HUB_SEARCH_RE.test(res.url())) return;
    try {
      const json = await res.json();
      const model = json?.polycard_client_model;
      if (!model) return;
      if (!state.context) state.context = model.polycard_context || null;
      if (!state.filters && Array.isArray(json.filters)) state.filters = json.filters;
      for (const card of model.polycards || []) state.cards.push(card);
    } catch { /* resposta descartada pelo Chrome ou não-JSON — ignora */ }
  });
}

// Aplica o filtro de categoria pela interface (o ML não aceita filtro por URL nem
// chamada direta na API). Descarta o que já tinha sido coletado sem filtro.
// Devolve true se o filtro pegou.
async function applyCategoryFilter(page, wanted, state) {
  if (!await clickByText(page, "Categorias")) return false;
  await sleep(800);
  if (!await clickByText(page, wanted.label)) return false;
  await clickByText(page, "Aplicar");   // alguns menus exigem confirmar; se não houver, tudo bem

  // Espera a nova leva chegar (a resposta filtrada) por até ~8s.
  const before = state.cards.length;
  for (let i = 0; i < 16 && state.cards.length === before; i++) await sleep(500);
  if (state.cards.length === before) return false;

  state.cards.splice(0, before);   // fora os cards do Hub sem filtro
  return true;
}

// Rola até juntar `limit` cards, parar de vir novidade ou bater o teto.
async function loadMoreCards(page, state, limit) {
  let idle = 0;
  for (let round = 0; round < MAX_SCROLL_ROUNDS && state.cards.length < limit && idle < IDLE_ROUNDS_TO_STOP; round++) {
    const before = state.cards.length;
    await autoScroll(page);
    await sleep(SCROLL_WAIT_MS);
    idle = state.cards.length > before ? 0 : idle + 1;
  }
}

// Coleta as ofertas do Hub. Devolve produtos no mesmo formato da vitrine pública,
// já passados pelos filtros de qualidade do admin e ordenados por desconto.
async function scrapeHub({ category = null, limit = 200 } = {}) {
  const affiliate = require("./affiliate");   // lazy: evita ciclo no boot
  const session = affiliate.getScraperMLSession();
  if (!session) {
    throw new Error("sem sessão do Mercado Livre do sistema — cole o cookie em Admin › Mercado Livre");
  }

  const state = { context: null, filters: null, cards: [] };
  const r = await withHubPage(session.cookie, (page) => collectHubCards(page, state));
  try {
    const verdict = verdictFor(r);
    if (!verdict.ok) {
      affiliate.recordMLHubCheck({ ok: false, reason: verdict.reason });
      throw new Error(verdict.reason);
    }

    const wanted = HUB_CATEGORIES[category];
    let filtered = false;
    if (wanted) {
      filtered = await applyCategoryFilter(r.page, wanted, state);
      if (!filtered) {
        console.warn(`[ml-hub] filtro "${wanted.label}" não pegou — coletando o Hub sem filtro de categoria`);
      }
    }

    await loadMoreCards(r.page, state, limit);

    const seen = new Set();
    const produtos = [];
    for (const card of state.cards) {
      const id = card?.metadata?.id;
      if (id) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      const p = polycardToProduct(card, state.context || {}, category);
      if (p) produtos.push(p);
    }

    const passed = produtos.filter(p => affiliate.passesMLFilters(p));
    passed.sort((a, b) => (b.discount || 0) - (a.discount || 0));
    const out = passed.slice(0, limit);

    const tag = category || "geral";
    console.log(`[ml-hub] ${tag}: ${state.cards.length} cards, ${produtos.length} produtos, ${out.length} aprovados${wanted && !filtered ? " (SEM filtro de categoria)" : ""}`);
    affiliate.recordMLHubCheck({
      ok: true,
      reason: `Última coleta: ${out.length} ofertas (${tag}${wanted && !filtered ? ", sem filtro de categoria" : ""}).`,
    });
    return out;
  } finally {
    await r.browser.close();
  }
}

// Testa se a sessão abre o Hub. Usado pelo botão "Testar acesso" do admin.
async function checkHubAccess(cookie) {
  const r = await withHubPage(cookie);
  try {
    return { ...verdictFor(r), finalUrl: r.finalUrl, title: r.title, cardCount: r.cardCount };
  } finally {
    await r.browser.close();
  }
}

// Salva o Hub em disco (HTML + print + XHRs + os produtos já convertidos).
// É o que mostra na hora se o ML mudou o formato dos cards.
// Nunca grava o cookie nem cabeçalhos de autenticação.
async function dumpHub(cookie, outDir, { category = null } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const xhr = [];
  const state = { context: null, filters: null, cards: [] };

  const r = await withHubPage(cookie, async (page) => {
    collectHubCards(page, state);
    page.on("response", async (res) => {
      try {
        const url = res.url();
        if (!/mercadolivre\.com\.br/i.test(url)) return;
        const type = res.headers()["content-type"] || "";
        if (!/json/i.test(type)) return;
        const body = await res.text();
        xhr.push({ url, status: res.status(), body: body.slice(0, MAX_BODY_CHARS), truncated: body.length > MAX_BODY_CHARS });
      } catch { /* resposta já descartada pelo Chrome — ignora */ }
    });
  });

  try {
    const verdict = verdictFor(r);

    const wanted = HUB_CATEGORIES[category];
    let filtered = false;
    if (verdict.ok && wanted) filtered = await applyCategoryFilter(r.page, wanted, state);

    const produtos = state.cards
      .map(c => polycardToProduct(c, state.context || {}, category))
      .filter(Boolean);

    fs.writeFileSync(path.join(outDir, "hub.html"), await r.page.content());
    await r.page.screenshot({ path: path.join(outDir, "hub.png"), fullPage: true });
    fs.writeFileSync(path.join(outDir, "hub-xhr.json"), JSON.stringify(xhr, null, 2));
    fs.writeFileSync(path.join(outDir, "hub-cards.json"), JSON.stringify(produtos, null, 2));
    fs.writeFileSync(path.join(outDir, "hub-meta.json"), JSON.stringify({
      at: new Date().toISOString(),
      hubUrl: HUB_URL,
      finalUrl: r.finalUrl,
      title: r.title,
      cardCount: r.cardCount,
      verdict,
      xhrCount: xhr.length,
      category,
      categoryFilterApplied: wanted ? filtered : null,
      hubCards: state.cards.length,
      produtos: produtos.length,
      // Categorias que o Hub oferece hoje — pra conferir o mapa HUB_CATEGORIES.
      hubFilters: state.filters,
    }, null, 2));

    return { outDir, verdict, xhrCount: xhr.length, cardCount: r.cardCount, finalUrl: r.finalUrl, produtos: produtos.length, filtered };
  } finally {
    await r.browser.close();
  }
}

module.exports = {
  HUB_URL,
  HUB_CATEGORIES,
  classifyHubResult,
  polycardToProduct,
  checkHubAccess,
  scrapeHub,
  dumpHub,
};
