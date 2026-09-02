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
//   node scripts/ml-vitrine-landing-probe.js --campaign 13471229 --montar --tag <TAG>
//   node scripts/ml-vitrine-landing-probe.js --url ... --tag ... --cookie-env MINHA_VAR
//
// ── `--montar`: dá pra chegar na vitrine só com o ID da campanha? ────────────
//
// A pergunta vale porque a busca de UMA campanha hoje varre a lista de cupons da
// conta página por página (scraping/ml-cupons.js:findCampaign) — é o caminho caro,
// e ele existe porque se acreditava que a URL da vitrine não era montável.
//
// Essa crença NÃO tinha medição por trás. O comentário que a registra
// (ml-cupons.js:containerUrlFor) cita uma sonda de 18/08 que teria trazido "zero
// produtos com `_Container_<campaignId>` montado", mas os artefatos daquela rodada
// (logs/ml-coupons/2026-08-18T20-*/container-items.json) têm `containerUrl: null` e
// `finalUrl: null`: o navegador nunca navegou. O zero é de "não tentei".
//
// Com `--montar` a sonda monta `_Container_<id>?coupon_campaign_id=<id>` e passa
// pelo MESMO pipeline. Rodar as duas formas na mesma campanha — com e sem a flag —
// é a comparação cabeça a cabeça que decide se o caminho barato existe.
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
  const montar = args.includes("--montar");
  let url = flag("--url");
  let urlDoModelo = null;

  if (campaign) {
    // A containerUrl guardada, que é a que o ML deu no modelo da lista. Serve de
    // GABARITO mesmo no modo `--montar`: é contra ela que se compara o resultado.
    const coupons = require("../coupons");
    urlDoModelo = (await coupons.getCoupon(campaign))?.containerUrl || null;
  }

  if (!url && campaign && montar) {
    url = `https://lista.mercadolivre.com.br/_Container_${campaign}?coupon_campaign_id=${campaign}`;
    console.log(`[sonda] URL MONTADA a partir do id: ${url}`);
    console.log(`[sonda] gabarito (a do modelo):     ${urlDoModelo || "— (não está no banco)"}`);
  } else if (!url && campaign) {
    url = urlDoModelo;
    if (!url) {
      console.error(`[sonda] a campanha ${campaign} não tem containerUrl guardada — ou não está no banco, ou é cupom não ativado (esse não tem vitrine).`);
      console.error("        (com --montar dá pra sondar mesmo assim: a URL sai do próprio id.)");
      process.exit(1);
    }
  }
  if (!url || !tag) {
    console.error("uso: node scripts/ml-vitrine-landing-probe.js --url <containerUrl> --tag <TAG_DE_AFILIADO>");
    console.error("     (ou --campaign <id> no lugar do --url)");
    console.error("     (--montar monta a URL a partir do id, em vez de ler a do modelo)");
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

  // O bloco só vale se ele for mesmo o da URL pedida — e há DUAS formas de
  // perguntar isso, que no modo `--montar` divergem de propósito:
  //
  //   `igualCru`  — a string bate inteira. É o que esta sonda comparava, e com URL
  //                 montada ele daria "não bate" mesmo quando o ML devolveu a
  //                 vitrine certa, porque o `seeMoreLink` volta na forma canônica
  //                 (com o slug). Usar só isto responderia "não funciona" para um
  //                 caminho que funciona — o falso negativo que fecharia a porta de novo.
  //   `mesmaCampanha` — compara pelo `coupon_campaign_id`, que é a assinatura que a
  //                 PRODUÇÃO já usa (scraping/ml-vitrine-landing.js:assinaturaDaVitrine).
  //                 É esta que responde a pergunta da sonda.
  const { assinaturaDaVitrine } = require("../scraping/ml-vitrine-landing");
  const igualCru = info?.seeMoreLink ? info.seeMoreLink.split("#")[0] === url.split("#")[0] : false;
  const assinaturaPedida = assinaturaDaVitrine(url);
  const assinaturaVinda = info?.seeMoreLink ? assinaturaDaVitrine(info.seeMoreLink) : null;
  const mesmaCampanha = !!assinaturaPedida && assinaturaPedida === assinaturaVinda;
  const confere = mesmaCampanha;

  if (info?.seeMoreLink) {
    console.log(`[sonda] assinatura pedida: ${assinaturaPedida} · veio: ${assinaturaVinda} · mesma campanha: ${mesmaCampanha ? "SIM" : "não"}${igualCru ? " (string idêntica)" : ""}`);
  }

  // A vitrine responde "quais produtos", nunca "que cupom é este": título,
  // desconto, mínimo e validade só existem no modelo da lista de cupons. Se algum
  // deles aparecer aqui, o caminho barato serve para MAIS do que os produtos — e é
  // isso que decide se ele substitui a varredura ou só a adianta. Procura-se no
  // modelo embutido, não no HTML: o HTML tem "R$" e "%" em todo card.
  const camposDeCupom = ["coupon", "campaign", "discount_info", "coupon_info"];
  const marcasDeCupom = camposDeCupom.filter(k => cru && cru.includes(`"${k}"`));
  console.log(`[sonda] dados do CUPOM no modelo: ${marcasDeCupom.length ? marcasDeCupom.join(", ") : "nenhum — só produtos"}`);

  let veredito;
  if (muro) {
    veredito = `muro:${muro}`;
    console.log(`[sonda] VEREDITO: o ML barrou a landing (${muro}).`);
    if (muro === "desafio-js") {
      console.log("        É o teste de JavaScript, não o CAPTCHA visual: o fetch recebe 200 e página vazia.");
    }
  } else if (daVitrine.length && confere) {
    veredito = montar ? "ok-parcial-montada" : "ok-parcial";
    console.log(`[sonda] VEREDITO: FUNCIONA, PARCIAL — ${daVitrine.length} produtos da vitrine, sem navegador.`);
    console.log(`        O ML manda só uma prévia (totalElements=${info.totalElements}); "ver mais" devolve pra página murada.`);
    console.log("        Serve como prova POSITIVA de cobertura, nunca como lista completa.");
    if (montar) {
      console.log(`        *** E a URL foi MONTADA a partir do id ${campaign} — dá pra chegar na vitrine sem varrer a lista. ***`);
      console.log(`        Quem seleciona a campanha é o coupon_campaign_id; o caminho (_Container_…) é slug de SEO.`);
      if (!marcasDeCupom.length) {
        console.log("        Ainda assim: vieram PRODUTOS, não os dados do cupom (título, desconto, validade).");
      }
    }
  } else if (daVitrine.length) {
    veredito = "bloco-de-outra-url";
    console.log("[sonda] VEREDITO: veio carrossel, mas ele é de OUTRA campanha — não dá pra dizer que é a vitrine deste cupom.");
    if (montar) console.log(`        A URL montada caiu na vitrine ${assinaturaVinda} em vez de ${assinaturaPedida}: o caminho montado não seleciona a campanha.`);
  } else {
    veredito = "sem-produtos";
    console.log("[sonda] VEREDITO: a landing abriu, mas sem produto da vitrine.");
    console.log("        Olhe o landing.html — o link curto pode ter caído no perfil do afiliado, sem prévia.");
  }

  finaliza(out, {
    etapa: "landing", veredito, url, shortUrl: short, finalUrl, muro,
    // O que a comparação com o modo normal precisa para valer alguma coisa.
    montada: montar,
    campanha: campaign || null,
    urlDoModelo,
    igualCru,
    mesmaCampanha,
    assinaturaPedida,
    assinaturaVinda,
    marcasDeCupomNoModelo: marcasDeCupom,
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
