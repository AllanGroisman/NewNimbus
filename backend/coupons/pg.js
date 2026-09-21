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

// Grava em lotes concorrentes em vez de um `await` por linha.
//
// Não é micro-otimização. Em série, cada linha custa uma ida e volta ao Postgres
// (~5,5ms medidos aqui, com o banco na mesma máquina): os 2.871 cupons de hoje
// levavam ~40s só de espera, dentro de uma requisição que o nginx corta aos 90s.
// Em lotes de 50 a mesma gravação leva ~8s. Mesmo remédio e mesmo tamanho de lote
// do catalog/pg.js:upsertProducts.
async function emLotes(itens, tamanho, fn) {
  for (let i = 0; i < itens.length; i += tamanho) {
    await Promise.all(itens.slice(i, i + tamanho).map(fn));
  }
}

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

  // Em lote, o mesmo id duas vezes na lista viraria duas inserções concorrentes
  // da MESMA linha — e a segunda morre na chave única. Em série isso não existia:
  // a segunda passada já encontrava a primeira gravada. Fica a última ocorrência,
  // que é o que o laço sequencial deixava no banco.
  const porId = new Map();
  for (const c of coupons || []) if (c?.campaignId) porId.set(c.campaignId, c);

  await emLotes([...porId.values()], 50, async (c) => {
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

    // A palavra que veio no TÍTULO ("10% OFF com QUEROPROMO"). Vai num update
    // separado, e não no `row`, porque a regra é condicional sobre a linha que já
    // existe — `code: null` —, e o upsert do Prisma não sabe fazer isso.
    //
    // Por que só onde está nulo: a palavra TESTADA no ML (recordCodeCheck, mais
    // abaixo) custou uma aba do Chrome com a conta do sistema e é resposta do
    // próprio ML; a do título é leitura de texto. Se as duas discordarem, quem
    // manda é a testada — sobrescrever aqui trocaria prova por palpite.
    if (c.codeFromTitle) {
      await prisma().mlCoupon.updateMany({
        where: { campaignId: c.campaignId, code: null },
        data: { code: c.codeFromTitle },
      });
    }
  });
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
  const pares = (items || [])
    .filter(it => it?.productKey && it?.productUrl)
    .map(it => ({ campaignId: String(campaignId), productKey: it.productKey, productUrl: it.productUrl }));
  const r = await gravarVinculos(pares, [String(campaignId)], origem);

  // `productsSyncedAt` quer dizer "a VITRINE foi raspada" e continua querendo
  // dizer só isso — a amostra não é vitrine e não pode carimbar esse campo, senão
  // a tela pararia de oferecer o botão de raspar justamente onde ele é preciso.
  if (origem === "vitrine") {
    await prisma().mlCoupon.update({ where: { campaignId }, data: { productsSyncedAt: nowish() } }).catch(() => {});
  }

  return r;
}

// A gravação em si, para um cupom ou para milhares: um INSERT por lote e um
// DELETE, em vez de uma ida ao banco por vínculo.
//
// É o mesmo formato do `syncCatalogCoupons` aqui embaixo (UNNEST de arrays
// paralelos), e é o que tirou a gravação da rodada dos 90s do nginx: as amostras
// de 2.871 cupons eram ~17 mil idas em fila indiana (171s medidos) e passaram a
// ser 7 comandos (1,1s). Só o SQL muda — a semântica das coleções por origem é a
// mesma de antes.
//
// `campanhas` é o escopo do apagamento, e é separado de `pares` de propósito: o
// cupom cuja lista veio VAZIA precisa ter os vínculos daquela origem apagados, e
// ele não aparece em par nenhum.
async function gravarVinculos(pares, campanhas, origem) {
  const agora = nowish();

  // Deduplicado porque o ML repete anúncio entre páginas da vitrine, e um INSERT
  // com a mesma chave duas vezes morre em "ON CONFLICT DO UPDATE command cannot
  // affect row a second time". Fica a última ocorrência, como no laço que existia
  // aqui antes. A chave é o par, não a chave do produto: o mesmo produto em dois
  // cupons são dois vínculos legítimos.
  const porPar = new Map();
  for (const p of pares || []) porPar.set(`${p.campaignId}\u0000${p.productKey}`, p);
  const validos = [...porPar.values()];

  const campanhasDoEscopo = [...new Set([...(campanhas || []).map(String), ...validos.map(p => p.campaignId)])];
  if (!campanhasDoEscopo.length) return { vinculados: 0, removidos: 0 };

  const ids = validos.map(p => p.campaignId);
  const chaves = validos.map(p => p.productKey);
  const urls = validos.map(p => p.productUrl);

  // Em lotes porque o Postgres tem teto de parâmetros por comando, e um array de
  // 50 mil chaves num INSERT só é bala na agulha à toa.
  const LOTE = 2000;
  for (let i = 0; i < validos.length; i += LOTE) {
    await prisma().$executeRaw`
      INSERT INTO "ml_coupon_products" ("campaign_id", "productKey", "productUrl", "origem", "firstSeenAt", "lastSeenAt")
      SELECT v."campanha", v."chave", v."url", ${origem}, ${agora}::timestamptz, ${agora}::timestamptz
        FROM (SELECT UNNEST(${ids.slice(i, i + LOTE)}::text[]) AS "campanha",
                     UNNEST(${chaves.slice(i, i + LOTE)}::text[]) AS "chave",
                     UNNEST(${urls.slice(i, i + LOTE)}::text[]) AS "url") v
      ON CONFLICT ("campaign_id", "productKey") DO UPDATE
         SET "productUrl" = EXCLUDED."productUrl",
             "origem"     = EXCLUDED."origem",
             "lastSeenAt" = EXCLUDED."lastSeenAt"
    `;
  }

  // Depois do INSERT, nunca antes: só se apaga quando tudo que vale já está
  // gravado. `enrichTriedAt` não é tocado em lugar nenhum daqui — quem já tentou
  // trazer a amostra pro catálogo não volta pra fila por causa de uma regravação.
  const removidos = Number(await prisma().$executeRaw`
    DELETE FROM "ml_coupon_products" p
     WHERE p."origem" = ${origem}
       AND p."campaign_id" = ANY(${campanhasDoEscopo}::text[])
       AND NOT EXISTS (
         SELECT 1 FROM (SELECT UNNEST(${ids}::text[]) AS "campanha",
                               UNNEST(${chaves}::text[]) AS "chave") v
          WHERE v."campanha" = p."campaign_id" AND v."chave" = p."productKey")
  `);

  return { vinculados: validos.length, removidos };
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
  return replaceCouponSamplesMany([{ campaignId, sampleItemIds: itemIds }]);
}

// As amostras de VÁRIOS cupons de uma vez — o que a gravação da rodada usa.
//
// Existe porque a rodada tem milhares de cupons e cada um traz 4 miniaturas:
// chamar o de cima cupom a cupom era ~6 idas ao banco por cupom e foi o que
// estourou o tempo do nginx no meio da etapa 2. Aqui tudo vira um punhado de
// comandos, e o escopo do apagamento continua sendo exatamente os cupons
// recebidos — cupom que não veio nesta chamada não tem amostra mexida.
async function replaceCouponSamplesMany(cupons) {
  const { productKey } = require("../catalog/product-key");
  const pares = [];
  const campanhas = [];

  for (const c of cupons || []) {
    if (!c?.campaignId) continue;
    const campaignId = String(c.campaignId);
    campanhas.push(campaignId);
    for (const id of c.sampleItemIds || []) {
      const link = linkSinteticoML(id);
      if (!link) continue;
      pares.push({ campaignId, productKey: productKey({ link }), productUrl: link });
    }
  }

  return gravarVinculos(pares, campanhas, "amostra");
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

  // De onde saiu a PALAVRA de cada cupom. `ml_coupons.code` guarda a palavra, mas
  // não guarda a procedência dela — e as duas não valem o mesmo: a testada é
  // resposta do próprio ML (custou uma aba do Chrome com a conta do sistema), a do
  // título é leitura de texto, com a regra apertada do `palavraDoTitulo`. É a mesma
  // hierarquia que o `upsertCoupons` já respeita ao não sobrescrever uma pela outra;
  // aqui ela só chega até a tela, para ninguém tomar palpite por prova.
  const testadas = ids.length
    ? await prisma().mlCouponCode.findMany({
        where: { campaignId: { in: ids }, verdict: "valid" },
        select: { campaignId: true, code: true, checkedAt: true },
      })
    : [];
  const mapaTestadas = new Map(testadas.map(t => [t.campaignId, t]));

  return {
    page: Math.max(1, Number(page) || 1),
    pageSize: take,
    total,
    items: rows.map(r => {
      // A linha só conta como "testada" quando a palavra é a MESMA: a campanha pode
      // ter uma palavra testada antiga e outra lida do título depois, e carimbar
      // "testada" na segunda diria que o ML confirmou algo que ele nunca viu.
      const t = mapaTestadas.get(r.campaignId);
      const testada = !!(r.code && t && t.code === r.code);
      return {
        ...r,
        products: r._count.products,
        inCatalog: mapaCatalogo.get(r.campaignId) || 0,
        codeSource: r.code ? (testada ? "testada" : "titulo") : null,
        codeCheckedAt: testada ? t.checkedAt : null,
        _count: undefined,
      };
    }),
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
// Existe separado do `couponsListForKeys` porque as duas perguntas são diferentes:
// aquele devolve os cupons DE um produto, sem saber qual campanha interessa — e o
// teste de cupom pergunta por uma campanha específica.
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

// TODOS os cupons vigentes que cobrem um lote de produtos — Map<productKey, cupom[]>.
//
// Existiu aqui uma irmã, `couponsForKeys`, que devolvia só o MELHOR cupom de cada
// produto (um `DISTINCT ON` ordenado por desconto). Ela saiu junto com a trava da
// palavra: ordenava por desconto sem olhar o `code`, então elegia o cupom de 20%
// sem palavra e escondia o de 10% com palavra — que é o único que o cliente
// conseguiria usar. Mantê-la exportada era deixar a armadilha à mão.
//
// A ordem daqui é a resposta a "qual deles eu consigo anunciar?": cupom COM palavra
// primeiro, e só dentro de cada grupo o maior desconto. Quem só quer um cupom pega
// o primeiro da lista; quem quer mostrar todos (a tela do catálogo) usa a lista
// inteira. O carimbo de `catalog_products.couponCampaignId` não passa por aqui — ele
// tem SQL próprio em `syncCatalogCoupons`.
async function couponsListForKeys(keys) {
  const lista = [...new Set((keys || []).filter(Boolean))];
  if (!lista.length) return new Map();

  const rows = await prisma().$queryRaw`
    SELECT p."productKey", c."campaign_id" AS "campaignId", c."title", c."kind", c."value",
           c."minPurchase", c."maxDiscount", c."code", c."startsAt", c."expiresAt",
           c."scope", c."sellerName"
      FROM "ml_coupon_products" p
      JOIN "ml_coupons" c ON c."campaign_id" = p."campaign_id"
     WHERE p."productKey" = ANY(${lista})
       AND (c."expiresAt" IS NULL OR c."expiresAt" > NOW())
     ORDER BY p."productKey",
              (c."code" IS NOT NULL) DESC,
              (CASE WHEN c."kind" = 'percent' THEN c."value" ELSE 0 END) DESC NULLS LAST,
              c."value" DESC NULLS LAST
  `;

  const mapa = new Map();
  for (const r of rows) {
    if (!mapa.has(r.productKey)) mapa.set(r.productKey, []);
    mapa.get(r.productKey).push(r);
  }
  return mapa;
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

// Os cupons que já têm categoria no banco. É o que deixa a passada de carimbo da
// etapa 1 ser incremental: o `upsertCoupons` nunca apaga `groupings` (lista vazia é
// "não sei"), então um cupom carimbado numa rodada anterior não precisa ser
// procurado de novo nas verticais.
async function campanhasComCategoria() {
  const rows = await prisma().$queryRaw`
    SELECT "campaign_id" AS id FROM "ml_coupons" WHERE jsonb_array_length("groupings") > 0`;
  return new Set(rows.map(r => r.id));
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
// antes desta correção.
//
// O `codeFromTitle` no filtro é o que mantém isso honesto. A coluna
// `ml_coupons.code` era escrita exclusivamente a partir de um teste `valid`, e é
// nisso que este UPDATE se apoia para carimbar `verdict = 'valid'`. Desde que a
// varredura passou a ler a palavra do TÍTULO (upsertCoupons), a coluna tem uma
// segunda origem — que nunca foi ao ML. Deixar essas entrarem aqui inventaria um
// teste que não houve, e o cache de 12h do `findCodeCheck` passaria a devolver
// "válido" por uma palavra que ninguém digitou.
async function recoverCodesFromCoupons() {
  const n = await prisma().$executeRaw`
    UPDATE "ml_coupon_codes" k
       SET "campaign_id" = c."campaign_id", "verdict" = 'valid',
           "message" = NULL, "response_code" = NULL
      FROM "ml_coupons" c
     WHERE c."code" = k."code"
       AND k."campaign_id" IS NULL
       AND (c."raw" -> 'codeFromTitle') IS DISTINCT FROM 'true'::jsonb`;
  return { recuperados: Number(n || 0) };
}

// Os cupons que ainda NÃO têm vitrine raspada, separados pelo que falta em cada um.
//
// A separação é o ponto: `containerUrl` só existe depois do "Eu quero", então os
// dois grupos custam coisas diferentes. `prontos` é só abrir a vitrine e ler —
// leitura pura. `precisamAtivar` exige um clique em "Aplicar" na lista do ML, que
// é ESCRITA irreversível na conta do sistema (a mesma do Hub) — por isso ele vem
// separado, contado, e quem decide se vai é a config (`activateCoupons`).
//
// `productsSyncedAt` é o carimbo de "a vitrine foi raspada" (replaceCouponProducts
// só o escreve para `origem: "vitrine"`), e é ele que faz o botão "buscar os que
// faltam" não repetir o trabalho da rodada anterior.
async function couponsSemVitrine({ limit = 500, campaignIds = null } = {}) {
  const teto = Math.min(2000, Math.max(1, Number(limit) || 500));
  const alvo = Array.isArray(campaignIds) && campaignIds.length
    ? { campaignId: { in: campaignIds.map(String) } }
    : {};
  // Cupom vencido não tem vitrine que valha uma aba aberta com a conta do sistema.
  const base = {
    ...alvo,
    productsSyncedAt: null,
    OR: [{ expiresAt: null }, { expiresAt: { gt: nowish() } }],
  };

  const [prontos, precisamAtivar, total] = await Promise.all([
    // A ordem gasta o tempo do admin (a extensão abre uma aba por cupom) onde ele
    // rende mais: primeiro quem a varredura pela landing NÃO conseguiu ler
    // (coupons/landing-sweep.js) — esses não têm produto nenhum —, e só depois
    // quem já tem a prévia e só ganharia a lista fechada. Dentro de cada grupo,
    // campanha antes de loja ("campaign" < "store").
    prisma().mlCoupon.findMany({
      where: { ...base, containerUrl: { not: null } },
      select: { campaignId: true, title: true, containerUrl: true, landingOk: true },
      orderBy: [{ landingOk: { sort: "asc", nulls: "first" } }, { scope: "asc" }, { lastSeenAt: "desc" }],
      take: teto,
    }),
    // Cupom de LOJA fica de fora: ele é AUTOMATIC, ou seja, já chega ativado. Um de
    // loja sem `containerUrl` é cupom que o ML não deu vitrine nenhuma, e clicar
    // não muda isso.
    prisma().mlCoupon.findMany({
      where: { ...base, containerUrl: null, scope: "campaign", activated: false },
      select: { campaignId: true, title: true },
      orderBy: { lastSeenAt: "desc" },
      take: teto,
    }),
    prisma().mlCoupon.count({ where: base }),
  ]);

  return { prontos, precisamAtivar, total };
}

// A fila da varredura pela landing (coupons/landing-sweep.js): cupom válido, com
// URL de vitrine, sem a vitrine fechada, e que a landing não tentou nas últimas
// `refazerHoras`. Cupom sem `containerUrl` não entra — sem ela não há link curto a
// gerar, e ativar ("Eu quero") é escrita na conta, que esta varredura não faz.
//
// A ordem é a de quem rende mais produto para o catálogo por requisição:
//   1. nunca tentado antes de retentativa — cupom novo é o que falta de tudo;
//   2. cupom de CAMPANHA antes de cupom de loja: é o do ML, cobre muitas lojas;
//   3. cupom de loja cuja loja já aparece no catálogo — esses casam com produto
//      que o sistema já tem, e não só com o que a landing trouxer;
//   4. o visto por último na aba primeiro.
async function alvosDaLanding({ limit = 60, refazerHoras = 24 } = {}) {
  const teto = Math.min(5000, Math.max(1, Number(limit) || 60));
  const corte = new Date(Date.now() - Math.max(0, Number(refazerHoras) || 0) * 3600_000);
  return prisma().$queryRaw`
    SELECT c."campaign_id" AS "campaignId", c."title", c."scope", c."sellerName",
           c."containerUrl", c."sampleItemIds", c."landingTriedAt"
      FROM "ml_coupons" c
     WHERE c."containerUrl" IS NOT NULL
       AND c."productsSyncedAt" IS NULL
       AND (c."expiresAt" IS NULL OR c."expiresAt" > NOW())
       AND (c."landingTriedAt" IS NULL OR c."landingTriedAt" < ${corte})
     ORDER BY (c."landingTriedAt" IS NULL) DESC,
              (c."scope" = 'campaign') DESC,
              EXISTS (SELECT 1 FROM "catalog_products" cp
                       WHERE cp."store" = 'Mercado Livre'
                         AND cp."payload"->>'seller' = c."sellerName") DESC,
              c."lastSeenAt" DESC
     LIMIT ${teto}`;
}

// O carimbo de "a landing foi tentada". `ok` é "trouxe produto"; a mensagem é a do
// ML (ou do nosso classificador), e é o que a tela mostra no cupom.
async function marcarLanding(campaignId, { ok, message = null } = {}) {
  return prisma().mlCoupon.update({
    where: { campaignId: String(campaignId) },
    data: { landingTriedAt: nowish(), landingOk: !!ok, landingMessage: message ? String(message).slice(0, 500) : null },
  }).catch(() => null);
}

// As amostras que ainda não viraram produto de catálogo (coupons/enrich-samples.js).
// A amostra chega só com o MLB; sem uma linha no catálogo com essa chave, o vínculo
// existe mas não aparece em busca nenhuma — que era o estado de quase todas.
//
// Uma linha por PRODUTO (o mesmo MLB pode ser amostra de dois cupons), e só de
// cupom que ainda vale: buscar produto para cupom vencido é requisição à toa.
async function amostrasSemCatalogo({ limit = 60, refazerDias = 7 } = {}) {
  const teto = Math.min(5000, Math.max(1, Number(limit) || 60));
  const corte = new Date(Date.now() - Math.max(0, Number(refazerDias) || 0) * 864e5);
  return prisma().$queryRaw`
    SELECT DISTINCT ON (p."productKey") p."productKey", p."productUrl"
      FROM "ml_coupon_products" p
      JOIN "ml_coupons" c ON c."campaign_id" = p."campaign_id"
     WHERE p."origem" = 'amostra'
       AND (c."expiresAt" IS NULL OR c."expiresAt" > NOW())
       AND (p."enrichTriedAt" IS NULL OR p."enrichTriedAt" < ${corte})
       AND NOT EXISTS (SELECT 1 FROM "catalog_products" cp WHERE cp."key" = p."productKey")
     ORDER BY p."productKey", p."enrichTriedAt" NULLS FIRST
     LIMIT ${teto}`;
}

// Carimba a tentativa em TODAS as linhas daquele produto — é o mesmo MLB, e a
// resposta do ML sobre ele não muda de cupom pra cupom.
async function marcarEnriquecimento(productKeys) {
  const chaves = [...new Set((productKeys || []).filter(Boolean))];
  if (!chaves.length) return 0;
  const { count } = await prisma().mlCouponProduct.updateMany({
    where: { productKey: { in: chaves }, origem: "amostra" },
    data: { enrichTriedAt: nowish() },
  });
  return count;
}

// O que o CHECKOUT do ML disse sobre UM produto (coupons/checkout-list.js): os
// cupons que ele aplicou ou calculou desconto pra este carrinho. É o vínculo mais
// forte que existe — o ML testou ESTE produto —, e entra com `origem: "checkout"`.
//
// Diferente do `replaceCouponProducts`, que é por CUPOM e apaga o que não veio: aqui
// a pergunta foi sobre um produto, então nada de outros produtos é tocado, e o que
// não veio neste checkout também não é apagado (não prova ausência — ainda).
//
// Vínculo `vitrine` já existente fica `vitrine` (as duas são fortes, e a vitrine é a
// que autoriza o "fora" do quick-check); `landing`/`amostra` são promovidos.
//
// Cupom que o sistema ainda não tinha (a aba /cupons não o listou) é CRIADO com o
// que o checkout disse dele — e só criado: cupom que já existe não é reescrito,
// porque a linha da aba sabe coisas (vitrine, amostras) que o checkout não traz.
async function vincularPorCheckout({ productKeys, productUrl, cupons }) {
  const chaves = [...new Set((productKeys || []).filter(Boolean))];
  const lista = (cupons || []).filter(c => c?.campaignId);
  if (!chaves.length || !lista.length || !productUrl) return { vinculados: 0, cuponsNovos: 0 };
  const agora = nowish();

  const { count: cuponsNovos } = await prisma().mlCoupon.createMany({
    data: lista.map(c => ({
      campaignId: String(c.campaignId),
      title: c.titulo || "(sem título)",
      kind: c.kind || "unknown",
      value: c.value ?? null,
      minPurchase: c.minPurchase ?? null,
      maxDiscount: c.maxDiscount ?? null,
      scope: c.grupo && c.grupo !== "meli" ? "store" : "campaign",
      activated: true,
      expiresAt: c.expiresAt ? new Date(c.expiresAt) : null,
      iconUrl: c.iconUrl || null,
      origin: "checkout",
      raw: { viaCheckout: true, categoria: c.categoria || null, grupo: c.grupo || null },
      firstSeenAt: agora,
      lastSeenAt: agora,
    })),
    skipDuplicates: true,
  });

  let vinculados = 0;
  for (const c of lista) {
    const campaignId = String(c.campaignId);
    for (const productKey of chaves) {
      const atual = await prisma().mlCouponProduct.findUnique({ where: { campaignId_productKey: { campaignId, productKey } } });
      if (!atual) {
        await prisma().mlCouponProduct.create({ data: { campaignId, productKey, productUrl, origem: "checkout", firstSeenAt: agora, lastSeenAt: agora } });
      } else {
        await prisma().mlCouponProduct.update({
          where: { id: atual.id },
          data: { lastSeenAt: agora, ...(atual.origem === "vitrine" ? {} : { origem: "checkout" }) },
        });
      }
      vinculados += 1;
    }
  }
  await syncCatalogCoupons();
  return { vinculados, cuponsNovos };
}

// Quanto da cobertura veio de cada caminho — o painel da varredura. Separado do
// `stats()` porque aquele roda a cada abertura da aba e este só no card.
async function coberturaStats() {
  const [landing, porOrigem, amostrasSemProduto] = await Promise.all([
    prisma().$queryRaw`
      SELECT COUNT(*) FILTER (WHERE "containerUrl" IS NOT NULL AND "productsSyncedAt" IS NULL
                                AND ("expiresAt" IS NULL OR "expiresAt" > NOW()))::int AS "comUrl",
             COUNT(*) FILTER (WHERE "landingTriedAt" IS NOT NULL)::int AS "tentados",
             COUNT(*) FILTER (WHERE "landingOk" = true)::int AS "comPrevia"
        FROM "ml_coupons"`,
    prisma().mlCouponProduct.groupBy({ by: ["origem"], _count: { _all: true } }),
    prisma().$queryRaw`
      SELECT COUNT(DISTINCT p."productKey")::int AS n
        FROM "ml_coupon_products" p
       WHERE p."origem" = 'amostra'
         AND NOT EXISTS (SELECT 1 FROM "catalog_products" cp WHERE cp."key" = p."productKey")`,
  ]);
  const catalogo = await prisma().catalogProduct.count({ where: { couponCampaignId: { not: null } } });
  return {
    ...(landing[0] || {}),
    vinculos: Object.fromEntries(porOrigem.map(r => [r.origem, r._count._all])),
    amostrasSemProduto: amostrasSemProduto[0]?.n || 0,
    produtosComCupom: catalogo,
  };
}

// Apaga UM cupom. Mesma ordem do `clearAll`, e pelo mesmo motivo: o carimbo do
// catálogo é coluna solta, sem FK, então ninguém o limpa por cascata — apagar o
// cupom antes deixaria `couponCampaignId` apontando pro nada. Os vínculos caem
// junto (a FK deles é ON DELETE CASCADE), mas vão explícitos para poder contar.
//
// A palavra em `ml_coupon_codes` fica, pelo mesmo motivo do `clearAll`.
async function deleteCoupon(campaignId) {
  const id = String(campaignId || "");
  if (!id) throw new Error("Sem campanha para apagar.");
  const [catalogo, vinculos] = await prisma().$transaction([
    prisma().catalogProduct.updateMany({ where: { couponCampaignId: id }, data: { couponCampaignId: null } }),
    prisma().mlCouponProduct.deleteMany({ where: { campaignId: id } }),
    prisma().mlCoupon.deleteMany({ where: { campaignId: id } }),
  ]);
  return { vinculos: vinculos.count, catalogoLimpo: catalogo.count };
}

module.exports = {
  upsertCoupons,
  clearAll,
  deleteCoupon,
  couponsSemVitrine,
  alvosDaLanding,
  marcarLanding,
  amostrasSemCatalogo,
  marcarEnriquecimento,
  coberturaStats,
  vincularPorCheckout,
  restampCodesFromChecks,
  findCouponByCode,
  recoverCodesFromCoupons,
  replaceCouponProducts,
  replaceCouponSamples,
  replaceCouponSamplesMany,
  linkSinteticoML,
  hasVitrine,
  syncCatalogCoupons,
  recordCodeCheck,
  listCoupons,
  couponProducts,
  hasCouponProduct,
  couponProductOrigem,
  couponsListForKeys,
  getCoupon,
  listCodeChecks,
  findCodeCheck,
  stats,
  countByGrouping,
  campanhasComCategoria,
  pruneExpired,
  EXPIRA_COM_FOLGA_MIN,
};
