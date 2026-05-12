const appConfig = require("./app-config");

// Config persistida via app-config (key "affiliate"). Schema:
// { ml: { tag, cookie, updatedAt }, amazon: { tag, updatedAt } }
// Lê também o schema antigo flat { tag, cookie, updatedAt } como ML.

const ML_ENDPOINT = "https://www.mercadolivre.com.br/affiliate-program/api/v2/affiliates/createLink";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias
const mlCache = new Map();      // linkOriginal → { shortUrl, ts }
const amazonCache = new Map();  // linkOriginal → { shortUrl, ts }

let mlLastFailureAt = null;
let mlLastFailureReason = null;
let mlLastSuccessAt = null;

let amazonLastFailureAt = null;
let amazonLastFailureReason = null;
let amazonLastSuccessAt = null;

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

// ────────────────────────────────────────────────────────────────────────
// Status
// ────────────────────────────────────────────────────────────────────────

function status() {
  const ml = readMLConfig();
  const amazon = readAmazonConfig();
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
  // Compat: nomes antigos apontam pra ML
  readConfig: readMLConfig,
  writeConfig: writeMLConfig,
  clearConfig: clearMLConfig,
  status,
};
