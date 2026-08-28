#!/usr/bin/env node
// SONDA VISUAL: por que "buscar os produtos de um cupom" só traz a prévia?
//
// A queixa é concreta: o botão traz 3–8 produtos (`origem: "landing"`) e NUNCA a
// vitrine fechada. O motivo está no caminho, em dois lugares que fazem a mesma
// coisa:
//
//   coupons/sync.js:syncOneCoupon      → tenta a landing de afiliado ANTES do
//                                        Chrome e, se ela responder, RETORNA ali
//                                        mesmo com `parcial: true`.
//   scraping/ml-cupons.js:scrapeCouponProducts → idem: landing primeiro, `return`
//                                        se der certo. O laço de
//                                        `lista.mercadolivre.com.br/_Container_…`
//                                        só roda quando a landing FALHA.
//
// Ou seja: hoje a vitrine no navegador quase nunca chega a ser tentada, e quando
// é, cai no muro anti-bot do ML. Isso já está escrito nos comentários do
// scraping/ml-vitrine-landing.js — o que faltava era a PROVA VISUAL, e é o que
// esta sonda grava: um print de cada página do caminho, em ordem.
//
// A diferença para o fluxo de produção é UMA, e é o ponto: aqui a etapa do
// navegador é FORÇADA mesmo quando a landing deu certo. É o único jeito de
// fotografar o que existe do outro lado do muro.
//
// Uso:
//   node scripts/cupom-produtos-visual.js --campaign 13471229
//   node scripts/cupom-produtos-visual.js --url "<containerUrl>"
//   node scripts/cupom-produtos-visual.js --campaign 13471229 --paginas 3 --keep 10
//
// Só LÊ: não ativa cupom, não escreve no banco e não grava o cookie em disco.
require("../config/loadEnv");
const fs = require("fs");
const path = require("path");

// A pasta que o pedido nomeou: raiz do projeto, uma subpasta por rodada.
const OUT_BASE = path.join(__dirname, "..", "..", "debug-cupom");
const PAGINAS_PADRAO = 2;
const KEEP_PADRAO = 5;
const FETCH_TIMEOUT_MS = 15000;
const NAV_TIMEOUT_MS = 45000;
const MAX_HTML_BYTES = 3 * 1024 * 1024;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Deixa só as `keep` rodadas mais novas. Cada rodada larga alguns MB de print e
// ninguém lembra de limpar — mesma disciplina do pruneRuns do ml-cupons.js.
function pruneRuns(baseDir, keep) {
  try {
    const dirs = fs.readdirSync(baseDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .sort();
    for (const nome of dirs.slice(0, Math.max(0, dirs.length - keep))) {
      fs.rmSync(path.join(baseDir, nome), { recursive: true, force: true });
    }
  } catch { /* limpeza é best-effort */ }
}

// O inventário dos blocos da landing — o achado que o comentário do
// ml-vitrine-landing.js chama de "armadilha central": a página tem quatro
// carrosséis e três são recomendação para o perfil do afiliado. Listar os quatro
// lado a lado é o que faz isso ficar óbvio ao olhar o JSON.
function inventarioDeBlocos(html) {
  const mlSocial = require("../scraping/ml-social");
  const cru = mlSocial.sliceBalancedJson(html, "_n.ctx.r=");
  if (!cru) return { modeloEncontrado: false, blocos: [] };
  let estado = null;
  try { estado = JSON.parse(cru); } catch { return { modeloEncontrado: false, blocos: [] }; }
  const componentes = estado?.appProps?.pageProps?.data?.components;
  if (!Array.isArray(componentes)) return { modeloEncontrado: true, blocos: [] };
  return {
    modeloEncontrado: true,
    blocos: componentes.map(c => {
      const info = c?.recommendation_data?.recommendation_info || null;
      return {
        id: c?.id ?? null,
        titulo: info?.title ?? c?.title ?? null,
        polycards: Array.isArray(info?.polycards) ? info.polycards.length : 0,
        totalElements: Number.isFinite(info?.totalElements) ? info.totalElements : null,
        seeMoreLink: info?.seeMoreLink ?? null,
        // Só este é a vitrine do cupom. Os outros são "Para você", "Mais
        // vendidos", "Ofertas" — produtos que não têm nada a ver com o cupom.
        ehAVitrine: c?.id === "carousel-featured",
      };
    }),
  };
}

// Um print nunca derruba a sonda: ele é diagnóstico, não resultado.
async function print(page, arquivo) {
  try {
    await page.screenshot({ path: arquivo, fullPage: true });
    return true;
  } catch (err) {
    console.warn(`[sonda] não deu pra salvar ${path.basename(arquivo)}: ${err.message}`);
    return false;
  }
}

// Aba nova NÃO herda o disfarce (o stealth é por página), e sem ele o
// lista.mercadolivre.com.br devolve "Hubo un error accediendo a esta pagina" em
// vez da lista — a armadilha anotada em ml-cupons.js:668.
async function novaAba(browser, cookies) {
  const { applyAmazonStealth } = require("../scraping/scraper");
  const page = await browser.newPage();
  await applyAmazonStealth(page);
  if (cookies?.length) await page.setCookie(...cookies);
  return page;
}

async function main() {
  await require("../config").warmup();

  const args = process.argv.slice(2);
  const flag = (nome) => {
    const i = args.indexOf(nome);
    return i !== -1 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : null;
  };

  const campaign = flag("--campaign");
  const paginas = Math.max(1, parseInt(flag("--paginas") || PAGINAS_PADRAO, 10) || PAGINAS_PADRAO);
  const keep = Math.max(1, parseInt(flag("--keep") || KEEP_PADRAO, 10) || KEEP_PADRAO);

  const coupons = require("../coupons");
  const affiliate = require("../scraping/affiliate");
  const mlCupons = require("../scraping/ml-cupons");
  const mlSocial = require("../scraping/ml-social");
  const mlVitrineLanding = require("../scraping/ml-vitrine-landing");
  const urlGuard = require("../scraping/urlGuard");
  const { launchAmazonBrowser, parseMLCookies, autoScroll, detectBlockPage, harvestMLCards } = require("../scraping/scraper");

  // A containerUrl NÃO é montável na mão (o ML usa um slug, não o id da
  // campanha), então ou ela vem do banco ou vem por parâmetro.
  let cupom = null;
  let containerUrl = flag("--url");
  if (campaign) {
    cupom = await coupons.getCoupon(campaign);
    if (!cupom) {
      console.error(`[sonda] a campanha ${campaign} não está no banco — puxe os cupons primeiro em Admin › Cupons ML.`);
      process.exit(1);
    }
    containerUrl = containerUrl || mlCupons.containerUrlFor(cupom);
  }
  if (!campaign && !containerUrl) {
    console.error("uso: node scripts/cupom-produtos-visual.js --campaign <id>");
    console.error("     (ou --url \"<containerUrl>\"; opcionais: --paginas N, --keep N)");
    process.exit(1);
  }

  const session = affiliate.getScraperMLSession();
  if (!session?.cookie) {
    console.error("[sonda] sem sessão do Mercado Livre do sistema — cole o cookie em Admin › Mercado Livre.");
    process.exit(1);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const out = path.join(OUT_BASE, `${stamp}-${campaign || "sem-campanha"}`);
  fs.mkdirSync(out, { recursive: true });
  pruneRuns(OUT_BASE, keep);
  const salvar = (nome, conteudo) => fs.writeFileSync(
    path.join(out, nome),
    typeof conteudo === "string" ? conteudo : JSON.stringify(conteudo, null, 2),
  );

  console.log(`[sonda] cupom:  ${campaign || "(por URL)"}`);
  console.log(`[sonda] vitrine: ${containerUrl || "(o cupom não tem containerUrl)"}`);
  console.log(`[sonda] saída:  ${out}`);

  const resumo = {
    campaignId: campaign || null,
    containerUrl: containerUrl || null,
    quandoRodou: new Date().toISOString(),
    etapas: {},
  };

  // ── 00. O que o banco sabe do cupom ──────────────────────────────────────
  // Sem `containerUrl` o caminho termina aqui, e isso é um desfecho de verdade:
  // cupom não ativado não tem vitrine pra raspar, porque o ML só a mostra depois
  // do "Eu quero" — e clicar nisso ATIVARIA o cupom na conta do sistema.
  salvar("00-cupom.json", cupom ? {
    campaignId: cupom.campaignId,
    title: cupom.title,
    scope: cupom.scope,
    activated: cupom.activated,
    containerUrl: cupom.containerUrl,
    code: cupom.code,
    expiresAt: cupom.expiresAt,
    sampleItemIds: cupom.sampleItemIds || [],
  } : { observacao: "rodada por --url, sem linha no banco" });

  if (!containerUrl) {
    resumo.etapas.cupom = {
      ok: false,
      porque: cupom?.activated
        ? "cupom ativado, mas o ML não deu a URL da vitrine dele"
        : "cupom NÃO ativado — o ML só mostra a vitrine depois do \"Eu quero\", e ativar mexeria na conta do sistema",
    };
    salvar("resumo.json", resumo);
    salvar("LEIA.md", `# ${campaign}\n\nO caminho termina no passo 0: ${resumo.etapas.cupom.porque}.\nSem \`containerUrl\` não há landing nem vitrine para fotografar.\n`);
    console.log(`[sonda] fim: ${resumo.etapas.cupom.porque}`);
    process.exit(0);
  }

  // ── 01. O link curto de afiliado ─────────────────────────────────────────
  // É o passo escondido do caminho da landing: a URL da vitrine passa pela API
  // de link curto do PRÓPRIO ML (com a conta do sistema) e o que volta é uma
  // landing `/social/<tag>` que o ML entrega a um fetch cru.
  const link = await affiliate.criarLinkAfiliadoMLSistema(containerUrl);
  salvar("01-link-afiliado.json", { url: containerUrl, shortUrl: link.shortUrl, kind: link.kind, reason: link.reason });
  resumo.etapas.linkAfiliado = { ok: !!link.shortUrl, shortUrl: link.shortUrl, reason: link.reason };
  console.log(`[sonda] 01 link de afiliado: ${link.shortUrl || `FALHOU — ${link.reason}`}`);

  const browser = await launchAmazonBrowser();
  const cookies = parseMLCookies(session.cookie);
  try {
    // ── 02. A landing crua, exatamente como a produção a lê ────────────────
    if (link.shortUrl) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const { res, finalUrl } = await urlGuard.safeFetchFollow(link.shortUrl, {
          headers: mlSocial.browserHeaders(),
          signal: controller.signal,
        });
        const html = (await res.text()).slice(0, MAX_HTML_BYTES);
        salvar("02-landing.html", html);

        const parsed = mlVitrineLanding.parseVitrineLanding(html, containerUrl, finalUrl);
        const blocos = inventarioDeBlocos(html);
        const vitrine = blocos.blocos.find(b => b.ehAVitrine) || null;
        salvar("02-landing.json", {
          status: res.status,
          finalUrl,
          bytes: html.length,
          resultado: { ok: parsed.ok, kind: parsed.kind, reason: parsed.reason, produtos: parsed.products.length, total: parsed.total },
          // A conferência que impede carimbar produto de outro lugar como se
          // fosse do cupom: o carrossel só vale se o `seeMoreLink` dele apontar
          // de volta para a URL pedida.
          assinaturas: {
            pedida: mlVitrineLanding.assinaturaDaVitrine(containerUrl),
            doCarrossel: vitrine ? mlVitrineLanding.assinaturaDaVitrine(vitrine.seeMoreLink) : null,
            batem: !!vitrine && mlVitrineLanding.assinaturaDaVitrine(containerUrl) === mlVitrineLanding.assinaturaDaVitrine(vitrine.seeMoreLink),
          },
          blocos,
          produtos: parsed.products,
        });
        resumo.etapas.landing = {
          ok: parsed.ok, kind: parsed.kind, reason: parsed.reason,
          produtos: parsed.products.length, total: parsed.total, finalUrl,
        };
        console.log(`[sonda] 02 landing (fetch): ${parsed.kind} — ${parsed.products.length} produto(s)${parsed.total != null ? ` de ${parsed.total}` : ""}`);

        // O print do que o PARSER viu: a MESMA HTML do fetch, renderizada.
        //
        // Não é `setContent`: a primeira versão desta sonda usou, e o print saiu
        // em branco. O React do ML se ancora na URL da página (o bootstrap
        // `_n.ctx.r=` e todo caminho relativo), e com `setContent` a URL é
        // `about:blank` — nada hidrata. O jeito honesto é interceptar a navegação
        // e SERVIR este HTML na URL de verdade: a página é a do fetch, mas o
        // navegador a trata como se tivesse vindo dele.
        const aba = await novaAba(browser, null);
        try {
          await aba.setRequestInterception(true);
          let servido = false;
          aba.on("request", (req) => {
            if (!servido && req.isNavigationRequest() && req.frame() === aba.mainFrame()) {
              servido = true;
              req.respond({ status: 200, contentType: "text/html; charset=utf-8", body: html });
              return;
            }
            req.continue().catch(() => {});
          });
          await aba.goto(finalUrl, { waitUntil: "networkidle2", timeout: NAV_TIMEOUT_MS }).catch(() => {});
          await print(aba, path.join(out, "02-landing.png"));
        } finally {
          await aba.close().catch(() => {});
        }
      } catch (err) {
        salvar("02-landing.json", { erro: err.message });
        resumo.etapas.landing = { ok: false, kind: "erro", reason: err.message };
        console.log(`[sonda] 02 landing (fetch): FALHOU — ${err.message}`);
      } finally {
        clearTimeout(timer);
      }

      // ── 03. A mesma landing, mas num navegador logado ────────────────────
      // Responde se o Chrome leva muro onde o fetch cru passa.
      const aba = await novaAba(browser, cookies);
      try {
        await aba.goto(link.shortUrl, { waitUntil: "networkidle2", timeout: NAV_TIMEOUT_MS });
        salvar("03-landing-navegador.html", await aba.content());
        await print(aba, path.join(out, "03-landing-navegador.png"));
        const blocked = await detectBlockPage(aba, "Mercado Livre");
        salvar("03-landing-navegador.json", { finalUrl: aba.url(), blocked });
        resumo.etapas.landingNavegador = { finalUrl: aba.url(), bloqueado: !!blocked?.blocked, reason: blocked?.reason || null };
        console.log(`[sonda] 03 landing (Chrome): ${blocked?.blocked ? `BLOQUEADO — ${blocked.reason}` : "abriu"}`);
      } catch (err) {
        salvar("03-landing-navegador.json", { erro: err.message });
        resumo.etapas.landingNavegador = { erro: err.message };
        console.log(`[sonda] 03 landing (Chrome): FALHOU — ${err.message}`);
      } finally {
        await aba.close().catch(() => {});
      }
    } else {
      resumo.etapas.landing = { ok: false, kind: link.kind, reason: link.reason, pulada: true };
    }

    // ── 04. A vitrine murada — a etapa que hoje NUNCA roda ─────────────────
    // Forçada de propósito: é o print que responde "por que nunca vem a
    // vitrine". Mesmos parâmetros do laço real (ml-cupons.js:673).
    const daVitrine = [];
    for (let n = 1; n <= paginas; n++) {
      const aba = await novaAba(browser, cookies);
      const alvo = mlCupons.containerPageUrl(containerUrl, n);
      try {
        await aba.goto(alvo, { waitUntil: "networkidle2", timeout: NAV_TIMEOUT_MS, referer: mlCupons.CUPONS_URL });
        const blocked = await detectBlockPage(aba, "Mercado Livre");
        await autoScroll(aba);
        const cards = await harvestMLCards(aba, null).catch(() => []);
        fs.writeFileSync(path.join(out, `04-vitrine-p${n}.html`), await aba.content());
        await print(aba, path.join(out, `04-vitrine-p${n}.png`));
        daVitrine.push({
          pagina: n, url: alvo, finalUrl: aba.url(),
          bloqueado: !!blocked?.blocked, reason: blocked?.reason || null,
          cards: cards.length,
        });
        console.log(`[sonda] 04 vitrine p${n}: ${blocked?.blocked ? `BLOQUEADO — ${blocked.reason}` : `${cards.length} card(s)`}`);
        // Muro é estado da SESSÃO, não daquela página: insistir só queima a conta.
        if (blocked?.blocked) break;
        if (!cards.length) break;
      } catch (err) {
        daVitrine.push({ pagina: n, url: alvo, erro: err.message });
        console.log(`[sonda] 04 vitrine p${n}: FALHOU — ${err.message}`);
        break;
      } finally {
        await aba.close().catch(() => {});
      }
      await sleep(400);
    }
    salvar("04-vitrine.json", daVitrine);
    resumo.etapas.vitrine = daVitrine;

    // ── O resumo, na ordem em que o sistema percorre ───────────────────────
    const landingOk = !!resumo.etapas.landing?.ok;
    const cardsVitrine = daVitrine.reduce((s, p) => s + (p.cards || 0), 0);
    resumo.ondeOFluxoDeProducaoPara = landingOk
      ? "syncOneCoupon: a landing respondeu, então ele retorna ali mesmo com `parcial: true` — o Chrome nem chega a ser aberto."
      : "syncOneCoupon: a landing não veio, então ele abre o Chrome e tenta a vitrine.";
    salvar("resumo.json", resumo);

    salvar("LEIA.md", [
      `# Caminho dos produtos do cupom ${campaign || "(por URL)"}`,
      "",
      `Vitrine: \`${containerUrl}\``,
      `Rodada:  ${resumo.quandoRodou}`,
      "",
      "## O que cada print mostra",
      "",
      "| Print | O quê |",
      "| --- | --- |",
      "| `02-landing.png` | A landing de afiliado como o PARSER a vê (HTML do fetch cru, renderizada). É daqui que saem os 3–8 produtos da prévia. |",
      "| `03-landing-navegador.png` | A mesma landing aberta no Chrome logado. Serve pra comparar: o fetch passa onde o navegador é barrado? |",
      "| `04-vitrine-p<N>.png` | A vitrine de verdade (`lista.mercadolivre.com.br/_Container_…`). **Esta etapa não roda em produção hoje** — a sonda a força. |",
      "",
      "## O que saiu",
      "",
      `- **Link de afiliado:** ${link.shortUrl ? `ok (${link.shortUrl})` : `FALHOU — ${link.reason}`}`,
      `- **Landing (fetch):** ${resumo.etapas.landing ? `${resumo.etapas.landing.kind} — ${resumo.etapas.landing.produtos ?? 0} produto(s)${resumo.etapas.landing.total != null ? ` de ${resumo.etapas.landing.total}` : ""}${resumo.etapas.landing.finalUrl ? ` (caiu em \`${resumo.etapas.landing.finalUrl}\`)` : ""}` : "não rodou"}`,
      `- **Landing (Chrome):** ${resumo.etapas.landingNavegador ? (resumo.etapas.landingNavegador.bloqueado ? `BLOQUEADO — ${resumo.etapas.landingNavegador.reason}` : "abriu") : "não rodou"}`,
      `- **Vitrine (Chrome, forçada):** ${daVitrine.length ? daVitrine.map(p => `p${p.pagina}: ${p.erro ? `erro (${p.erro})` : p.bloqueado ? `bloqueado (${p.reason})` : `${p.cards} card(s)`}`).join(" · ") : "não rodou"}`,
      "",
      "## Por que só vem a prévia",
      "",
      resumo.ondeOFluxoDeProducaoPara,
      "",
      "O curto-circuito está em dois lugares, e os dois fazem a mesma coisa:",
      "",
      "- `backend/coupons/sync.js` → `syncOneCoupon`: landing antes do Chrome, `return` se ela responder.",
      "- `backend/scraping/ml-cupons.js` → `scrapeCouponProducts`: idem.",
      "",
      `Nesta rodada a landing entregou ${resumo.etapas.landing?.produtos ?? 0} produto(s) e a vitrine forçada entregou ${cardsVitrine} card(s).`,
      "Os produtos da landing entram com `origem: \"landing\"` — prova positiva de cobertura, nunca lista fechada.",
      "",
    ].join("\n"));

    console.log(`[sonda] pronto: ${out}`);
  } finally {
    await browser.close().catch(() => {});
  }
}

main().then(() => process.exit(0)).catch((err) => {
  console.error("[sonda] erro:", err);
  process.exit(1);
});
