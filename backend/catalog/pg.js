// Implementação Postgres do catálogo (tudo async via Prisma).
const { Prisma } = require("@prisma/client");
const { prisma } = require("../db");
const { productKey, mlItemIdFromUrl, mlUrlSpace, mlAnuncioIdFromUrl } = require("./product-key");
const { normalizeText, parseSearch, isEmptySearch, likePattern } = require("./search-query");

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
  "mlAnuncioId", "nameSearch", "firstSeenAt", "lastSeenAt",
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
    nameSearch: normalizeText(p.name),
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
    mlAnuncioId: mlAnuncioIdFromUrl(p.link),
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

// A chave que cada produto deve usar no catálogo: Map<keyPedida, keyCanônica>.
//
// O mesmo anúncio do ML chega com chaves diferentes conforme o caminho (ver
// product-key.js:mlAnuncioIdFromUrl): a vitrine do cupom manda o nº de catálogo
// no caminho, o scraping manda o nº do anúncio. Se já existe linha com aquele
// anúncio, a chave dela é a canônica — a mais antiga, se houver mais de uma, que
// é a mesma escolha do scripts/merge-ml-duplicates.js. Se não existe, a primeira
// chave pedida para o anúncio vira a de todas (dois caminhos na mesma chamada).
//
// É o que o upsert usa para gravar na linha certa e o que os vínculos de cupom
// (coupons/pg.js:gravarVinculos) usam para apontar para ela. Chave sem anúncio
// (Amazon, Shopee, /p/ sem `wid`) é canônica de si mesma.
async function resolveKeys(items) {
  const mapa = new Map();
  const porAnuncio = new Map();
  for (const it of items || []) {
    if (!it?.key) continue;
    if (!mapa.has(it.key)) mapa.set(it.key, it.key);
    const anuncio = mlAnuncioIdFromUrl(it.link);
    if (!anuncio) continue;
    if (!porAnuncio.has(anuncio)) porAnuncio.set(anuncio, []);
    porAnuncio.get(anuncio).push(it.key);
  }
  if (!porAnuncio.size) return mapa;

  const dono = new Map();
  const anuncios = [...porAnuncio.keys()];
  const LOTE = 1000;
  for (let i = 0; i < anuncios.length; i += LOTE) {
    const rows = await prisma().catalogProduct.findMany({
      where: { mlAnuncioId: { in: anuncios.slice(i, i + LOTE) } },
      select: { key: true, mlAnuncioId: true },
      orderBy: [{ firstSeenAt: "asc" }, { key: "asc" }],
    });
    for (const r of rows) if (!dono.has(r.mlAnuncioId)) dono.set(r.mlAnuncioId, r.key);
  }

  for (const [anuncio, chaves] of porAnuncio) {
    const canonica = dono.get(anuncio) || chaves[0];
    for (const k of chaves) mapa.set(k, canonica);
  }
  return mapa;
}

async function upsertProducts(products) {
  const now = new Date();
  let inserted = 0, updated = 0, fundidos = 0;

  const valid = (products || []).filter(p => p && p.name);
  const comChave = valid.map(p => ({ p, key: productKey(p) }));
  const canonical = await resolveKeys(comChave.map(({ p, key }) => ({ key, link: p.link })));

  // Um item por chave canônica: dois caminhos do mesmo anúncio na mesma chamada
  // viravam dois upserts concorrentes da MESMA linha. Fica, de preferência, o que
  // É a chave canônica (link coerente com a key); senão o último.
  const porChave = new Map();
  for (const { p, key } of comChave) {
    const alvo = canonical.get(key) || key;
    const atual = porChave.get(alvo);
    if (!atual || key === alvo || atual.key !== alvo) porChave.set(alvo, { p, key, alvo });
  }

  // Em batch via transação. Prisma não tem ON CONFLICT bulk nativo no client JS;
  // usamos upsert individual em batches concorrentes pra não saturar a conexão.
  const itens = [...porChave.values()];
  const BATCH = 50;
  for (let i = 0; i < itens.length; i += BATCH) {
    const slice = itens.slice(i, i + BATCH);
    const ops = slice.map(async ({ p, key, alvo }) => {
      const row = toRow(p, alvo, now);
      // Gravando na linha de OUTRA chave (o mesmo anúncio que já estava lá): o
      // `link` fica o da linha, que é o que casa com a key dela — trocar o link
      // e manter a key deixaria os dois se desmentindo. O cupom (`couponCampaignId`)
      // nunca passa pelo upsert, então continua na linha.
      const fundindo = key !== alvo;
      const { link: _link, ...semLink } = row;
      const res = await prisma().catalogProduct.upsert({
        where: { key: alvo },
        create: { ...row, firstSeenAt: now },
        update: fundindo ? semLink : { ...row },
      });
      if (fundindo) fundidos++;
      // Detecta se foi inserção ou update comparando timestamps
      if (res.firstSeenAt.getTime() === res.lastSeenAt.getTime()) inserted++;
      else updated++;
    });
    await Promise.all(ops);
  }

  const total = await prisma().catalogProduct.count();
  return { inserted, updated, fundidos, total, canonical };
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

// Um produto pelo link, se ele já estiver no catálogo e ainda for recente.
// O `productKey` normaliza /p/MLB…, /MLB-…- e produto.mercadolivre.com.br/MLB-…
// na mesma chave, então o link colado à mão casa com o que o scraping gravou.
//
// Duas travas, porque aqui o produto vai parar na mensagem de um cliente:
//  - o número do ML da linha achada tem que ser o MESMO do link pedido. A chave
//    funde a numeração de catálogo (/p/MLB…) com a de anúncio (/MLB-…-), e dois
//    produtos diferentes com o mesmo número cairiam na mesma chave;
//  - linha velha não serve: preço de dias atrás no grupo de um cliente é pior do
//    que campo em branco. `maxAgeMs` null desliga a checagem de idade.
const CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;

async function getByLink(link, { maxAgeMs = CATALOG_MAX_AGE_MS } = {}) {
  if (!link || typeof link !== "string") return null;
  const key = productKey({ link });
  const row = await prisma().catalogProduct.findUnique({ where: { key } });
  let p = fromRow(row);

  if (p) {
    const pedido = mlItemIdFromUrl(link);
    const achado = mlItemIdFromUrl(p.link);
    // Mesmo número em espaços diferentes (/p/MLB123 × /MLB-123-) são produtos
    // diferentes que caem na mesma chave — aqui a linha não serve.
    const espacoPedido = mlUrlSpace(link);
    const espacoAchado = mlUrlSpace(p.link);
    if ((pedido && achado && pedido !== achado)
        || (espacoPedido && espacoAchado && espacoPedido !== espacoAchado)) p = null;
  }

  // Pela chave não achou: o produto pode estar no catálogo pelo OUTRO caminho —
  // o link colado é `produto.mercadolivre.com.br/MLB-<anúncio>` e a linha veio da
  // vitrine do cupom, em `/p/MLB<catálogo>?wid=MLB<anúncio>`. O anúncio é a mesma
  // identidade que o upsert usa para fundir as duas, então aqui não há número a
  // conferir: foi por ele que a linha foi achada.
  if (!p) {
    const anuncio = mlAnuncioIdFromUrl(link);
    if (anuncio) {
      p = fromRow(await prisma().catalogProduct.findFirst({
        where: { mlAnuncioId: anuncio },
        orderBy: [{ firstSeenAt: "asc" }, { key: "asc" }],
      }));
    }
  }
  if (!p) return null;

  if (maxAgeMs != null) {
    const seen = p.lastSeenAt ? Date.parse(p.lastSeenAt) : NaN;
    if (!Number.isFinite(seen) || Date.now() - seen > maxAgeMs) return null;
  }
  return p;
}

async function listAll() {
  const all = await prisma().catalogProduct.findMany();
  return all.map(fromRow);
}

// O pedaço de SQL da busca por palavras-chave (sintaxe em search-query.js), sobre
// a coluna `nameSearch` do alias `cp`. `fuzzy` deixa cada PALAVRA casar também
// por semelhança de trigramas (`<%`, o word_similarity do pg_trgm) — frase e
// exclusão continuam exatas, senão "-infantil" tiraria "infantaria".
// Devolve null quando a busca não tem termo nenhum.
function keywordSql(parsed, { fuzzy = false } = {}) {
  if (isEmptySearch(parsed)) return null;
  const like = (t) => Prisma.sql`cp."nameSearch" LIKE ${likePattern(t)}`;
  const cond = [];
  if (parsed.groups.length) {
    const grupos = parsed.groups.map(g => Prisma.join([
      ...g.words.map(w => (fuzzy ? Prisma.sql`(${like(w)} OR ${w} <% cp."nameSearch")` : like(w))),
      ...g.phrases.map(like),
    ], " AND "));
    cond.push(Prisma.sql`(${Prisma.join(grupos.map(g => Prisma.sql`(${g})`), " OR ")})`);
  }
  for (const x of parsed.excludes) cond.push(Prisma.sql`NOT ${like(x)}`);
  return Prisma.join(cond, " AND ");
}

// Corte de semelhança da busca aproximada. O padrão do pg_trgm (0,6) deixava de
// fora erro comum de digitação ("notbook" 0,55, "blutooth" 0,58); abaixo de 0,5
// começa a casar palavra que só divide um pedaço ("fone" ~ "iphone", 0,4).
const FUZZY_THRESHOLD = 0.5;

// Roda a consulta; na aproximada, numa transação com o corte do `<%` ajustado
// (SET LOCAL morre com ela, e não vaza pra outra consulta da mesma conexão).
async function runSearchSql(sql, fuzzy) {
  if (!fuzzy) return prisma().$queryRaw(sql);
  const [, rows] = await prisma().$transaction([
    prisma().$executeRawUnsafe(`SET LOCAL pg_trgm.word_similarity_threshold = ${FUZZY_THRESHOLD}`),
    prisma().$queryRaw(sql),
  ]);
  return rows;
}

// Monta o WHERE a partir dos filtros da campanha/página. Separado de query()
// porque count() precisa exatamente do mesmo filtro. SQL cru (e não o `where` do
// Prisma) por causa da busca: sem acento, com trigramas e ordem por relevância,
// nada disso cabe no client.
function buildWhere({ categories, sources, excludeKeys, filters = {} }) {
  const cond = [];

  if (Array.isArray(categories) && categories.length) {
    cond.push(Prisma.sql`cp."category" IN (${Prisma.join(categories)})`);
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
    cond.push(Prisma.sql`cp."store" IN (${Prisma.join(labels.length ? labels : ["__never_matches__"])})`);
  }
  if (excludeKeys) {
    const arr = excludeKeys instanceof Set ? [...excludeKeys] : (Array.isArray(excludeKeys) ? excludeKeys : []);
    // Um parâmetro só (array), e não um IN com milhares de placeholders.
    if (arr.length) cond.push(Prisma.sql`cp."key" <> ALL(${arr}::text[])`);
  }

  const { minDiscount = 0, minPrice = 0, maxPrice, minRating = 0, minSales = 0, keywords = "", hasCoupon = false, fuzzy = false } = filters;
  // "só produtos com cupom do ML". Cabe no WHERE porque o vínculo mora numa
  // COLUNA (couponCampaignId, escrita só pela sincronização de cupons) — filtrar
  // isso em JS depois da query deixaria o count() e a paginação mentindo, que é
  // o mesmo motivo do soldCount ter virado coluna.
  if (hasCoupon) cond.push(Prisma.sql`cp."couponCampaignId" IS NOT NULL`);
  if (minDiscount > 0) cond.push(Prisma.sql`cp."discount" >= ${minDiscount}`);
  if (minPrice > 0) cond.push(Prisma.sql`cp."price" >= ${minPrice}`);
  if (maxPrice != null && Number.isFinite(maxPrice) && maxPrice > 0) {
    cond.push(Prisma.sql`cp."price" <= ${maxPrice}`);
  }
  if (minRating > 0) cond.push(Prisma.sql`cp."rating" >= ${minRating}`);
  // soldCount é gravado já parseado (0 quando o produto não diz quantas vendeu),
  // então o corte de vendas mínimas cabe no WHERE junto com os outros — é o que
  // mantém o count() honesto e a paginação sem páginas vazias no fim.
  if (minSales > 0) cond.push(Prisma.sql`cp."soldCount" >= ${minSales}`);
  const kw = keywords && String(keywords).trim() ? keywordSql(parseSearch(keywords), { fuzzy }) : null;
  if (kw) cond.push(kw);

  return cond.length ? Prisma.sql`WHERE ${Prisma.join(cond, " AND ")}` : Prisma.empty;
}

// "Mais relevantes": primeiro quem tem a busca inteira como frase, depois quem
// COMEÇA com a primeira palavra, depois a soma da semelhança de cada palavra
// (o que ordena os resultados da busca aproximada). Desempata pelo desconto.
// Sem palavras-chave não há o que medir, e vale o maior desconto.
function relevanceOrder(keywords) {
  const parsed = parseSearch(keywords || "");
  const termos = parsed.groups.flatMap(g => [...g.words, ...g.phrases]);
  if (!termos.length) return null;
  const inteira = parsed.groups[0] ? [...parsed.groups[0].phrases, ...parsed.groups[0].words].join(" ") : termos[0];
  const primeira = termos[0];
  const soma = Prisma.join(termos.map(t => Prisma.sql`word_similarity(${t}, cp."nameSearch")`), " + ");
  return Prisma.sql`(cp."nameSearch" LIKE ${likePattern(inteira)}) DESC,
                    (cp."nameSearch" LIKE ${likePattern(primeira).slice(1)}) DESC,
                    (${soma}) DESC,
                    cp."discount" DESC NULLS LAST`;
}

async function query({
  categories, sources, excludeKeys, filters = {}, limit = 200, offset = 0,
  sortBy = "discount_desc",
} = {}) {
  const where = buildWhere({ categories, sources, excludeKeys, filters });
  const skip = Math.max(0, Number(offset) || 0);

  // `NULLS LAST` é obrigatório: price/discount/rating são colunas opcionais e
  // no Postgres o DESC joga NULL na frente — "maior desconto" abria a lista com
  // os produtos que nem têm desconto.
  //
  // O `key` no fim desempata: empate é a regra aqui (dezenas de produtos com 50%
  // de desconto, a cauda inteira com desconto nulo) e sem critério estável o
  // Postgres pode devolver a mesma linha na página 1 e na 2 — e sumir com outra.
  const orderBy = (sortBy === "relevance" && relevanceOrder(filters.keywords))
    || ADMIN_SORTS[sortBy] || ADMIN_SORTS.discount_desc;

  const lim = limit > 0 ? Prisma.sql`LIMIT ${Number(limit)}` : Prisma.empty;
  const rows = await runSearchSql(Prisma.sql`SELECT cp.* FROM "catalog_products" cp ${where}
                                             ORDER BY ${orderBy}, cp."key" ASC ${lim} OFFSET ${skip}`, !!filters.fuzzy);
  return rows.map(fromRow);
}

// A listagem da tela Admin › Produtos. SQL cru, e não o `buildWhere` do Prisma,
// por causa dos filtros de CUPOM: "produto coberto pela campanha X" mora na tabela
// de vínculos (ml_coupon_products), que não tem relação com o catálogo no schema.
// Via Prisma isso seria buscar as chaves antes e mandar um `key IN (…)` com até
// dezenas de milhares de itens; aqui é um EXISTS indexado por productKey.
//
// Só cupom VIGENTE conta, em todos os filtros — o mesmo corte do
// `couponsListForKeys`, que é o que a tela mostra no card. Filtrar por um cupom
// vencido e ver o card sem ele seria a tela se desmentindo.
//
// `cupom`: { status, busca, origem }
//   status — "com" | "com-palavra" | "sem-palavra" | "sem"
//   busca  — id da campanha (exato), palavra (sem caixa) ou trecho do título
//   origem — "vitrine" | "parcial" | "checkout" | "repasse" (de onde veio o vínculo)
const ADMIN_SORTS = {
  price_asc:     Prisma.sql`cp."price" ASC NULLS LAST`,
  price_desc:    Prisma.sql`cp."price" DESC NULLS LAST`,
  rating_desc:   Prisma.sql`cp."rating" DESC NULLS LAST`,
  lastSeen_desc: Prisma.sql`cp."lastSeenAt" DESC`,
  discount_desc: Prisma.sql`cp."discount" DESC NULLS LAST`,
};
const ORIGENS_CUPOM = new Set(["vitrine", "parcial", "checkout", "repasse"]);

async function adminQuery({
  category = null, source = null, q = "", minDiscount = 0, sortBy = "lastSeen_desc",
  page = 1, pageSize = 60, cupom = {},
} = {}) {
  const cond = [];
  if (category) cond.push(Prisma.sql`cp."category" = ${category}`);
  if (source) {
    const label = { ml: "Mercado Livre", amazon: "Amazon", shopee: "Shopee" }[storeToId(source)];
    cond.push(Prisma.sql`cp."store" = ${label || "__never_matches__"}`);
  }
  const termo = String(q || "").trim();
  const kw = termo ? keywordSql(parseSearch(termo)) : null;
  if (kw) cond.push(kw);
  if (Number(minDiscount) > 0) cond.push(Prisma.sql`cp."discount" >= ${Number(minDiscount)}`);

  // O vínculo vigente do produto, com os filtros de busca/origem já aplicados.
  // Os filtros de status se compõem com ele: "com palavra" + busca "casa" é
  // "tem um cupom de casa, e esse cupom tem palavra".
  const { status = null, busca = "", origem = null } = cupom || {};
  const vinc = [
    Prisma.sql`p."productKey" = cp."key"`,
    Prisma.sql`(c."expiresAt" IS NULL OR c."expiresAt" > NOW())`,
  ];
  const b = String(busca || "").trim();
  if (b) {
    vinc.push(Prisma.sql`(c."campaign_id" = ${b} OR LOWER(c."code") = LOWER(${b}) OR c."title" ILIKE ${"%" + b + "%"})`);
  }
  if (origem && ORIGENS_CUPOM.has(origem)) vinc.push(Prisma.sql`p."origem" = ${origem}`);
  const existe = (extra) => Prisma.sql`EXISTS (
    SELECT 1 FROM "ml_coupon_products" p
      JOIN "ml_coupons" c ON c."campaign_id" = p."campaign_id"
     WHERE ${Prisma.join([...vinc, ...(extra ? [extra] : [])], " AND ")})`;

  if (status === "sem") {
    cond.push(Prisma.sql`NOT ${existe()}`);
  } else if (status === "com-palavra") {
    cond.push(existe(Prisma.sql`c."code" IS NOT NULL`));
  } else if (status === "sem-palavra") {
    cond.push(existe());
    cond.push(Prisma.sql`NOT ${existe(Prisma.sql`c."code" IS NOT NULL`)}`);
  } else if (status === "com" || b || (origem && ORIGENS_CUPOM.has(origem))) {
    // Buscar por um cupom (ou por uma origem) já implica ter o cupom.
    cond.push(existe());
  }

  const where = cond.length ? Prisma.sql`WHERE ${Prisma.join(cond, " AND ")}` : Prisma.empty;
  const orderBy = ADMIN_SORTS[sortBy] || ADMIN_SORTS.lastSeen_desc;
  const take = Math.min(200, Math.max(1, Number(pageSize) || 60));
  const skip = (Math.max(1, Number(page) || 1) - 1) * take;

  const [rows, contagem] = await Promise.all([
    prisma().$queryRaw`SELECT cp.* FROM "catalog_products" cp ${where}
                        ORDER BY ${orderBy}, cp."key" ASC LIMIT ${take} OFFSET ${skip}`,
    prisma().$queryRaw`SELECT COUNT(*)::int AS n FROM "catalog_products" cp ${where}`,
  ]);
  return { items: rows.map(fromRow), total: contagem[0]?.n || 0 };
}

// Total de produtos que batem com os filtros (pro contador/paginação da UI).
// Mesmo `where` do query(), então o número é exato — inclusive com minSales.
async function count({ categories, sources, excludeKeys, filters = {} } = {}) {
  const where = buildWhere({ categories, sources, excludeKeys, filters });
  const [{ n }] = await runSearchSql(Prisma.sql`SELECT COUNT(*)::int AS n FROM "catalog_products" cp ${where}`, !!filters.fuzzy);
  return n || 0;
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

// `keepCouponLinked`: poupa o produto com vínculo (ml_coupon_products) a um cupom
// que ainda vale. Os produtos das vitrines de cupons entram no catálogo com o
// lastSeenAt da COLHEITA de cupons, não do scraping — sem isso, o purge diário do
// scraping apagava todos eles (~90 mil numa rodada). O vínculo, e não a coluna
// couponCampaignId, é o critério: não depende do syncCatalogCoupons ter rodado.
// O prune de 30 dias (acima) continua valendo para todos.
async function pruneBeforeDate(cutoffDate, { keepCouponLinked = false } = {}) {
  const cutoff = new Date(cutoffDate);
  if (!keepCouponLinked) {
    const r = await prisma().catalogProduct.deleteMany({ where: { lastSeenAt: { lt: cutoff } } });
    const total = await prisma().catalogProduct.count();
    return { removed: r.count, kept: 0, total };
  }
  const removed = await prisma().$executeRaw`
    DELETE FROM "catalog_products" cp
     WHERE cp."lastSeenAt" < ${cutoff}
       AND NOT EXISTS (
         SELECT 1 FROM "ml_coupon_products" p
           JOIN "ml_coupons" c ON c."campaign_id" = p."campaign_id"
          WHERE p."productKey" = cp."key"
            AND (c."expiresAt" IS NULL OR c."expiresAt" > now()))`;
  // O que sobrou antes do corte é justamente o que o cupom segurou.
  const [kept, total] = await Promise.all([
    prisma().catalogProduct.count({ where: { lastSeenAt: { lt: cutoff } } }),
    prisma().catalogProduct.count(),
  ]);
  return { removed: Number(removed), kept, total };
}

// Apaga TODO o catálogo (usado pelo botão "Apagar todos" do admin).
//
// As sondas do checkout em lote (`ml_checkout_probes`) vão junto: são por produto,
// e o lote pula por 7 dias quem foi sondado há pouco. Sem isto, os produtos que o
// próximo scraping trouxer de volta — com a mesma chave — ficariam de fora da fila.
async function clearAll() {
  const [sondas, r] = await prisma().$transaction([
    prisma().mlCheckoutProbe.deleteMany({}),
    prisma().catalogProduct.deleteMany({}),
  ]);
  return { removed: r.count, sondas: sondas.count };
}

module.exports = {
  productKey,
  resolveKeys,
  upsertProducts,
  loadAll,
  getByLink,
  CATALOG_MAX_AGE_MS,
  listAll,
  query,
  adminQuery,
  count,
  getStats,
  parseSold,
  prune,
  pruneBeforeDate,
  clearAll,
  storeToId,
};
