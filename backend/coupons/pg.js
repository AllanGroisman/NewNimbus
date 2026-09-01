// Onde os cupons do Mercado Livre e os produtos de cada um ficam guardados.
//
// Três tabelas (ver schema.prisma): `ml_coupons` (o cupom), `ml_coupon_products`
// (o vínculo cupom ↔ produto, pela chave do catálogo) e `ml_coupon_codes` (as
// PALAVRAS testadas e o que o ML respondeu a cada uma).
//
// A regra que explica quase tudo aqui: quem raspa não decide nada sobre o
// catálogo. O scraping normal reescreve o payload do produto inteiro a cada
// rodada (catalog/pg.js:toRow), então o vínculo com o cupom mora numa COLUNA
// própria (`catalog_products.couponCampaignId`) que só este arquivo escreve.
const { prisma } = require("../db");

// Um cupom vencido não pode continuar carimbado no produto: a fila do repasse
// mandaria "leve com cupom" para um cupom que não existe mais.
const EXPIRA_COM_FOLGA_MIN = 0;

function nowish() { return new Date(); }

// ────────────────────────────────────────────────────────────────────────
// Gravação
// ────────────────────────────────────────────────────────────────────────

// Grava (ou atualiza) os cupons de uma rodada. Devolve { novos, atualizados }.
//
// `lastSeenAt` é o que separa "o cupom continua na página" de "sumiu": nada é
// apagado aqui, porque o cupom que sai da vitrine de hoje pode voltar amanhã e
// os vínculos dele ainda valem enquanto não vencer.
async function upsertCoupons(coupons, { origin = "page" } = {}) {
  const agora = nowish();
  let novos = 0, atualizados = 0;

  for (const c of coupons || []) {
    if (!c || !c.campaignId) continue;
    const row = {
      title: c.title || "(sem título)",
      subtitle: c.subtitle ?? null,
      kind: c.kind || "unknown",
      value: c.value ?? null,
      minPurchase: c.minPurchase ?? null,
      maxDiscount: c.maxDiscount ?? null,
      scope: c.scope || "campaign",
      sellerName: c.sellerName ?? null,
      containerUrl: c.containerUrl ?? null,
      activated: !!c.activated,
      activationType: c.activationType ?? null,
      startsAt: c.startsAt ? new Date(c.startsAt) : null,
      expiresAt: c.expiresAt ? new Date(c.expiresAt) : null,
      expiresText: c.expiresText ?? null,
      iconUrl: c.iconUrl ?? null,
      sampleItems: c.sampleItems || [],
      raw: c.raw || {},
      lastSeenAt: agora,
    };
    // Os ids da amostra só são ESCRITOS quando vieram: o cupom pode chegar por um
    // caminho que não lê o bloco de telemetria (uma busca por campanha, um dump
    // parcial), e gravar `[]` ali apagaria a amostra que a rodada anterior achou.
    // Lista vazia aqui é "não sei", não "não tem" — a mesma disciplina do
    // sem-vitrine ≠ fora-da-vitrine, um nível abaixo.
    const comIds = (c.sampleItemIds || []).length ? { sampleItemIds: c.sampleItemIds } : {};
    // A categoria segue a mesma disciplina, e pelo mesmo motivo. O ML não diz a
    // vertical do cupom na lista: a categoria que chega aqui é o filtro que a
    // rodada pediu na URL (ver parseFilterProps, scraping/ml-cupons.js). Uma
    // passada na lista GERAL não pede filtro nenhum e traz `[]` para todo mundo —
    // e gravar isso por cima apagava a categoria que uma rodada por vertical já
    // tinha aprendido. Lista vazia aqui é "não sei", não "não tem".
    const comGrupos = (c.groupings || []).length ? { groupings: c.groupings } : {};
    const r = await prisma().mlCoupon.upsert({
      where: { campaignId: c.campaignId },
      create: { campaignId: c.campaignId, origin, firstSeenAt: agora, ...row, groupings: c.groupings || [], sampleItemIds: c.sampleItemIds || [] },
      update: { ...row, ...comGrupos, ...comIds },
    });
    if (r.firstSeenAt.getTime() === r.lastSeenAt.getTime()) novos++; else atualizados++;
  }
  return { novos, atualizados };
}

// Os produtos de UM cupom. `items` são produtos no formato do catálogo (o que o
// harvestMLCards devolve) — a chave é calculada pelo chamador, que é quem já tem
// o productKey na mão.
//
// Vínculo que não veio nesta rodada é APAGADO: o cupom deixou de cobrir aquele
// produto, e um vínculo velho vira promessa falsa na fila do repasse.
//
// O apagamento é escopado por ORIGEM, e isso não é detalhe: vitrine e amostra são
// duas coleções que chegam por caminhos diferentes e em momentos diferentes. Sem o
// escopo, raspar a vitrine apagaria as amostras (e a rodada seguinte, que só
// consegue as amostras, apagaria a vitrine inteira) — cada uma zerando a outra.
async function replaceCouponProducts(campaignId, items, { origem = "vitrine" } = {}) {
  const agora = nowish();
  const chaves = [];

  for (const it of items || []) {
    if (!it?.productKey || !it?.productUrl) continue;
    chaves.push(it.productKey);
    await prisma().mlCouponProduct.upsert({
      where: { campaignId_productKey: { campaignId, productKey: it.productKey } },
      // Produto que já estava como amostra e apareceu na vitrine é PROMOVIDO: o
      // vínculo passa a ser o forte, e some da coleção fraca sozinho.
      create: { campaignId, productKey: it.productKey, productUrl: it.productUrl, origem, firstSeenAt: agora, lastSeenAt: agora },
      update: { productUrl: it.productUrl, origem, lastSeenAt: agora },
    });
  }

  const { count: removidos } = await prisma().mlCouponProduct.deleteMany({
    where: { campaignId, origem, productKey: { notIn: chaves.length ? chaves : ["__nenhum__"] } },
  });
  // `productsSyncedAt` quer dizer "a VITRINE foi raspada" e continua querendo
  // dizer só isso — a amostra não é vitrine e não pode carimbar esse campo, senão
  // a tela pararia de oferecer o botão de raspar justamente onde ele é preciso.
  if (origem === "vitrine") {
    await prisma().mlCoupon.update({ where: { campaignId }, data: { productsSyncedAt: agora } }).catch(() => {});
  }

  return { vinculados: chaves.length, removidos };
}

// As 4 miniaturas do card do cupom, gravadas como vínculo parcial.
//
// Vem de `ml_coupons.sampleItemIds` (ml-cupons.js:sampleIdsFromTracking). Como o
// ML não dá a URL do anúncio ali — só o id —, a URL é a sintética de catálogo, a
// MESMA forma que coupons/quick-check.js:chavesCandidatas monta a partir de
// `pdp_filters=item_id:MLB…`. É isso que faz a chave bater dos dois lados: se as
// duas pontas não usarem a mesma URL, o hash sai diferente e o vínculo nunca casa.
function linkSinteticoML(itemId) {
  const n = (String(itemId || "").match(/MLB-?(\d{6,})/i) || [])[1];
  return n ? `https://www.mercadolivre.com.br/x/p/MLB${n}` : null;
}

async function replaceCouponSamples(campaignId, itemIds) {
  const { productKey } = require("../catalog/product-key");
  const items = [];
  for (const id of itemIds || []) {
    const link = linkSinteticoML(id);
    if (!link) continue;
    items.push({ productKey: productKey({ link }), productUrl: link });
  }
  return replaceCouponProducts(String(campaignId), items, { origem: "amostra" });
}

// Carimba no catálogo qual campanha cobre cada produto — e tira o carimbo do que
// não vale mais. É a única escrita nesta coluna em todo o sistema.
//
// Ordem importa: primeiro limpa tudo que aponta para campanha vencida ou para
// vínculo que sumiu, depois carimba o que está valendo. Fazer ao contrário
// deixaria uma janela em que o produto aponta para dois cupons.
async function syncCatalogCoupons() {
  const agora = nowish();

  // 1. Cupons vencidos deixam de valer para todo mundo.
  const vencidos = await prisma().mlCoupon.findMany({
    where: { expiresAt: { not: null, lt: agora } },
    select: { campaignId: true },
  });
  const idsVencidos = vencidos.map(c => c.campaignId);
  let limpos = 0;
  if (idsVencidos.length) {
    const r = await prisma().catalogProduct.updateMany({
      where: { couponCampaignId: { in: idsVencidos } },
      data: { couponCampaignId: null },
    });
    limpos += r.count;
  }

  // 2. Carimba o que está valendo. Um produto pode estar em mais de um cupom; fica
  //    o de maior desconto percentual (o ML só deixa aplicar um por produto de
  //    qualquer jeito — "Cada produto pode ter apenas um cupom aplicado", diz a
  //    própria página).
  const vinculos = await prisma().$queryRaw`
    SELECT DISTINCT ON (p."productKey") p."productKey", p."campaign_id" AS "campaignId"
      FROM "ml_coupon_products" p
      JOIN "ml_coupons" c ON c."campaign_id" = p."campaign_id"
     WHERE (c."expiresAt" IS NULL OR c."expiresAt" > NOW())
     ORDER BY p."productKey", (CASE WHEN c."kind" = 'percent' THEN c."value" ELSE 0 END) DESC NULLS LAST, c."value" DESC NULLS LAST
  `;

  // Um UPDATE só, com a lista de pares. Fazer linha a linha custava mil idas ao
  // banco — e a versão anterior ainda errava o filtro: `NOT { couponCampaignId }`
  // vira `NOT (coluna = valor)` no SQL, que é NULL (nunca verdadeiro) justamente
  // nas linhas ainda sem cupom, que são as que precisavam ser carimbadas.
  let carimbados = 0;
  const BATCH = 500;
  for (let i = 0; i < vinculos.length; i += BATCH) {
    const lote = vinculos.slice(i, i + BATCH);
    const chaves = lote.map(v => v.productKey);
    const campanhas = lote.map(v => v.campaignId);
    carimbados += Number(await prisma().$executeRaw`
      UPDATE "catalog_products" cp
         SET "couponCampaignId" = v."campaignId"
        FROM (SELECT UNNEST(${chaves}::text[]) AS "key", UNNEST(${campanhas}::text[]) AS "campaignId") v
       WHERE cp."key" = v."key"
         AND ("couponCampaignId" IS NULL OR "couponCampaignId" <> v."campaignId")
    `);
  }

  // 3. Produto carimbado com campanha que não tem mais vínculo nenhum com ele.
  const orfaos = await prisma().$executeRaw`
    UPDATE "catalog_products" cp SET "couponCampaignId" = NULL
     WHERE cp."couponCampaignId" IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM "ml_coupon_products" p
          WHERE p."productKey" = cp."key" AND p."campaign_id" = cp."couponCampaignId")
  `;

  return { carimbados, limpos: limpos + Number(orfaos || 0), vinculosAtivos: vinculos.length };
}

// Uma palavra testada no ML. O histórico é por palavra (PK), com contador — a
// mesma palavra costuma chegar de novo pelo repasse, e o que interessa é o
// veredito mais recente sem perder desde quando ela é conhecida.
async function recordCodeCheck({ code, verdict, campaignId = null, message = null, responseCode = null, source = "admin", raw = {} }) {
  if (!code) return null;
  const agora = nowish();

  // Este dicionário é a ÚNICA cópia do "palavra → campanha": a página do ML não
  // lista palavra nenhuma, e a resposta só se descobre digitando. Um engasgo do ML
  // ("Tivemos um problema", que chega como indeterminado) não é motivo para apagar
  // uma resposta boa — foi assim que BRINCADEIRAS perdeu a campanha 13471229 e
  // passou a aparecer na tela como "o ML não reconheceu". Guarda o que se sabe e
  // registra só que houve mais uma tentativa.
  const anterior = await prisma().mlCouponCode.findUnique({ where: { code } });
  const preservar = verdict === "indeterminado" && anterior?.verdict === "valid";

  const r = await prisma().mlCouponCode.upsert({
    where: { code },
    create: { code, verdict, campaignId, message, responseCode, source, raw: raw || {}, checkedAt: agora, checkCount: 1, firstSeenAt: agora },
    update: preservar
      ? { checkedAt: agora, checkCount: { increment: 1 } }
      : { verdict, campaignId, message, responseCode, source, raw: raw || {}, checkedAt: agora, checkCount: { increment: 1 } },
  });

  // A palavra resolveu para uma campanha: carimba nela, que é o que fecha o ciclo
  // "palavra do grupo líder → produtos do cupom". Quem manda é a campanha que ficou
  // na linha (`r`), não a da resposta — no caso preservado elas diferem.
  if (r.campaignId) {
    await prisma().mlCoupon.updateMany({ where: { campaignId: r.campaignId, code: null }, data: { code } }).catch(() => {});
  }
  return r;
}

// ────────────────────────────────────────────────────────────────────────
// Leitura
// ────────────────────────────────────────────────────────────────────────

function buildCouponWhere({ q = "", scope = null, grouping = null, onlyActive = false, onlyValid = false, withCode = false } = {}) {
  const AND = [];
  if (q && String(q).trim()) {
    const t = String(q).trim();
    AND.push({ OR: [
      { title: { contains: t, mode: "insensitive" } },
      { sellerName: { contains: t, mode: "insensitive" } },
      { campaignId: { contains: t } },
      { code: { contains: t, mode: "insensitive" } },
    ] });
  }
  if (scope) AND.push({ scope });
  // A categoria do ML mora num array Json (jsonb no Postgres) porque o mesmo cupom
  // aparece em vários grupos — o 13907402 estava em 7. `array_contains` é o filtro
  // nativo do Prisma pra isso; não dá pra usar igualdade.
  if (grouping && String(grouping).trim()) AND.push({ groupings: { array_contains: String(grouping).trim() } });
  if (onlyActive) AND.push({ activated: true });
  if (onlyValid) AND.push({ OR: [{ expiresAt: null }, { expiresAt: { gt: nowish() } }] });
  if (withCode) AND.push({ code: { not: null } });
  return AND.length ? { AND } : undefined;
}

// Lista paginada para o admin, já com a contagem de produtos de cada cupom.
async function listCoupons({ page = 1, pageSize = 50, sortBy = "lastSeen_desc", ...filtros } = {}) {
  const where = buildCouponWhere(filtros);
  const take = Math.min(200, Math.max(5, Number(pageSize) || 50));
  const skip = (Math.max(1, Number(page) || 1) - 1) * take;

  const orderBy = {
    lastSeen_desc: [{ lastSeenAt: "desc" }],
    value_desc: [{ value: { sort: "desc", nulls: "last" } }],
    expires_asc: [{ expiresAt: { sort: "asc", nulls: "last" } }],
    products_desc: [{ productsSyncedAt: { sort: "desc", nulls: "last" } }],
  }[sortBy] || [{ lastSeenAt: "desc" }];

  const [total, rows] = await Promise.all([
    prisma().mlCoupon.count({ where }),
    prisma().mlCoupon.findMany({ where, orderBy, skip, take, include: { _count: { select: { products: true } } } }),
  ]);

  const ids = rows.map(r => r.campaignId);
  const noCatalogo = ids.length ? await prisma().$queryRaw`
    SELECT cp."couponCampaignId" AS "campaignId", COUNT(*)::int AS n
      FROM "catalog_products" cp
     WHERE cp."couponCampaignId" = ANY(${ids})
     GROUP BY 1` : [];
  const mapaCatalogo = new Map(noCatalogo.map(r => [r.campaignId, r.n]));

  return {
    page: Math.max(1, Number(page) || 1),
    pageSize: take,
    total,
    items: rows.map(r => ({
      ...r,
      products: r._count.products,
      inCatalog: mapaCatalogo.get(r.campaignId) || 0,
      _count: undefined,
    })),
  };
}

// Os produtos de um cupom, com o que o catálogo sabe sobre cada um.
async function couponProducts(campaignId, { page = 1, pageSize = 50, origem = null } = {}) {
  const take = Math.min(200, Math.max(5, Number(pageSize) || 50));
  const skip = (Math.max(1, Number(page) || 1) - 1) * take;
  const where = origem ? { campaignId, origem } : { campaignId };

  const [total, links] = await Promise.all([
    prisma().mlCouponProduct.count({ where }),
    prisma().mlCouponProduct.findMany({ where, orderBy: { lastSeenAt: "desc" }, skip, take }),
  ]);

  const chaves = links.map(l => l.productKey);
  const produtos = chaves.length
    ? await prisma().catalogProduct.findMany({
        where: { key: { in: chaves } },
        select: { key: true, name: true, img: true, price: true, originalPrice: true, discount: true, link: true, lastSeenAt: true },
      })
    : [];
  const mapa = new Map(produtos.map(p => [p.key, p]));

  return {
    page: Math.max(1, Number(page) || 1),
    pageSize: take,
    total,
    items: links.map(l => ({
      productKey: l.productKey,
      productUrl: l.productUrl,
      origem: l.origem || "vitrine",
      firstSeenAt: l.firstSeenAt,
      lastSeenAt: l.lastSeenAt,
      inCatalog: mapa.has(l.productKey),
      catalog: mapa.get(l.productKey) || null,
    })),
  };
}

// Este produto está na vitrine DESTA campanha?
//
// Existe separado do `couponsForKeys` porque as duas perguntas são diferentes: o
// `couponsForKeys` devolve o MELHOR cupom de cada produto, então um produto
// coberto por duas campanhas responde por só uma delas — e o teste de cupom
// pergunta por uma campanha específica.
async function hasCouponProduct(campaignId, productKey) {
  return !!(await couponProductOrigem(campaignId, productKey));
}

// O mesmo vínculo, mas dizendo de ONDE ele veio ("vitrine" | "amostra"), ou null
// se não existe. A tela usa isso para não dar à amostra o peso da vitrine: as duas
// respondem "o cupom cobre este produto", mas uma vem da lista inteira e a outra
// de 4 miniaturas.
async function couponProductOrigem(campaignId, productKey) {
  if (!campaignId || !productKey) return null;
  const row = await prisma().mlCouponProduct.findUnique({
    where: { campaignId_productKey: { campaignId: String(campaignId), productKey } },
    select: { origem: true },
  });
  return row ? (row.origem || "vitrine") : null;
}

// Esta campanha tem vitrine RASPADA (não só as amostras do card)?
//
// É a pergunta que separa "o produto não está na vitrine" de "não sei": só quem
// tem a lista completa pode dizer que um produto está fora dela. Quatro amostras
// não autorizam essa frase — ver coupons/quick-check.js:coberturaDoProduto.
async function hasVitrine(campaignId) {
  if (!campaignId) return false;
  const n = await prisma().mlCouponProduct.count({ where: { campaignId: String(campaignId), origem: "vitrine" } });
  return n > 0;
}

// Os cupons que cobrem um lote de produtos, para a tela do catálogo e para a fila
// do repasse. Devolve Map<productKey, cupom>. Só cupom que ainda vale.
async function couponsForKeys(keys) {
  const lista = [...new Set((keys || []).filter(Boolean))];
  if (!lista.length) return new Map();

  const rows = await prisma().$queryRaw`
    SELECT DISTINCT ON (p."productKey")
           p."productKey", c."campaign_id" AS "campaignId", c."title", c."kind", c."value",
           c."minPurchase", c."maxDiscount", c."code", c."expiresAt", c."scope", c."sellerName"
      FROM "ml_coupon_products" p
      JOIN "ml_coupons" c ON c."campaign_id" = p."campaign_id"
     WHERE p."productKey" = ANY(${lista})
       AND (c."expiresAt" IS NULL OR c."expiresAt" > NOW())
     ORDER BY p."productKey", (CASE WHEN c."kind" = 'percent' THEN c."value" ELSE 0 END) DESC NULLS LAST, c."value" DESC NULLS LAST
  `;
  return new Map(rows.map(r => [r.productKey, r]));
}

async function getCoupon(campaignId) {
  return prisma().mlCoupon.findUnique({ where: { campaignId } });
}

// O cupom que carrega esta palavra, se algum. É o que o sistema sabe por conta
// própria quando o ML não responde — a coluna `code` só é escrita a partir de um
// teste `valid`, então o que estiver lá já foi confirmado pelo ML algum dia.
async function findCouponByCode(code) {
  if (!code) return null;
  return prisma().mlCoupon.findFirst({ where: { code }, orderBy: { lastSeenAt: "desc" } });
}

// As palavras testadas, com o que o sistema sabe da campanha de cada uma.
//
// `inSystem` é o que a tela usa pra oferecer "buscar e adicionar esta campanha":
// a palavra pode ter resolvido pra uma campanha que nunca foi raspada, e aí não
// existe linha em `ml_coupons` (não há FK entre as duas tabelas de propósito —
// ver o comentário do clearAll). Sem esta coluna o front teria que adivinhar.
async function listCodeChecks({ limit = 50 } = {}) {
  const rows = await prisma().mlCouponCode.findMany({
    orderBy: { checkedAt: "desc" },
    take: Math.min(200, Math.max(1, limit)),
  });

  const ids = [...new Set(rows.map(r => r.campaignId).filter(Boolean))];
  const cupons = ids.length
    ? await prisma().mlCoupon.findMany({ where: { campaignId: { in: ids } }, select: { campaignId: true, title: true } })
    : [];
  const mapa = new Map(cupons.map(c => [c.campaignId, c.title]));

  return rows.map(r => ({
    ...r,
    inSystem: r.campaignId ? mapa.has(r.campaignId) : null,
    couponTitle: r.campaignId ? (mapa.get(r.campaignId) || null) : null,
  }));
}

// Uma palavra já conhecida — evita ir ao ML de novo por algo que já foi testado
// hoje. `maxAgeHours` existe porque cupom vence: a resposta de ontem não vale
// para sempre.
async function findCodeCheck(code, { maxAgeHours = 24 } = {}) {
  if (!code) return null;
  const r = await prisma().mlCouponCode.findUnique({ where: { code } });
  if (!r) return null;
  // Engasgo do ML não é resposta: guardá-lo em cache prenderia a palavra num
  // "não deu pra saber" por horas, quando repetir custa só um Chrome.
  if (r.verdict === "indeterminado") return null;
  const idadeH = (Date.now() - new Date(r.checkedAt).getTime()) / 36e5;
  return idadeH <= maxAgeHours ? r : null;
}

async function stats() {
  const agora = nowish();
  const [cupons, validos, comVitrine, vinculos, parciais, comCodigo, ultimo] = await Promise.all([
    prisma().mlCoupon.count(),
    prisma().mlCoupon.count({ where: { OR: [{ expiresAt: null }, { expiresAt: { gt: agora } }] } }),
    prisma().mlCoupon.count({ where: { productsSyncedAt: { not: null } } }),
    prisma().mlCouponProduct.count(),
    // Quanto do total de vínculos NÃO é vitrine fechada — a prévia da landing e
    // as miniaturas do card. Sem essa separação o número grande do painel esconde
    // que quase nenhum cupom tem a lista completa.
    prisma().mlCouponProduct.count({ where: { NOT: { origem: "vitrine" } } }),
    prisma().mlCoupon.count({ where: { code: { not: null } } }),
    prisma().mlCoupon.findFirst({ orderBy: { lastSeenAt: "desc" }, select: { lastSeenAt: true } }),
  ]);
  const catalogo = await prisma().catalogProduct.count({ where: { couponCampaignId: { not: null } } });
  return { cupons, validos, comVitrine, vinculos, parciais, comCodigo, catalogo, ultimaColeta: ultimo?.lastSeenAt || null, porCategoria: await countByGrouping() };
}

// Quantos cupons GUARDADOS há em cada categoria do ML. É diferente do `count` que
// a aba do ML mostra (aquele é o que o ML tem, não o que o sistema colheu), e é o
// que alimenta o filtro por categoria da tela do admin. `groupings` é um array
// jsonb, então a contagem passa por jsonb_array_elements_text — um cupom em 7
// grupos conta 1 em cada.
async function countByGrouping() {
  const rows = await prisma().$queryRaw`
    SELECT g.chave AS chave, COUNT(*)::int AS n
      FROM "ml_coupons" c,
           LATERAL jsonb_array_elements_text(c."groupings") AS g(chave)
     GROUP BY 1
     ORDER BY 2 DESC`;
  return rows.map(r => ({ chave: r.chave, n: r.n }));
}

// Faxina: cupom vencido há mais de `days` dias não interessa a ninguém, e os
// vínculos dele vão junto (a FK é ON DELETE CASCADE).
async function pruneExpired(days = 30) {
  const corte = new Date(Date.now() - days * 864e5);
  const { count } = await prisma().mlCoupon.deleteMany({ where: { expiresAt: { not: null, lt: corte } } });
  return { removidos: count };
}

// Apaga TODOS os cupons: a lista, os vínculos e o carimbo no catálogo.
//
// O que NÃO some: `ml_coupon_codes`. Cada palavra ali custou um Chrome aberto com
// a conta do sistema — é a única forma de descobrir a que campanha ela pertence —
// e ela continua valendo depois: a campanha volta na próxima rodada e o
// `restampCodesFromChecks` recarimba. O `campaign_id` das palavras fica apontando
// pra cupom inexistente até lá, e isso é inofensivo: não existe FK, e quem lê
// (`findCodeCheck`) usa a palavra como chave.
//
// A ordem dentro da transação importa: o carimbo do catálogo é COLUNA solta, sem
// FK — ninguém limpa isso por cascata, e apagar o cupom antes deixaria
// `couponCampaignId` apontando pro nada.
async function clearAll() {
  const [catalogo, vinculos, cupons] = await prisma().$transaction([
    prisma().catalogProduct.updateMany({ where: { couponCampaignId: { not: null } }, data: { couponCampaignId: null } }),
    prisma().mlCouponProduct.deleteMany({}),
    prisma().mlCoupon.deleteMany({}),
  ]);
  return { cupons: cupons.count, vinculos: vinculos.count, catalogoLimpo: catalogo.count };
}

// Devolve aos cupons a palavra que já foi descoberta por teste. O `recordCodeCheck`
// só carimba no momento do teste, e o cache de 12h impede refazer — sem isto, um
// cupom que voltou zerado (purga, ou venceu e reapareceu) fica sem palavra na tela
// mesmo com a palavra guardada. Se duas palavras apontarem pra mesma campanha, o
// Postgres escolhe uma: qualquer uma serve.
async function restampCodesFromChecks() {
  const n = await prisma().$executeRaw`
    UPDATE "ml_coupons" c SET "code" = k."code"
      FROM "ml_coupon_codes" k
     WHERE k."campaign_id" = c."campaign_id"
       AND k."verdict" = 'valid'
       AND c."code" IS NULL`;
  return { recarimbados: Number(n || 0) };
}

// O caminho de volta do `restampCodesFromChecks`: devolve à palavra a campanha que
// só sobrou carimbada no cupom. Existe porque um engasgo do ML já zerou linhas boas
// antes desta correção — e a coluna `ml_coupons.code` é escrita exclusivamente a
// partir de um teste `valid` (aqui e no `recordCodeCheck`), então ela é fonte
// confiável para reconstruir o que se perdeu.
async function recoverCodesFromCoupons() {
  const n = await prisma().$executeRaw`
    UPDATE "ml_coupon_codes" k
       SET "campaign_id" = c."campaign_id", "verdict" = 'valid',
           "message" = NULL, "response_code" = NULL
      FROM "ml_coupons" c
     WHERE c."code" = k."code"
       AND k."campaign_id" IS NULL`;
  return { recuperados: Number(n || 0) };
}

module.exports = {
  upsertCoupons,
  clearAll,
  restampCodesFromChecks,
  findCouponByCode,
  recoverCodesFromCoupons,
  replaceCouponProducts,
  replaceCouponSamples,
  linkSinteticoML,
  hasVitrine,
  syncCatalogCoupons,
  recordCodeCheck,
  listCoupons,
  couponProducts,
  hasCouponProduct,
  couponProductOrigem,
  couponsForKeys,
  getCoupon,
  listCodeChecks,
  findCodeCheck,
  stats,
  countByGrouping,
  pruneExpired,
  EXPIRA_COM_FOLGA_MIN,
};
