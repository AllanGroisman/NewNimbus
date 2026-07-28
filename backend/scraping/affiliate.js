const crypto = require("crypto");
const store = require("./affiliate-store");
const appConfig = require("../config");

// Chave em appConfig pro override admin do scraper Shopee.
// Sobrescreve "primeiro usuário com config" como fallback do admin-scraper.
const SCRAPER_SHOPEE_ADMIN_KEY = "scraper-shopee-admin";

// Filtros de qualidade aplicados aos resultados da Shopee. Ajustáveis no admin.
const SHOPEE_FILTERS_KEY = "shopee-scraper-filters";
const SHOPEE_FILTERS_DEFAULTS = {
  minRating: 0,           // 0 = sem filtro. Recomendado: 4.0
  minSales: 0,            // 0 = sem filtro. Recomendado: 100
  minPrice: 0,            // BRL
  maxPrice: 0,            // 0 = sem teto
  minCommissionRate: 0,   // 0.05 = 5%. 0 = sem filtro
  maxDiscount: 0,         // % máximo. Recomendado: 95 (corta "99% off" fake). 0 = sem filtro
  minDiscount: 0,         // % mínimo. >0 = só itens em promoção. 0 = sem filtro
  listType: 0,            // pré-seleção Shopee: 0=Recomendados, 1=Maior comissão, 2=Top performance
  sortType: 2,            // ordenação Shopee: 2=Mais vendidos (melhores produtos),
                          // 1=Relevância, 3=Preço, 4=Maior comissão (traz spam barato).
};

// Config persistida POR USUÁRIO via affiliate-store. Schema do `raw`:
//   { ml: { tag, cookie, updatedAt },
//     amazon: { tag, updatedAt },
//     shopee: { appId, appSecret, updatedAt } }
// Env vars (ML_AFFILIATE_TAG, AMAZON_AFFILIATE_TAG, SHOPEE_AFFILIATE_APP_ID, …)
// continuam funcionando como override GLOBAL — útil em dev ou pra fallback do
// admin-scraper (que roda fora de qualquer userId).

const ML_ENDPOINT = "https://www.mercadolivre.com.br/affiliate-program/api/v2/affiliates/createLink";
const SHOPEE_ENDPOINT = "https://open-api.affiliate.shopee.com.br/graphql";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias

// Caches per-user. Chave externa = userId, interna = link → { shortUrl, ts }.
const mlCache = new Map();
const amazonCache = new Map();
const shopeeCache = new Map();

// Telemetria per-user (last success/failure por loja).
// Estrutura: stats[userId] = { ml: {ok, fail, reason}, amazon: {...}, shopee: {...} }
const stats = new Map();

function ensureStats(userId) {
  let s = stats.get(userId);
  if (!s) {
    s = {
      ml:     { lastSuccessAt: null, lastFailureAt: null, lastFailureReason: null },
      amazon: { lastSuccessAt: null, lastFailureAt: null, lastFailureReason: null },
      shopee: { lastSuccessAt: null, lastFailureAt: null, lastFailureReason: null },
    };
    stats.set(userId, s);
  }
  return s;
}

function getCache(map, userId) {
  let m = map.get(userId);
  if (!m) { m = new Map(); map.set(userId, m); }
  return m;
}

// ────────────────────────────────────────────────────────────────────────
// Storage helpers
// ────────────────────────────────────────────────────────────────────────

function readMLConfig(userId) {
  if (process.env.ML_AFFILIATE_TAG && process.env.ML_AFFILIATE_COOKIE) {
    return { tag: process.env.ML_AFFILIATE_TAG.trim(), cookie: process.env.ML_AFFILIATE_COOKIE, source: "env", updatedAt: null };
  }
  if (!userId) return { tag: null, cookie: null, source: null, updatedAt: null };
  const raw = store.getRaw(userId);
  if (raw.ml && (raw.ml.tag || raw.ml.cookie)) {
    return { tag: raw.ml.tag || null, cookie: raw.ml.cookie || null, source: "file", updatedAt: raw.ml.updatedAt || null };
  }
  return { tag: null, cookie: null, source: null, updatedAt: null };
}

function readAmazonConfig(userId) {
  if (process.env.AMAZON_AFFILIATE_TAG) {
    return { tag: process.env.AMAZON_AFFILIATE_TAG.trim(), source: "env", updatedAt: null };
  }
  if (!userId) return { tag: null, source: null, updatedAt: null };
  const raw = store.getRaw(userId);
  if (raw.amazon && raw.amazon.tag) {
    return { tag: raw.amazon.tag, source: "file", updatedAt: raw.amazon.updatedAt || null };
  }
  return { tag: null, source: null, updatedAt: null };
}

function readShopeeConfig(userId) {
  if (process.env.SHOPEE_AFFILIATE_APP_ID && process.env.SHOPEE_AFFILIATE_APP_SECRET) {
    return {
      appId: process.env.SHOPEE_AFFILIATE_APP_ID.trim(),
      appSecret: process.env.SHOPEE_AFFILIATE_APP_SECRET,
      source: "env",
      updatedAt: null,
    };
  }
  if (!userId) return { appId: null, appSecret: null, source: null, updatedAt: null };
  const raw = store.getRaw(userId);
  if (raw.shopee && (raw.shopee.appId || raw.shopee.appSecret)) {
    return {
      appId: raw.shopee.appId || null,
      appSecret: raw.shopee.appSecret || null,
      source: "file",
      updatedAt: raw.shopee.updatedAt || null,
    };
  }
  return { appId: null, appSecret: null, source: null, updatedAt: null };
}

function writeMLConfig(userId, { tag, cookie }) {
  if (!userId) throw new Error("writeMLConfig exige userId");
  if (process.env.ML_AFFILIATE_TAG || process.env.ML_AFFILIATE_COOKIE) {
    throw new Error("Configuração ML vem de variável de ambiente — desligue ML_AFFILIATE_TAG/ML_AFFILIATE_COOKIE pra usar config dinâmica.");
  }
  const raw = { ...(store.getRaw(userId) || {}) };
  const cur = readMLConfig(userId);
  const next = {
    tag: tag !== undefined ? String(tag || "").trim() : cur.tag,
    cookie: cookie !== undefined ? String(cookie || "").trim() : cur.cookie,
    updatedAt: new Date().toISOString(),
  };
  raw.ml = next;
  store.setRaw(userId, raw, { mode: 0o600 });
  getCache(mlCache, userId).clear();
  const s = ensureStats(userId).ml;
  s.lastFailureAt = null;
  s.lastFailureReason = null;
  return next;
}

function writeAmazonConfig(userId, { tag }) {
  if (!userId) throw new Error("writeAmazonConfig exige userId");
  if (process.env.AMAZON_AFFILIATE_TAG) {
    throw new Error("Configuração Amazon vem de variável de ambiente — desligue AMAZON_AFFILIATE_TAG pra usar config dinâmica.");
  }
  const cleanTag = String(tag || "").trim();
  if (cleanTag && !/^[a-zA-Z0-9_-]{2,30}$/.test(cleanTag)) {
    throw new Error("Tag inválida — use letras, números, hífen ou sublinhado (ex: sualoja-20)");
  }
  const raw = { ...(store.getRaw(userId) || {}) };
  raw.amazon = { tag: cleanTag || null, updatedAt: new Date().toISOString() };
  store.setRaw(userId, raw, { mode: 0o600 });
  getCache(amazonCache, userId).clear();
  const s = ensureStats(userId).amazon;
  s.lastFailureAt = null;
  s.lastFailureReason = null;
  return raw.amazon;
}

function clearMLConfig(userId) {
  if (!userId) return;
  const raw = { ...(store.getRaw(userId) || {}) };
  delete raw.ml;
  if (Object.keys(raw).length) store.setRaw(userId, raw, { mode: 0o600 });
  else store.clear(userId);
  getCache(mlCache, userId).clear();
  const s = ensureStats(userId).ml;
  s.lastFailureAt = null;
  s.lastFailureReason = null;
}

function clearAmazonConfig(userId) {
  if (!userId) return;
  const raw = { ...(store.getRaw(userId) || {}) };
  delete raw.amazon;
  if (Object.keys(raw).length) store.setRaw(userId, raw, { mode: 0o600 });
  else store.clear(userId);
  getCache(amazonCache, userId).clear();
  const s = ensureStats(userId).amazon;
  s.lastFailureAt = null;
  s.lastFailureReason = null;
}

function writeShopeeConfig(userId, { appId, appSecret }) {
  if (!userId) throw new Error("writeShopeeConfig exige userId");
  if (process.env.SHOPEE_AFFILIATE_APP_ID || process.env.SHOPEE_AFFILIATE_APP_SECRET) {
    throw new Error("Configuração Shopee vem de variável de ambiente — desligue SHOPEE_AFFILIATE_APP_ID/SHOPEE_AFFILIATE_APP_SECRET pra usar config dinâmica.");
  }
  const cleanId = String(appId || "").trim();
  const cleanSecret = String(appSecret || "").trim();
  if (cleanId && !/^[a-zA-Z0-9_-]{4,64}$/.test(cleanId)) {
    throw new Error("App ID inválido — use letras, números, hífen ou sublinhado.");
  }
  if (cleanSecret && cleanSecret.length < 16) {
    throw new Error("Senha muito curta — confira o valor copiado do painel.");
  }
  const raw = { ...(store.getRaw(userId) || {}) };
  const cur = readShopeeConfig(userId);
  raw.shopee = {
    appId: cleanId || cur.appId || null,
    appSecret: cleanSecret || cur.appSecret || null,
    updatedAt: new Date().toISOString(),
  };
  store.setRaw(userId, raw, { mode: 0o600 });
  getCache(shopeeCache, userId).clear();
  const s = ensureStats(userId).shopee;
  s.lastFailureAt = null;
  s.lastFailureReason = null;
  return raw.shopee;
}

function clearShopeeConfig(userId) {
  if (!userId) return;
  const raw = { ...(store.getRaw(userId) || {}) };
  delete raw.shopee;
  if (Object.keys(raw).length) store.setRaw(userId, raw, { mode: 0o600 });
  else store.clear(userId);
  getCache(shopeeCache, userId).clear();
  const s = ensureStats(userId).shopee;
  s.lastFailureAt = null;
  s.lastFailureReason = null;
}

// ────────────────────────────────────────────────────────────────────────
// Status
// ────────────────────────────────────────────────────────────────────────

function status(userId) {
  const ml = readMLConfig(userId);
  const amazon = readAmazonConfig(userId);
  const shopee = readShopeeConfig(userId);
  const s = userId ? ensureStats(userId) : {
    ml: { lastSuccessAt: null, lastFailureAt: null, lastFailureReason: null },
    amazon: { lastSuccessAt: null, lastFailureAt: null, lastFailureReason: null },
    shopee: { lastSuccessAt: null, lastFailureAt: null, lastFailureReason: null },
  };
  const mlHealthy = !!(ml.tag && ml.cookie) && (!s.ml.lastFailureAt || (s.ml.lastSuccessAt && new Date(s.ml.lastSuccessAt) > new Date(s.ml.lastFailureAt)));
  return {
    // Compat com UI antiga: campos top-level são do ML
    configured: !!(ml.tag && ml.cookie),
    tag: ml.tag || null,
    cookieLength: ml.cookie ? ml.cookie.length : 0,
    cookiePreview: ml.cookie ? ml.cookie.slice(0, 30) + "…" : null,
    source: ml.source,
    updatedAt: ml.updatedAt,
    lastSuccessAt: s.ml.lastSuccessAt,
    lastFailureAt: s.ml.lastFailureAt,
    lastFailureReason: s.ml.lastFailureReason,
    healthy: mlHealthy,
    ml: {
      configured: !!(ml.tag && ml.cookie),
      tag: ml.tag || null,
      cookieLength: ml.cookie ? ml.cookie.length : 0,
      cookiePreview: ml.cookie ? ml.cookie.slice(0, 30) + "…" : null,
      source: ml.source,
      updatedAt: ml.updatedAt,
      lastSuccessAt: s.ml.lastSuccessAt,
      lastFailureAt: s.ml.lastFailureAt,
      lastFailureReason: s.ml.lastFailureReason,
      healthy: mlHealthy,
    },
    amazon: {
      configured: !!amazon.tag,
      tag: amazon.tag || null,
      source: amazon.source,
      updatedAt: amazon.updatedAt,
      lastSuccessAt: s.amazon.lastSuccessAt,
      lastFailureAt: s.amazon.lastFailureAt,
      lastFailureReason: s.amazon.lastFailureReason,
    },
    shopee: {
      configured: !!(shopee.appId && shopee.appSecret),
      appId: shopee.appId || null,
      appSecretLength: shopee.appSecret ? shopee.appSecret.length : 0,
      appSecretPreview: shopee.appSecret ? shopee.appSecret.slice(0, 6) + "…" : null,
      source: shopee.source,
      updatedAt: shopee.updatedAt,
      lastSuccessAt: s.shopee.lastSuccessAt,
      lastFailureAt: s.shopee.lastFailureAt,
      lastFailureReason: s.shopee.lastFailureReason,
      healthy: !!(shopee.appId && shopee.appSecret) && (!s.shopee.lastFailureAt || (s.shopee.lastSuccessAt && new Date(s.shopee.lastSuccessAt) > new Date(s.shopee.lastFailureAt))),
    },
  };
}

// ────────────────────────────────────────────────────────────────────────
// Mercado Livre
// ────────────────────────────────────────────────────────────────────────

async function gerarLinkAfiliadoML(userId, linkOriginal) {
  if (!linkOriginal || typeof linkOriginal !== "string") return null;
  const { tag, cookie } = readMLConfig(userId);
  if (!tag || !cookie) return null;

  const cache = getCache(mlCache, userId);
  const cached = cache.get(linkOriginal);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.shortUrl;

  const s = ensureStats(userId).ml;
  try {
    const res = await fetch(ML_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Cookie": cookie,
        "User-Agent": UA,
        "Origin": "https://www.mercadolivre.com.br",
        "Referer": "https://www.mercadolivre.com.br/afiliados",
      },
      body: JSON.stringify({ urls: [linkOriginal], tag }),
    });

    if (!res.ok) {
      s.lastFailureAt = new Date().toISOString();
      s.lastFailureReason = `HTTP ${res.status} — cookie pode ter expirado`;
      console.error(`[afiliados ML] ${s.lastFailureReason}`);
      return null;
    }

    const data = await res.json();
    const short = data?.urls?.[0]?.short_url || null;
    if (!short) {
      s.lastSuccessAt = new Date().toISOString();
      const apiMsg = data?.urls?.[0]?.error || data?.message || data?.error || null;
      s.lastFailureReason = apiMsg
        ? `Link inválido: ${String(apiMsg).slice(0, 120)}`
        : "Link inválido — use uma URL de produto/oferta do Mercado Livre (a home não funciona)";
      console.warn(`[afiliados ML] ${s.lastFailureReason}: ${JSON.stringify(data).slice(0, 200)}`);
      return null;
    }
    cache.set(linkOriginal, { shortUrl: short, ts: Date.now() });
    s.lastSuccessAt = new Date().toISOString();
    s.lastFailureReason = null;
    return short;
  } catch (err) {
    s.lastFailureAt = new Date().toISOString();
    s.lastFailureReason = err.message;
    console.error("[afiliados ML] erro:", err.message);
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────────
// Amazon BR
// ────────────────────────────────────────────────────────────────────────

function extractASIN(url) {
  if (!url || typeof url !== "string") return null;
  const decoded = (() => { try { return decodeURIComponent(url); } catch { return url; } })();
  const patterns = [
    /\/dp\/([A-Z0-9]{10})(?:[/?]|$)/i,
    /\/gp\/product\/([A-Z0-9]{10})(?:[/?]|$)/i,
    /\/gp\/aw\/d\/([A-Z0-9]{10})(?:[/?]|$)/i,
    /\/product\/([A-Z0-9]{10})(?:[/?]|$)/i,
    /\/[a-z]{2}\/dp\/([A-Z0-9]{10})(?:[/?]|$)/i,
    /\/exec\/obidos\/asin\/([A-Z0-9]{10})(?:[/?]|$)/i,
    /[?&]asin=([A-Z0-9]{10})\b/i,
  ];
  for (const p of patterns) {
    const m = decoded.match(p);
    if (m) return m[1].toUpperCase();
  }
  return null;
}

function gerarLinkAfiliadoAmazon(userId, linkOriginal) {
  if (!linkOriginal || typeof linkOriginal !== "string") return null;
  const { tag } = readAmazonConfig(userId);
  if (!tag) return null;

  const cache = getCache(amazonCache, userId);
  const cached = cache.get(linkOriginal);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.shortUrl;

  const s = ensureStats(userId).amazon;
  const asin = extractASIN(linkOriginal);
  if (!asin) {
    s.lastFailureAt = new Date().toISOString();
    s.lastFailureReason = "Não foi possível extrair o ASIN — URL não é de produto Amazon BR válida";
    return null;
  }

  const short = `https://www.amazon.com.br/dp/${asin}?tag=${encodeURIComponent(tag)}`;
  cache.set(linkOriginal, { shortUrl: short, ts: Date.now() });
  s.lastSuccessAt = new Date().toISOString();
  s.lastFailureReason = null;
  return short;
}

// ────────────────────────────────────────────────────────────────────────
// Shopee (Affiliate Open API — GraphQL)
// ────────────────────────────────────────────────────────────────────────

function signShopeeRequest({ appId, appSecret, timestamp, payload }) {
  const base = String(appId) + String(timestamp) + String(payload) + String(appSecret);
  const signature = crypto.createHash("sha256").update(base).digest("hex");
  return `SHA256 Credential=${appId}, Timestamp=${timestamp}, Signature=${signature}`;
}

// Lookup de UM item por itemId/shopId (usado pelo repasse: link único do grupo
// líder, sem busca por keyword/categoria). Mesmo endpoint/schema do scraping em
// massa (productOfferV2), só filtrando por ID em vez de keyword/productCatId.
function buildShopeeItemLookupPayload(itemId, shopId) {
  const query = `query{productOfferV2(itemId:${Number(itemId)},shopId:${Number(shopId)}){nodes{itemId shopId productName productLink offerLink imageUrl price priceMin priceDiscountRate sales commissionRate ratingStar shopName}pageInfo{page limit hasNextPage}}}`;
  return JSON.stringify({ query });
}

// Busca um item específico da Shopee usando o afiliado DO USUÁRIO (não o
// admin/scraper) — é o que o repasse precisa, já que a captura já garantiu
// que esse usuário tem afiliado Shopee configurado. Retorna o node cru (ou
// null) — o chamador mapeia os campos (mesmo formato de shopeeNodeToProduct).
async function fetchShopeeItemByIds(userId, itemId, shopId) {
  const { appId, appSecret } = readShopeeConfig(userId);
  if (!appId || !appSecret) return null;
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = buildShopeeItemLookupPayload(itemId, shopId);
  const authHeader = signShopeeRequest({ appId, appSecret, timestamp, payload });
  try {
    const res = await fetch(SHOPEE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": authHeader, "User-Agent": UA },
      body: payload,
    });
    if (!res.ok) {
      console.error(`[afiliados Shopee] fetchShopeeItemByIds HTTP ${res.status}`);
      return null;
    }
    const data = await res.json();
    if (data?.errors?.length) {
      console.warn(`[afiliados Shopee] fetchShopeeItemByIds erro API: ${JSON.stringify(data.errors).slice(0, 200)}`);
      return null;
    }
    return data?.data?.productOfferV2?.nodes?.[0] || null;
  } catch (err) {
    console.error(`[afiliados Shopee] fetchShopeeItemByIds falhou: ${err.message}`);
    return null;
  }
}

function buildShopeeShortLinkPayload(originUrl) {
  const safe = String(originUrl).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const query = `mutation{generateShortLink(input:{originUrl:"${safe}",subIds:["","","","",""]}){shortLink}}`;
  return JSON.stringify({ query });
}

function buildShopeeProductOfferPayload({ keyword, productCatId, page = 1, limit = 50, sortType = 4, listType = 0 }) {
  // keyword e productCatId são opcionais e combináveis. Com productCatId e sem
  // keyword, a API devolve produtos GERAIS da categoria (sem viés de busca textual).
  const parts = [];
  if (keyword) {
    const safe = String(keyword).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    parts.push(`keyword:"${safe}"`);
  }
  if (productCatId) parts.push(`productCatId:${Number(productCatId)}`);
  parts.push(`listType:${Number(listType)}`, `sortType:${Number(sortType)}`, `page:${Number(page)}`, `limit:${Number(limit)}`);
  const query = `query{productOfferV2(${parts.join(",")}){nodes{itemId shopId productName productLink offerLink imageUrl price priceMin priceMax priceDiscountRate sales commissionRate ratingStar shopName productCatIds} pageInfo{page limit hasNextPage}}}`;
  return JSON.stringify({ query });
}

async function gerarLinkAfiliadoShopee(userId, linkOriginal) {
  if (!linkOriginal || typeof linkOriginal !== "string") return null;
  const { appId, appSecret } = readShopeeConfig(userId);
  if (!appId || !appSecret) return null;

  const cache = getCache(shopeeCache, userId);
  const cached = cache.get(linkOriginal);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.shortUrl;

  const s = ensureStats(userId).shopee;
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = buildShopeeShortLinkPayload(linkOriginal);
  const authHeader = signShopeeRequest({ appId, appSecret, timestamp, payload });

  try {
    const res = await fetch(SHOPEE_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": authHeader,
        "User-Agent": UA,
      },
      body: payload,
    });

    if (!res.ok) {
      s.lastFailureAt = new Date().toISOString();
      s.lastFailureReason = `HTTP ${res.status} — confira App ID/senha no painel da Shopee`;
      console.error(`[afiliados Shopee] ${s.lastFailureReason}`);
      return null;
    }

    const data = await res.json();
    if (data?.errors?.length) {
      const msg = data.errors[0]?.message || "erro desconhecido";
      s.lastFailureAt = new Date().toISOString();
      s.lastFailureReason = `API: ${String(msg).slice(0, 120)}`;
      console.warn(`[afiliados Shopee] ${s.lastFailureReason}`);
      return null;
    }
    const short = data?.data?.generateShortLink?.shortLink || null;
    if (!short) {
      s.lastFailureAt = new Date().toISOString();
      s.lastFailureReason = "Resposta sem shortLink — URL pode não ser de produto Shopee válido";
      console.warn(`[afiliados Shopee] ${s.lastFailureReason}: ${JSON.stringify(data).slice(0, 200)}`);
      return null;
    }
    cache.set(linkOriginal, { shortUrl: short, ts: Date.now() });
    s.lastSuccessAt = new Date().toISOString();
    s.lastFailureReason = null;
    return short;
  } catch (err) {
    s.lastFailureAt = new Date().toISOString();
    s.lastFailureReason = err.message;
    console.error("[afiliados Shopee] erro:", err.message);
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────────
// Admin Shopee creds (override global pro admin-scraper)
// ────────────────────────────────────────────────────────────────────────

function readScraperShopeeAdminCreds() {
  const raw = appConfig.get(SCRAPER_SHOPEE_ADMIN_KEY);
  if (!raw || typeof raw !== "object") return { appId: null, appSecret: null, updatedAt: null };
  return {
    appId: raw.appId || null,
    appSecret: raw.appSecret || null,
    updatedAt: raw.updatedAt || null,
  };
}

function writeScraperShopeeAdminCreds({ appId, appSecret }) {
  const cleanId = String(appId || "").trim();
  const cleanSecret = String(appSecret || "").trim();
  if (cleanId && !/^[a-zA-Z0-9_-]{4,64}$/.test(cleanId)) {
    throw new Error("App ID inválido — use letras, números, hífen ou sublinhado.");
  }
  if (cleanSecret && cleanSecret.length < 16) {
    throw new Error("Senha muito curta — confira o valor copiado do painel.");
  }
  const cur = readScraperShopeeAdminCreds();
  const next = {
    appId: cleanId || cur.appId || null,
    appSecret: cleanSecret || cur.appSecret || null,
    updatedAt: new Date().toISOString(),
  };
  appConfig.set(SCRAPER_SHOPEE_ADMIN_KEY, next);
  return next;
}

function clearScraperShopeeAdminCreds() {
  appConfig.del(SCRAPER_SHOPEE_ADMIN_KEY);
}

// ────────────────────────────────────────────────────────────────────────
// Filtros de qualidade do Mercado Livre (admin-only)
// ────────────────────────────────────────────────────────────────────────

const ML_FILTERS_KEY = "ml-scraper-filters";
const ML_FILTERS_DEFAULTS = {
  minRating:   0,  // 0 = sem filtro
  minSales:    0,  // 0 = sem filtro
  minPrice:    0,  // BRL
  maxPrice:    0,  // 0 = sem teto
  maxDiscount: 0,  // % máximo; 0 = sem filtro
  minDiscount: 0,  // % mínimo. >0 = só itens em promoção. 0 = sem filtro
};

function readMLScraperFilters() {
  const raw = appConfig.get(ML_FILTERS_KEY);
  if (!raw || typeof raw !== "object") return { ...ML_FILTERS_DEFAULTS };
  return { ...ML_FILTERS_DEFAULTS, ...raw };
}

function writeMLScraperFilters(patch) {
  const cur = readMLScraperFilters();
  const num = (v, def) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : def; };
  const next = {
    minRating:   num(patch?.minRating,   cur.minRating),
    minSales:    num(patch?.minSales,    cur.minSales),
    minPrice:    num(patch?.minPrice,    cur.minPrice),
    maxPrice:    num(patch?.maxPrice,    cur.maxPrice),
    maxDiscount: num(patch?.maxDiscount, cur.maxDiscount),
    minDiscount: num(patch?.minDiscount, cur.minDiscount),
  };
  if (next.minRating > 5)   next.minRating = 5;
  if (next.maxDiscount > 100) next.maxDiscount = 100;
  if (next.minDiscount > 100) next.minDiscount = 100;
  appConfig.set(ML_FILTERS_KEY, next);
  return next;
}

// ────────────────────────────────────────────────────────────────────────
// Filtros de qualidade da Amazon (admin-only)
// ────────────────────────────────────────────────────────────────────────

const AMAZON_FILTERS_KEY = "amazon-scraper-filters";
const AMAZON_FILTERS_DEFAULTS = {
  minRating:   0,  // 0 = sem filtro
  minReviews:  0,  // 0 = sem filtro
  minPrice:    0,  // BRL
  maxPrice:    0,  // 0 = sem teto
  maxDiscount: 0,  // % máximo; 0 = sem filtro
  minDiscount: 0,  // % mínimo. >0 = só itens em promoção. 0 = sem filtro
  // Quantos produtos por rodada ganham nota/avaliações/vendas/vendedor/frete —
  // cada um exige abrir a página do produto (~5s e risco de CAPTCHA), por isso é
  // limitado. Só vale pras rodadas SEM filtro de nota/avaliações; com filtro o
  // scraper usa o teto maior (AMZ_ENRICH_MAX), senão o filtro cortaria tudo.
  enrichLimit: 40,
};

function readAmazonScraperFilters() {
  const raw = appConfig.get(AMAZON_FILTERS_KEY);
  if (!raw || typeof raw !== "object") return { ...AMAZON_FILTERS_DEFAULTS };
  return { ...AMAZON_FILTERS_DEFAULTS, ...raw };
}

function writeAmazonScraperFilters(patch) {
  const cur = readAmazonScraperFilters();
  const num = (v, def) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : def; };
  const next = {
    minRating:   num(patch?.minRating,   cur.minRating),
    minReviews:  num(patch?.minReviews,  cur.minReviews),
    minPrice:    num(patch?.minPrice,    cur.minPrice),
    maxPrice:    num(patch?.maxPrice,    cur.maxPrice),
    maxDiscount: num(patch?.maxDiscount, cur.maxDiscount),
    minDiscount: num(patch?.minDiscount, cur.minDiscount),
    enrichLimit: Math.round(num(patch?.enrichLimit, cur.enrichLimit)),
  };
  if (next.minRating > 5)   next.minRating = 5;
  if (next.maxDiscount > 100) next.maxDiscount = 100;
  if (next.minDiscount > 100) next.minDiscount = 100;
  if (next.enrichLimit > 300) next.enrichLimit = 300;
  appConfig.set(AMAZON_FILTERS_KEY, next);
  return next;
}

// ────────────────────────────────────────────────────────────────────────
// Filtros de qualidade da Shopee (admin-only)
// ────────────────────────────────────────────────────────────────────────

function readShopeeScraperFilters() {
  const raw = appConfig.get(SHOPEE_FILTERS_KEY);
  if (!raw || typeof raw !== "object") return { ...SHOPEE_FILTERS_DEFAULTS };
  return { ...SHOPEE_FILTERS_DEFAULTS, ...raw };
}

function writeShopeeScraperFilters(patch) {
  const cur = readShopeeScraperFilters();
  const num = (v, def) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : def;
  };
  const next = {
    minRating:         num(patch?.minRating,         cur.minRating),
    minSales:          num(patch?.minSales,          cur.minSales),
    minPrice:          num(patch?.minPrice,          cur.minPrice),
    maxPrice:          num(patch?.maxPrice,          cur.maxPrice),
    minCommissionRate: num(patch?.minCommissionRate, cur.minCommissionRate),
    maxDiscount:       num(patch?.maxDiscount,       cur.maxDiscount),
    minDiscount:       num(patch?.minDiscount,       cur.minDiscount),
    // listType é escolha discreta (0/1/2), não número livre: valida por whitelist.
    listType:          [0, 1, 2].includes(Number(patch?.listType)) ? Number(patch.listType) : cur.listType,
    // sortType idem (1/2/3/4/5): 2=Mais vendidos é o default de qualidade.
    sortType:          [1, 2, 3, 4, 5].includes(Number(patch?.sortType)) ? Number(patch.sortType) : cur.sortType,
  };
  // Validações de sanidade
  if (next.minRating > 5) next.minRating = 5;
  if (next.maxDiscount > 100) next.maxDiscount = 100;
  if (next.minDiscount > 100) next.minDiscount = 100;
  if (next.minCommissionRate > 1) next.minCommissionRate = next.minCommissionRate / 100; // aceita "5" → 0.05
  appConfig.set(SHOPEE_FILTERS_KEY, next);
  return next;
}

// Aplica filtros num node bruto da Shopee. Retorna `true` se passa.
// node: { ratingStar, sales, price, commissionRate, priceDiscountRate, ... }
function passesShopeeFilters(node, filters = null) {
  const f = filters || readShopeeScraperFilters();
  const rating = Number(node?.ratingStar) || 0;
  const sales = Number(node?.sales) || 0;
  const price = Number(node?.price) || 0;
  const commission = Number(node?.commissionRate) || 0;
  const discount = Number(node?.priceDiscountRate) || 0;

  if (f.minRating > 0 && rating < f.minRating) return false;
  if (f.minSales > 0 && sales < f.minSales) return false;
  if (f.minPrice > 0 && price > 0 && price < f.minPrice) return false;
  if (f.maxPrice > 0 && price > f.maxPrice) return false;
  if (f.minCommissionRate > 0 && commission < f.minCommissionRate) return false;
  if (f.maxDiscount > 0 && discount > f.maxDiscount) return false;
  if (f.minDiscount > 0 && discount < f.minDiscount) return false;
  return true;
}

// "+50 vendidos" / "1 mil" / number → quantidade aproximada de vendas.
// ML manda string ("+50 vendidos"); aceita number direto também.
function parseSoldText(s) {
  if (s == null) return 0;
  if (typeof s === "number") return Number.isFinite(s) ? s : 0;
  const m = String(s).toLowerCase().match(/([\d.,]+)\s*(mil|mi)?/);
  if (!m) return 0;
  let n = parseFloat(m[1].replace(/\./g, "").replace(",", "."));
  if (!isFinite(n)) return 0;
  if (m[2] === "mil") n *= 1000;
  if (m[2] === "mi") n *= 1000000;
  return Math.round(n);
}

// Aplica filtros de qualidade num produto JÁ scrapeado do ML. Retorna `true` se passa.
// product: { price, discount, rating, sold, ... } (formato Nimbus, pós-scrapeML).
// Nota: ML nem sempre expõe `sold` no card de ofertas — com minSales > 0, itens
// sem rótulo de vendas são cortados (sold ausente conta como 0).
function passesMLFilters(product, filters = null) {
  const f = filters || readMLScraperFilters();
  const price = Number(product?.price) || 0;
  const rating = Number(product?.rating) || 0;
  const discount = Number(product?.discount) || 0;
  const sales = parseSoldText(product?.sold);

  if (f.minRating > 0 && rating < f.minRating) return false;
  if (f.minSales > 0 && sales < f.minSales) return false;
  if (f.minPrice > 0 && price > 0 && price < f.minPrice) return false;
  if (f.maxPrice > 0 && price > f.maxPrice) return false;
  if (f.maxDiscount > 0 && discount > f.maxDiscount) return false;
  if (f.minDiscount > 0 && discount < f.minDiscount) return false;
  return true;
}

// Aplica filtros de qualidade num produto JÁ scrapeado da Amazon. Retorna `true` se passa.
// product: { price, discount, rating, reviewsCount, ... } (formato Nimbus, pós-scrapeAmazon).
// rating/reviews NÃO vêm da página de ofertas — só chegam via enriquecimento (abrindo
// a página do produto), que pode falhar/cair em CAPTCHA. Por isso, quando AUSENTES,
// minRating/minReviews não cortam o produto: só filtram quem realmente tem o dado.
function passesAmazonFilters(product, filters = null) {
  const f = filters || readAmazonScraperFilters();
  const price = Number(product?.price) || 0;
  const discount = Number(product?.discount) || 0;

  const hasRating = product?.rating != null;
  const hasReviews = product?.reviewsCount != null && String(product.reviewsCount).trim() !== "";
  const rating = Number(product?.rating) || 0;
  const reviews = Number(String(product?.reviewsCount ?? "").replace(/[^\d]/g, "")) || 0;

  if (f.minRating > 0 && hasRating && rating < f.minRating) return false;
  if (f.minReviews > 0 && hasReviews && reviews < f.minReviews) return false;
  if (f.minPrice > 0 && price > 0 && price < f.minPrice) return false;
  if (f.maxPrice > 0 && price > f.maxPrice) return false;
  if (f.maxDiscount > 0 && discount > f.maxDiscount) return false;
  if (f.minDiscount > 0 && discount < f.minDiscount) return false;
  return true;
}

// Resolve credenciais Shopee pro admin-scraper (que roda fora de qualquer userId).
// Prioridade: env vars → admin override (appConfig) → primeiro user com config.
// Retorna null se nada disponível.
function getScraperShopeeCreds() {
  if (process.env.SHOPEE_AFFILIATE_APP_ID && process.env.SHOPEE_AFFILIATE_APP_SECRET) {
    return {
      appId: process.env.SHOPEE_AFFILIATE_APP_ID.trim(),
      appSecret: process.env.SHOPEE_AFFILIATE_APP_SECRET,
      source: "env",
    };
  }
  const admin = readScraperShopeeAdminCreds();
  if (admin.appId && admin.appSecret) {
    return { appId: admin.appId, appSecret: admin.appSecret, source: "admin" };
  }
  const list = store.listShopeeConfigs();
  if (list.length) return { appId: list[0].appId, appSecret: list[0].appSecret, source: "user-fallback" };
  return null;
}

// Busca ofertas Shopee — usada pelo admin-scraper. Recebe { appId, appSecret }
// explicitamente (ou pega de getScraperShopeeCreds se ausente). Devolve { nodes, pageInfo }.
async function fetchShopeeOffers({ keyword, productCatId, page = 1, limit = 50, sortType = 4, listType = 0, creds } = {}) {
  if (!keyword && !productCatId) return { nodes: [], pageInfo: null };
  const c = creds || getScraperShopeeCreds();
  if (!c || !c.appId || !c.appSecret) {
    console.warn("[afiliados Shopee] fetchShopeeOffers: sem App ID/Secret (env ou usuário configurado) — pulando");
    return { nodes: [], pageInfo: null };
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const payload = buildShopeeProductOfferPayload({ keyword, productCatId, page, limit, sortType, listType });
  const authHeader = signShopeeRequest({ appId: c.appId, appSecret: c.appSecret, timestamp, payload });

  try {
    const res = await fetch(SHOPEE_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": authHeader,
        "User-Agent": UA,
      },
      body: payload,
    });

    if (!res.ok) {
      console.error(`[afiliados Shopee] fetchShopeeOffers HTTP ${res.status}`);
      return { nodes: [], pageInfo: null };
    }

    const data = await res.json();
    if (data?.errors?.length) {
      const msg = data.errors[0]?.message || "erro desconhecido";
      console.warn(`[afiliados Shopee] productOfferV2: ${String(msg).slice(0, 160)}`);
      return { nodes: [], pageInfo: null };
    }
    const result = data?.data?.productOfferV2 || {};
    const nodes = Array.isArray(result.nodes) ? result.nodes : [];
    return { nodes, pageInfo: result.pageInfo || null };
  } catch (err) {
    console.error("[afiliados Shopee] fetchShopeeOffers erro:", err.message);
    return { nodes: [], pageInfo: null };
  }
}

// ────────────────────────────────────────────────────────────────────────
// Warmup (chamar no boot — popula cache do store)
// ────────────────────────────────────────────────────────────────────────

async function warmup() {
  await store.warmup();
}

// ────────────────────────────────────────────────────────────────────────
// API pública
// ────────────────────────────────────────────────────────────────────────

module.exports = {
  // ML
  gerarLinkAfiliadoML,
  readMLConfig,
  writeMLConfig,
  clearMLConfig,
  // Amazon
  gerarLinkAfiliadoAmazon,
  readAmazonConfig,
  writeAmazonConfig,
  clearAmazonConfig,
  extractASIN,
  // Shopee
  gerarLinkAfiliadoShopee,
  fetchShopeeOffers,
  fetchShopeeItemByIds,
  readShopeeConfig,
  writeShopeeConfig,
  clearShopeeConfig,
  getScraperShopeeCreds,
  readScraperShopeeAdminCreds,
  writeScraperShopeeAdminCreds,
  clearScraperShopeeAdminCreds,
  readMLScraperFilters,
  writeMLScraperFilters,
  passesMLFilters,
  ML_FILTERS_DEFAULTS,
  readAmazonScraperFilters,
  writeAmazonScraperFilters,
  passesAmazonFilters,
  AMAZON_FILTERS_DEFAULTS,
  readShopeeScraperFilters,
  writeShopeeScraperFilters,
  passesShopeeFilters,
  SHOPEE_FILTERS_DEFAULTS,
  // Puros — testes
  parseSoldText,
  signShopeeRequest,
  buildShopeeShortLinkPayload,
  buildShopeeProductOfferPayload,
  // Compat: nomes antigos apontam pra ML
  readConfig: readMLConfig,
  writeConfig: writeMLConfig,
  clearConfig: clearMLConfig,
  status,
  warmup,
};
