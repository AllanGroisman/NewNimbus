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
  "discount", "store", "category", "rating", "sold", "soldCount",
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
    // Shopee manda a contagem exata em soldCount; ML só tem o texto ("+1,5 mil
    // vendidos"). O parse acontece aqui, na gravação, pra o filtro de vendas
    // mínimas poder rodar no SQL.
    soldCount: p.soldCount != null && p.soldCount !== "" && Number.isFinite(Number(p.soldCount))
      ? Math.round(Number(p.soldCount))
      : parseSold(p.sold),
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
    // Depois do payload de propósito: linhas gravadas antes da coluna existir
    // ainda carregam um `soldCount` antigo lá dentro, e quem manda é a coluna.
    soldCount: r.soldCount ?? null,
    // Mesma regra: a campanha de cupom é coluna (só a sincronização de cupons
    // escreve nela), e o payload não tem voz nisso.
    couponCampaignId: r.couponCampaignId ?? null,
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

  const { minDiscount = 0, minPrice = 0, maxPrice, minRating = 0, minSales = 0, keywords = "", hasCoupon = false } = filters;
  // "só produtos com cupom do ML". Cabe no WHERE porque o vínculo mora numa
  // COLUNA (couponCampaignId, escrita só pela sincronização de cupons) — filtrar
  // isso em JS depois da query deixaria o count() e a paginação mentindo, que é
  // o mesmo motivo do soldCount ter virado coluna.
  if (hasCoupon) where.AND.push({ couponCampaignId: { not: null } });
  if (minDiscount > 0) where.AND.push({ discount: { gte: minDiscount } });
  if (minPrice > 0) where.AND.push({ price: { gte: minPrice } });
  if (maxPrice != null && Number.isFinite(maxPrice) && maxPrice > 0) {
    where.AND.push({ price: { lte: maxPrice, not: null } });
  }
  if (minRating > 0) where.AND.push({ rating: { gte: minRating } });
  // soldCount é gravado já parseado (0 quando o produto não diz quantas vendeu),
  // então o corte de vendas mínimas cabe no WHERE junto com os outros — é o que
  // mantém o count() honesto e a paginação sem páginas vazias no fim.
  if (minSales > 0) where.AND.push({ soldCount: { gte: minSales } });
  if (keywords && String(keywords).trim()) {
    const terms = String(keywords).toLowerCase().split(",").map(t => t.trim()).filter(Boolean);
    if (terms.length) {
      where.AND.push({ OR: terms.map(t => ({ name: { contains: t, mode: "insensitive" } })) });
    }
  }

  return where.AND.length ? where : undefined;
}

async function query({
  categories, sources, excludeKeys, filters = {}, limit = 200, offset = 0,
  sortBy = "discount_desc",
} = {}) {
  const where = buildWhere({ categories, sources, excludeKeys, filters });
  const skip = Math.max(0, Number(offset) || 0);

  // `nulls: "last"` é obrigatório: price/discount/rating são colunas opcionais e
  // no Postgres o DESC joga NULL na frente — "maior desconto" abria a lista com
  // os produtos que nem têm desconto.
  //
  // O `key` no fim desempata: empate é a regra aqui (dezenas de produtos com 50%
  // de desconto, a cauda inteira com desconto nulo) e sem critério estável o
  // Postgres pode devolver a mesma linha na página 1 e na 2 — e sumir com outra.
  const orderBy = (() => {
    switch (sortBy) {
      case "price_asc":     return [{ price: { sort: "asc", nulls: "last" } }, { key: "asc" }];
      case "price_desc":    return [{ price: { sort: "desc", nulls: "last" } }, { key: "asc" }];
      case "rating_desc":   return [{ rating: { sort: "desc", nulls: "last" } }, { key: "asc" }];
      case "lastSeen_desc": return [{ lastSeenAt: "desc" }, { key: "asc" }];
      case "discount_desc":
      default:              return [{ discount: { sort: "desc", nulls: "last" } }, { key: "asc" }];
    }
  })();

  const rows = await prisma().catalogProduct.findMany({
    where,
    orderBy,
    skip: skip || undefined,
    take: limit > 0 ? limit : undefined,
  });
  return rows.map(fromRow);
}

// Total de produtos que batem com os filtros (pro contador/paginação da UI).
// Mesmo `where` do query(), então o número é exato — inclusive com minSales.
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
