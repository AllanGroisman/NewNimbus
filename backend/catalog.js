const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = path.join(__dirname, "data");
const CATALOG_FILE = path.join(DATA_DIR, "catalog.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Mutex global do catálogo — operações de upsert/prune são serializadas
// pra evitar corrida entre o admin-scraper e leituras concorrentes.
let _lock = Promise.resolve();
function withLock(fn) {
  const next = _lock.then(fn, fn);
  _lock = next.catch(() => {});
  return next;
}

// Mesma lógica de productKey() do scheduler — chave estável de produto.
function productKey(p) {
  const link = p.link || "";
  const decoded = (() => { try { return decodeURIComponent(link); } catch { return link; } })();
  const m = decoded.match(/\/p\/MLB(\d+)/i)
        || decoded.match(/\/MLB-?(\d{6,})-/i)
        || decoded.match(/produto\.mercadolivre\.com\.br\/MLB-?(\d{6,})/i);
  if (m) return crypto.createHash("md5").update("MLB" + m[1]).digest("hex");
  if (link) {
    try {
      const u = new URL(link);
      return crypto.createHash("md5").update(u.origin + u.pathname).digest("hex");
    } catch {}
  }
  const nm = (p.name || "").toLowerCase().replace(/\s+/g, " ").trim();
  return crypto.createHash("md5").update(`${nm}|${p.store || ""}`).digest("hex");
}

function readDisk() {
  if (!fs.existsSync(CATALOG_FILE)) return { products: {}, updatedAt: null };
  try {
    const raw = JSON.parse(fs.readFileSync(CATALOG_FILE, "utf-8"));
    return { products: raw.products || {}, updatedAt: raw.updatedAt || null };
  } catch (err) {
    console.warn(`[catalog] arquivo corrompido: ${err.message}`);
    return { products: {}, updatedAt: null };
  }
}

function writeDisk(data) {
  const tmp = CATALOG_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, CATALOG_FILE);
}

// Upsert de uma lista de produtos. Cada produto é normalizado e indexado por key.
// `category` e `store` devem vir nos próprios produtos.
function upsertProducts(products) {
  return withLock(() => {
    const data = readDisk();
    const now = new Date().toISOString();
    let inserted = 0, updated = 0;
    for (const p of products) {
      if (!p || !p.name) continue;
      const key = productKey(p);
      const existing = data.products[key];
      if (existing) {
        data.products[key] = {
          ...existing,
          ...p,
          key,
          firstSeenAt: existing.firstSeenAt || now,
          lastSeenAt: now,
        };
        updated++;
      } else {
        data.products[key] = {
          ...p,
          key,
          firstSeenAt: now,
          lastSeenAt: now,
        };
        inserted++;
      }
    }
    data.updatedAt = now;
    writeDisk(data);
    return { inserted, updated, total: Object.keys(data.products).length };
  });
}

// Lê o catálogo em memória (objeto inteiro) — uso sob demanda
function loadAll() {
  return readDisk();
}

// Lista todos os produtos (array). Não passa lock — leitura é eventualmente consistente.
function listAll() {
  return Object.values(readDisk().products);
}

// Query do catálogo. Suporta:
// - categories: array de category ids ou null/[] = todas
// - sources: array de stores normalizadas ("ml", "amazon") ou null/[] = todas
// - excludeKeys: Set ou array com keys a excluir
// - filters: { minDiscount, minPrice, maxPrice, minRating, minSales, keywords }
// - limit: corta resultado
// - sortBy: "discount_desc" (default) | "price_asc" | "price_desc" | "rating_desc" | "lastSeen_desc"
function query({ categories, sources, excludeKeys, filters = {}, limit = 200, sortBy = "discount_desc" } = {}) {
  const all = listAll();
  const cats = Array.isArray(categories) && categories.length ? new Set(categories) : null;
  const srcs = Array.isArray(sources) && sources.length ? new Set(sources.map(s => storeToId(s))) : null;
  const excl = excludeKeys instanceof Set ? excludeKeys : new Set(Array.isArray(excludeKeys) ? excludeKeys : []);

  let out = all.filter(p => {
    if (excl.has(p.key)) return false;
    if (cats) {
      const pcat = typeof p.category === "string" ? p.category : (p.category?.id || null);
      if (!pcat || !cats.has(pcat)) return false;
    }
    if (srcs) {
      const sid = storeToId(p.store);
      if (!sid || !srcs.has(sid)) return false;
    }
    return true;
  });

  // Filtros do usuário. null/undefined em maxPrice = sem limite (slider no máximo).
  const { minDiscount = 0, minPrice = 0, maxPrice, minRating = 0, minSales = 0, keywords = "" } = filters;
  if (minDiscount > 0) out = out.filter(p => p.discount && p.discount >= minDiscount);
  if (minPrice > 0) out = out.filter(p => p.price != null && p.price >= minPrice);
  if (maxPrice != null && Number.isFinite(maxPrice) && maxPrice > 0) {
    out = out.filter(p => p.price != null && p.price <= maxPrice);
  }
  if (minRating > 0) out = out.filter(p => (p.rating || 0) >= minRating);
  if (minSales > 0) out = out.filter(p => parseSold(p.sold) >= minSales);
  if (keywords && String(keywords).trim()) {
    // Split SÓ por vírgula — preserva frases multi-palavra ("fone bluetooth")
    const terms = String(keywords).toLowerCase().split(",").map(t => t.trim()).filter(Boolean);
    if (terms.length) out = out.filter(p => terms.some(t => (p.name || "").toLowerCase().includes(t)));
  }

  const sorters = {
    discount_desc: (a, b) => (b.discount || 0) - (a.discount || 0),
    price_asc: (a, b) => (a.price || Infinity) - (b.price || Infinity),
    price_desc: (a, b) => (b.price || 0) - (a.price || 0),
    rating_desc: (a, b) => (b.rating || 0) - (a.rating || 0),
    lastSeen_desc: (a, b) => new Date(b.lastSeenAt || 0) - new Date(a.lastSeenAt || 0),
  };
  out.sort(sorters[sortBy] || sorters.discount_desc);

  return limit > 0 ? out.slice(0, limit) : out;
}

function storeToId(store) {
  if (!store) return null;
  const k = String(store).toLowerCase().replace(/\s+/g, "");
  if (k === "ml" || k === "mercadolivre") return "ml";
  if (k === "amazon" || k === "amz") return "amazon";
  return null;
}

function parseSold(s) {
  if (!s) return 0;
  const m = String(s).toLowerCase().match(/([\d.,]+)\s*(mil|mi)?/);
  if (!m) return 0;
  let n = parseFloat(m[1].replace(/\./g, "").replace(",", "."));
  if (m[2] === "mil") n *= 1000;
  if (m[2] === "mi") n *= 1000000;
  return Math.round(n);
}

// Estatísticas do catálogo — usado pelo painel admin
function getStats() {
  const all = listAll();
  const byCategory = {};
  const byStore = {};
  for (const p of all) {
    const cat = typeof p.category === "string" ? p.category : (p.category?.id || "_null");
    byCategory[cat] = (byCategory[cat] || 0) + 1;
    const sid = storeToId(p.store) || "_null";
    byStore[sid] = (byStore[sid] || 0) + 1;
  }
  const data = readDisk();
  return {
    total: all.length,
    byCategory,
    byStore,
    updatedAt: data.updatedAt,
  };
}

// Remove produtos não vistos há mais de `daysOld` dias.
function prune(daysOld = 30) {
  return withLock(() => {
    const data = readDisk();
    const cutoff = Date.now() - daysOld * 24 * 60 * 60 * 1000;
    let removed = 0;
    for (const [key, p] of Object.entries(data.products)) {
      const last = new Date(p.lastSeenAt || p.firstSeenAt || 0).getTime();
      if (last < cutoff) {
        delete data.products[key];
        removed++;
      }
    }
    if (removed > 0) {
      data.updatedAt = new Date().toISOString();
      writeDisk(data);
    }
    return { removed, total: Object.keys(data.products).length };
  });
}

module.exports = {
  productKey,
  upsertProducts,
  loadAll,
  listAll,
  query,
  getStats,
  prune,
  storeToId,
};
