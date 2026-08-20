#!/usr/bin/env node
// Salva em disco o caminho inteiro de "testar um cupom" no Mercado Livre — página
// do produto, checkout e a tela depois de aplicar o código — pra escrever o
// scraping olhando a página de verdade. O checkout só existe logado, então não dá
// pra inspecionar de fora.
//
// Grava HTML + print de cada etapa, TODAS as respostas JSON que a página buscou
// (coupon-xhr.json), só as que falam de cupom (coupon-responses.json) e um resumo
// com o veredito (coupon-meta.json). É o que mostra na hora se o ML mudou a tela
// e o teste de cupom parou de entender o que aconteceu.
//
// Uso:
//   node scripts/ml-coupon-dump.js --url https://produto.mercadolivre.com.br/MLB-...
//   node scripts/ml-coupon-dump.js --url ... --code JBL20        # testa o código no checkout
//   node scripts/ml-coupon-dump.js --url ... --mode leitura      # só a página do produto
//   node scripts/ml-coupon-dump.js --url ... --code X --out DIR
//
// Pré: sessão da conta do sistema salva em Admin › Mercado Livre (ou env ML_SCRAPER_COOKIE).
// O cookie NÃO vai pros arquivos. NUNCA finaliza compra: para na tela de pagamento.
// Read-only quanto ao banco: não escreve nada (nem no histórico do admin).

require("../config/loadEnv");
const path = require("path");

async function main() {
  await require("../config").warmup();
  const affiliate = require("../scraping/affiliate");
  const mlCoupon = require("../scraping/ml-coupon");

  const session = affiliate.getScraperMLSession();
  if (!session) {
    console.error("[ml-coupon] sem sessão da conta do sistema — cole o cookie em Admin › Mercado Livre (ou defina ML_SCRAPER_COOKIE).");
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i !== -1 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : null;
  };

  const url = flag("--url");
  if (!url) {
    console.error("[ml-coupon] faltou --url com o link do produto do Mercado Livre.");
    process.exit(1);
  }
  const code = flag("--code");
  const mode = flag("--mode") === "leitura" ? "leitura" : "checkout";
  if (mode === "checkout" && !code) {
    console.error("[ml-coupon] sem --code não há o que aplicar no checkout. Passe --code CODIGO ou --mode leitura.");
    process.exit(1);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outArg = flag("--out");
  const outDir = outArg ? path.resolve(outArg) : path.join(__dirname, "..", "logs", "ml-coupon", stamp);

  console.log(`[ml-coupon] sessão: ${session.source} — abrindo ${url}${code ? ` com o cupom ${code}` : ""} (modo ${mode}) ...`);
  const r = await mlCoupon.dumpCoupon(session.cookie, { url, code, mode }, outDir);

  console.log(`[ml-coupon] url final: ${r.finalUrl}`);
  console.log(`[ml-coupon] cupons na página do produto: ${r.clipped.length ? r.clipped.map(c => c.label).join(" | ") : "nenhum"}`);
  if (mode === "checkout") {
    console.log(`[ml-coupon] checkout: ${r.checkout.reached ? `chegou via ${r.checkout.via}` : "NÃO chegou"}` +
      `, campo de cupom ${r.checkout.fieldFound ? "encontrado" : "NÃO encontrado"}` +
      (r.checkout.cartUsed ? `, carrinho ${r.checkout.cartCleaned ? "limpo" : "NÃO limpo — confira à mão"}` : ""));
  }
  if (r.verdict) console.log(`[ml-coupon] veredito: ${r.verdict.status} — ${r.verdict.reason}`);
  console.log(`[ml-coupon] ${r.xhrCount} respostas JSON capturadas (${r.couponXhrCount} falando de cupom)`);
  console.log(`[ml-coupon] arquivos em: ${r.outDir}`);

  if (r.verdict && !r.verdict.ok) process.exit(2);
}

main().catch(err => {
  console.error("[ml-coupon] erro:", err.message);
  process.exit(1);
});
