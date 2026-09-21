// Ops pontual: junta as linhas do catálogo que são o MESMO anúncio do ML.
//
// O PROBLEMA. O productKey usa o número que aparece no caminho da URL, e o ML tem
// duas numerações para o mesmo produto: a vitrine/landing do cupom entrega
// `/p/MLB<catálogo>?…&wid=MLB<anúncio>` e o scraping entrega
// `produto.mercadolivre.com.br/MLB-<anúncio>`. Saíam duas chaves, duas linhas no
// catálogo, e o cupom carimbado numa só (medido em 21/09/2026: 204 anúncios
// duplicados, 49 com o cupom só numa das linhas).
//
// Desde a coluna `mlAnuncioId` o upsert (catalog/pg.js:upsertProducts) grava o
// anúncio repetido na linha que já existe. Este script arruma o que ficou de antes:
//   1. preenche `mlAnuncioId` das linhas antigas (mesma função do upsert,
//      catalog/product-key.js:mlAnuncioIdFromUrl);
//   2. por anúncio com mais de uma linha, fica a mais ANTIGA (firstSeenAt) — a
//      mesma escolha do catalog/pg.js:resolveKeys, para o upsert seguinte cair nela;
//   3. o que apontava para as outras chaves passa a apontar para ela: vínculos de
//      cupom (a origem mais forte vence), fila, pendentes e histórico dos grupos;
//   4. apaga as linhas que sobraram e recarimba os cupons.
//
// Critério é SÓ o número do anúncio. Mesmo nome com anúncio diferente é outro
// vendedor, e juntar herdaria o cupom de um vendedor no anúncio de outro.
//
// Uso:
//   node scripts/merge-ml-duplicates.js           # dry-run: só mostra o que faria
//   node scripts/merge-ml-duplicates.js --apply   # grava
//
// Idempotente: a segunda passada não acha nada.
require("../config/loadEnv");
const { prisma, disconnect } = require("../db");
const { mlAnuncioIdFromUrl } = require("../catalog/product-key");

// Quando a mesma campanha tem vínculo com as duas chaves, qual origem fica. A
// vitrine é a lista fechada (a única que autoriza "fora da vitrine" no quick-check),
// o checkout é prova direta, e as prévias vêm depois.
const PESO_ORIGEM = `CASE "origem" WHEN 'vitrine' THEN 0 WHEN 'checkout' THEN 1 WHEN 'landing' THEN 2 ELSE 3 END`;

// Pura: linhas → [{ anuncio, sobrevivente, perdedoras[], maisRecente }]. Testável.
function planejar(linhas) {
  const porAnuncio = new Map();
  for (const r of linhas || []) {
    const anuncio = r.mlAnuncioId || mlAnuncioIdFromUrl(r.link);
    if (!anuncio) continue;
    if (!porAnuncio.has(anuncio)) porAnuncio.set(anuncio, []);
    porAnuncio.get(anuncio).push(r);
  }
  const grupos = [];
  for (const [anuncio, rs] of porAnuncio) {
    if (rs.length < 2) continue;
    const ordem = [...rs].sort((a, b) =>
      new Date(a.firstSeenAt) - new Date(b.firstSeenAt) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const maisRecente = [...rs].sort((a, b) => new Date(b.lastSeenAt) - new Date(a.lastSeenAt))[0];
    grupos.push({ anuncio, sobrevivente: ordem[0], perdedoras: ordem.slice(1), maisRecente });
  }
  return grupos;
}

async function preencherAnuncios(linhas) {
  const faltando = linhas
    .filter(r => !r.mlAnuncioId)
    .map(r => ({ key: r.key, anuncio: mlAnuncioIdFromUrl(r.link) }))
    .filter(r => r.anuncio);
  const LOTE = 2000;
  for (let i = 0; i < faltando.length; i += LOTE) {
    const lote = faltando.slice(i, i + LOTE);
    await prisma().$executeRaw`
      UPDATE "catalog_products" cp SET "mlAnuncioId" = v."anuncio"
        FROM (SELECT UNNEST(${lote.map(r => r.key)}::text[]) AS "key",
                     UNNEST(${lote.map(r => r.anuncio)}::text[]) AS "anuncio") v
       WHERE cp."key" = v."key"`;
  }
  return faltando.length;
}

async function fundirGrupo({ sobrevivente, perdedoras, maisRecente }) {
  const alvo = sobrevivente.key;
  const velhas = perdedoras.map(r => r.key);

  await prisma().$transaction(async (tx) => {
    // Vínculos de cupom: um por campanha, com a origem mais forte entre as chaves.
    await tx.$executeRawUnsafe(`
      INSERT INTO "ml_coupon_products" ("campaign_id", "productKey", "productUrl", "origem", "firstSeenAt", "lastSeenAt", "enrichTriedAt")
      SELECT DISTINCT ON ("campaign_id") "campaign_id", $1, "productUrl", "origem", "firstSeenAt", "lastSeenAt", "enrichTriedAt"
        FROM "ml_coupon_products"
       WHERE "productKey" = ANY($2::text[]) OR "productKey" = $1
       ORDER BY "campaign_id", ${PESO_ORIGEM}, "lastSeenAt" DESC
      ON CONFLICT ("campaign_id", "productKey") DO UPDATE
         SET "origem" = EXCLUDED."origem", "productUrl" = EXCLUDED."productUrl",
             "lastSeenAt" = GREATEST("ml_coupon_products"."lastSeenAt", EXCLUDED."lastSeenAt")`,
      alvo, velhas);
    await tx.$executeRaw`DELETE FROM "ml_coupon_products" WHERE "productKey" = ANY(${velhas}::text[])`;

    // Fila e pendentes são únicos por (grupo, chave): se o grupo já tem a
    // sobrevivente, a cópia da perdedora sai; senão ela é renomeada. Uma chave
    // por vez para duas perdedoras no mesmo grupo não colidirem entre si.
    for (const tabela of ["group_queue", "group_pending"]) {
      for (const k of velhas) {
        await tx.$executeRawUnsafe(`
          DELETE FROM "${tabela}" v WHERE v."productKey" = $2
             AND EXISTS (SELECT 1 FROM "${tabela}" s WHERE s."groupId" = v."groupId" AND s."productKey" = $1)`, alvo, k);
        await tx.$executeRawUnsafe(`UPDATE "${tabela}" SET "productKey" = $1 WHERE "productKey" = $2`, alvo, k);
      }
    }
    // O histórico não é único: só renomeia, e o cooldown passa a valer para a linha que ficou.
    await tx.$executeRaw`UPDATE "group_history" SET "productKey" = ${alvo} WHERE "productKey" = ANY(${velhas}::text[])`;

    // O preço mais fresco vence: se a linha vista por último é uma perdedora, os
    // números dela passam para a sobrevivente (key e link ficam os da sobrevivente).
    const fresco = maisRecente.key !== alvo ? maisRecente : null;
    await tx.catalogProduct.update({
      where: { key: alvo },
      data: {
        mlAnuncioId: sobrevivente.mlAnuncioId || mlAnuncioIdFromUrl(sobrevivente.link) || mlAnuncioIdFromUrl(maisRecente.link),
        ...(fresco ? {
          name: fresco.name, img: fresco.img, price: fresco.price, originalPrice: fresco.originalPrice,
          discount: fresco.discount, rating: fresco.rating, sold: fresco.sold, soldCount: fresco.soldCount,
          lastSeenAt: fresco.lastSeenAt,
        } : {}),
      },
    });
    await tx.catalogProduct.deleteMany({ where: { key: { in: velhas } } });
  });
}

async function mergeDuplicates({ apply = false, log = console.log } = {}) {
  const linhas = await prisma().catalogProduct.findMany({
    where: { OR: [{ store: "Mercado Livre" }, { link: { contains: "mercadoli", mode: "insensitive" } }] },
    select: {
      key: true, link: true, mlAnuncioId: true, firstSeenAt: true, lastSeenAt: true, couponCampaignId: true,
      name: true, img: true, price: true, originalPrice: true, discount: true, rating: true, sold: true, soldCount: true,
    },
  });
  const semAnuncio = linhas.filter(r => !r.mlAnuncioId && mlAnuncioIdFromUrl(r.link)).length;
  const grupos = planejar(linhas);
  const removidas = grupos.reduce((n, g) => n + g.perdedoras.length, 0);
  const cupomSoNuma = grupos.filter(g => {
    const cs = [g.sobrevivente, ...g.perdedoras].map(r => r.couponCampaignId);
    return cs.some(Boolean) && cs.some(c => !c);
  }).length;

  log(`${linhas.length} linhas do ML; ${semAnuncio} sem mlAnuncioId preenchido.`);
  log(`${grupos.length} anúncios duplicados → ${removidas} linha(s) a remover; ${cupomSoNuma} com o cupom só numa das linhas.`);
  for (const g of grupos.slice(0, 5)) {
    log(`  ${g.anuncio}: fica ${g.sobrevivente.link.slice(0, 90)}`);
    for (const p of g.perdedoras) log(`           sai  ${p.link.slice(0, 90)}`);
  }

  if (!apply) {
    log("\n[dry-run] Rode com --apply pra gravar.");
    return { grupos: grupos.length, removidas, cupomSoNuma, preenchidas: 0, aplicado: false };
  }

  const preenchidas = await preencherAnuncios(linhas);
  for (const g of grupos) await fundirGrupo(g);
  const carimbo = await require("../coupons/pg").syncCatalogCoupons();
  log(`\n[apply] ${preenchidas} mlAnuncioId preenchidos, ${grupos.length} anúncios fundidos, ${removidas} linhas removidas.`);
  log(`[apply] cupons: ${carimbo.carimbados} carimbados, ${carimbo.limpos} limpos.`);
  return { grupos: grupos.length, removidas, cupomSoNuma, preenchidas, aplicado: true };
}

module.exports = { planejar, mergeDuplicates };

if (require.main === module) {
  mergeDuplicates({ apply: process.argv.includes("--apply") })
    .catch(err => { console.error(err); process.exitCode = 1; })
    .finally(() => disconnect?.());
}
