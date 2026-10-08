#!/usr/bin/env node
// Descobre/valida os category IDs (Level 1) reais da Shopee BR.
//
// A Shopee NÃO publica uma tabela oficial desses IDs. Mas cada produto do
// productOfferV2 vem com `productCatIds: [Level1, Level2, Level3]`. Este script
// faz buscas por palavras-chave variadas, conta qual Level-1 domina cada uma e
// dá um nome a cada categoria amostrando os mais vendidos. É a fonte de verdade
// pro mapa CATEGORIES[*].shopeeCatIds em scraping/scraper.js — re-rode quando
// quiser conferir se a Shopee mudou algum ID.
//
// Uso:
//   node scripts/shopee-discover-categories.js                # descobre o mapa completo
//   node scripts/shopee-discover-categories.js 100013         # inspeciona 1 catId (amostra)
//   node scripts/shopee-discover-categories.js --kw "notebook" # distribuição de Level-1 de uma busca
//
// Pré: conta Shopee do sistema configurada (env SHOPEE_AFFILIATE_APP_ID/SECRET,
// ou Admin › Shopee). Read-only — não escreve nada.

require("../config/loadEnv");

// Palavras-chave de sondagem, espalhadas por domínios pra cobrir o catálogo todo.
const SEED_KEYWORDS = [
  "celular", "notebook computador", "fone de ouvido", "tv televisão",
  "geladeira eletrodoméstico", "ferramenta", "roupa masculina", "tênis",
  "relógio", "brinquedo infantil", "pet cachorro", "papelaria",
  "esporte academia", "automotivo carro", "jardim", "livro",
  "maquiagem", "suplemento", "cozinha panela", "console videogame",
  "bebê fralda", "casa decoração",
];

const SLEEP_MS = 300;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  await require("../config").warmup();
  const affiliate = require("../scraping/affiliate");
  const creds = affiliate.getScraperShopeeCreds();
  if (!creds) {
    console.error("[discover] sem credenciais Shopee (env/admin/usuário). Configure antes.");
    process.exit(1);
  }
  console.log(`[discover] usando credenciais (fonte: ${creds.source})\n`);

  const args = process.argv.slice(2);
  const kwFlag = args.indexOf("--kw");

  // Modo 1: inspecionar um catId específico → mostra amostra de mais vendidos.
  const single = args.find(a => /^\d+$/.test(a));
  if (single) {
    const { nodes } = await affiliate.fetchShopeeOffers({ productCatId: Number(single), sortType: 2, page: 1, limit: 10, creds });
    console.log(`catId ${single} — ${nodes.length} produtos (mais vendidos):`);
    nodes.forEach(n => console.log(`  • ${(n.productName || "").slice(0, 60)} | R$${n.price} | ${n.sales}v | ${n.ratingStar}★ | cat=${JSON.stringify(n.productCatIds)}`));
    return;
  }

  // Modo 2: distribuição de Level-1 de uma busca por palavra-chave.
  if (kwFlag !== -1) {
    const kw = args[kwFlag + 1];
    const tally = await tallyKeyword(affiliate, creds, kw, 3);
    console.log(`keyword "${kw}" → distribuição Level-1:`, JSON.stringify(tally));
    return;
  }

  // Modo 3 (padrão): descobre o mapa completo.
  console.log("[discover] sondando palavras-chave...\n");
  const lvl1 = new Map(); // id -> total de aparições
  for (const kw of SEED_KEYWORDS) {
    const tally = await tallyKeyword(affiliate, creds, kw, 2);
    for (const [id, n] of tally) lvl1.set(id, (lvl1.get(id) || 0) + n);
  }

  const ids = [...lvl1.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  console.log(`[discover] ${ids.length} categorias Level-1 encontradas. Nomeando por amostra...\n`);

  for (const id of ids) {
    const { nodes } = await affiliate.fetchShopeeOffers({ productCatId: id, sortType: 2, page: 1, limit: 4, creds });
    const samples = nodes.map(n => (n.productName || "").slice(0, 40)).filter(Boolean);
    console.log(`catId ${id}  (apareceu ${lvl1.get(id)}x)`);
    samples.forEach(s => console.log(`    ${s}`));
    console.log("");
    await sleep(SLEEP_MS);
  }

  console.log("Mapa atual em scraper.js (CATEGORIES[*].shopeeCatIds):");
  console.log("  bebe: [100632] · gamer: [100634, 100644] · eletronicos: [100013, 100644, 100535, 100010]");
  console.log("  casa: [100636] · beleza: [100630] · roupas: [100017, 100011] · esportes: [100637]");
  console.log("  informatica: [100644] · pet: [100631] · brinquedos: (keyword 'brinquedo infantil')");
}

async function tallyKeyword(affiliate, creds, keyword, pages) {
  const tally = new Map();
  for (let page = 1; page <= pages; page++) {
    const { nodes } = await affiliate.fetchShopeeOffers({ keyword, page, limit: 10, sortType: 2, creds });
    for (const n of nodes) {
      const id = Array.isArray(n.productCatIds) ? n.productCatIds[0] : null;
      if (id != null) tally.set(id, (tally.get(id) || 0) + 1);
    }
    await sleep(SLEEP_MS);
  }
  return [...tally.entries()].sort((a, b) => b[1] - a[1]);
}

main().catch(err => {
  console.error("[discover] falha:", err.message);
  process.exit(1);
});
