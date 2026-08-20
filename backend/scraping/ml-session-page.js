// Abrir uma página do Mercado Livre COM A SESSÃO DA CONTA DO SISTEMA.
//
// O ML tem páginas que só existem logado — o Hub de Afiliados (ml-hub.js) e o
// checkout (ml-coupon.js). As duas precisam exatamente da mesma preparação:
// Chrome com stealth, o cookie da conta do sistema injetado, listeners de rede
// instalados ANTES de navegar (a SPA busca o conteúdo sozinha e a primeira leva
// chega junto com a página) e, no fim, a leitura de "o que apareceu" pra decidir
// se entrou ou caiu num muro.
//
// Isso mora aqui, e não em cada módulo, porque errar a ordem (cookie depois do
// goto, listener depois do goto) não dá erro: dá página vazia sem explicação.
const {
  launchAmazonBrowser,
  applyAmazonStealth,
  parseMLCookies,
  autoScroll,
  detectBlockPage,
} = require("./scraper");

const NAV_TIMEOUT_MS = 45000;
const BODY_TEXT_CHARS = 5000;   // texto da página guardado pro veredito

// Abre `url` logado e chama `onPage(page)` ANTES do goto — é onde o chamador
// instala os listeners de resposta. Devolve o navegador ABERTO: quem chama é
// responsável por `browser.close()` (normalmente num `finally`), porque o
// trabalho de verdade costuma continuar na página depois daqui.
//
// Devolve { page, browser, finalUrl, title, bodyText, cardCount, blocked, extra },
// onde `extra` é o retorno de onPage e `cardCount` é a maior contagem entre
// `countSelectors` (0 quando não se pede contagem nenhuma).
async function withMLSessionPage(cookie, url, onPage, {
  waitUntil = "networkidle2",
  timeout = NAV_TIMEOUT_MS,
  scrollAfterLoad = false,
  countSelectors = [],
} = {}) {
  if (!cookie) throw new Error("Sem sessão do Mercado Livre — cole o cookie da conta do sistema em Admin › Mercado Livre.");

  const browser = await launchAmazonBrowser();
  try {
    const page = await browser.newPage();
    await applyAmazonStealth(page);

    const cookies = parseMLCookies(cookie);
    if (!cookies.length) throw new Error("Cookie em formato inesperado — esperado \"nome=valor; outro=valor\".");
    await page.setCookie(...cookies);

    const extra = onPage ? await onPage(page) : null;   // listeners precisam existir antes do goto

    await page.goto(url, { waitUntil, timeout });
    if (scrollAfterLoad) await autoScroll(page);

    const snapshot = await snapshotPage(page, countSelectors);
    const blocked = await detectBlockPage(page, "Mercado Livre");

    return { page, browser, finalUrl: page.url(), blocked, extra, ...snapshot };
  } catch (err) {
    await browser.close();
    throw err;
  }
}

// O que a página mostrou, do jeito que os classificadores puros esperam receber.
// Exportada porque o fluxo do cupom navega DEPOIS do goto inicial (PDP → checkout)
// e precisa reler a mesma coisa na página nova.
async function snapshotPage(page, countSelectors = []) {
  return page.evaluate((selectors, maxChars) => {
    let cards = 0;
    for (const sel of selectors) {
      const n = document.querySelectorAll(sel).length;
      if (n > cards) cards = n;
    }
    return {
      title: document.title || "",
      bodyText: (document.body?.innerText || "").slice(0, maxChars),
      cardCount: cards,
    };
  }, countSelectors, BODY_TEXT_CHARS);
}

// ────────────────────────────────────────────────────────────────────────
// Muros do ML (login, verificação de conta, CAPTCHA)
// ────────────────────────────────────────────────────────────────────────
//
// Mora aqui porque é o mesmo muro em qualquer página logada do ML: o checkout
// (ml-coupon.js), o Hub e a aba de cupons batem todos nas mesmas três telas, e
// cada módulo escrevendo a sua versão significa três textos diferentes pro
// mesmo problema — e um deles sempre desatualizado.
//
// Devolve { status, reason } ou null quando não há muro nenhum. `status` ∈
// login | verificacao | captcha.
//
// A distinção login × verificação é o ponto todo: são problemas diferentes e a
// saída de cada um é outra. Confundir manda alguém caçar cookie novo à toa.
function classifyMLWall({ finalUrl = "", bodyText = "" } = {}) {
  const url = String(finalUrl);
  const hay = String(bodyText || "");

  // Verificação de conta não é sessão vencida: o cookie está bom, a CONTA é que
  // ficou de castigo por parecer robô. Trocar o cookie não resolve — quem resolve
  // é abrir o ML no navegador com essa conta e concluir a verificação.
  if (/account-verification/i.test(url)) {
    return {
      status: "verificacao",
      reason: "O Mercado Livre pediu verificação da CONTA (não é o cookie). Abra o ML no navegador com a conta do sistema, conclua a verificação e espere um pouco antes de tentar de novo — tentativas seguidas aumentam esse atrito. A mesma conta é usada no scraping do Hub, então vale conferir se ele ainda entra.",
    };
  }

  // O /gz/ sozinho não serve de sinal: /gz/checkout e /gz/cart são o caminho
  // normal da compra. Só as telas de identificação contam como muro de login.
  if (/\/(gz|lgz)\/(login|logout|signin|registration|identification)|\/login|\/signin|\/hub\/login/i.test(url) ||
      /acesse sua conta|para continuar, acesse|informe seu e-mail ou telefone/i.test(hay)) {
    return {
      status: "login",
      reason: "O Mercado Livre pediu login — a sessão da conta do sistema expirou. Cole um cookie novo em Admin › Mercado Livre.",
    };
  }

  if (/\/captcha\/wall/i.test(url) || /seguridad|captcha|n[ãa]o sou um rob[ôo]|no soy un robot/i.test(hay)) {
    return {
      status: "captcha",
      reason: "O Mercado Livre pediu verificação (CAPTCHA) — tente de novo daqui a alguns minutos.",
    };
  }

  return null;
}

// ────────────────────────────────────────────────────────────────────────
// Clique por texto
// ────────────────────────────────────────────────────────────────────────
//
// O Hub e o checkout são SPAs sem id estável: o texto visível é a âncora menos
// frágil que existe nelas. Em ambos os casos pegamos o elemento MAIS INTERNO
// que casa (o último na ordem do documento) e subimos até o clicável mais
// próximo — clicar no <div> de fora costuma não disparar o handler do botão.

// Clica num elemento cujo texto é exatamente `text`. true se achou o que clicar.
function clickByText(page, text) {
  return page.evaluate((wanted) => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
    const alvo = norm(wanted);
    const matches = Array.from(document.querySelectorAll("button, [role='button'], li, label, a, span, div"))
      .filter(el => norm(el.textContent) === alvo && el.offsetParent !== null);
    const el = matches[matches.length - 1];   // o mais interno (ordem do documento)
    if (!el) return false;
    (el.closest("button, [role='button'], li, label, a") || el).click();
    return true;
  }, text);
}

// Mesma ideia, mas casando por expressão regular e ignorando elementos com muito
// texto (um <div> que embrulha a página inteira "casa" com qualquer padrão).
// Devolve o texto do elemento clicado, ou null.
function clickByPattern(page, re, { maxLen = 120 } = {}) {
  return page.evaluate((source, flags, maxLen) => {
    const rx = new RegExp(source, flags);
    // Botão desabilitado não vale como clique: o .click() não faz nada e quem
    // chamou fica achando que andou. No checkout do ML isso vira loop — a sonda
    // do cupom clicou 4x no mesmo "Continuar" desabilitado e contou 4 passos.
    const bloqueado = (el) => el.disabled === true || el.getAttribute("aria-disabled") === "true";
    const clicavel = (el) => el.closest("button, [role='button'], a, label") || el;
    const matches = Array.from(document.querySelectorAll("button, [role='button'], a, label, span, div"))
      .filter(el => el.offsetParent !== null)
      .map(el => ({ el, txt: (el.textContent || "").replace(/\s+/g, " ").trim() }))
      .filter(({ el, txt }) => txt && txt.length <= maxLen && rx.test(txt) && !bloqueado(el) && !bloqueado(clicavel(el)));
    const hit = matches[matches.length - 1];
    if (!hit) return null;
    clicavel(hit.el).click();
    return hit.txt;
  }, re.source, re.flags, maxLen);
}

module.exports = { withMLSessionPage, snapshotPage, classifyMLWall, clickByText, clickByPattern, NAV_TIMEOUT_MS, BODY_TEXT_CHARS };
