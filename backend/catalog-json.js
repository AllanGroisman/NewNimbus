const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { productKey } = require("./product-key");

const DATA_DIR = process.env.NIMBUS_DATA_DIR || path.join(__dirname, "data");
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

// Cache em memória — evita reler o arquivo de 1MB+ a cada query.
// Invalidado/atualizado em todas as escritas (upsert/prune/pruneBeforeDate).
let _cache = null;
let _cacheLoading = null;

async function readDiskFresh() {
  try {
    const raw = JSON.parse(await fsp.readFile(CATALOG_FILE, "utf-8"));
    return { products: raw.products || {}, updatedAt: raw.updatedAt || null };
  } catch (err) {
    if (err.code === "ENOENT") return { products: {}, updatedAt: null };
    console.warn(`[catalog] arquivo corrompido: ${err.message}`);
    return { products: {}, updatedAt: null };
  }
}

// Carrega cache uma vez (lazy). Se já em cache, devolve direto.
async function ensureCache() {
  if (_cache) return _cache;
  if (_cacheLoading) return _cacheLoading;
  _cacheLoading = readDiskFresh().then(d => { _cache = d; _cacheLoading = null; return d; });
  return _cacheLoading;
}

async function writeDisk(data) {
  _cache = data; // cache fica em sincronia
  const tmp = CATALOG_FILE + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2));
  await fsp.rename(tmp, CATALOG_FILE);
}

// Upsert de uma lista de produtos. Cada produto é normalizado e indexado por key.
// `category` e `store` devem vir nos próprios produtos.
function upsertProducts(products) {
  return withLock(async () => {
    const data = await ensureCache();
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
    await writeDisk(data);
    return { inserted, updated, total: Object.keys(data.products).length };
  });
}

// Lê o catálogo em memória (objeto inteiro) — uso sob demanda
async function loadAll() {
  return ensureCache();
}

// Lista todos os produtos (array). Não passa lock — leitura é eventualmente consistente.
async function listAll() {
  return Object.values((await ensureCache()).products);
}

// Query do catálogo. Suporta:
// - categories: array de category ids ou null/[] = todas
// - sources: array de stores normalizadas ("ml", "amazon") ou null/[] = todas
// - excludeKeys: Set ou array com keys a excluir
// - filters: { minDiscount, minPrice, maxPrice, minRating, minSales, keywords }
// - limit: corta resultado
// - sortBy: "discount_desc" (default) | "price_asc" | "price_desc" | "rating_desc" | "lastSeen_desc"
async function query({ categories, sources, excludeKeys, filters = {}, limit = 200, sortBy = "discount_desc" } = {}) {
  const all = Object.values((await ensureCache()).products);
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
async function getStats() {
  const data = await ensureCache();
  const all = Object.values(data.products);
  const byCategory = {};
  const byStore = {};
  for (const p of all) {
    const cat = typeof p.category === "string" ? p.category : (p.category?.id || "_null");
    byCategory[cat] = (byCategory[cat] || 0) + 1;
    const sid = storeToId(p.store) || "_null";
    byStore[sid] = (byStore[sid] || 0) + 1;
  }
  return {
    total: all.length,
    byCategory,
    byStore,
    updatedAt: data.updatedAt,
  };
}

// Remove produtos não vistos há mais de `daysOld` dias.
function prune(daysOld = 30) {
  return withLock(async () => {
    const data = await ensureCache();
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
      await writeDisk(data);
    }
    return { removed, total: Object.keys(data.products).length };
  });
}

// Remove produtos cujo lastSeenAt é anterior ao instante `cutoffDate`.
// Usado pelo admin-scraper ao final de cada run pra descartar itens do dia anterior.
function pruneBeforeDate(cutoffDate) {
  return withLock(async () => {
    const data = await ensureCache();
    const cutoff = new Date(cutoffDate).getTime();
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
      await writeDisk(data);
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
  pruneBeforeDate,
  storeToId,
};
