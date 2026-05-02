const fs = require("fs");
const path = require("path");

// Config persistida em data/affiliate.json (data/ está no .gitignore — cookie nunca vai pro git).
// Variáveis de ambiente têm precedência sobre o arquivo, pra facilitar deploy.
const DATA_DIR = path.join(__dirname, "data");
const CONFIG_FILE = path.join(DATA_DIR, "affiliate.json");

const ENDPOINT = "https://www.mercadolivre.com.br/affiliate-program/api/v2/affiliates/createLink";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias
const cache = new Map(); // linkOriginal → { shortUrl, ts }

// Estado de saúde do cookie. Sai pra status() saber se expirou.
let lastFailureAt = null;
let lastFailureReason = null;
let lastSuccessAt = null;

function readConfig() {
  if (process.env.ML_AFFILIATE_TAG && process.env.ML_AFFILIATE_COOKIE) {
    return {
      tag: process.env.ML_AFFILIATE_TAG.trim(),
      cookie: process.env.ML_AFFILIATE_COOKIE,
      source: "env",
      updatedAt: null,
    };
  }
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const obj = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
      return { tag: obj.tag || null, cookie: obj.cookie || null, source: "file", updatedAt: obj.updatedAt || null };
    } catch {}
  }
  return { tag: null, cookie: null, source: null, updatedAt: null };
}

function writeConfig({ tag, cookie }) {
  if (process.env.ML_AFFILIATE_TAG || process.env.ML_AFFILIATE_COOKIE) {
    throw new Error("Configuração vem de variável de ambiente — desligue ML_AFFILIATE_TAG/ML_AFFILIATE_COOKIE pra usar config dinâmica.");
  }
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const cur = readConfig();
  const next = {
    tag: tag !== undefined ? String(tag || "").trim() : cur.tag,
    cookie: cookie !== undefined ? String(cookie || "").trim() : cur.cookie,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  cache.clear();
  lastFailureAt = null;
  lastFailureReason = null;
  return next;
}

function clearConfig() {
  if (fs.existsSync(CONFIG_FILE)) fs.unlinkSync(CONFIG_FILE);
  cache.clear();
  lastFailureAt = null;
  lastFailureReason = null;
}

function status() {
  const c = readConfig();
  return {
    configured: !!(c.tag && c.cookie),
    tag: c.tag || null,
    cookieLength: c.cookie ? c.cookie.length : 0,
    cookiePreview: c.cookie ? c.cookie.slice(0, 30) + "…" : null,
    source: c.source,
    updatedAt: c.updatedAt,
    lastSuccessAt,
    lastFailureAt,
    lastFailureReason,
    healthy: !!(c.tag && c.cookie) && (!lastFailureAt || (lastSuccessAt && new Date(lastSuccessAt) > new Date(lastFailureAt))),
  };
}

// Gera link de afiliado via API interna do painel ML. Devolve a short_url
// ou null em qualquer falha (cookie expirado, link inválido, rede, etc).
async function gerarLinkAfiliadoML(linkOriginal) {
  if (!linkOriginal || typeof linkOriginal !== "string") return null;
  const { tag, cookie } = readConfig();
  if (!tag || !cookie) return null;

  const cached = cache.get(linkOriginal);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.shortUrl;

  try {
    const res = await fetch(ENDPOINT, {
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
      lastFailureAt = new Date().toISOString();
      lastFailureReason = `HTTP ${res.status} — cookie pode ter expirado`;
      console.error(`[afiliados] ${lastFailureReason}`);
      return null;
    }

    const data = await res.json();
    const short = data?.urls?.[0]?.short_url || null;
    if (!short) {
      // API respondeu autenticada (cookie OK), mas a URL não gera link curto.
      // Marcar lastSuccessAt mantém o cookie como "saudável".
      lastSuccessAt = new Date().toISOString();
      const apiMsg = data?.urls?.[0]?.error || data?.message || data?.error || null;
      lastFailureReason = apiMsg
        ? `Link inválido: ${String(apiMsg).slice(0, 120)}`
        : "Link inválido — use uma URL de produto/oferta do Mercado Livre (a home não funciona)";
      console.warn(`[afiliados] ${lastFailureReason}: ${JSON.stringify(data).slice(0, 200)}`);
      return null;
    }
    cache.set(linkOriginal, { shortUrl: short, ts: Date.now() });
    lastSuccessAt = new Date().toISOString();
    lastFailureReason = null;
    return short;
  } catch (err) {
    lastFailureAt = new Date().toISOString();
    lastFailureReason = err.message;
    console.error("[afiliados] erro:", err.message);
    return null;
  }
}

module.exports = { gerarLinkAfiliadoML, readConfig, writeConfig, clearConfig, status };
