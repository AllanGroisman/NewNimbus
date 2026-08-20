#!/usr/bin/env node
// Salva em disco a ABA DE CUPONS do Mercado Livre (mercadolivre.com.br/cupons) —
// HTML, print, o modelo JSON cru da página, os cupons já convertidos, TODAS as
// respostas que a página buscou e a vitrine de um cupom. A página só existe
// logada, então não dá pra inspecionar de fora.
//
// É a sonda que se roda ANTES de mexer no scraping (e de novo quando ele parar de
// entender a página). Ela responde, em cupons-meta.json, as perguntas que decidem
// o código:
//
//   - a lista cheia (/cupons/filter) ainda pagina do mesmo jeito, e quantas
//     páginas tem a categoria pedida?
//   - quantos cupons da lista vêm com vitrine (só esses dão pra raspar produto)?
//   - a vitrine de um cupom NÃO ativado abre? (se abrir, dá pra raspar os produtos
//     sem clicar "Aplicar" — ou seja, sem escrever nada na conta do sistema)
//   - quantos cupons a conta enxerga no total, e em que categorias?
//
// Uso:
//   node scripts/ml-cupons-dump.js
//   node scripts/ml-cupons-dump.js --grouping tb_vertical --limit 60
//   node scripts/ml-cupons-dump.js --container 13907402     # raspa a vitrine desse cupom
//   node scripts/ml-cupons-dump.js --code BRINQUEDOS        # testa uma PALAVRA no campo do ML
//   node scripts/ml-cupons-dump.js --out DIR
//
// Pré: sessão da conta do sistema salva em Admin › Mercado Livre (ou env ML_SCRAPER_COOKIE).
// O cookie NÃO vai pros arquivos. Nunca ativa cupom (não clica "Aplicar") e não
// escreve nada no banco.

require("../config/loadEnv");
const path = require("path");

async function main() {
  await require("../config").warmup();
  const affiliate = require("../scraping/affiliate");
  const mlCupons = require("../scraping/ml-cupons");

  const session = affiliate.getScraperMLSession();
  if (!session) {
    console.error("[ml-cupons] sem sessão da conta do sistema — cole o cookie em Admin › Mercado Livre (ou defina ML_SCRAPER_COOKIE).");
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i !== -1 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : null;
  };

  const grouping = flag("--grouping") || flag("--category");
  const container = flag("--container");
  const word = flag("--code");
  const limit = Number(flag("--limit")) > 0 ? Number(flag("--limit")) : 60;

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outArg = flag("--out");
  const outDir = outArg ? path.resolve(outArg) : path.join(__dirname, "..", "logs", "ml-coupons", stamp);

  console.log(`[ml-cupons] sessão: ${session.source} — abrindo ${mlCupons.CUPONS_URL}${grouping ? ` (categoria ${grouping})` : ""} ...`);
  const r = await mlCupons.dumpCupons(session.cookie, outDir, { grouping, limit, container, word });

  console.log(`[ml-cupons] veredito: ${r.verdict.kind} — ${r.verdict.reason}`);
  console.log(`[ml-cupons] modelo ${r.modelFound ? "encontrado" : "NÃO encontrado"} · ${r.totalNoML ?? "?"} cupons na conta · ${r.categoriasDoML.length} categorias`);
  console.log(`[ml-cupons] aba: ${r.cuponsNaAba} cupons · lista ${r.grouping || "todas"}: ${r.cuponsNaLista} cupons ` +
    `em ${r.paginasDaLista} página(s) (${r.totalDaLista ?? "?"} no filtro) — ${r.ativados} ativados, ${r.comVitrineNoModelo} com vitrine`);
  console.log(`[ml-cupons] XHR: ${r.xhrTotal} no total` +
    `${r.xhrDeCupom.length ? `\n[ml-cupons] respostas de cupom: ${r.xhrDeCupom.join("\n[ml-cupons]   ")}` : ""}`);
  if (r.vitrine) {
    console.log(`[ml-cupons] vitrine do cupom ${r.vitrine.campaignId} (${r.vitrine.activated ? "ativado" : "NÃO ativado"}, ${r.vitrine.scope}): ` +
      `${r.vitrine.ok ? `${r.vitrine.count} produtos` : `falhou — ${r.vitrine.reason}`}\n[ml-cupons]   ${r.vitrine.url}`);
  }
  if (r.codeCheck) {
    console.log(`[ml-cupons] palavra "${r.codeCheck.word}": ${r.codeCheck.verdict}` +
      `${r.codeCheck.campaignId ? ` → campanha ${r.codeCheck.campaignId}` : ""} (${r.codeCheck.responseCode || "sem código"}) — ${r.codeCheck.message || "sem mensagem"}`);
  }
  console.log(`[ml-cupons] arquivos em: ${r.outDir}`);

  if (!r.verdict.ok) process.exit(2);
}

main().catch(err => {
  console.error("[ml-cupons] erro:", err.message);
  process.exit(1);
});
