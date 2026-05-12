// Implementação Postgres do catálogo. Mesma interface pública de catalog-json.js,
// mas tudo async (Prisma).
const { prisma } = require("../db");
const { productKey } = require("./product-key");

function storeToId(store) {
  if (!store) return null;
  const k = String(store).toLowerCase().replace(/\s+/g, "");
  if (k === "ml" || k === "mercadolivre") return "ml";
  if (k === "amazon" || k === "amz") return "amazon";
  if (k === "shopee") return "shopee";
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

// Separa campos "indexáveis" (colunas) de campos extras (jsonb payload).
const INDEXED_FIELDS = new Set([
  "key", "name", "link", "img", "price", "originalPrice",
  "discount", "store", "category", "rating", "sold",
  "firstSeenAt", "lastSeenAt",
]);

function toRow(p, key, now) {
  const cat = typeof p.category === "string" ? p.category : (p.category?.id || null);
  const payload = {};
  for (const [k, v] of Object.entries(p)) {
    if (!INDEXED_FIELDS.has(k) && v !== undefined) payload[k] = v;
  }
  return {
    key,
    name: p.name || "",
    link: p.link || "",
    img: p.img || null,
    price: p.price ?? null,
    originalPrice: p.originalPrice ?? null,
    discount: p.discount ?? null,
    store: p.store || null,
    category: cat,
    rating: p.rating ?? null,
    sold: p.sold || null,
    payload,
    lastSeenAt: now,
  };
}

// Reconstrói o "shape" antigo (planos + payload spread) pra UI/scheduler.
function fromRow(r) {
  if (!r) return null;
  return {
    key: r.key,
    name: r.name,
    link: r.link,
    img: r.img,
    price: r.price,
    originalPrice: r.originalPrice,
    discount: r.discount,
    store: r.store,
    category: r.category,
    rating: r.rating,
    sold: r.sold,
    firstSeenAt: r.firstSeenAt?.toISOString?.() || r.firstSeenAt,
    lastSeenAt: r.lastSeenAt?.toISOString?.() || r.lastSeenAt,
    ...(r.payload || {}),
  };
}

async function upsertProducts(products) {
  const now = new Date();
  let inserted = 0, updated = 0;

  // Em batch via transação. Prisma não tem ON CONFLICT bulk nativo no client JS;
  // usamos upsert individual em batches concorrentes pra não saturar a conexão.
  const BATCH = 50;
  const valid = (products || []).filter(p => p && p.name);
  for (let i = 0; i < valid.length; i += BATCH) {
    const slice = valid.slice(i, i + BATCH);
    const ops = slice.map(async p => {
      const key = productKey(p);
      const row = toRow(p, key, now);
      const res = await prisma().catalogProduct.upsert({
        where: { key },
        create: { ...row, firstSeenAt: now },
        update: { ...row },
      });
      // Detecta se foi inserção ou update comparando timestamps
      if (res.firstSeenAt.getTime() === res.lastSeenAt.getTime()) inserted++;
      else updated++;
    });
    await Promise.all(ops);
  }

  const total = await prisma().catalogProduct.count();
  return { inserted, updated, total };
}

async function loadAll() {
  const all = await prisma().catalogProduct.findMany();
  const products = {};
  for (const r of all) products[r.key] = fromRow(r);
  const last = await prisma().catalogProduct.findFirst({
    orderBy: { lastSeenAt: "desc" },
    select: { lastSeenAt: true },
  });
  return { products, updatedAt: last?.lastSeenAt?.toISOString() || null };
}

async function listAll() {
  const all = await prisma().catalogProduct.findMany();
  return all.map(fromRow);
}

async function query({
  categories, sources, excludeKeys, filters = {}, limit = 200, sortBy = "discount_desc",
} = {}) {
  const where = { AND: [] };

  if (Array.isArray(categories) && categories.length) {
    where.AND.push({ category: { in: categories } });
  }
  if (Array.isArray(sources) && sources.length) {
    // Sources podem vir como ids ("ml", "amazon", "shopee") ou rótulos ("Mercado Livre"). Normaliza.
    const wanted = new Set(sources.map(storeToId).filter(Boolean));
    // Convertemos pra lista de strings de store que dão match no DB.
    // Na tabela, store guarda o rótulo ("Mercado Livre" / "Amazon" / "Shopee"). Mapa reverso:
    const labels = [];
    if (wanted.has("ml")) labels.push("Mercado Livre");
    if (wanted.has("amazon")) labels.push("Amazon");
    if (wanted.has("shopee")) labels.push("Shopee");
    // IMPORTANTE: se o usuário pediu sources mas NENHUM normalizou (ex: typo, ou
    // store inexistente), retorna lista vazia. Sem esse guard, o filtro store
    // seria pulado e a query devolveria TODOS os produtos — bug.
    where.AND.push({ store: { in: labels.length ? labels : ["__never_matches__"] } });
  }
  if (excludeKeys) {
    const arr = excludeKeys instanceof Set ? [...excludeKeys] : (Array.isArray(excludeKeys) ? excludeKeys : []);
    if (arr.length) where.AND.push({ key: { notIn: arr } });
  }

  const { minDiscount = 0, minPrice = 0, maxPrice, minRating = 0, minSales = 0, keywords = "" } = filters;
  if (minDiscount > 0) where.AND.push({ discount: { gte: minDiscount } });
  if (minPrice > 0) where.AND.push({ price: { gte: minPrice } });
  if (maxPrice != null && Number.isFinite(maxPrice) && maxPrice > 0) {
    where.AND.push({ price: { lte: maxPrice, not: null } });
  }
  if (minRating > 0) where.AND.push({ rating: { gte: minRating } });
  if (keywords && String(keywords).trim()) {
    const terms = String(keywords).toLowerCase().split(",").map(t => t.trim()).filter(Boolean);
    if (terms.length) {
      where.AND.push({ OR: terms.map(t => ({ name: { contains: t, mode: "insensitive" } })) });
    }
  }
  // minSales depende do parseSold do payload — filtramos pós-query (campo não-indexado).

  const orderBy = (() => {
    switch (sortBy) {
      case "price_asc":     return [{ price: "asc" }];
      case "price_desc":    return [{ price: "desc" }];
      case "rating_desc":   return [{ rating: "desc" }];
      case "lastSeen_desc": return [{ lastSeenAt: "desc" }];
      case "discount_desc":
      default:              return [{ discount: "desc" }];
    }
  })();

  // Quando vai ter filtro pós-query (minSales), busca um pouco mais que o limit.
  const fetchLimit = (minSales > 0 && limit > 0) ? limit * 5 : (limit > 0 ? limit : undefined);
  const rows = await prisma().catalogProduct.findMany({
    where: where.AND.length ? where : undefined,
    orderBy,
    take: fetchLimit,
  });

  let out = rows.map(fromRow);
  if (minSales > 0) out = out.filter(p => parseSold(p.sold) >= minSales);
  if (limit > 0) out = out.slice(0, limit);
  return out;
}

async function getStats() {
  const [total, byCategoryRaw, byStoreRaw, last] = await Promise.all([
    prisma().catalogProduct.count(),
    prisma().catalogProduct.groupBy({ by: ["category"], _count: { _all: true } }),
    prisma().catalogProduct.groupBy({ by: ["store"], _count: { _all: true } }),
    prisma().catalogProduct.findFirst({ orderBy: { lastSeenAt: "desc" }, select: { lastSeenAt: true } }),
  ]);
  const byCategory = {};
  for (const r of byCategoryRaw) byCategory[r.category || "_null"] = r._count._all;
  const byStore = {};
  for (const r of byStoreRaw) {
    const sid = storeToId(r.store) || "_null";
    byStore[sid] = (byStore[sid] || 0) + r._count._all;
  }
  return {
    total,
    byCategory,
    byStore,
    updatedAt: last?.lastSeenAt?.toISOString() || null,
  };
}

async function prune(daysOld = 30) {
  const cutoff = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000);
  const r = await prisma().catalogProduct.deleteMany({ where: { lastSeenAt: { lt: cutoff } } });
  const total = await prisma().catalogProduct.count();
  return { removed: r.count, total };
}

async function pruneBeforeDate(cutoffDate) {
  const cutoff = new Date(cutoffDate);
  const r = await prisma().catalogProduct.deleteMany({ where: { lastSeenAt: { lt: cutoff } } });
  const total = await prisma().catalogProduct.count();
  return { removed: r.count, total };
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
