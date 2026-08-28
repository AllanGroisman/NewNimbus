#!/usr/bin/env node
// SONDA: dá pra ler a vitrine de um cupom pela LANDING DE AFILIADO, sem navegador?
//
// Por que a pergunta existe. Em 25/08/2026 o repasse do ML parou por CAPTCHA e o
// que destravou não foi resolver o CAPTCHA: foi parar de abrir navegador. A
// landing de afiliado (`/social/…`) responde 200 a um fetch cru e traz o produto
// inteiro num JSON embutido (scraping/ml-social.js). A vitrine do cupom
// (`lista.mercadolivre.com.br/_Container_…`) é o dado que falta hoje — o muro
// anti-bot do ML come tanto o Chrome quanto o fetch direto —, e a ideia desta
// sonda é aplicar ali o mesmo truque: passar a URL da vitrine pela API de link
// curto do próprio ML e ler a landing que sair.
//
// A sonda existe porque a resposta é desconhecida: **não se sabe se o ML aceita
// URL de LISTAGEM no programa de afiliados** (ele recusa a home, por exemplo). Se
// recusar, o caminho morre aqui e não se escreve código de produção nenhum.
//
// Uso:
//   node scripts/ml-vitrine-landing-probe.js --url "<containerUrl>" --tag <TAG>
//   node scripts/ml-vitrine-landing-probe.js --campaign 13471229 --tag <TAG>
//   node scripts/ml-vitrine-landing-probe.js --url ... --tag ... --cookie-env MINHA_VAR
//
// A TAG vem por parâmetro DE PROPÓSITO: a sessão do sistema
// (affiliate.getScraperMLSession) guarda só o cookie, sem tag, e inventar um
// campo novo antes de saber se o caminho funciona é construir no escuro. O cookie
// é o da conta do sistema (Admin › Mercado Livre ou ML_SCRAPER_COOKIE).
//
// Só LÊ: não ativa cupom, não escreve no banco e não grava o cookie em disco.

require("../config/loadEnv");
const fs = require("fs");
const path = require("path");

const ML_ENDPOINT = "https://www.mercadolivre.com.br/affiliate-program/api/v2/affiliates/createLink";
const OUT_BASE = path.join(__dirname, "..", "logs", "ml-vitrine");

// O muro de hoje, nas três formas em que ele aparece. `desafio` é o achado de
// 26/08: uma página de ~11 KB que não é o CAPTCHA visual, e sim um teste de
// JavaScript (prova de trabalho) — o fetch recebe 200 e conteúdo nenhum.
function classificaMuro(html, url) {
  const hay = `${url}\n${html}`;
  if (/\/gz\/account-verification/i.test(url)) return "account-verification";
  if (/\/captcha\/wall/i.test(url) || /n[ãa]o sou um rob[ôo]|no soy un robot/i.test(html)) return "captcha";
  if (/micro-landing-container|security\/bot_challenge/i.test(hay)) return "desafio-js";
  if (/\/gz\/login/i.test(url) || /acesse sua conta/i.test(hay)) return "login";
  return null;
}

async function main() {
  await require("../config").warmup();
  const affiliate = require("../scraping/affiliate");
  const mlSocial = require("../scraping/ml-social");
  const urlGuard = require("../scraping/urlGuard");

  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i !== -1 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : null;
  };

  const tag = flag("--tag");
  const campaign = flag("--campaign");
  let url = flag("--url");
  if (!url && campaign) {
    // Atalho: pega a containerUrl que já está guardada no banco. Ela NÃO é
    // montável na mão (o ML usa um slug, não o id da campanha), então esse é o
    // único jeito de chegar nela sem reabrir a aba de cupons.
    const coupons = require("../coupons");
    const c = await coupons.getCoupon(campaign);
    url = c?.containerUrl || null;
    if (!url) {
      console.error(`[sonda] a campanha ${campaign} não tem containerUrl guardada — ou não está no banco, ou é cupom não ativado (esse não tem vitrine).`);
      process.exit(1);
    }
  }
  if (!url || !tag) {
    console.error("uso: node scripts/ml-vitrine-landing-probe.js --url <containerUrl> --tag <TAG_DE_AFILIADO>");
    console.error("     (ou --campaign <id> no lugar do --url)");
    process.exit(1);
  }

  const cookie = flag("--cookie-env")
    ? process.env[flag("--cookie-env")]
    : affiliate.getScraperMLSession()?.cookie;
  if (!cookie) {
    console.error("[sonda] sem cookie da conta do sistema — cole em Admin › Mercado Livre (ou defina ML_SCRAPER_COOKIE).");
    process.exit(1);
  }

  const out = path.join(OUT_BASE, new Date().toISOString().replace(/[:.]/g, "-"));
  fs.mkdirSync(out, { recursive: true });
  const salva = (nome, conteudo) => fs.writeFileSync(path.join(out, nome), conteudo);

  console.log(`[sonda] vitrine: ${url}`);
  console.log(`[sonda] saída:   ${out}`);

  // ── Passo 1: o ML aceita esta URL no programa de afiliados? ──────────────
  const { UA } = require("../scraping/scraper");
  const res = await fetch(ML_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Cookie": cookie,
      "User-Agent": UA,
      "Origin": "https://www.mercadolivre.com.br",
      "Referer": "https://www.mercadolivre.com.br/afiliados",
    },
    body: JSON.stringify({ urls: [url], tag }),
  });
  const texto = await res.text();
  salva("createlink.json", texto);
  console.log(`[sonda] createLink → HTTP ${res.status}`);

  if (res.status === 401 || res.status === 403) {
    console.log("[sonda] VEREDITO: cookie da conta do sistema venceu — cole um novo e rode de novo.");
    return finaliza(out, { etapa: "createLink", veredito: "cookie-vencido", status: res.status });
  }

  let dados = null;
  try { dados = JSON.parse(texto); } catch { /* resposta não-JSON: fica no arquivo */ }
  const short = dados?.urls?.[0]?.short_url || null;
  if (!short) {
    console.log(`[sonda] resposta: ${texto.slice(0, 300)}`);
    console.log("[sonda] VEREDITO: o ML NÃO gera link de afiliado para a URL da vitrine.");
    console.log("        O caminho da landing morre aqui — a vitrine continua dependendo de outro jeito.");
    return finaliza(out, { etapa: "createLink", veredito: "link-recusado", status: res.status, resposta: dados });
  }
  console.log(`[sonda] link curto: ${short}`);

  // ── Passo 2: a landing abre sem navegador, e traz os produtos? ───────────
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  let html = "", finalUrl = short;
  try {
    const r = await urlGuard.safeFetchFollow(short, { headers: mlSocial.browserHeaders(), signal: controller.signal });
    finalUrl = r.finalUrl;
    html = await r.res.text();
    salva("landing.html", html);
    console.log(`[sonda] landing → HTTP ${r.res.status}, ${html.length} bytes`);
    console.log(`[sonda] URL final: ${finalUrl}`);
  } finally {
    clearTimeout(timer);
  }

  const muro = classificaMuro(html, finalUrl);
  const cru = mlSocial.sliceBalancedJson(html, "_n.ctx.r=");
  salva("state.json", cru || "");

  // Contar MLB no HTML cru MENTE, e essa foi a primeira leitura errada desta
  // sonda: a landing tem 46 MLBs, mas 41 deles são das abas "Para você", "Mais
  // vendidos" e "Ofertas" — recomendação para o perfil do afiliado, que não tem
  // nada a ver com o cupom. Só o bloco `carousel-featured` é a vitrine, e ele se
  // identifica sozinho: o `seeMoreLink` dele aponta de volta para a URL que a
  // gente pediu. Repassar produto de outro bloco como "coberto pelo cupom" seria
  // anunciar desconto que não existe.
  let estado = null;
  try { estado = JSON.parse(cru); } catch { /* fica o arquivo */ }
  const bloco = (estado?.appProps?.pageProps?.data?.components || [])
    .find(c => c?.id === "carousel-featured");
  const info = bloco?.recommendation_data?.recommendation_info || null;
  const daVitrine = Array.isArray(info?.polycards) ? info.polycards : [];
  const outros = new Set(html.match(/MLB\d{6,}/g) || []).size;

  console.log(`[sonda] modelo embutido: ${cru ? `${cru.length} bytes` : "NÃO veio"}`);
  console.log(`[sonda] carousel-featured: ${daVitrine.length} produto(s) · seeMoreLink: ${info?.seeMoreLink || "—"}`);
  console.log(`[sonda] (MLBs no HTML inteiro: ${outros} — o resto é recomendação do perfil, NÃO é o cupom)`);

  // O bloco só vale se ele for mesmo o da URL pedida.
  const confere = info?.seeMoreLink ? info.seeMoreLink.split("#")[0] === url.split("#")[0] : false;

  let veredito;
  if (muro) {
    veredito = `muro:${muro}`;
    console.log(`[sonda] VEREDITO: o ML barrou a landing (${muro}).`);
    if (muro === "desafio-js") {
      console.log("        É o teste de JavaScript, não o CAPTCHA visual: o fetch recebe 200 e página vazia.");
    }
  } else if (daVitrine.length && confere) {
    veredito = "ok-parcial";
    console.log(`[sonda] VEREDITO: FUNCIONA, PARCIAL — ${daVitrine.length} produtos da vitrine, sem navegador.`);
    console.log(`        O ML manda só uma prévia (totalElements=${info.totalElements}); "ver mais" devolve pra página murada.`);
    console.log("        Serve como prova POSITIVA de cobertura, nunca como lista completa.");
  } else if (daVitrine.length) {
    veredito = "bloco-de-outra-url";
    console.log("[sonda] VEREDITO: veio carrossel, mas o seeMoreLink NÃO é a URL pedida — não dá pra dizer que é a vitrine deste cupom.");
  } else {
    veredito = "sem-produtos";
    console.log("[sonda] VEREDITO: a landing abriu, mas sem produto da vitrine.");
    console.log("        Olhe o landing.html — o link curto pode ter caído no perfil do afiliado, sem prévia.");
  }

  finaliza(out, {
    etapa: "landing", veredito, url, shortUrl: short, finalUrl, muro,
    produtosDaVitrine: daVitrine.length,
    totalElements: info?.totalElements ?? null,
    seeMoreLink: info?.seeMoreLink || null,
    mlbsNoHtml: outros,
  });
}

// O resumo do que a sonda apurou. Como o dumpHub e o dumpCupons, o cookie NUNCA
// entra em arquivo nenhum.
function finaliza(out, meta) {
  fs.writeFileSync(path.join(out, "meta.json"), JSON.stringify({ quando: new Date().toISOString(), ...meta }, null, 2));
  console.log(`[sonda] resumo em ${path.join(out, "meta.json")}`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error("[sonda] falhou:", err.message);
  process.exit(1);
});
