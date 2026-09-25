// Testar um CÓDIGO de cupom num produto, no checkout — na aba do próprio admin.
//
// Desde 25/08/2026 o ML barra o navegador automatizado com CAPTCHA já na página do
// produto: o caminho do servidor (`backend/scraping/ml-coupon.js`) quase nunca
// chega ao checkout. Aqui quem caminha é uma aba do Chrome do admin.
//
// Este arquivo é um PORTE do fluxo de lá, e os pedaços que rodam dentro da página
// são os mesmos — em `ml-coupon.js` eles já viviam dentro de `page.evaluate`. O que
// muda é o motor: `avaliar()` no lugar do `page.evaluate`, `irPara()` no lugar do
// `page.goto`.
//
// Os freios vieram junto e são a parte que não pode se perder:
//
//   - só clica em rótulo do tipo "Continuar" (regex ANCORADA). Nunca em
//     pagar/confirmar — o pior caso é parar antes da hora, nunca comprar;
//   - se o caminho passou pelo carrinho, o item sai de lá no fim;
//   - a aba é sempre fechada.
//
// Nada é interpretado aqui: os totais, os cupons da página e o veredito saem das
// funções puras do servidor, sobre o texto cru que este arquivo devolve.

import { sleep, abrir, irPara, fechar, avaliar, esperarHumano, classificarMuro } from "./aba.js";

// Gêmeos de ml-coupon.js. Em texto porque viajam para dentro da página.
const CHECKOUT_URL_RE = /\/(checkout|gz\/checkout|cart|carrinho)\b/i;
const CHECKOUT_LOADING_RE = /preparando tudo|estamos preparando|aguarde um instante|carregando/i;
const CHECKOUT_READY_RE = /forma de pagamento|como (voc[êe] )?quer pagar|resumo da compra|revise (sua|a) compra|finalizar compra|meios de pagamento|endere[çc]o de entrega/i;
const CHECKOUT_ERROR_RE = /(ocorreu um problema|algo deu errado|tivemos um problema)[\s\S]{0,140}?(tente novamente|estamos trabalhando)/i;
const CHECKOUT_ERROR_TITLE_RE = /^\s*(ocorreu um problema|algo deu errado|tivemos um problema)/i;
const CHECKOUT_ERROR_CODE_RE = /\b[A-Z]{2,6}\d{0,3}-[A-Z0-9]{6,}\b/;
const PAYMENT_STEP_RE = /forma de pagamento|formas de pagamento|como (voc[êe] )?quer pagar|escolha como pagar|meios de pagamento|escolha o meio de pagamento/i;
// A última alternativa é a linha do resumo no checkout de página única (sonda de
// 19/09/2026): "Cupons (1/1 em uso)". O `^cupons?$` sozinho não casava com ela, e a
// caminhada parava na primeira tela sem nunca abrir o popup.
export const COUPON_OPEN_SRC = "(inserir|adicionar|usar|tenho|aplicar).{0,12}(cupom|cupons|c[óo]digo)|c[óo]digos? de desconto|cupom de desconto|cupons de desconto|^cupons?$|^cupons?\\s*\\(\\s*\\d+\\s*/\\s*\\d+";
// A oferta de seguro que o ML põe ENTRE o "Comprar agora" e o checkout em alguns
// produtos (sonda de 19/09/2026, porteiro Intelbras): `/protections/hub/attach`. A
// saída é recusar — "Agora não" —, e a URL do checkout vem no `callback_url` dela,
// que é o plano B quando o botão não aparece.
const PROTECTIONS_URL_RE = /\/protections\//i;
const RECUSAR_SEGURO_SRC = "^agora n[ãa]o\\b";
const SEGURO_WAIT_MS = 8000;
const IFRAME_WAIT_MS = 12000;

// Dentro do popup: o caminho para a lista dos cupons que a conta já tem ativos.
const VER_ATIVOS_SRC = "^(ver|mostrar|conferir)( os| seus| meus)? cupons( ativos| dispon[íi]veis)?|^cupons ativos|^meus cupons";
export const API_RE = "(coupon|cupon|discount|promotion|promocao|promo)";
const BUY_NOW_SRC = "^comprar agora";
const ADD_TO_CART_SRC = "^adicionar ao carrinho$";
const CONTINUE_SRC = "^continuar( compra)?$";
const CONTINUE_STEP_SRC = "^continuar( compra| para .{0,30})?$";
const COUPON_APPLY_SRC = "^(aplicar|adicionar|inserir|usar|confirmar)( cupom| c[óo]digo)?$";
const COUPON_APPLY_FALLBACK_SRC = "^continuar$";
const CART_REMOVE_SRC = "^(excluir|remover|tirar)$";
const CART_URL = "https://www.mercadolivre.com.br/gz/cart";

const SETTLE_MS = 1500;
const APPLY_WAIT_MS = 6000;
const COUPON_OPEN_WAIT_MS = 12000;
const TOTAL_WAIT_MS = 10000;
const STEP_CHANGE_WAIT_MS = 15000;
const QUIET_WAIT_MS = 8000;
const CHECKOUT_READY_WAIT_MS = 30000;
const NAV_WAIT_MS = 20000;
const MAX_CHECKOUT_STEPS = 6;

// Os tempos que o lote da sonda pode ajustar (backend/coupons/checkout-lote-config.js).
// Quem não manda nada anda com os de sempre; valor fora da faixa cai no padrão,
// porque um 0 aqui viraria laço de espera que nunca espera.
const TEMPOS_PADRAO = {
  settleMs: SETTLE_MS,
  esperaCheckoutMs: CHECKOUT_READY_WAIT_MS,
  esperaNavMs: NAV_WAIT_MS,
  esperaIframeMs: IFRAME_WAIT_MS,
};
export function lerTempos(t) {
  const saida = { ...TEMPOS_PADRAO };
  for (const k of Object.keys(TEMPOS_PADRAO)) {
    const n = Number(t?.[k]);
    if (Number.isFinite(n) && n >= 300 && n <= 120000) saida[k] = n;
  }
  return saida;
}

// ── o que roda DENTRO da página ──────────────────────────────────────────
// Todas serializadas pelo executeScript: auto-contidas, sem fechar sobre nada.

export function naPagina_espiao(apiRe) {
  if (window.__nimbusCupomEspiao) return true;
  const re = new RegExp(apiRe, "i");
  const guardados = [];
  window.__nimbusCupomEspiao = guardados;
  const fetchOriginal = window.fetch;
  window.fetch = function (...args) {
    return fetchOriginal.apply(this, args).then((res) => {
      try { if (re.test(res.url)) res.clone().text().then(t => guardados.push(t)).catch(() => {}); } catch { /* opaca */ }
      return res;
    });
  };
  const abrirOriginal = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (metodo, url, ...resto) {
    this.addEventListener("load", () => {
      try { if (re.test(String(url))) guardados.push(this.responseText); } catch { /* binário */ }
    });
    return abrirOriginal.call(this, metodo, url, ...resto);
  };
  return true;
}

export function naPagina_foto() {
  const texto = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
  const visivel = (el) => el.offsetParent !== null && (el.textContent || "").trim();
  const titulo = Array.from(document.querySelectorAll("h1, h2, [role='heading']"))
    .filter(visivel)
    .map(el => el.textContent.replace(/\s+/g, " ").trim())
    .find(t => t.length <= 90) || "";
  return {
    url: location.href,
    titulo,
    tituloDaAba: document.title || "",
    texto: texto.slice(0, 8000),
    // A "impressão digital" da tela, pra saber se ela mudou. O título sozinho não
    // serve: o checkout tem duas telas seguidas com o mesmo nome.
    digital: `${location.pathname}|${texto.slice(0, 400)}`,
    respostas: (window.__nimbusCupomEspiao || []).slice(),
  };
}

// A tela dos cupons, crua, para a SONDA (modo "listar"). Nada é interpretado aqui:
// o parser só vai ser escrito depois de alguém olhar isto (task 12, etapa D) — os
// seletores do popup de cupom nunca foram conferidos contra a tela de hoje.
// Tetos de tamanho porque tudo viaja até o servidor, que aceita 2 MB por pedido
// (express.json e o nginx). `comHtml: false` na captura ao entrar: o HTML que
// importa é o da tela dos cupons.
//
// Com um popup aberto (`[role=dialog]`), o HTML guardado é SÓ o do popup — é ele que
// interessa, e é muito menor que a página inteira. `tetoHtml` 0 = sem HTML.
function naPagina_capturaDosCupons(tetoHtml) {
  const dialogos = Array.from(document.querySelectorAll("[role='dialog'], [aria-modal='true']"))
    .filter(el => el.offsetParent !== null || el.getClientRects().length);
  const fonte = dialogos.length ? dialogos.map(d => d.outerHTML).join("\n<!-- dialogo -->\n") : (document.documentElement?.outerHTML || "");
  const teto = Number(tetoHtml) || 0;
  // O conteúdo do popup de cupons mora num IFRAME (`/cupons/cho?context_id=…`),
  // do mesmo domínio — então dá pra ler o documento dele daqui. Iframe de outro
  // domínio (ou ainda carregando) vem só com o `src`.
  const iframes = dialogos.flatMap(d => Array.from(d.querySelectorAll("iframe"))).map(f => {
    let doc = null;
    try { doc = f.contentDocument; } catch { doc = null; }
    const html = doc?.documentElement?.outerHTML || "";
    return {
      src: f.src || null,
      legivel: !!doc,
      texto: (doc?.body?.innerText || "").slice(0, 20000),
      html: teto ? html.slice(0, teto) : "",
    };
  });
  return {
    url: location.href,
    tituloDaAba: document.title || "",
    texto: (document.body?.innerText || "").slice(0, 40000),
    textoDoPopup: [...dialogos.map(d => d.innerText || ""), ...iframes.map(f => f.texto)].join("\n---\n").slice(0, 30000),
    popupAberto: dialogos.length > 0,
    iframes,
    html: teto ? fonte.slice(0, teto) : "",
    htmlCortado: teto ? fonte.length > teto : false,
    respostas: (window.__nimbusCupomEspiao || []).slice(-15).map(r => String(r).slice(0, 20_000)),
  };
}

// O "Agora não" da oferta de seguro. Função própria, e não o `clicarPorTexto`,
// porque a sonda de 19/09 mostrou o botão numa BARRA FIXA no rodapé — e elemento
// `position: fixed` tem `offsetParent === null`, que o `clicarPorTexto` lê como
// "invisível". Aqui a visibilidade é por `getClientRects`, o rótulo vale pelo texto
// OU pelo `aria-label`, e os iframes do mesmo domínio entram na busca.
// Sem achar, devolve os rótulos clicáveis da tela — é o que explica o porquê.
function naPagina_recusarSeguro(padrao) {
  const re = new RegExp(padrao, "i");
  const docs = [document];
  for (const f of document.querySelectorAll("iframe")) {
    try { if (f.contentDocument) docs.push(f.contentDocument); } catch { /* outro domínio */ }
  }
  const rotulos = [];
  for (const doc of docs) {
    for (const el of doc.querySelectorAll("button, a, [role='button'], input[type='button'], input[type='submit']")) {
      // NFC: "NÃO" pode vir com o til como caractere separado, e aí não casa.
      const txt = (el.textContent || el.value || "").normalize("NFC").replace(/\s+/g, " ").trim();
      const aria = (el.getAttribute("aria-label") || "").normalize("NFC").trim();
      if (txt || aria) rotulos.push((txt || aria).slice(0, 50));
      if (!el.getClientRects().length) continue;
      if (el.disabled === true || el.getAttribute("aria-disabled") === "true") continue;
      if ((txt && txt.length <= 40 && re.test(txt)) || (aria && re.test(aria))) {
        el.click();
        return { clicou: txt || aria, noIframe: doc !== document };
      }
    }
  }
  return { clicou: null, rotulos: [...new Set(rotulos)].slice(0, 40), iframes: docs.length - 1 };
}

// Quanto texto o iframe do popup já pintou (0 = ainda carregando ou ilegível).
function naPagina_textoDoIframeDoPopup() {
  const f = document.querySelector("[role='dialog'] iframe, [aria-modal='true'] iframe");
  try { return (f?.contentDocument?.body?.innerText || "").trim().length; } catch { return 0; }
}

// A página dos cupons do checkout, sem depender de o popup abrir. A linha do
// resumo ("Cupons (1/1 em uso)" quando há cupom em uso, "Inserir código do cupom"
// quando não há) é um DEEPLINK no modelo da página, para
// `https://www.mercadolivre.com.br/cupons/cho?context_id=…` — exatamente o
// documento que o popup carrega dentro de um iframe. Ele está no HTML do checkout
// com as barras escapadas (`/`), por isso o replace antes do casamento.
//
// Isto existe porque a sonda de 19/09/2026 mostrou o clique falhando justamente no
// caso comum: sem cupom em uso, clicar em "Inserir código do cupom" só trocava a
// URL por "#" e nenhum `[role=dialog]` era montado — a caminhada parava ali e a
// sonda voltava sem resposta nenhuma.
export function naPagina_paginaDosCupons() {
  const cru = document.documentElement?.outerHTML || "";
  const m = cru.replace(/\\u002F/gi, "/")
    .match(/https?:\/\/[a-z0-9.-]*mercadolivre\.com\.br\/cupons\/cho\?context_id=[A-Za-z0-9]+/i);
  if (m) return m[0];
  // Popup já aberto: o iframe dele serve igual.
  const f = document.querySelector("iframe[src*='/cupons/cho']");
  return f?.src || null;
}

// Busca uma página do próprio ML de dentro da aba: mesma origem, mesmos cookies,
// mesma sessão de checkout. Só a sonda usa, e só para LER.
export async function naPagina_buscarPagina(endereco, tetoHtml) {
  const teto = Number(tetoHtml) || 0;
  try {
    const res = await fetch(endereco, { credentials: "include", headers: { Accept: "text/html" } });
    const html = await res.text();
    return {
      ok: res.ok, status: res.status, url: res.url, endereco,
      tamanho: html.length, html: html.slice(0, teto), cortado: html.length > teto,
    };
  } catch (e) {
    return { ok: false, status: 0, url: null, endereco, erro: String((e && e.message) || e), html: "" };
  }
}

// O espião, instalado TAMBÉM dentro do iframe do popup: é lá que a lista dos cupons
// busca os dados. Guarda no mesmo array da página de cima.
function naPagina_espiaoNoIframe(apiRe) {
  const f = document.querySelector("[role='dialog'] iframe, [aria-modal='true'] iframe");
  let w = null;
  try { w = f?.contentWindow; if (!w?.document) return false; } catch { return false; }
  if (w.__nimbusCupomEspiao) return true;
  const re = new RegExp(apiRe, "i");
  const guardados = window.__nimbusCupomEspiao || (window.__nimbusCupomEspiao = []);
  w.__nimbusCupomEspiao = guardados;
  const fetchOriginal = w.fetch;
  w.fetch = function (...args) {
    return fetchOriginal.apply(this, args).then((res) => {
      try { if (re.test(res.url)) res.clone().text().then(t => guardados.push(t)).catch(() => {}); } catch { /* opaca */ }
      return res;
    });
  };
  const abrirOriginal = w.XMLHttpRequest.prototype.open;
  w.XMLHttpRequest.prototype.open = function (metodo, url, ...resto) {
    this.addEventListener("load", () => {
      try { if (re.test(String(url))) guardados.push(this.responseText); } catch { /* binário */ }
    });
    return abrirOriginal.call(this, metodo, url, ...resto);
  };
  return true;
}

// Clica por texto DENTRO do popup, iframe incluído. Só na sonda, e só no link que
// mostra a lista dos cupons ativos — nunca num cupom.
function naPagina_clicarNoPopup(padrao, maxLen) {
  const rx = new RegExp(padrao, "i");
  const docs = [];
  for (const d of document.querySelectorAll("[role='dialog'], [aria-modal='true']")) {
    docs.push(d);
    for (const f of d.querySelectorAll("iframe")) {
      try { if (f.contentDocument?.body) docs.push(f.contentDocument.body); } catch { /* outro domínio */ }
    }
  }
  for (const raiz of docs) {
    const achados = Array.from(raiz.querySelectorAll("button, [role='button'], a, span, p, div"))
      .map(el => ({ el, txt: (el.textContent || "").replace(/\s+/g, " ").trim() }))
      .filter(({ txt }) => txt && txt.length <= maxLen && rx.test(txt));
    if (!achados.length) continue;
    const { el, txt } = achados[achados.length - 1];
    const alvo = el.closest("button, [role='button'], a") || el;
    alvo.click();
    return { texto: txt, tag: alvo.tagName.toLowerCase() };
  }
  return null;
}

export function naPagina_clicarPorTexto(padrao, maxLen) {
  const re = new RegExp(padrao, "i");
  for (const el of document.querySelectorAll("button, a, [role='button'], span, div, label")) {
    const txt = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (!txt || txt.length > maxLen || !re.test(txt)) continue;
    if (el.offsetParent === null) continue;
    const clicavel = el.closest("button, a, [role='button']") || el;
    if (clicavel.disabled === true || clicavel.getAttribute("aria-disabled") === "true") continue;
    clicavel.click();
    return txt;
  }
  return null;
}

// Os cupons que a própria página do produto oferece ("cupom clipado").
function naPagina_cuponsDaPagina() {
  const caixa = document.querySelector(".ui-pdp-price__main-container")
             || document.querySelector("#price_container")
             || document.querySelector(".ui-pdp-container__row--price")
             || document.querySelector(".ui-pdp-price");
  const raiz = caixa?.closest(".ui-pdp-container__row, .ui-pdp-container") || caixa;
  const textos = [];
  const push = (el) => {
    const t = (el?.textContent || "").replace(/\s+/g, " ").trim();
    if (t && t.length <= 160) textos.push(t);
  };
  if (raiz) for (const el of raiz.querySelectorAll("*")) if (/cupom/i.test(el.textContent || "") && !el.children.length) push(el);
  for (const el of document.querySelectorAll("[class*='coupon' i], [class*='promotion' i]")) push(el);
  return textos;
}

// O formulário de compra da PDP. O "Comprar agora" é o submit de um <form
// method="get"> cheio de campo oculto cujo alvo mora no `formaction` do botão —
// montar a URL a partir daí é mais firme do que clicar por texto, e é o que revela
// o botão DESABILITADO (produto com variação não vende antes de alguém escolher).
function naPagina_formDeCompra() {
  const botao = Array.from(document.querySelectorAll("form button[formaction], form input[type='submit'][formaction]"))
    .find(b => /checkout\/buy|gz\/checkout/i.test(b.getAttribute("formaction") || ""));
  if (!botao) return null;
  const form = botao.closest("form");
  if (!form) return null;
  const campos = {};
  for (const el of form.querySelectorAll("input[type='hidden'][name]")) campos[el.name] = el.value;
  const bloqueado = !!form.querySelector("input[required][name='disabledform']")
                 || /--disabled/.test(botao.className)
                 || !!botao.disabled;
  return {
    action: botao.getAttribute("formaction"),
    method: (form.getAttribute("method") || "get").toLowerCase(),
    campos,
    bloqueado,
    texto: (botao.textContent || "").replace(/\s+/g, " ").trim(),
  };
}

function naPagina_escolherVariacao() {
  const caixa = document.querySelector(".ui-pdp-variations, [class*='variations']");
  if (!caixa) return null;
  const opcoes = Array.from(caixa.querySelectorAll("a, label, li, button"))
    .filter(el => el.offsetParent !== null)
    .filter(el => !/--disabled|--unavailable/.test(el.className || ""))
    .filter(el => el.getAttribute("aria-disabled") !== "true" && !el.disabled)
    .filter(el => !/^(sim|n[ãa]o)$/i.test((el.textContent || "").trim()));
  const alvo = opcoes.find(el => el.getAttribute("aria-checked") !== "true" && !/--selected/.test(el.className || "")) || opcoes[0];
  if (!alvo) return null;
  const texto = (alvo.getAttribute("aria-label") || alvo.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60);
  (alvo.closest("a, label, button, [role='button']") || alvo).click();
  return texto || "(sem nome)";
}

// O que esta tela tem de cupom — e são DUAS coisas diferentes. Um campo à mostra é
// resposta fechada; uma LINHA ("Cupons", "Inserir código do cupom") só abre popup
// na tela de pagamento. Juntar as duas num booleano era o bug do caminho antigo.
function naPagina_temCupom(source) {
  const rx = new RegExp(source, "i");
  const campo = Array.from(document.querySelectorAll("input")).some(el => {
    const pista = `${el.name || ""} ${el.id || ""} ${el.placeholder || ""} ${el.getAttribute("aria-label") || ""}`;
    return el.offsetParent !== null && /cupom|coupon|c[óo]digo de desconto/i.test(pista);
  });
  const linha = Array.from(document.querySelectorAll("button, [role='button'], a, label, span")).some(el => {
    const t = (el.textContent || "").replace(/\s+/g, " ").trim();
    return el.offsetParent !== null && t && t.length <= 60 && rx.test(t);
  });
  return { campo, linha };
}

// O rádio do ML é um <input> ESCONDIDO atrás do desenho do Andes: quem recebe o
// clique de verdade é o <label for="...">. Clicar no input marca a bolinha e não
// avisa o React — aí o "Continuar" vai sem forma de entrega e o checkout morre.
function naPagina_marcarPrimeiraOpcao() {
  const radios = Array.from(document.querySelectorAll("input[type='radio']")).filter(el => !el.disabled);
  if (!radios.length) return { needed: false, checked: true };
  if (radios.some(el => el.checked)) return { needed: true, checked: true };
  const alvo = radios[0];
  const label = (alvo.id && document.querySelector(`label[for="${CSS.escape(alvo.id)}"]`)) || alvo.closest("label");
  (label || alvo).click();
  return { needed: true, checked: Array.from(document.querySelectorAll("input[type='radio']")).some(el => el.checked) };
}

// Um popup à mostra. Na sonda, é isto que conta como "abriu": o popup dos cupons
// pode abrir com botões ("inserir outro", "ver ativos") e sem campo nenhum.
function naPagina_temPopup() {
  return Array.from(document.querySelectorAll("[role='dialog'], [aria-modal='true']"))
    .some(el => el.offsetParent !== null || el.getClientRects().length);
}

function naPagina_temCampoDeCupom() {
  const campos = Array.from(document.querySelectorAll("input"))
    .filter(el => el.offsetParent !== null && !el.disabled && el.type !== "hidden" && el.type !== "radio" && el.type !== "checkbox");
  const pista = (el) => `${el.name || ""} ${el.id || ""} ${el.placeholder || ""} ${el.getAttribute("aria-label") || ""}`;
  return !!(campos.find(el => /cupom|c[óo]digo|coupon|discount/i.test(pista(el))) || (campos.length === 1 ? campos[0] : null));
}

// Quem tem o texto costuma ser um <span> lá no fundo, que não escuta clique — o
// clique útil é o do ancestral. `nivel` diz quantos degraus subir.
export function naPagina_clicarLinhaDoCupom(source, nivel) {
  const rx = new RegExp(source, "i");
  const achados = Array.from(document.querySelectorAll("button, [role='button'], a, label, li, div, span"))
    .filter(el => el.offsetParent !== null)
    .map(el => ({ el, txt: (el.textContent || "").replace(/\s+/g, " ").trim() }))
    .filter(({ txt }) => txt && txt.length <= 80 && rx.test(txt));
  if (!achados.length) return null;
  const { el, txt } = achados[achados.length - 1];   // o mais interno
  let alvo = el.closest("button, [role='button'], a, label, li, [data-testid]") || el;
  for (let i = 0; i < nivel && alvo.parentElement; i++) alvo = alvo.parentElement;
  alvo.click();
  return { texto: txt, tag: alvo.tagName.toLowerCase() };
}

// O React do ML não enxerga `el.value = x`: o setter nativo + o evento é o que faz
// o botão "Aplicar" acompanhar o que foi digitado.
function naPagina_digitarCupom(valor) {
  const campos = Array.from(document.querySelectorAll("input"))
    .filter(el => el.offsetParent !== null && !el.disabled && el.type !== "hidden" && el.type !== "radio" && el.type !== "checkbox");
  const pista = (el) => `${el.name || ""} ${el.id || ""} ${el.placeholder || ""} ${el.getAttribute("aria-label") || ""}`;
  const alvo = campos.find(el => /cupom|c[óo]digo|coupon|discount/i.test(pista(el))) || (campos.length === 1 ? campos[0] : null);
  if (!alvo) return false;
  alvo.focus();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(alvo, valor);
  alvo.dispatchEvent(new Event("input", { bubbles: true }));
  alvo.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

// ── o comando ────────────────────────────────────────────────────────────

// A página onde a gente parou é mesmo a de um produto? Gêmeo do
// `ml-coupon.js:isProductPage`: link de perfil de afiliado leva pra vitrine do
// afiliado, cheia de cupons que não são deste produto.
export function ehPaginaDeProduto(finalUrl) {
  let u;
  try { u = new URL(String(finalUrl || "")); } catch { return false; }
  const caminho = decodeURIComponent(u.pathname);
  if (/^\/social\//i.test(caminho)) return false;
  return /\/p\/MLB\d+/i.test(caminho)
      || /\/up\/MLBU\d+/i.test(caminho)
      || /\/MLB-?\d{6,}/i.test(caminho)
      || /^produto\./i.test(u.hostname);
}

// Landing de afiliado (`/social/…`, onde desemboca o meli.la): o caminho até a
// PDP, do mesmo jeito que o repasse faz no servidor (scraping/scraper.js
// :clickGoToProductML e scraping/ml-social.js:parseSocialLanding).
//   1. o "Ir para o produto": se for link, devolve o href SEM clicar — o
//      target=_blank abriria outra aba, e o teste segue nesta;
//   2. sem botão (landing renderizada por JS), o estado embutido `_n.ctx.r`: o
//      produto compartilhado é o `card-featured` do primeiro nível. O carrossel
//      "quem viu também comprou" mora aninhado e é de OUTROS produtos — por isso
//      só vale exatamente um card, e ambiguidade é null.
export function naPagina_irParaProduto() {
  const RE = /ir\s+para\s+o?\s*produto|ver\s+produto/i;
  const el = Array.from(document.querySelectorAll("a, button")).find(e => RE.test((e.textContent || "").trim()));
  if (el) {
    const href = el.tagName === "A" ? el.href : null;
    if (href && /^https?:/i.test(href)) return { href, via: "botao" };
    el.click();
    return { clicou: true, via: "botao" };
  }

  const MARCA = "_n.ctx.r=";
  const script = Array.from(document.querySelectorAll("script")).find(s => (s.textContent || "").includes(MARCA));
  if (!script) return null;
  const texto = script.textContent;
  const inicio = texto.indexOf("{", texto.indexOf(MARCA) + MARCA.length);
  if (inicio < 0) return null;
  let fim = -1, prof = 0, emString = false, escapado = false;
  for (let i = inicio; i < texto.length; i++) {
    const c = texto[i];
    if (emString) {
      if (escapado) escapado = false;
      else if (c === "\\") escapado = true;
      else if (c === '"') emString = false;
      continue;
    }
    if (c === '"') emString = true;
    else if (c === "{") prof++;
    else if (c === "}" && --prof === 0) { fim = i; break; }
  }
  if (fim < 0) return null;
  let estado;
  try { estado = JSON.parse(texto.slice(inicio, fim + 1)); } catch { return null; }
  const componentes = estado?.appProps?.pageProps?.data?.components;
  const info = Array.isArray(componentes)
    ? componentes.find(c => c?.id === "card-featured")?.recommendation_data?.recommendation_info
    : null;
  const cards = Array.isArray(info?.polycards) ? info.polycards : [];
  if (cards.length !== 1) return null;
  const url = cards[0]?.metadata?.url;
  if (!url) return null;
  const href = /^https?:\/\//i.test(url) ? url : `${info.polycard_context?.url_prefix || "https://"}${url}`;
  return { href, via: "estado" };
}

// `rapido` e `semCarrinho` são do lote da sonda (frontend/src/data/sondaLote.js):
// o primeiro encerra assim que a página dos cupons foi lida, o segundo proíbe o
// plano B do carrinho — com várias abas ao mesmo tempo, o carrinho da conta é um
// só, e dois produtos nele dariam os cupons do carrinho COMBINADO.
export async function checkout({ url, code = null, mode = "checkout", rapido = false, semCarrinho = false, tempos = null }, progresso) {
  const T = lerTempos(tempos);
  const tabId = await abrir(url);
  const material = {
    t0: Date.now(),
    finalUrl: null, title: null, muro: null, motivo: null, notProductPage: false,
    clippedTexts: [], respostas: [],
    bodyTextAoEntrar: "", bodyTextAntes: "", bodyTextDepois: "",
    checkout: { attempted: false, reached: false, via: null, url: null, blockedReason: null, variacao: null,
      stepReached: false, steps: 0, trail: [], couponOpen: null, fieldFound: false, applied: false,
      botao: null, cartCleaned: null },
  };

  const foto = () => avaliar(tabId, naPagina_foto, [], { mundoDaPagina: true })
    .then(r => r || { url: "", titulo: "", tituloDaAba: "", texto: "", digital: "", respostas: [] });
  const clicar = (src, maxLen) => avaliar(tabId, naPagina_clicarPorTexto, [src, maxLen], { mundoDaPagina: true });

  try {
    // O espião entra antes de tudo: a resposta que dá o veredito é um XHR do
    // checkout, e o texto na tela é só o segundo palpite.
    await avaliar(tabId, naPagina_espiao, [API_RE], { mundoDaPagina: true });
    await sleep(T.settleMs);   // a PDP ainda pinta preço/promoção por JS

    let tela = await foto();
    material.finalUrl = tela.url;
    material.title = tela.tituloDaAba;

    // O muro. A extensão não contorna: traz a aba para a frente e espera o humano.
    const olharMuro = async () => {
      const t = await foto();
      return { muro: classificarMuro(t.url, t.texto, t.tituloDaAba) };
    };
    const muro = (await olharMuro()).muro;
    if (muro) {
      const resolvido = await esperarHumano(tabId, olharMuro, () => progresso({ tipo: "muro", muro }));
      if (!resolvido) {
        material.muro = muro;
        material.motivo = "o Mercado Livre pediu verificação e ela não foi resolvida";
        material.bodyTextDepois = tela.texto;
        return material;
      }
      tela = await foto();
      material.finalUrl = tela.url;
    }

    if (!ehPaginaDeProduto(tela.url)) {
      material.notProductPage = true;
      return material;
    }

    material.clippedTexts = await avaliar(tabId, naPagina_cuponsDaPagina, [], { mundoDaPagina: true }) || [];
    progresso({ tipo: "pdp", cupons: material.clippedTexts.length });
    // "listar" (a sonda da task 12) anda o mesmo caminho SEM código: a pergunta é
    // quais cupons o ML oferece sozinho para este carrinho.
    const listar = mode === "listar";
    material.listar = listar;
    if (!listar && (mode !== "checkout" || !code)) return material;

    // ── até o checkout ──────────────────────────────────────────────────
    material.checkout.attempted = true;
    const ida = await irAoCheckout(tabId, { foto, clicar, progresso, T, semCarrinho });
    Object.assign(material.checkout, ida);
    if (!ida.reached) {
      // Na sonda, a página onde a caminhada parou vai inteira pro servidor: é ela
      // que mostra o que o ML pôs no caminho (seguro, variação, aviso novo).
      if (listar) material.capturaNaParada = await avaliar(tabId, naPagina_capturaDosCupons, [500_000], { mundoDaPagina: true }).catch(() => null);
      return material;
    }

    material.bodyTextAoEntrar = (await foto()).texto;
    // O resumo do checkout ao chegar — o ML costuma já mostrar ali o cupom que ele
    // aplicou sozinho. Vale guardar mesmo que a caminhada até o popup não chegue.
    // No lote (`rapido`) ela não serve: o `materialEnxuto` a descarta antes de mandar.
    if (listar && !rapido) material.capturaAoEntrar = await avaliar(tabId, naPagina_capturaDosCupons, [300_000], { mundoDaPagina: true });

    // ── a página dos cupons, sem clique nenhum ──────────────────────────
    // O caminho curto e o que sempre responde: a mesma página que o popup abriria,
    // buscada direto da aba. O clique continua depois, porque o popup aberto é a
    // única forma de ver a lista "ativos" — mas ele já não é o único caminho.
    if (listar) {
      const endereco = await avaliar(tabId, naPagina_paginaDosCupons, [], { mundoDaPagina: true });
      material.paginaDosCupons = endereco
        ? await avaliar(tabId, naPagina_buscarPagina, [endereco, 500_000], { mundoDaPagina: true }).catch(() => null)
        : null;
      progresso({ tipo: "pagina-cupons", ok: !!material.paginaDosCupons?.ok });
      // O lote para aqui quando a página trouxe o modelo dos cupons — o mesmo
      // `buyingFlowData` que o servidor exige (coupons/checkout-list.js). A caminhada
      // até o popup, a espera do iframe e a lista dos "ativos" leem a MESMA página;
      // no lote eram só segundos a mais por produto. Sem o modelo, segue o caminho
      // longo como sempre.
      if (rapido && material.paginaDosCupons?.ok && /buyingFlowData/.test(material.paginaDosCupons.html || "")) {
        material.checkout.atalho = "pagina-dos-cupons";
        progresso({ tipo: "capturado" });
        return material;
      }
    }

    // ── caminhando até a tela do cupom ──────────────────────────────────
    const caminho = await andarAteOCupom(tabId, { foto, clicar, progresso, material, T });
    material.checkout.steps = caminho.steps;
    material.checkout.trail = caminho.trail;
    material.checkout.couponOpen = caminho.abertura || null;
    material.checkout.stepReached = !!caminho.abertura;
    // A caminhada não ter chegado no popup só encerra a sonda se a busca direta
    // também não trouxe nada — senão a resposta já está na mão.
    const temPagina = !!(material.paginaDosCupons?.ok && material.paginaDosCupons?.html);
    if (!caminho.reached && !(listar && temPagina)) return material;

    // ── a sonda: a tela dos cupons, crua, e mais nada ───────────────────
    // Nunca digita, nunca clica em cupom: só olha. O carrinho é limpo no finally.
    if (listar && caminho.reached) {
      // O conteúdo do popup é um iframe que carrega depois: espera ele ter texto.
      for (let i = 0; i < Math.ceil(T.esperaIframeMs / 500); i++) {
        if (await avaliar(tabId, naPagina_textoDoIframeDoPopup, [], { mundoDaPagina: true }) > 20) break;
        await sleep(500);
      }
      await avaliar(tabId, naPagina_espiaoNoIframe, [API_RE], { mundoDaPagina: true });
      await sleep(T.settleMs);
      material.capturaDosCupons = await avaliar(tabId, naPagina_capturaDosCupons, [400_000], { mundoDaPagina: true });
      // O popup oferece "inserir outro cupom" OU ver os ativos. A lista dos ativos é
      // a que diz QUAL cupom está em uso — só olhar, nenhum cupom é clicado.
      const verAtivos = await avaliar(tabId, naPagina_clicarNoPopup, [VER_ATIVOS_SRC, 40], { mundoDaPagina: true });
      material.checkout.verAtivos = verAtivos || null;
      if (verAtivos) {
        await sleep(T.settleMs * 2);
        material.capturaDosAtivos = await avaliar(tabId, naPagina_capturaDosCupons, [600_000], { mundoDaPagina: true });
      }
    }
    if (listar) {
      progresso({ tipo: "capturado" });
      return material;
    }

    // ── digitar e aplicar ───────────────────────────────────────────────
    if (!await avaliar(tabId, naPagina_digitarCupom, [code], { mundoDaPagina: true })) return material;
    material.checkout.fieldFound = true;

    let botao = await clicar(COUPON_APPLY_SRC, 30);
    if (!botao) botao = await clicar(COUPON_APPLY_FALLBACK_SRC, 30);
    material.checkout.botao = botao;
    material.checkout.applied = true;
    progresso({ tipo: "aplicado", code });
    await sleep(APPLY_WAIT_MS);

    // O total DEPOIS tem que ser lido na mesma tela do ANTES. A tela de digitar o
    // código costuma não ter total nenhum: depois de aplicar, o ML volta pro
    // resumo. Esperar o número voltar é o que salva a única prova forte do veredito.
    let depois = await foto();
    for (let i = 0; i < Math.ceil(TOTAL_WAIT_MS / 1000) && !/R\$/.test(depois.texto); i++) {
      await sleep(1000);
      depois = await foto();
    }
    material.bodyTextDepois = depois.texto;
    material.finalUrl = depois.url;
    material.respostas = depois.respostas || [];
    return material;
  } finally {
    // O carrinho da conta não pode ficar sujo por causa de um teste.
    if (material.checkout.via === "carrinho") {
      material.checkout.cartCleaned = await limparCarrinho(tabId, clicar, T).catch(() => false);
    }
    await fechar(tabId);
  }
}

// O comando da SONDA: quais cupons o ML oferece para ESTE produto no checkout.
// Comando próprio (e não só um `mode`) para a tela saber se a extensão instalada
// é nova o bastante — versão velha ignoraria o modo e voltaria da página do
// produto sem dizer nada.
export async function cuponsNoCheckout({ url, rapido = false, semCarrinho = false, tempos = null }, progresso) {
  return checkout({ url, mode: "listar", rapido, semCarrinho, tempos }, progresso);
}

// Chegar = a URL virar de checkout E a tela terminar de montar. Só a URL não vale:
// o interstitial ("Preparando tudo para sua compra") já tem a URL certa.
async function esperarCheckoutPronto(foto, ms = CHECKOUT_READY_WAIT_MS) {
  // Olha já na entrada e depois a cada meio segundo: a tela costuma estar pronta
  // antes do primeiro segundo, e esperar ele inteiro era tempo morto em toda sonda.
  for (let i = 0; i <= Math.ceil(ms / 500); i++) {
    if (i > 0) await sleep(500);
    const t = await foto();
    if (!CHECKOUT_URL_RE.test(t.url)) return { ready: false, tela: t };
    if (CHECKOUT_LOADING_RE.test(t.texto)) continue;
    if (CHECKOUT_READY_RE.test(t.texto)) return { ready: true, tela: t };
  }
  return { ready: false, tela: await foto() };
}

// Da PDP até a tela de checkout. Ordem: o formulário de compra (firme), depois o
// clique em "Comprar agora" e, por último, o carrinho — que é o único caminho que
// deixa rastro na conta, e por isso vem depois e obriga a limpeza no fim.
export async function irAoCheckout(tabId, { foto, clicar, progresso, T = TEMPOS_PADRAO, semCarrinho = false }) {
  let seguro = null;
  let tentouSeguro = false;
  const esperarSaida = async () => {
    for (let i = 0; i < Math.ceil(T.esperaNavMs / 500); i++) {
      await sleep(500);
      const agora = (await foto()).url;
      // A oferta de seguro no meio do caminho: recusa e segue. Vem ANTES do teste do
      // checkout porque o caminho real (sonda de 19/09) é checkout → seguro →
      // checkout: o ML passa primeiro por uma URL de checkout e só então redireciona
      // pro seguro. Olhando o checkout primeiro, a espera dele via a URL virar
      // `/protections/` e desistia — e o "Agora não" nunca era tentado.
      if (PROTECTIONS_URL_RE.test(agora)) {
        if (!tentouSeguro) {
          tentouSeguro = true;
          seguro = await recusarSeguro(tabId, { foto, url: agora, T });
          progresso({ tipo: "seguro", como: seguro.como });
          await avaliar(tabId, naPagina_espiao, [API_RE], { mundoDaPagina: true }).catch(() => {});
        }
        continue;
      }
      if (CHECKOUT_URL_RE.test(agora)) {
        const r = await esperarCheckoutPronto(foto, T.esperaCheckoutMs);
        if (r.ready) return true;
        // Saiu do checkout pro seguro: a volta do laço trata.
        if (PROTECTIONS_URL_RE.test(r.tela?.url || "")) continue;
        return false;
      }
    }
    return false;
  };

  let form = await avaliar(tabId, naPagina_formDeCompra, [], { mundoDaPagina: true });
  let variacao = null;

  // Botão desabilitado costuma querer dizer "escolha a variação primeiro". Uma
  // tentativa só: escolher variação muda o produto que está sendo testado, então
  // isso é um plano B honesto e o resultado avisa qual foi escolhida.
  if (form?.bloqueado) {
    variacao = await avaliar(tabId, naPagina_escolherVariacao, [], { mundoDaPagina: true });
    if (variacao) {
      await sleep(T.settleMs * 2);
      form = await avaliar(tabId, naPagina_formDeCompra, [], { mundoDaPagina: true });
    }
  }

  const url = async () => (await foto()).url;
  if (form?.bloqueado) {
    return { reached: false, via: null, url: await url(), variacao,
      blockedReason: form.texto || "O botão de compra está desabilitado nesta página." };
  }

  if (form?.action && form.method === "get") {
    const alvo = new URL(form.action);
    for (const [k, v] of Object.entries(form.campos)) alvo.searchParams.set(k, v);
    progresso({ tipo: "checkout", via: "form-compra" });
    await irPara(tabId, alvo.href).catch(() => {});
    await avaliar(tabId, naPagina_espiao, [API_RE], { mundoDaPagina: true });
    if (await esperarSaida()) return { reached: true, via: "form-compra", url: await url(), blockedReason: null, variacao, seguro };
  }

  if (await clicar(BUY_NOW_SRC, 60)) {
    progresso({ tipo: "checkout", via: "comprar-agora" });
    if (await esperarSaida()) return { reached: true, via: "comprar-agora", url: await url(), blockedReason: null, variacao, seguro };
  }

  if (semCarrinho) {
    return { reached: false, via: null, url: await url(), variacao, seguro,
      blockedReason: "Não chegou ao checkout sem passar pelo carrinho (desligado com abas em paralelo)." };
  }

  if (await clicar(ADD_TO_CART_SRC, 60)) {
    progresso({ tipo: "checkout", via: "carrinho" });
    await sleep(T.settleMs);
    if (!CHECKOUT_URL_RE.test(await url())) await irPara(tabId, CART_URL).catch(() => {});
    await avaliar(tabId, naPagina_espiao, [API_RE], { mundoDaPagina: true });
    await clicar(CONTINUE_SRC, 60);
    const chegou = await esperarSaida();
    return { reached: chegou, via: "carrinho", url: await url(), blockedReason: null, variacao, seguro };
  }

  return { reached: false, via: null, url: await url(), blockedReason: null, variacao, seguro };
}

// Recusa a oferta de seguro: clica em "Agora não"; se o botão não aparecer ou o
// clique não tirar a aba de lá, vai direto pro `callback_url` — que é para onde o
// próprio "Agora não" levaria. Devolve como saiu ("recusou" | "callback" | null).
async function recusarSeguro(tabId, { foto, url, T = TEMPOS_PADRAO }) {
  const diag = { tentativas: 0, clicou: null, rotulos: null, callback: false, voltouProSeguro: false };
  for (let i = 0; i < Math.ceil(SEGURO_WAIT_MS / 500); i++) {
    diag.tentativas += 1;
    const r = await avaliar(tabId, naPagina_recusarSeguro, [RECUSAR_SEGURO_SRC], { mundoDaPagina: true }) || {};
    if (r.clicou) {
      diag.clicou = r.clicou;
      for (let j = 0; j < Math.ceil(SEGURO_WAIT_MS / 500); j++) {
        await sleep(500);
        if (!PROTECTIONS_URL_RE.test((await foto()).url)) return { como: "recusou", ...diag };
      }
      break;
    }
    diag.rotulos = r.rotulos || null;
    await sleep(500);
  }
  let volta = null;
  try { volta = new URL(url).searchParams.get("callback_url"); } catch { volta = null; }
  if (volta && /^https:\/\/www\.mercadolivre\.com\.br\//.test(volta)) {
    diag.callback = true;
    await irPara(tabId, volta).catch(() => {});
    await sleep(T.settleMs * 2);
    // O ML pode mandar de volta pro seguro até alguém escolher — aí o plano B não
    // serve, e o diagnóstico precisa dizer isso.
    diag.voltouProSeguro = PROTECTIONS_URL_RE.test((await foto()).url);
    return { como: diag.voltouProSeguro ? null : "callback", ...diag };
  }
  return { como: null, ...diag };
}

// Caminha pelo checkout até a tela que tem cupom. Só clica em "Continuar" (regex
// ancorada) — nunca em pagar/confirmar —, então o pior caso é parar antes da hora.
async function andarAteOCupom(tabId, { foto, clicar, progresso, material, T = TEMPOS_PADRAO }) {
  const trail = [];
  let passos = 0;
  let motivo = "limite-de-passos";
  let jaRecarregou = false;
  let abertura = null;

  for (; passos < MAX_CHECKOUT_STEPS; passos++) {
    const tela = await foto();
    const passo = { passo: passos + 1, url: tela.url, titulo: tela.titulo, escolha: null, clicou: null, mudou: null, erro: null, parou: null };
    trail.push(passo);
    progresso({ tipo: "passo", passo: passos + 1, titulo: tela.titulo });

    const entrada = await avaliar(tabId, naPagina_temCupom, [COUPON_OPEN_SRC], { mundoDaPagina: true }) || { campo: false, linha: false };
    // Um campo à mostra é resposta fechada. Já a LINHA do resumo só vale na tela de
    // pagamento: nas de entrega ela está lá o tempo todo e não abre nada.
    const naTelaDePagamento = PAYMENT_STEP_RE.test(tela.titulo || "") || PAYMENT_STEP_RE.test(tela.texto || "");
    if (entrada.campo || (entrada.linha && naTelaDePagamento)) {
      passo.cupom = entrada.campo ? "campo" : "linha";
      // O total ANTES é lido AQUI, no último instante antes de o popup do cupom
      // cobrir a tela: o "antes" e o "depois" têm que ser da MESMA tela, senão a
      // diferença é de frete e viraria "cupom válido" sem cupom nenhum.
      material.bodyTextAntes = tela.texto;
      abertura = await abrirCampoDoCupom(tabId, { foto, aceitarPopup: !!material.listar });
      if (abertura.found) {
        passo.parou = "achei-o-cupom";
        return { reached: true, steps: passos, trail, motivo: "achei-o-cupom", abertura };
      }
      // Não abriu. Segue o checkout: o cupom pode aparecer um passo à frente.
      passo.parou = motivo = "cupom-nao-abriu";
    }

    // O checkout do ML caiu. Ele mesmo pede "tente novamente", e recarregar
    // costuma trazer a tela de volta — vale uma vez.
    const caiu = CHECKOUT_ERROR_RE.test(tela.texto || "") || CHECKOUT_ERROR_TITLE_RE.test(tela.titulo || "");
    if (caiu) {
      passo.erro = (String(tela.texto || "").match(CHECKOUT_ERROR_CODE_RE) || ["sem código"])[0];
      if (jaRecarregou) { passo.parou = motivo = "checkout-quebrou"; break; }
      jaRecarregou = true;
      passo.parou = "recarreguei";
      await irPara(tabId, tela.url).catch(() => {});
      await avaliar(tabId, naPagina_espiao, [API_RE], { mundoDaPagina: true });
      await esperarCheckoutPronto(foto, T.esperaCheckoutMs);
      continue;
    }

    const opcao = await avaliar(tabId, naPagina_marcarPrimeiraOpcao, [], { mundoDaPagina: true }) || { needed: false, checked: true };
    passo.escolha = !opcao.needed ? "nada a escolher" : (opcao.checked ? "opção marcada" : "não consegui marcar");
    await sleep(700);
    // Sem escolher a opção do passo, "Continuar" derruba o checkout. Parar aqui é
    // um resultado honesto; quebrar a tela e reportar "indeterminado" não é.
    if (!opcao.checked) { passo.parou = motivo = "opcao-nao-marcada"; break; }

    // Deixar a tela assentar antes de clicar: marcar a entrega dispara recálculo de
    // frete, e "Continuar" no meio disso derruba o checkout do ML.
    await esperarQuieto(foto);

    let clicou = null;
    let mudou = false;
    for (let tentativa = 0; tentativa < 2 && !mudou; tentativa++) {
      const antes = (await foto()).digital;
      clicou = await clicar(CONTINUE_STEP_SRC, 30);
      if (!clicou) { await sleep(T.settleMs); continue; }   // botão ainda montando
      mudou = await esperarTelaMudar(foto, antes);
    }
    passo.clicou = clicou;
    passo.mudou = clicou ? mudou : null;
    if (!clicou) { passo.parou = motivo = "sem-botao-continuar"; break; }
    if (!mudou) { passo.parou = motivo = "tela-nao-mudou"; break; }

    await esperarCheckoutPronto(foto, T.esperaCheckoutMs);
  }

  // Se em alguma tela a linha do cupom foi clicada e o campo não abriu, é ISSO que
  // explica o fim da caminhada — mesmo que ela tenha morrido depois num "sem botão
  // Continuar" (na tela de pagamento não existe "Continuar", só "Pagar", e a
  // ferramenta nunca encosta nele).
  return { reached: false, steps: passos, trail, motivo: abertura && !abertura.found ? "cupom-nao-abriu" : motivo, abertura };
}

// Abre a tela/campo do cupom e espera ela montar.
async function abrirCampoDoCupom(tabId, { foto, aceitarPopup = false }) {
  const tentativas = [];
  const temCampo = async () => (await avaliar(tabId, naPagina_temCampoDeCupom, [], { mundoDaPagina: true }))
    || (aceitarPopup && await avaliar(tabId, naPagina_temPopup, [], { mundoDaPagina: true }));

  for (let nivel = 0; nivel <= 3; nivel++) {
    if (await temCampo()) {
      const t = await foto();
      return { found: true, tentativas, url: t.url, titulo: t.titulo };
    }
    const clicou = await avaliar(tabId, naPagina_clicarLinhaDoCupom, [COUPON_OPEN_SRC, nivel], { mundoDaPagina: true });
    tentativas.push({ nivel, clicou: clicou?.texto || null, tag: clicou?.tag || null });
    if (!clicou) break;

    // A linha do cupom navega pra outro passo do checkout: 1,5s não bastava.
    for (let i = 0; i < Math.ceil(COUPON_OPEN_WAIT_MS / 500); i++) {
      await sleep(500);
      if (await temCampo()) {
        const t = await foto();
        return { found: true, tentativas, url: t.url, titulo: t.titulo };
      }
    }
  }
  const t = await foto();
  return { found: false, tentativas, url: t.url, titulo: t.titulo };
}

async function esperarTelaMudar(foto, antes, ms = STEP_CHANGE_WAIT_MS) {
  for (let i = 0; i < Math.ceil(ms / 500); i++) {
    await sleep(500);
    const agora = (await foto()).digital;
    if (agora && antes && agora !== antes) return true;
  }
  return false;
}

async function esperarQuieto(foto, ms = QUIET_WAIT_MS) {
  let anterior = (await foto()).digital;
  let iguais = 0;
  for (let i = 0; i < Math.ceil(ms / 500); i++) {
    await sleep(500);
    const agora = (await foto()).digital;
    iguais = agora && agora === anterior ? iguais + 1 : 0;
    anterior = agora;
    if (iguais >= 2) return true;   // 1s parada já basta
  }
  return false;
}

// Tira o item do carrinho — só faz sentido quando o plano B foi usado. Falhar aqui
// não pode derrubar o teste, mas deixar lixo no carrinho da conta também não é
// aceitável, então tenta sempre.
async function limparCarrinho(tabId, clicar, T = TEMPOS_PADRAO) {
  try {
    await irPara(tabId, CART_URL);
    await sleep(T.settleMs);
    const removeu = await clicar(CART_REMOVE_SRC, 30);
    await sleep(T.settleMs);
    return !!removeu;
  } catch {
    return false;
  }
}
