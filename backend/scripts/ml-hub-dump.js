#!/usr/bin/env node
// Salva o Hub de Afiliados do Mercado Livre em disco pra escrever o scraping
// olhando a página de verdade (o Hub só abre logado, então não dá pra inspecionar
// de fora). Grava HTML, print, as respostas JSON que a própria página busca e os
// produtos já convertidos (hub-cards.json) — é o que mostra na hora se o ML mudou
// o formato dos cards e o scraping parou de entender a página.
//
// Uso:
//   node scripts/ml-hub-dump.js                    # grava em backend/logs/ml-hub/<timestamp>/
//   node scripts/ml-hub-dump.js --out DIR          # grava onde você quiser
//   node scripts/ml-hub-dump.js --category casa    # aplica o filtro de categoria antes
//
// Pré: sessão da conta do sistema salva em Admin › Mercado Livre (ou env ML_SCRAPER_COOKIE).
// O cookie NÃO vai pros arquivos. Read-only quanto a banco: não escreve nada.

require("../config/loadEnv");
const path = require("path");

async function main() {
  await require("../config").warmup();
  const affiliate = require("../scraping/affiliate");
  const mlHub = require("../scraping/ml-hub");

  const session = affiliate.getScraperMLSession();
  if (!session) {
    console.error("[ml-hub] sem sessão da conta do sistema — cole o cookie em Admin › Mercado Livre (ou defina ML_SCRAPER_COOKIE).");
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i !== -1 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : null;
  };
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outArg = flag("--out");
  const outDir = outArg ? path.resolve(outArg) : path.join(__dirname, "..", "logs", "ml-hub", stamp);

  const category = flag("--category");
  if (category && !mlHub.HUB_CATEGORIES[category]) {
    console.error(`[ml-hub] categoria "${category}" não existe no Hub. Use uma de: ${Object.keys(mlHub.HUB_CATEGORIES).join(", ")}`);
    process.exit(1);
  }

  console.log(`[ml-hub] sessão: ${session.source} — abrindo ${mlHub.HUB_URL}${category ? ` (categoria ${category})` : ""} ...`);
  const r = await mlHub.dumpHub(session.cookie, outDir, { category });

  console.log(`[ml-hub] ${r.verdict.ok ? "OK" : "FALHOU"}: ${r.verdict.reason}`);
  console.log(`[ml-hub] url final: ${r.finalUrl}`);
  if (category) console.log(`[ml-hub] filtro de categoria: ${r.filtered ? "aplicado" : "NÃO pegou (coletou o Hub geral)"}`);
  console.log(`[ml-hub] ${r.cardCount} blocos de oferta, ${r.produtos} produtos convertidos, ${r.xhrCount} respostas JSON capturadas`);
  console.log(`[ml-hub] arquivos em: ${r.outDir}`);
  if (!r.verdict.ok) process.exit(2);
}

main().catch(err => {
  console.error("[ml-hub] erro:", err.message);
  process.exit(1);
});
