const crypto = require("crypto");
const appConfig = require("../config");

// Config persistida via app-config (key "affiliate"). Schema:
// { ml: { tag, cookie, updatedAt }, amazon: { tag, updatedAt }, shopee: { appId, appSecret, updatedAt } }
// Lê também o schema antigo flat { tag, cookie, updatedAt } como ML.

const ML_ENDPOINT = "https://www.mercadolivre.com.br/affiliate-program/api/v2/affiliates/createLink";
const SHOPEE_ENDPOINT = "https://open-api.affiliate.shopee.com.br/graphql";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias
const mlCache = new Map();      // linkOriginal → { shortUrl, ts }
const amazonCache = new Map();  // linkOriginal → { shortUrl, ts }
const shopeeCache = new Map();  // linkOriginal → { shortUrl, ts }

let mlLastFailureAt = null;
let mlLastFailureReason = null;
let mlLastSuccessAt = null;

let amazonLastFailureAt = null;
let amazonLastFailureReason = null;
let amazonLastSuccessAt = null;

let shopeeLastFailureAt = null;
let shopeeLastFailureReason = null;
let shopeeLastSuccessAt = null;

// ────────────────────────────────────────────────────────────────────────
// Storage
// ────────────────────────────────────────────────────────────────────────

function readRaw() {
  return appConfig.get("affiliate") || {};
}

function writeRaw(obj) {
  appConfig.set("affiliate", obj, { mode: 0o600 });
}

function readMLConfig() {
  if (process.env.ML_AFFILIATE_TAG && process.env.ML_AFFILIATE_COOKIE) {
    return { tag: process.env.ML_AFFILIATE_TAG.trim(), cookie: process.env.ML_AFFILIATE_COOKIE, source: "env", updatedAt: null };
  }
  const raw = readRaw();
  // Schema novo
  if (raw.ml && (raw.ml.tag || raw.ml.cookie)) {
    return { tag: raw.ml.tag || null, cookie: raw.ml.cookie || null, source: "file", updatedAt: raw.ml.updatedAt || null };
  }
  // Schema antigo (flat) — migra mentalmente como ML
  if (raw.tag || raw.cookie) {
    return { tag: raw.tag || null, cookie: raw.cookie || null, source: "file", updatedAt: raw.updatedAt || null };
  }
  return { tag: null, cookie: null, source: null, updatedAt: null };
}

function readAmazonConfig() {
  if (process.env.AMAZON_AFFILIATE_TAG) {
    return { tag: process.env.AMAZON_AFFILIATE_TAG.trim(), source: "env", updatedAt: null };
  }
  const raw = readRaw();
  if (raw.amazon && raw.amazon.tag) {
    return { tag: raw.amazon.tag, source: "file", updatedAt: raw.amazon.updatedAt || null };
  }
  return { tag: null, source: null, updatedAt: null };
}

function readShopeeConfig() {
  if (process.env.SHOPEE_AFFILIATE_APP_ID && process.env.SHOPEE_AFFILIATE_APP_SECRET) {
    return {
      appId: process.env.SHOPEE_AFFILIATE_APP_ID.trim(),
      appSecret: process.env.SHOPEE_AFFILIATE_APP_SECRET,
      source: "env",
      updatedAt: null,
    };
  }
  const raw = readRaw();
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

function writeMLConfig({ tag, cookie }) {
  if (process.env.ML_AFFILIATE_TAG || process.env.ML_AFFILIATE_COOKIE) {
    throw new Error("Configuração ML vem de variável de ambiente — desligue ML_AFFILIATE_TAG/ML_AFFILIATE_COOKIE pra usar config dinâmica.");
  }
  const raw = readRaw();
  const cur = readMLConfig();
  const next = {
    tag: tag !== undefined ? String(tag || "").trim() : cur.tag,
    cookie: cookie !== undefined ? String(cookie || "").trim() : cur.cookie,
    updatedAt: new Date().toISOString(),
  };
  // Migra schema antigo: remove campos flat
  delete raw.tag; delete raw.cookie; delete raw.updatedAt;
  raw.ml = next;
  writeRaw(raw);
  mlCache.clear();
  mlLastFailureAt = null;
  mlLastFailureReason = null;
  return next;
}

function writeAmazonConfig({ tag }) {
  if (process.env.AMAZON_AFFILIATE_TAG) {
    throw new Error("Configuração Amazon vem de variável de ambiente — desligue AMAZON_AFFILIATE_TAG pra usar config dinâmica.");
  }
  const cleanTag = String(tag || "").trim();
  if (cleanTag && !/^[a-zA-Z0-9_-]{2,30}$/.test(cleanTag)) {
    throw new Error("Tag inválida — use letras, números, hífen ou sublinhado (ex: pedroguterres-20)");
  }
  const raw = readRaw();
  raw.amazon = { tag: cleanTag || null, updatedAt: new Date().toISOString() };
  writeRaw(raw);
  amazonCache.clear();
  amazonLastFailureAt = null;
  amazonLastFailureReason = null;
  return raw.amazon;
}

function clearMLConfig() {
  const raw = readRaw();
  delete raw.tag; delete raw.cookie; delete raw.updatedAt; delete raw.ml;
  if (Object.keys(raw).length) writeRaw(raw);
  else appConfig.del("affiliate");
  mlCache.clear();
  mlLastFailureAt = null;
  mlLastFailureReason = null;
}

function clearAmazonConfig() {
  const raw = readRaw();
  delete raw.amazon;
  if (Object.keys(raw).length) writeRaw(raw);
  else appConfig.del("affiliate");
  amazonCache.clear();
  amazonLastFailureAt = null;
  amazonLastFailureReason = null;
}

function writeShopeeConfig({ appId, appSecret }) {
  if (process.env.SHOPEE_AFFILIATE_APP_ID || process.env.SHOPEE_AFFILIATE_APP_SECRET) {
    throw new Error("Configuração Shopee vem de variável de ambiente — desligue SHOPEE_AFFILIATE_APP_ID/SHOPEE_AFFILIATE_APP_SECRET pra usar config dinâmica.");
  }
  const cleanId = String(appId || "").trim();
  const cleanSecret = String(appSecret || "").trim();
  if (cleanId && !/^[a-zA-Z0-9_-]{4,64}$/.test(cleanId)) {
    throw new Error("App ID inválido — use letras, números, hífen ou sublinhado.");
  }
  if (cleanSecret && cleanSecret.length < 16) {
    throw new Error("App Secret muito curto — confira o valor copiado do painel.");
  }
  const raw = readRaw();
  const cur = readShopeeConfig();
  raw.shopee = {
    appId: cleanId || cur.appId || null,
    appSecret: cleanSecret || cur.appSecret || null,
    updatedAt: new Date().toISOString(),
  };
  writeRaw(raw);
  shopeeCache.clear();
  shopeeLastFailureAt = null;
  shopeeLastFailureReason = null;
  return raw.shopee;
}

function clearShopeeConfig() {
  const raw = readRaw();
  delete raw.shopee;
  if (Object.keys(raw).length) writeRaw(raw);
  else appConfig.del("affiliate");
  shopeeCache.clear();
  shopeeLastFailureAt = null;
  shopeeLastFailureReason = null;
}

// ────────────────────────────────────────────────────────────────────────
// Status
// ────────────────────────────────────────────────────────────────────────

function status() {
  const ml = readMLConfig();
  const amazon = readAmazonConfig();
  const shopee = readShopeeConfig();
  return {
    // Compat com UI antiga: campos top-level são do ML
    configured: !!(ml.tag && ml.cookie),
    tag: ml.tag || null,
    cookieLength: ml.cookie ? ml.cookie.length : 0,
    cookiePreview: ml.cookie ? ml.cookie.slice(0, 30) + "…" : null,
    source: ml.source,
    updatedAt: ml.updatedAt,
    lastSuccessAt: mlLastSuccessAt,
    lastFailureAt: mlLastFailureAt,
    lastFailureReason: mlLastFailureReason,
    healthy: !!(ml.tag && ml.cookie) && (!mlLastFailureAt || (mlLastSuccessAt && new Date(mlLastSuccessAt) > new Date(mlLastFailureAt))),
    // Sub-objetos novos (UI nova lê daqui)
    ml: {
      configured: !!(ml.tag && ml.cookie),
      tag: ml.tag || null,
      cookieLength: ml.cookie ? ml.cookie.length : 0,
      cookiePreview: ml.cookie ? ml.cookie.slice(0, 30) + "…" : null,
      source: ml.source,
      updatedAt: ml.updatedAt,
      lastSuccessAt: mlLastSuccessAt,
      lastFailureAt: mlLastFailureAt,
      lastFailureReason: mlLastFailureReason,
      healthy: !!(ml.tag && ml.cookie) && (!mlLastFailureAt || (mlLastSuccessAt && new Date(mlLastSuccessAt) > new Date(mlLastFailureAt))),
    },
    amazon: {
      configured: !!amazon.tag,
      tag: amazon.tag || null,
      source: amazon.source,
      updatedAt: amazon.updatedAt,
      lastSuccessAt: amazonLastSuccessAt,
      lastFailureAt: amazonLastFailureAt,
      lastFailureReason: amazonLastFailureReason,
    },
    shopee: {
      configured: !!(shopee.appId && shopee.appSecret),
      appId: shopee.appId || null,
      // Mostra só preview do secret pra UI confirmar sem expor o valor inteiro
      appSecretLength: shopee.appSecret ? shopee.appSecret.length : 0,
      appSecretPreview: shopee.appSecret ? shopee.appSecret.slice(0, 6) + "…" : null,
      source: shopee.source,
      updatedAt: shopee.updatedAt,
      lastSuccessAt: shopeeLastSuccessAt,
      lastFailureAt: shopeeLastFailureAt,
      lastFailureReason: shopeeLastFailureReason,
      healthy: !!(shopee.appId && shopee.appSecret) && (!shopeeLastFailureAt || (shopeeLastSuccessAt && new Date(shopeeLastSuccessAt) > new Date(shopeeLastFailureAt))),
    },
  };
}

// ────────────────────────────────────────────────────────────────────────
// Mercado Livre
// ────────────────────────────────────────────────────────────────────────

async function gerarLinkAfiliadoML(linkOriginal) {
  if (!linkOriginal || typeof linkOriginal !== "string") return null;
  const { tag, cookie } = readMLConfig();
  if (!tag || !cookie) return null;

  const cached = mlCache.get(linkOriginal);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.shortUrl;

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
      mlLastFailureAt = new Date().toISOString();
      mlLastFailureReason = `HTTP ${res.status} — cookie pode ter expirado`;
      console.error(`[afiliados ML] ${mlLastFailureReason}`);
      return null;
    }

    const data = await res.json();
    const short = data?.urls?.[0]?.short_url || null;
    if (!short) {
      mlLastSuccessAt = new Date().toISOString();
      const apiMsg = data?.urls?.[0]?.error || data?.message || data?.error || null;
      mlLastFailureReason = apiMsg
        ? `Link inválido: ${String(apiMsg).slice(0, 120)}`
        : "Link inválido — use uma URL de produto/oferta do Mercado Livre (a home não funciona)";
      console.warn(`[afiliados ML] ${mlLastFailureReason}: ${JSON.stringify(data).slice(0, 200)}`);
      return null;
    }
    mlCache.set(linkOriginal, { shortUrl: short, ts: Date.now() });
    mlLastSuccessAt = new Date().toISOString();
    mlLastFailureReason = null;
    return short;
  } catch (err) {
    mlLastFailureAt = new Date().toISOString();
    mlLastFailureReason = err.message;
    console.error("[afiliados ML] erro:", err.message);
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────────
// Amazon BR
// ────────────────────────────────────────────────────────────────────────

// Extrai ASIN (10 caracteres alfanuméricos) de uma URL da Amazon BR.
// Cobre os principais padrões de URL: /dp/, /gp/product/, /product/, /-/pt/dp/, /exec/obidos/asin/
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

// Gera link curto de afiliado Amazon: https://www.amazon.com.br/dp/ASIN?tag=TAG
// Não chama API externa — só monta a URL. Retorna null se não tem tag ou ASIN.
function gerarLinkAfiliadoAmazon(linkOriginal) {
  if (!linkOriginal || typeof linkOriginal !== "string") return null;
  const { tag } = readAmazonConfig();
  if (!tag) return null;

  const cached = amazonCache.get(linkOriginal);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.shortUrl;

  const asin = extractASIN(linkOriginal);
  if (!asin) {
    amazonLastFailureAt = new Date().toISOString();
    amazonLastFailureReason = "Não foi possível extrair o ASIN — URL não é de produto Amazon BR válida";
    return null;
  }

  const short = `https://www.amazon.com.br/dp/${asin}?tag=${encodeURIComponent(tag)}`;
  amazonCache.set(linkOriginal, { shortUrl: short, ts: Date.now() });
  amazonLastSuccessAt = new Date().toISOString();
  amazonLastFailureReason = null;
  return short;
}

// ────────────────────────────────────────────────────────────────────────
// Shopee (Affiliate Open API — GraphQL)
// ────────────────────────────────────────────────────────────────────────

// Assina o request da Shopee. Pura — sem rede. Útil pra testar.
//   header = sha256(appId + timestamp + payload + appSecret)
//   payload é a string JSON enviada no body, EXATAMENTE como vai pra rede.
// Retorna a string completa pra header Authorization.
function signShopeeRequest({ appId, appSecret, timestamp, payload }) {
  const base = String(appId) + String(timestamp) + String(payload) + String(appSecret);
  const signature = crypto.createHash("sha256").update(base).digest("hex");
  return `SHA256 Credential=${appId}, Timestamp=${timestamp}, Signature=${signature}`;
}

// Monta a mutation GraphQL pra gerar short link.
// subIds são opcionais (tracking) — passamos vazios pra deixar o link genérico.
function buildShopeeShortLinkPayload(originUrl) {
  // Escapa aspas duplas e barras pra ficar dentro da string GraphQL
  const safe = String(originUrl).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const query = `mutation{generateShortLink(input:{originUrl:"${safe}",subIds:["","","","",""]}){shortLink}}`;
  return JSON.stringify({ query });
}

// Monta query GraphQL pro productOfferV2 — usada pra popular o catálogo.
// sortType: 2=mais vendidos, 3=maior comissão, 4=maior desconto, 0=mais novos.
// Default 4 (maior desconto) porque é o que faz sentido pra um app de ofertas.
function buildShopeeProductOfferPayload({ keyword, page = 1, limit = 50, sortType = 4 }) {
  const safe = String(keyword || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const query = `query{productOfferV2(keyword:"${safe}",sortType:${Number(sortType)},page:${Number(page)},limit:${Number(limit)}){nodes{itemId shopId productName productLink offerLink imageUrl price priceMin priceMax priceDiscountRate sales commissionRate ratingStar productCatIds} pageInfo{page limit hasNextPage}}}`;
  return JSON.stringify({ query });
}

async function gerarLinkAfiliadoShopee(linkOriginal) {
  if (!linkOriginal || typeof linkOriginal !== "string") return null;
  const { appId, appSecret } = readShopeeConfig();
  if (!appId || !appSecret) return null;

  const cached = shopeeCache.get(linkOriginal);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.shortUrl;

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
      shopeeLastFailureAt = new Date().toISOString();
      shopeeLastFailureReason = `HTTP ${res.status} — confira App ID/Secret no painel da Shopee`;
      console.error(`[afiliados Shopee] ${shopeeLastFailureReason}`);
      return null;
    }

    const data = await res.json();
    if (data?.errors?.length) {
      const msg = data.errors[0]?.message || "erro desconhecido";
      shopeeLastFailureAt = new Date().toISOString();
      shopeeLastFailureReason = `API: ${String(msg).slice(0, 120)}`;
      console.warn(`[afiliados Shopee] ${shopeeLastFailureReason}`);
      return null;
    }
    const short = data?.data?.generateShortLink?.shortLink || null;
    if (!short) {
      shopeeLastFailureAt = new Date().toISOString();
      shopeeLastFailureReason = "Resposta sem shortLink — URL pode não ser de produto Shopee válido";
      console.warn(`[afiliados Shopee] ${shopeeLastFailureReason}: ${JSON.stringify(data).slice(0, 200)}`);
      return null;
    }
    shopeeCache.set(linkOriginal, { shortUrl: short, ts: Date.now() });
    shopeeLastSuccessAt = new Date().toISOString();
    shopeeLastFailureReason = null;
    return short;
  } catch (err) {
    shopeeLastFailureAt = new Date().toISOString();
    shopeeLastFailureReason = err.message;
    console.error("[afiliados Shopee] erro:", err.message);
    return null;
  }
}

// Busca ofertas da Shopee via productOfferV2. Retorna array crus de nodes da API.
// Não mapeia pro formato do Nimbus — quem usa (scraper.js) faz isso.
// Devolve [] em qualquer erro (sem credenciais, HTTP fail, GraphQL error).
// Trata 1 página por chamada — paginação fica com o caller.
async function fetchShopeeOffers({ keyword, page = 1, limit = 50, sortType = 4 } = {}) {
  if (!keyword) return { nodes: [], pageInfo: null };
  const { appId, appSecret } = readShopeeConfig();
  if (!appId || !appSecret) {
    console.warn("[afiliados Shopee] fetchShopeeOffers: sem App ID/Secret — pulando");
    return { nodes: [], pageInfo: null };
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const payload = buildShopeeProductOfferPayload({ keyword, page, limit, sortType });
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
      shopeeLastFailureAt = new Date().toISOString();
      shopeeLastFailureReason = `HTTP ${res.status} ao buscar ofertas`;
      console.error(`[afiliados Shopee] ${shopeeLastFailureReason}`);
      return { nodes: [], pageInfo: null };
    }

    const data = await res.json();
    if (data?.errors?.length) {
      const msg = data.errors[0]?.message || "erro desconhecido";
      shopeeLastFailureAt = new Date().toISOString();
      shopeeLastFailureReason = `productOfferV2: ${String(msg).slice(0, 160)}`;
      console.warn(`[afiliados Shopee] ${shopeeLastFailureReason}`);
      return { nodes: [], pageInfo: null };
    }
    const result = data?.data?.productOfferV2 || {};
    const nodes = Array.isArray(result.nodes) ? result.nodes : [];
    shopeeLastSuccessAt = new Date().toISOString();
    shopeeLastFailureReason = null;
    return { nodes, pageInfo: result.pageInfo || null };
  } catch (err) {
    shopeeLastFailureAt = new Date().toISOString();
    shopeeLastFailureReason = err.message;
    console.error("[afiliados Shopee] fetchShopeeOffers erro:", err.message);
    return { nodes: [], pageInfo: null };
  }
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
  readShopeeConfig,
  writeShopeeConfig,
  clearShopeeConfig,
  // Exportados pra testes unitários (puros, sem rede)
  signShopeeRequest,
  buildShopeeShortLinkPayload,
  buildShopeeProductOfferPayload,
  // Compat: nomes antigos apontam pra ML
  readConfig: readMLConfig,
  writeConfig: writeMLConfig,
  clearConfig: clearMLConfig,
  status,
};
