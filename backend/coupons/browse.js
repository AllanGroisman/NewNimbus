// Admin › Cupons (task 17): a tela de NAVEGAR pelos cupons guardados — resumo,
// lista filtrável e os produtos de cada cupom, também filtráveis.
//
// Separado do `pg.js` porque as perguntas são outras. Lá mora quem escreve (a
// colheita, a sonda, o repasse) e a tabela da aba "Cupons do ML", que é a tela de
// OPERAR a colheita. Aqui é só leitura, com SQL cru: os filtros de produto cruzam
// `ml_coupon_products` com `catalog_products`, que não têm relação no schema, e a
// contagem de produtos por cupom precisa entrar no ORDER BY.
//
// "Vigente" é a mesma régua do resto do sistema (`couponsListForKeys`): sem data de
// validade, ou com ela no futuro.
const { Prisma } = require("@prisma/client");
const { prisma } = require("../db");
const { normalizeText, likePattern } = require("../catalog/search-query");
const { detalheDoCupom } = require("./price");

const VIGENTE = Prisma.sql`(c."expiresAt" IS NULL OR c."expiresAt" > NOW())`;
// "Vencendo": o que ainda vale, mas acaba nas próximas 72 horas.
const VENCENDO = Prisma.sql`(c."expiresAt" > NOW() AND c."expiresAt" <= NOW() + INTERVAL '72 hours')`;
const N_PRODUTOS = Prisma.sql`(SELECT COUNT(*)::int FROM "ml_coupon_products" p WHERE p."campaign_id" = c."campaign_id")`;

const clampPage = (v) => Math.max(1, Number(v) || 1);
const clampSize = (v, def = 24) => Math.min(100, Math.max(5, Number(v) || def));
const texto = (v, max = 100) => String(v || "").trim().slice(0, max);

// O "15% OFF" / "R$ 30 OFF" de um cupom — a regra, não o que ela vale num produto.
function rotuloDoCupom(c) {
  const v = Number(c?.value);
  if (!Number.isFinite(v) || v <= 0) return null;
  if (c.kind === "percent") return `${v}% OFF`;
  if (c.kind === "fixed") return `R$ ${v.toLocaleString("pt-BR", { minimumFractionDigits: 2 })} OFF`;
  return null;
}

// ── Resumo ─────────────────────────────────────────────────────────────────
async function resumo() {
  const [[n], categorias, destaques] = await Promise.all([
    prisma().$queryRaw`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE ${VIGENTE})::int AS vigentes,
             COUNT(*) FILTER (WHERE NOT ${VIGENTE})::int AS vencidos,
             COUNT(*) FILTER (WHERE ${VENCENDO})::int AS vencendo,
             COUNT(*) FILTER (WHERE ${VIGENTE} AND c."code" IS NOT NULL)::int AS "comPalavra",
             COUNT(*) FILTER (WHERE ${VIGENTE} AND EXISTS (
               SELECT 1 FROM "ml_coupon_products" p WHERE p."campaign_id" = c."campaign_id"))::int AS "comProdutos",
             COUNT(*) FILTER (WHERE ${VIGENTE} AND c."scope" = 'store')::int AS "deLoja"
        FROM "ml_coupons" c`,
    // As categorias do ML dos cupons vigentes (o mesmo cupom pode estar em várias).
    prisma().$queryRaw`
      SELECT g.chave AS chave, COUNT(*)::int AS n
        FROM "ml_coupons" c, LATERAL jsonb_array_elements_text(c."groupings") AS g(chave)
       WHERE ${VIGENTE}
       GROUP BY 1 ORDER BY 2 DESC`,
    // Os maiores descontos percentuais com palavra: o que vale a pena anunciar já.
    prisma().$queryRaw`
      SELECT c."campaign_id" AS "campaignId", c."title", c."code", c."kind", c."value", c."expiresAt"
        FROM "ml_coupons" c
       WHERE ${VIGENTE} AND c."code" IS NOT NULL AND c."kind" = 'percent' AND c."value" > 0 AND c."value" < 100
       ORDER BY c."value" DESC, c."lastSeenAt" DESC
       LIMIT 5`,
  ]);
  const [{ vinculos }] = await prisma().$queryRaw`SELECT COUNT(*)::int AS vinculos FROM "ml_coupon_products"`;
  return {
    ...n,
    vinculos,
    categorias: categorias.map(r => ({ chave: r.chave, n: r.n })),
    destaques: destaques.map(d => ({ ...d, rotulo: rotuloDoCupom(d) })),
  };
}

// ── Lista de cupons ────────────────────────────────────────────────────────
const SITUACOES = new Set(["vigentes", "vencendo", "vencidos", "todos"]);
const ORDENS_CUPOM = {
  recentes: Prisma.sql`c."lastSeenAt" DESC`,
  // Percentual antes de valor fixo: "20%" e "R$ 20" não cabem na mesma régua.
  desconto: Prisma.sql`(c."kind" = 'percent') DESC, c."value" DESC NULLS LAST`,
  vence: Prisma.sql`c."expiresAt" ASC NULLS LAST`,
  produtos: Prisma.sql`${N_PRODUTOS} DESC`,
  minimo: Prisma.sql`c."minPurchase" ASC NULLS FIRST`,
};

function whereCupons(f = {}) {
  const cond = [];
  const situacao = SITUACOES.has(f.situacao) ? f.situacao : "vigentes";
  if (situacao === "vigentes") cond.push(VIGENTE);
  else if (situacao === "vencendo") cond.push(VENCENDO);
  else if (situacao === "vencidos") cond.push(Prisma.sql`NOT ${VIGENTE}`);

  const q = texto(f.q);
  if (q) {
    const like = `%${q}%`;
    cond.push(Prisma.sql`(c."title" ILIKE ${like} OR c."sellerName" ILIKE ${like}
                          OR c."code" ILIKE ${like} OR c."campaign_id" = ${q})`);
  }
  if (f.palavra === "com") cond.push(Prisma.sql`c."code" IS NOT NULL`);
  else if (f.palavra === "sem") cond.push(Prisma.sql`c."code" IS NULL`);
  if (f.tipo === "percent" || f.tipo === "fixed") cond.push(Prisma.sql`c."kind" = ${f.tipo}`);
  if (f.escopo === "campaign" || f.escopo === "store") cond.push(Prisma.sql`c."scope" = ${f.escopo}`);
  const cat = texto(f.categoria);
  // `groupings` é um array jsonb — `?` é "o array contém esta string".
  if (cat) cond.push(Prisma.sql`c."groupings" ? ${cat}`);
  if (f.produtos === "com") cond.push(Prisma.sql`EXISTS (SELECT 1 FROM "ml_coupon_products" p WHERE p."campaign_id" = c."campaign_id")`);
  else if (f.produtos === "sem") cond.push(Prisma.sql`NOT EXISTS (SELECT 1 FROM "ml_coupon_products" p WHERE p."campaign_id" = c."campaign_id")`);
  const minValor = Number(f.minValor) || 0;
  if (minValor > 0) cond.push(Prisma.sql`c."value" >= ${minValor}`);
  return cond.length ? Prisma.sql`WHERE ${Prisma.join(cond, " AND ")}` : Prisma.empty;
}

async function listar(f = {}) {
  const where = whereCupons(f);
  const take = clampSize(f.pageSize);
  const page = clampPage(f.page);
  const orderBy = ORDENS_CUPOM[f.sortBy] || ORDENS_CUPOM.recentes;
  const [rows, [{ n }]] = await Promise.all([
    prisma().$queryRaw`
      SELECT c."campaign_id" AS "campaignId", c."title", c."subtitle", c."kind", c."value",
             c."minPurchase", c."maxDiscount", c."scope", c."sellerName", c."code", c."activated",
             c."startsAt", c."expiresAt", c."expiresText", c."iconUrl", c."groupings",
             c."firstSeenAt", c."lastSeenAt", c."productsSyncedAt", c."vitrineTotal",
             ${N_PRODUTOS} AS produtos
        FROM "ml_coupons" c ${where}
       ORDER BY ${orderBy}, c."campaign_id" ASC
       LIMIT ${take} OFFSET ${(page - 1) * take}`,
    prisma().$queryRaw`SELECT COUNT(*)::int AS n FROM "ml_coupons" c ${where}`,
  ]);
  return {
    page, pageSize: take, total: n,
    items: rows.map(r => ({ ...r, rotulo: rotuloDoCupom(r), vigente: !r.expiresAt || new Date(r.expiresAt) > new Date() })),
  };
}

async function detalhe(campaignId) {
  const [c] = await prisma().$queryRaw`
    SELECT c."campaign_id" AS "campaignId", c."title", c."subtitle", c."kind", c."value",
           c."minPurchase", c."maxDiscount", c."scope", c."sellerName", c."code", c."activated",
           c."activationType", c."startsAt", c."expiresAt", c."expiresText", c."iconUrl", c."groupings",
           c."containerUrl", c."firstSeenAt", c."lastSeenAt", c."productsSyncedAt", c."vitrineTotal",
           ${N_PRODUTOS} AS produtos
      FROM "ml_coupons" c WHERE c."campaign_id" = ${String(campaignId)}`;
  if (!c) return null;
  const origens = await prisma().$queryRaw`
    SELECT p."origem", COUNT(*)::int AS n,
           COUNT(cp."key")::int AS "noCatalogo"
      FROM "ml_coupon_products" p
      LEFT JOIN "catalog_products" cp ON cp."key" = p."productKey"
     WHERE p."campaign_id" = ${c.campaignId}
     GROUP BY 1 ORDER BY 2 DESC`;
  return {
    ...c,
    rotulo: rotuloDoCupom(c),
    vigente: !c.expiresAt || new Date(c.expiresAt) > new Date(),
    origens: origens.map(o => ({ origem: o.origem || "vitrine", n: o.n, noCatalogo: o.noCatalogo })),
    noCatalogo: origens.reduce((s, o) => s + o.noCatalogo, 0),
  };
}

// ── Produtos de um cupom ───────────────────────────────────────────────────
const ORDENS_PRODUTO = {
  recentes: Prisma.sql`p."lastSeenAt" DESC`,
  // Com o cupom deste cupom, o preço final cresce junto com o preço (o teto só
  // achata o desconto) — ordenar pelo preço é ordenar pelo final.
  preco_asc: Prisma.sql`cp."price" ASC NULLS LAST`,
  preco_desc: Prisma.sql`cp."price" DESC NULLS LAST`,
  desconto: Prisma.sql`cp."discount" DESC NULLS LAST`,
  vendidos: Prisma.sql`cp."soldCount" DESC NULLS LAST`,
  nota: Prisma.sql`cp."rating" DESC NULLS LAST`,
};
const ORIGENS = new Set(["vitrine", "parcial", "checkout", "repasse"]);

async function produtos(campaignId, f = {}) {
  const cupom = await prisma().mlCoupon.findUnique({ where: { campaignId: String(campaignId) } });
  if (!cupom) return null;

  const cond = [Prisma.sql`p."campaign_id" = ${cupom.campaignId}`];
  const q = normalizeText(texto(f.q));
  if (q) cond.push(Prisma.sql`cp."nameSearch" LIKE ${likePattern(q)}`);
  if (ORIGENS.has(f.origem)) cond.push(Prisma.sql`p."origem" = ${f.origem}`);
  if (f.catalogo === "com") cond.push(Prisma.sql`cp."key" IS NOT NULL`);
  else if (f.catalogo === "sem") cond.push(Prisma.sql`cp."key" IS NULL`);
  const minPrice = Number(f.minPrice) || 0;
  const maxPrice = Number(f.maxPrice) || 0;
  if (minPrice > 0) cond.push(Prisma.sql`cp."price" >= ${minPrice}`);
  if (maxPrice > 0) cond.push(Prisma.sql`cp."price" <= ${maxPrice}`);
  const minDiscount = Number(f.minDiscount) || 0;
  if (minDiscount > 0) cond.push(Prisma.sql`cp."discount" >= ${minDiscount}`);
  // "O cupom pega": o produto passa da compra mínima (sem preço não dá pra saber).
  if (f.valendo === true || f.valendo === "1" || f.valendo === "true") {
    cond.push(Prisma.sql`cp."price" IS NOT NULL`);
    if (Number(cupom.minPurchase) > 0) cond.push(Prisma.sql`cp."price" >= ${Number(cupom.minPurchase)}`);
  }
  const where = Prisma.sql`WHERE ${Prisma.join(cond, " AND ")}`;
  const take = clampSize(f.pageSize);
  const page = clampPage(f.page);
  const orderBy = ORDENS_PRODUTO[f.sortBy] || ORDENS_PRODUTO.recentes;

  const [rows, [{ n }]] = await Promise.all([
    prisma().$queryRaw`
      SELECT p."productKey", p."productUrl", p."origem", p."firstSeenAt" AS "linkedAt", p."lastSeenAt" AS "linkSeenAt",
             cp."key" AS "catalogKey", cp."name", cp."img", cp."price", cp."originalPrice", cp."discount",
             cp."link", cp."store", cp."category", cp."rating", cp."sold", cp."soldCount", cp."lastSeenAt"
        FROM "ml_coupon_products" p
        LEFT JOIN "catalog_products" cp ON cp."key" = p."productKey"
        ${where}
       ORDER BY ${orderBy}, p."productKey" ASC
       LIMIT ${take} OFFSET ${(page - 1) * take}`,
    prisma().$queryRaw`
      SELECT COUNT(*)::int AS n
        FROM "ml_coupon_products" p
        LEFT JOIN "catalog_products" cp ON cp."key" = p."productKey"
        ${where}`,
  ]);

  return {
    page, pageSize: take, total: n,
    items: rows.map(r => {
      const d = r.price != null ? detalheDoCupom(r.price, cupom) : null;
      return {
        productKey: r.productKey,
        origem: r.origem || "vitrine",
        linkedAt: r.linkedAt,
        inCatalog: !!r.catalogKey,
        name: r.name || null,
        img: r.img || null,
        link: r.link || r.productUrl,
        price: r.price, originalPrice: r.originalPrice, discount: r.discount,
        store: r.store, category: r.category, rating: r.rating, sold: r.sold, soldCount: r.soldCount,
        lastSeenAt: r.lastSeenAt,
        // Nulos quando o cupom não pega neste preço (compra mínima, vencido…).
        priceWithCoupon: d ? d.final : null,
        economia: d ? d.economia : null,
      };
    }),
  };
}

module.exports = { resumo, listar, detalhe, produtos, rotuloDoCupom };
