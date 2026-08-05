// Implementação Postgres do catálogo (tudo async via Prisma).
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

// Monta o `where` do Prisma a partir dos filtros da campanha/página.
// Separado de query() porque count() precisa exatamente do mesmo filtro.
function buildWhere({ categories, sources, excludeKeys, filters = {} }) {
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

  return where.AND.length ? where : undefined;
}

async function query({
  categories, sources, excludeKeys, filters = {}, limit = 200, offset = 0,
  sortBy = "discount_desc",
} = {}) {
  const where = buildWhere({ categories, sources, excludeKeys, filters });
  const { minSales = 0 } = filters;
  const skip = Math.max(0, Number(offset) || 0);

  // `nulls: "last"` é obrigatório: price/discount/rating são colunas opcionais e
  // no Postgres o DESC joga NULL na frente — "maior desconto" abria a lista com
  // os produtos que nem têm desconto.
  const orderBy = (() => {
    switch (sortBy) {
      case "price_asc":     return [{ price: { sort: "asc", nulls: "last" } }];
      case "price_desc":    return [{ price: { sort: "desc", nulls: "last" } }];
      case "rating_desc":   return [{ rating: { sort: "desc", nulls: "last" } }];
      case "lastSeen_desc": return [{ lastSeenAt: "desc" }];
      case "discount_desc":
      default:              return [{ discount: { sort: "desc", nulls: "last" } }];
    }
  })();

  // Com minSales o corte é pós-query, então o offset também precisa ser aplicado
  // depois do filtro — buscamos com folga e paginamos em memória. Sem minSales,
  // skip/take vão direto pro banco.
  const postFilter = minSales > 0;
  const fetchLimit = limit > 0
    ? (postFilter ? (skip + limit) * 5 : limit)
    : undefined;
  const rows = await prisma().catalogProduct.findMany({
    where,
    orderBy,
    skip: postFilter ? undefined : (skip || undefined),
    take: fetchLimit,
  });

  let out = rows.map(fromRow);
  if (postFilter) {
    out = out.filter(p => parseSold(p.sold) >= minSales);
    out = limit > 0 ? out.slice(skip, skip + limit) : out.slice(skip);
  }
  return out;
}

// Total de produtos que batem com os filtros (pro contador/paginação da UI).
// Com minSales o número é aproximado: esse filtro é pós-query e o count roda no
// banco, então ele ignora o corte de vendas.
async function count({ categories, sources, excludeKeys, filters = {} } = {}) {
  const where = buildWhere({ categories, sources, excludeKeys, filters });
  return prisma().catalogProduct.count({ where });
}

async function getStats() {
  const [total, byCategoryRaw, byStoreRaw, byStoreCatRaw, last] = await Promise.all([
    prisma().catalogProduct.count(),
    prisma().catalogProduct.groupBy({ by: ["category"], _count: { _all: true } }),
    prisma().catalogProduct.groupBy({ by: ["store"], _count: { _all: true } }),
    prisma().catalogProduct.groupBy({ by: ["store", "category"], _count: { _all: true } }),
    prisma().catalogProduct.findFirst({ orderBy: { lastSeenAt: "desc" }, select: { lastSeenAt: true } }),
  ]);
  const byCategory = {};
  for (const r of byCategoryRaw) byCategory[r.category || "_null"] = r._count._all;
  const byStore = {};
  for (const r of byStoreRaw) {
    const sid = storeToId(r.store) || "_null";
    byStore[sid] = (byStore[sid] || 0) + r._count._all;
  }
  // Quebra por loja × categoria: { ml: { gamer: 10, casa: 5 }, amazon: {...}, ... }
  const byStoreCategory = {};
  for (const r of byStoreCatRaw) {
    const sid = storeToId(r.store) || "_null";
    const cat = r.category || "_null";
    if (!byStoreCategory[sid]) byStoreCategory[sid] = {};
    byStoreCategory[sid][cat] = (byStoreCategory[sid][cat] || 0) + r._count._all;
  }
  return {
    total,
    byCategory,
    byStore,
    byStoreCategory,
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

// Apaga TODO o catálogo (usado pelo botão "Apagar todos" do admin).
async function clearAll() {
  const r = await prisma().catalogProduct.deleteMany({});
  return { removed: r.count };
}

module.exports = {
  productKey,
  upsertProducts,
  loadAll,
  listAll,
  query,
  count,
  getStats,
  parseSold,
  prune,
  pruneBeforeDate,
  clearAll,
  storeToId,
};
