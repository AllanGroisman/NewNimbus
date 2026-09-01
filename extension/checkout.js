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
const COUPON_OPEN_SRC = "(inserir|adicionar|usar|tenho|aplicar).{0,12}(cupom|cupons|c[óo]digo)|c[óo]digos? de desconto|cupom de desconto|cupons de desconto|^cupons?$";
const API_RE = "(coupon|cupon|discount|promotion|promocao|promo)";
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

// ── o que roda DENTRO da página ──────────────────────────────────────────
// Todas serializadas pelo executeScript: auto-contidas, sem fechar sobre nada.

function naPagina_espiao(apiRe) {
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

function naPagina_foto() {
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

function naPagina_clicarPorTexto(padrao, maxLen) {
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

function naPagina_temCampoDeCupom() {
  const campos = Array.from(document.querySelectorAll("input"))
    .filter(el => el.offsetParent !== null && !el.disabled && el.type !== "hidden" && el.type !== "radio" && el.type !== "checkbox");
  const pista = (el) => `${el.name || ""} ${el.id || ""} ${el.placeholder || ""} ${el.getAttribute("aria-label") || ""}`;
  return !!(campos.find(el => /cupom|c[óo]digo|coupon|discount/i.test(pista(el))) || (campos.length === 1 ? campos[0] : null));
}

// Quem tem o texto costuma ser um <span> lá no fundo, que não escuta clique — o
// clique útil é o do ancestral. `nivel` diz quantos degraus subir.
function naPagina_clicarLinhaDoCupom(source, nivel) {
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
function ehPaginaDeProduto(finalUrl) {
  let u;
  try { u = new URL(String(finalUrl || "")); } catch { return false; }
  const caminho = decodeURIComponent(u.pathname);
  if (/^\/social\//i.test(caminho)) return false;
  return /\/p\/MLB\d+/i.test(caminho)
      || /\/up\/MLBU\d+/i.test(caminho)
      || /\/MLB-?\d{6,}/i.test(caminho)
      || /^produto\./i.test(u.hostname);
}

export async function checkout({ url, code = null, mode = "checkout" }, progresso) {
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
    await sleep(SETTLE_MS);   // a PDP ainda pinta preço/promoção por JS

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
    if (mode !== "checkout" || !code) return material;

    // ── até o checkout ──────────────────────────────────────────────────
    material.checkout.attempted = true;
    const ida = await irAoCheckout(tabId, { foto, clicar, progresso });
    Object.assign(material.checkout, ida);
    if (!ida.reached) return material;

    material.bodyTextAoEntrar = (await foto()).texto;

    // ── caminhando até a tela do cupom ──────────────────────────────────
    const caminho = await andarAteOCupom(tabId, { foto, clicar, progresso, material });
    material.checkout.steps = caminho.steps;
    material.checkout.trail = caminho.trail;
    material.checkout.couponOpen = caminho.abertura || null;
    material.checkout.stepReached = !!caminho.abertura;
    if (!caminho.reached) return material;

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
      material.checkout.cartCleaned = await limparCarrinho(tabId, clicar).catch(() => false);
    }
    await fechar(tabId);
  }
}

// Chegar = a URL virar de checkout E a tela terminar de montar. Só a URL não vale:
// o interstitial ("Preparando tudo para sua compra") já tem a URL certa.
async function esperarCheckoutPronto(foto) {
  for (let i = 0; i < Math.ceil(CHECKOUT_READY_WAIT_MS / 1000); i++) {
    await sleep(1000);
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
async function irAoCheckout(tabId, { foto, clicar, progresso }) {
  const esperarSaida = async () => {
    for (let i = 0; i < Math.ceil(NAV_WAIT_MS / 500); i++) {
      await sleep(500);
      if (CHECKOUT_URL_RE.test((await foto()).url)) return (await esperarCheckoutPronto(foto)).ready;
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
      await sleep(SETTLE_MS * 2);
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
    if (await esperarSaida()) return { reached: true, via: "form-compra", url: await url(), blockedReason: null, variacao };
  }

  if (await clicar(BUY_NOW_SRC, 60)) {
    progresso({ tipo: "checkout", via: "comprar-agora" });
    if (await esperarSaida()) return { reached: true, via: "comprar-agora", url: await url(), blockedReason: null, variacao };
  }

  if (await clicar(ADD_TO_CART_SRC, 60)) {
    progresso({ tipo: "checkout", via: "carrinho" });
    await sleep(SETTLE_MS);
    if (!CHECKOUT_URL_RE.test(await url())) await irPara(tabId, CART_URL).catch(() => {});
    await avaliar(tabId, naPagina_espiao, [API_RE], { mundoDaPagina: true });
    await clicar(CONTINUE_SRC, 60);
    const chegou = await esperarSaida();
    return { reached: chegou, via: "carrinho", url: await url(), blockedReason: null, variacao };
  }

  return { reached: false, via: null, url: await url(), blockedReason: null, variacao };
}

// Caminha pelo checkout até a tela que tem cupom. Só clica em "Continuar" (regex
// ancorada) — nunca em pagar/confirmar —, então o pior caso é parar antes da hora.
async function andarAteOCupom(tabId, { foto, clicar, progresso, material }) {
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
      abertura = await abrirCampoDoCupom(tabId, { foto });
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
      await esperarCheckoutPronto(foto);
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
      if (!clicou) { await sleep(SETTLE_MS); continue; }   // botão ainda montando
      mudou = await esperarTelaMudar(foto, antes);
    }
    passo.clicou = clicou;
    passo.mudou = clicou ? mudou : null;
    if (!clicou) { passo.parou = motivo = "sem-botao-continuar"; break; }
    if (!mudou) { passo.parou = motivo = "tela-nao-mudou"; break; }

    await esperarCheckoutPronto(foto);
  }

  // Se em alguma tela a linha do cupom foi clicada e o campo não abriu, é ISSO que
  // explica o fim da caminhada — mesmo que ela tenha morrido depois num "sem botão
  // Continuar" (na tela de pagamento não existe "Continuar", só "Pagar", e a
  // ferramenta nunca encosta nele).
  return { reached: false, steps: passos, trail, motivo: abertura && !abertura.found ? "cupom-nao-abriu" : motivo, abertura };
}

// Abre a tela/campo do cupom e espera ela montar.
async function abrirCampoDoCupom(tabId, { foto }) {
  const tentativas = [];
  const temCampo = () => avaliar(tabId, naPagina_temCampoDeCupom, [], { mundoDaPagina: true });

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
async function limparCarrinho(tabId, clicar) {
  try {
    await irPara(tabId, CART_URL);
    await sleep(SETTLE_MS);
    const removeu = await clicar(CART_REMOVE_SRC, 30);
    await sleep(SETTLE_MS);
    return !!removeu;
  } catch {
    return false;
  }
}
