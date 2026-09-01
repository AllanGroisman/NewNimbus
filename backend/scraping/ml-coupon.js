// Testar um cupom num produto do Mercado Livre.
//
// Existem DOIS cupons diferentes e a ferramenta responde pelos dois:
//
//   1. O que a loja oferece na própria página ("cupom clipado"): aparece na PDP,
//      dá pra ler sem sair do lugar. É o que o scraping hoje joga fora de
//      propósito (scraper.js: o "10% com cupom" não pode virar o desconto do item).
//   2. O CÓDIGO que veio escrito na legenda do grupo líder (repasse/capture.js).
//      Esse não existe em lugar nenhum da página — a única forma de saber se ele
//      vale pra aquele produto é levar o item ao CHECKOUT e aplicar o código lá,
//      lendo o que o ML responde.
//
// O caminho é o mesmo do Hub de Afiliados: Chrome de verdade + o cookie da conta
// do sistema (ml-session-page.js). O checkout é uma SPA, então o veredito bom vem
// da resposta JSON que a página busca ao aplicar o cupom — o texto na tela é o
// segundo palpite, não o primeiro.
//
// NUNCA finaliza compra: o fluxo para na tela de pagamento, o navegador é sempre
// fechado no finally e, se o caminho tiver passado pelo carrinho, o item é tirado
// de lá na saída.
const fs = require("fs");
const path = require("path");
const { withMLSessionPage, snapshotPage, classifyMLWall, clickByPattern } = require("./ml-session-page");
const { detectBlockPage } = require("./scraper");
const urlGuard = require("./urlGuard");
const appConfig = require("../config");

const HISTORY_KEY = "ml-coupon-history";
const HISTORY_MAX = 20;
// Onde ficam os prints de cada teste. Todo teste do admin grava — é a única
// forma de ver a tela que o robô viu sem ficar rodando o dump à mão depois que
// já deu errado. Guarda poucas rodadas: cada uma tem ~8 prints de página cheia.
const SHOTS_DIR = path.join(__dirname, "..", "logs", "ml-coupon");
const SHOTS_KEEP = 5;
const MAX_BODY_CHARS = 200 * 1024;    // corpo de XHR guardado no dump
const CODE_MAX = 40;                  // mesmo teto do normalizeCoupon do server.js

// Quanto esperar em cada etapa. O checkout do ML é lento e carrega em ondas.
const NAV_WAIT_MS = 20000;
const APPLY_WAIT_MS = 6000;
const SETTLE_MS = 1500;
// A linha do cupom leva pra OUTRO passo do checkout, não abre um campo ali mesmo:
// os 1,5s de antes fotografavam a tela velha e diziam "não achei o campo".
const COUPON_OPEN_WAIT_MS = 12000;
const TOTAL_WAIT_MS = 10000;      // depois de aplicar, esperar o resumo com o total voltar
// Quanto esperar a tela do checkout virar outra depois do "Continuar". O ML
// repinta em ondas: menos que isso e a sonda desiste no meio da troca.
const STEP_CHANGE_WAIT_MS = 15000;
// Quanto esperar a tela parar de se mexer ANTES de clicar em "Continuar".
const QUIET_WAIT_MS = 8000;

// A URL do checkout/carrinho muda de forma com o tempo; o que se mantém é o
// pedaço do caminho. Serve pra saber se saímos da PDP e chegamos onde queríamos.
const CHECKOUT_URL_RE = /\/(checkout|gz\/checkout|cart|carrinho)\b/i;

// O /gz/checkout/buy não é a tela de compra: é um interstitial ("Preparando tudo
// para sua compra") que monta o pedido e só então leva pro checkout de verdade.
// Bater o olho na URL não basta — a primeira sonda parou aqui, achando que tinha
// chegado, e fotografou uma tela de carregamento.
const CHECKOUT_LOADING_RE = /preparando tudo|estamos preparando|aguarde um instante|carregando/i;
// A tela de erro do próprio checkout do ML ("Ocorreu um problema / tente
// novamente", com um código tipo CHS37-XXXX). Não é falta de botão nem cupom
// inválido: é o checkout deles caindo no meio do caminho.
const CHECKOUT_ERROR_RE = /(ocorreu um problema|algo deu errado|tivemos um problema)[\s\S]{0,140}?(tente novamente|estamos trabalhando)/i;
const CHECKOUT_ERROR_CODE_RE = /\b[A-Z]{2,6}\d{0,3}-[A-Z0-9]{6,}\b/;
const CHECKOUT_READY_RE = /forma de pagamento|como (voc[êe] )?quer pagar|resumo da compra|revise (sua|a) compra|finalizar compra|meios de pagamento|endere[çc]o de entrega/i;
const CHECKOUT_READY_WAIT_MS = 30000;
// A tela de PAGAMENTO, e só ela. Mais estreita que a CHECKOUT_READY_RE de
// propósito: aquela reconhece "resumo da compra" e "endereço de entrega", que
// aparecem desde o primeiro passo. Esta é o que separa "o checkout montou" de
// "cheguei onde o cupom existe" — e essa diferença era o bug: o "Resumo da
// compra" mostra a linha "Cupons" desde a tela de entrega, mas ali ela não abre
// popup nenhum, e a automação parava três telas antes da certa.
const PAYMENT_STEP_RE = /forma de pagamento|formas de pagamento|como (voc[êe] )?quer pagar|escolha como pagar|meios de pagamento|escolha o meio de pagamento/i;

// Respostas que interessam guardar: as que falam de cupom/desconto. Vale como
// filtro largo de propósito — o nome exato da API só se descobre olhando o dump.
const COUPON_API_RE = /(coupon|cupon|discount|promotion|promocao|promo)/i;

// Textos de botão/link do fluxo. Regex (e não texto exato) porque o ML alterna
// entre "Comprar agora" e "Comprar agora com 1 clique", e o link do cupom já foi
// "Inserir código", "Adicionar cupom" e "Cupom de desconto" em versões diferentes.
const BUY_NOW_RE = /^comprar agora/i;
const ADD_TO_CART_RE = /^adicionar ao carrinho$/i;
const CONTINUE_RE = /^continuar( compra)?$/i;
// Avançar os passos do checkout. ANCORADO de propósito: é o que garante que a
// automação nunca encoste em "Pagar", "Comprar" ou "Confirmar compra". O checkout
// é entrega → pagamento → revisão, e o campo de cupom só aparece lá na frente.
//
// "Continuar COMPRANDO" está fora de propósito: esse é o link de voltar pra loja,
// e clicar nele joga a automação pra fora do checkout gastando um passo à toa.
const CONTINUE_STEP_RE = /^continuar( compra| para .{0,30})?$/i;
// Com o cupom só valendo na tela de pagamento (ver PAYMENT_STEP_RE), a caminhada
// ficou mais longa por desenho: 6 já estourava antes, sem nem chegar lá.
const MAX_CHECKOUT_STEPS = 10;
// Inclui o plural de propósito: na tela "Escolha como pagar" a linha aparece como
// "Cupons de desconto", e o singular sozinho passava batido.
const COUPON_OPEN_RE = /(inserir|adicionar|usar|tenho|aplicar).{0,12}(cupom|cupons|c[óo]digo)|c[óo]digos? de desconto|cupom de desconto|cupons de desconto|^cupons?$/i;
// O botão que confirma o código dentro do popup do cupom. "Inserir" entra aqui
// porque é assim que o ML chama o botão de confirmar — e a âncora ^...$ é o que
// impede de confundir com a LINHA "Inserir código do cupom", que só abre o popup.
const COUPON_APPLY_RE = /^(aplicar|adicionar|inserir|usar|confirmar)( cupom| c[óo]digo)?$/i;
// Alguns layouts fecham o cupom com "Continuar" em vez de "Adicionar". Só é usado
// como último recurso, e só depois de o código já estar digitado no campo — nunca
// como forma de avançar o checkout.
const COUPON_APPLY_FALLBACK_RE = /^continuar$/i;
const CART_REMOVE_RE = /^(excluir|remover|tirar)$/i;

// ────────────────────────────────────────────────────────────────────────
// Parte pura — é o que os testes cobrem, sem navegador
// ────────────────────────────────────────────────────────────────────────

// 1234.56 → "R$ 1.234,56". O caminho de volta do parseMoney, pra escrever valor
// em português nas mensagens e no relatório da tela.
function formatMoney(v) {
  if (!Number.isFinite(v)) return "—";
  return `R$ ${v.toFixed(2).replace(".", ",").replace(/\B(?=(\d{3})+(?!\d),)/g, ".")}`;
}

// "R$ 1.234,56" → 1234.56. Mesmo formato que o scraper já lê na PDP; aqui mora
// no Node porque quem vasculha a página devolve TEXTO CRU e quem interpreta é
// este lado (mesma divisão de nota/vendas no scraper.js).
function parseMoney(s) {
  if (!s) return null;
  const m = String(s).replace(/\s+/g, "").match(/R\$([\d.]+)(?:,(\d{1,2}))?/i);
  if (!m) return null;
  const v = parseFloat(`${m[1].replace(/\./g, "")}.${m[2] || "00"}`);
  return Number.isFinite(v) ? v : null;
}

// Normaliza o código como o resto do sistema já faz (server.js:normalizeCoupon).
function normalizeCode(v) {
  const s = String(v ?? "").trim().toUpperCase();
  return s ? s.slice(0, CODE_MAX) : null;
}

// Total do pedido a partir do texto da tela de checkout. Pega a ÚLTIMA ocorrência
// de propósito: a tela lista "Produto R$ X", "Frete R$ Y" e só então o total, e
// aparecer por último é a única regra que se manteve entre as versões da página.
//
// Duas coisas que a tela real ensinou e a versão anterior errava:
// - na tela "Escolha como pagar" o resumo não diz "Total", diz "Você pagará" —
//   e sem esse rótulo o antes/depois vinha null nos dois, jogando fora a prova
//   mais forte do veredito bem na única tela onde o cupom é aplicado;
// - o valor vem em par, o riscado e o que se paga ("R$ 159,80  R$ 135"). Fica o
//   ÚLTIMO: o riscado é o preço de antes do desconto, e ler ele daria "o total
//   não mudou" mesmo com o cupom pegando.
function extractCheckoutTotal(bodyText) {
  const rx = /(?:total|voc[êe] pagar[áa])[\s\S]{0,25}?((?:R\$\s?[\d.]+(?:,\d{1,2})?\s*){1,3})/gi;
  let bloco = null;
  for (const m of String(bodyText || "").matchAll(rx)) bloco = m[1];
  if (!bloco) return null;
  const valores = bloco.match(/R\$\s?[\d.]+(?:,\d{1,2})?/g) || [];
  return parseMoney(valores[valores.length - 1]);
}

// Os cupons que a PRÓPRIA PÁGINA oferece, a partir dos textos crus colhidos na
// PDP. Devolve [{ label, kind, value }] com kind ∈ valor | percentual | desconhecido.
//
// O trabalho aqui é quase todo desduplicação, e por um motivo concreto: o mesmo
// cupom é colhido três vezes na página real — o <span> com o texto, o bloco que o
// embrulha e o bloco de cima, cada um devolvendo o texto dos filhos GRUDADO
// ("R$ 113 com CupomR$113 com CupomVer cupons disponíveis"). A regra é ficar com o
// texto mais curto e jogar fora todo texto que CONTENHA um já guardado: o pai
// sempre contém o filho. A comparação ignora espaço porque é exatamente ele que a
// concatenação come ("R$ 113 com Cupom" vira "R$113 com Cupom" no pai).
//
// Com uma exceção, que a página do tênis mostrou: o texto mais curto era só
// "com Cupom" — o <span> do valor é irmão, não pai. Ficando com ele, o admin
// mostrava "com Cupom" e nenhum número, que não diz nada. Então, dentro do mesmo
// cupom, o mais curto COM VALOR ganha do mais curto sem valor nenhum.
function temValor(label) {
  return /R\$\s?[\d.,]+|\d{1,3}\s*%/.test(label);
}

function parseProductCoupons(blocos) {
  const candidatos = (blocos || [])
    .map(b => String(b || "").replace(/\s+/g, " ").trim())
    .filter(label => label && /cupom/i.test(label))
    .sort((a, b) => a.length - b.length);

  const grupos = [];
  for (const label of candidatos) {
    const chave = label.toLowerCase().replace(/\s+/g, "");
    const g = grupos.find(x => chave.includes(x.chave));
    if (g) {
      // Mesmo cupom, texto maior: só troca se o guardado não tem valor e este tem,
      // e sem deixar entrar o bloco gigante que grudou a página inteira.
      if (!temValor(g.label) && temValor(label) && label.length <= g.label.length + 60) g.label = label;
      continue;
    }
    grupos.push({ chave, label });   // `chave` fica a do mais curto, pra desduplicar
  }

  const out = [];
  for (const { label } of grupos) {
    const pct = label.match(/(\d{1,3})\s*%/);
    const money = parseMoney(label);
    out.push({
      label,
      kind: pct ? "percentual" : (money != null ? "valor" : "desconhecido"),
      value: pct ? Number(pct[1]) : money,
    });
  }
  return out;
}

// Junta os textos legíveis de um JSON qualquer — o ML não tem um formato só pra
// erro de cupom, então em vez de adivinhar o nome do campo a gente varre o objeto
// e recolhe tudo que parece mensagem. Pura → testável com o JSON salvo no dump.
function collectMessages(json, depth = 0) {
  if (depth > 6 || json == null) return [];
  if (typeof json === "string") return depth === 0 ? [json] : [];
  if (Array.isArray(json)) return json.flatMap(v => collectMessages(v, depth + 1));
  if (typeof json !== "object") return [];

  const out = [];
  for (const [k, v] of Object.entries(json)) {
    if (typeof v === "string" && v.trim() && /message|text|title|subtitle|description|error|reason|label|detail|status/i.test(k)) {
      out.push(v.trim());
    } else if (v && typeof v === "object") {
      out.push(...collectMessages(v, depth + 1));
    }
  }
  return out;
}

// Desfechos possíveis, do mais específico pro mais genérico. A ORDEM importa:
// "cupom inválido ou expirado" casa com dois padrões, e a primeira linha da tabela
// existe justamente pra essa frase ambígua não virar um veredito confiante errado.
const VERDICT_PATTERNS = [
  { status: "invalido", re: /inv[áa]lid[oa].{0,20}(ou|\/).{0,20}(expir|vencid)|(expir|vencid)\w*.{0,20}(ou|\/).{0,20}inv[áa]lid/i,
    reason: "O Mercado Livre recusou o código (a mensagem não separa inválido de expirado)." },
  { status: "expirado", re: /expir|vencid|venceu|fora do prazo|prazo (de uso )?encerrad|j[áa] terminou|n[ãa]o est[áa] mais dispon[íi]vel/i,
    reason: "O Mercado Livre disse que o cupom está expirado." },
  { status: "usado", re: /j[áa] (foi )?utiliz|j[áa] us(ou|ad)|limite de uso|atingiu o limite|esgotad/i,
    reason: "O cupom existe, mas já foi usado (ou bateu o limite de usos)." },
  { status: "minimo-nao-atingido", re: /valor m[íi]nimo|compras? acima de|a partir de r\$|m[íi]nimo de r\$/i,
    reason: "O cupom existe, mas o pedido não atinge o valor mínimo dele." },
  { status: "nao-aplicavel", re: /n[ãa]o (é|e) v[áa]lido para|n[ãa]o se aplica|n[ãa]o pode ser (usado|aplicado)|n[ãa]o vale para|n[ãa]o participa|n[ãa]o (é|e) eleg[íi]vel/i,
    reason: "O cupom existe, mas não vale para este produto." },
  { status: "invalido", re: /cupom inv[áa]lido|c[óo]digo inv[áa]lido|inv[áa]lid[oa]|n[ãa]o encontramos|n[ãa]o existe|verifique o c[óo]digo|c[óo]digo incorreto/i,
    reason: "O Mercado Livre não reconheceu esse código." },
  { status: "valido", re: /cupom aplicado|desconto aplicado|cupom adicionado|cupom ativado|cupom v[áa]lido/i,
    reason: "O Mercado Livre aceitou o cupom." },
];

// O veredito. Pura → testável sem navegador, como o classifyHubResult.
// Devolve { ok, status, reason, discount } com status ∈
//   valido | invalido | expirado | usado | nao-aplicavel | minimo-nao-atingido
//   | login | verificacao | captcha | indeterminado
//
// `indeterminado` é um desfecho legítimo e precisa existir: quando o ML muda a
// tela, dizer "não deu pra saber" é a resposta certa — fingir veredito aqui vira
// cupom morto indo pro grupo lá na frente (tarefa 95).
function classifyCouponResult({ finalUrl = "", bodyText = "", apiJson = null, totalBefore = null, totalAfter = null } = {}) {
  const url = String(finalUrl);
  const mensagens = collectMessages(apiJson);
  const hay = [...mensagens, String(bodyText || "")].join("\n");

  // Os três muros do ML (login × verificação × CAPTCHA) são os mesmos em qualquer
  // página logada e moram no ml-session-page.js — inclusive a distinção entre
  // "o cookie venceu" e "a conta está de castigo", que manda gente pra lugares
  // diferentes e não pode divergir entre o checkout, o Hub e a aba de cupons.
  const muro = classifyMLWall({ finalUrl: url, bodyText: hay });
  if (muro) return { ok: false, status: muro.status, discount: null, reason: muro.reason };

  // O total caindo é a prova mais forte que existe: o desconto entrou no pedido.
  // Vem antes da tabela de textos porque a tela pode continuar mostrando o aviso
  // de um código digitado errado ANTES, e aí o texto contaria a história velha.
  if (Number.isFinite(totalBefore) && Number.isFinite(totalAfter) && totalAfter < totalBefore) {
    const desconto = Math.round((totalBefore - totalAfter) * 100) / 100;
    return {
      ok: true, status: "valido", discount: desconto,
      reason: `O cupom entrou no pedido: o total caiu ${formatMoney(desconto)}.`,
    };
  }

  for (const p of VERDICT_PATTERNS) {
    if (!p.re.test(hay)) continue;
    // "Aceitou" sem o total ter caído não fecha: pode ser o texto de outra parte
    // da tela. Sem a queda no total, isso vira aviso, não aprovação.
    if (p.status === "valido") {
      return {
        ok: true, status: "indeterminado", discount: null,
        reason: "A tela disse que o cupom foi aplicado, mas o total do pedido não mudou — confira à mão.",
      };
    }
    return { ok: true, status: p.status, discount: null, reason: p.reason };
  }

  return {
    ok: true, status: "indeterminado", discount: null,
    reason: "O Mercado Livre não deu resposta reconhecível — a tela do checkout pode ter mudado. Rode o ml-coupon-dump.js e olhe as páginas salvas.",
  };
}

// ────────────────────────────────────────────────────────────────────────
// Parte com navegador
// ────────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Escuta as respostas JSON do ML. `state.coupon` guarda só as que falam de cupom
// (é de onde sai o veredito); `state.all` guarda tudo e só é ligado no dump.
// Precisa ser instalado ANTES do goto, como no Hub.
function collectCouponResponses(page, state, { captureAll = false } = {}) {
  page.on("response", async (res) => {
    try {
      const url = res.url();
      if (!/mercadolivre\.com\.br|mercadolibre\.com/i.test(url)) return;
      const type = res.headers()["content-type"] || "";
      if (!/json/i.test(type)) return;
      const body = await res.text();
      const entry = { url, status: res.status(), body: body.slice(0, MAX_BODY_CHARS), truncated: body.length > MAX_BODY_CHARS };
      if (captureAll) state.all.push(entry);
      if (!COUPON_API_RE.test(url)) return;
      let json = null;
      try { json = JSON.parse(body); } catch { return; }
      state.coupon.push({ url, status: res.status(), json, at: Date.now() });
    } catch { /* resposta descartada pelo Chrome — ignora */ }
  });
}

// Os cupons que a página do produto oferece sozinha, em TEXTO CRU.
//
// A busca é escopada na caixa de preço (mesma disciplina do scrapeSingleProduct:
// o carrossel de recomendados tem promoção própria e contaminaria a leitura) mais
// uma varredura por classe com "coupon" no nome, que é como o ML costuma marcar
// o bloco. Devolve textos curtos; quem interpreta é o parseProductCoupons.
function readProductCouponTexts(page) {
  return page.evaluate(() => {
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

    if (raiz) {
      for (const el of raiz.querySelectorAll("*")) {
        if (/cupom/i.test(el.textContent || "") && !el.children.length) push(el);
      }
    }
    for (const el of document.querySelectorAll("[class*='coupon' i], [class*='promotion' i]")) {
      push(el);
    }
    return textos;
  });
}

// O formulário de compra da PDP, em dados. O "Comprar agora" NÃO é um link: é o
// submit de um <form method="get"> cheio de campo oculto (item_id, quantity,
// shipping_option_id, _csrf) cujo alvo mora no `formaction` do botão. Montar a URL
// a partir daí é muito mais firme do que clicar por texto — e, de quebra, é o que
// revela quando o botão está DESABILITADO: produto com variação ("Escolha Tamanho
// para continuar com sua compra") não vende antes de alguém escolher, e clicar nele
// não faz nada nem dá erro. Foi exatamente nisso que a primeira sonda parou.
function readBuyForm(page) {
  return page.evaluate(() => {
    const botao = Array.from(document.querySelectorAll("form button[formaction], form input[type='submit'][formaction]"))
      .find(b => /checkout\/buy|gz\/checkout/i.test(b.getAttribute("formaction") || ""));
    if (!botao) return null;
    const form = botao.closest("form");
    if (!form) return null;

    const campos = {};
    for (const el of form.querySelectorAll("input[type='hidden'][name]")) campos[el.name] = el.value;

    // Três sinais do mesmo estado; o ML já usou todos em versões diferentes.
    const bloqueado = !!form.querySelector("input[required][name='disabledform']")
                   || /--disabled/.test(botao.className)
                   || !!botao.disabled;

    return {
      action: botao.getAttribute("formaction"),
      method: (form.getAttribute("method") || "get").toLowerCase(),
      campos,
      bloqueado,
      // O texto do botão traz junto o motivo, num <span> invisível:
      // "Comprar agora. Escolha Tamanho para continuar com sua compra."
      texto: (botao.textContent || "").replace(/\s+/g, " ").trim(),
    };
  });
}

// Escolhe a primeira variação disponível da PDP (tamanho, cor, voltagem…).
//
// Produto com variação não vende antes de alguém escolher, e o botão "Comprar
// agora" fica desabilitado dizendo isso no texto — foi assim que o teste morreu
// em 18/08 com um tênis. O picker do ML é uma lista de <a>/<label> dentro de
// `.ui-pdp-variations`; os indisponíveis vêm marcados com `--disabled`.
//
// Só a PRIMEIRA disponível, e só uma vez: escolher variação muda o produto que
// está sendo testado, então isso é um plano B honesto, não o caminho normal —
// e o resultado avisa qual foi escolhida.
async function pickFirstVariation(page) {
  const escolheu = await page.evaluate(() => {
    const caixa = document.querySelector(".ui-pdp-variations, [class*='variations']");
    if (!caixa) return null;
    const opcoes = Array.from(caixa.querySelectorAll("a, label, li, button"))
      .filter(el => el.offsetParent !== null)
      .filter(el => !/--disabled|--unavailable/.test(el.className || ""))
      .filter(el => el.getAttribute("aria-disabled") !== "true" && !el.disabled)
      .filter(el => !/^(sim|n[ãa]o)$/i.test((el.textContent || "").trim()));
    const alvo = opcoes.find(el => el.getAttribute("aria-checked") !== "true" && !/--selected/.test(el.className || ""))
              || opcoes[0];
    if (!alvo) return null;
    const texto = (alvo.getAttribute("aria-label") || alvo.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60);
    (alvo.closest("a, label, button, [role='button']") || alvo).click();
    return texto || "(sem nome)";
  }).catch(() => null);

  if (!escolheu) return null;
  // Escolher variação recarrega a PDP (o ML troca a URL do anúncio).
  await sleep(SETTLE_MS * 2);
  return escolheu;
}

// Espera o checkout sair do "Preparando tudo para sua compra" e virar tela de
// verdade. Devolve { ready, url, bodyText } — `ready:false` quando o ML devolveu
// a gente pra fora do checkout (acontece quando o pedido não pode ser montado).
async function waitForCheckoutReady(page) {
  let bodyText = "";
  for (let i = 0; i < Math.ceil(CHECKOUT_READY_WAIT_MS / 1000); i++) {
    await sleep(1000);
    if (!CHECKOUT_URL_RE.test(page.url())) return { ready: false, url: page.url(), bodyText };
    bodyText = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
    if (CHECKOUT_LOADING_RE.test(bodyText)) continue;
    if (CHECKOUT_READY_RE.test(bodyText)) return { ready: true, url: page.url(), bodyText };
  }
  return { ready: false, url: page.url(), bodyText };
}

// Da PDP até a tela de checkout. Ordem: o formulário de compra (firme), depois o
// clique em "Comprar agora" (para layouts que não usam form) e, por último, o
// carrinho — que é o único caminho que deixa rastro na conta, e por isso vem
// depois e obriga a limpeza no fim (ver removeFromCart).
// Devolve { reached, via, url, blockedReason }.
async function goToCheckout(page) {
  // Chegar = a URL virar de checkout E a tela terminar de montar. Só a URL não
  // vale: o interstitial já tem a URL certa e ainda não dá pra fazer nada nele.
  const esperarSaida = async () => {
    for (let i = 0; i < Math.ceil(NAV_WAIT_MS / 500); i++) {
      await sleep(500);
      if (CHECKOUT_URL_RE.test(page.url())) return (await waitForCheckoutReady(page)).ready;
    }
    return false;
  };

  let form = await readBuyForm(page);

  // Botão desabilitado costuma querer dizer "escolha a variação primeiro".
  // Tenta escolher uma e relê o formulário — uma vez só.
  let variacao = null;
  if (form?.bloqueado) {
    variacao = await pickFirstVariation(page);
    if (variacao) form = await readBuyForm(page);
  }

  if (form?.bloqueado) {
    return {
      reached: false, via: null, url: page.url(), variacao,
      blockedReason: form.texto || "O botão de compra está desabilitado nesta página.",
    };
  }

  if (form?.action && form.method === "get") {
    const alvo = new URL(form.action);
    for (const [k, v] of Object.entries(form.campos)) alvo.searchParams.set(k, v);
    await page.goto(alvo.href, { waitUntil: "domcontentloaded", timeout: NAV_WAIT_MS }).catch(() => {});
    if (await esperarSaida()) return { reached: true, via: "form-compra", url: page.url(), blockedReason: null, variacao };
  }

  if (await clickByPattern(page, BUY_NOW_RE, { maxLen: 60 })) {
    if (await esperarSaida()) return { reached: true, via: "comprar-agora", url: page.url(), blockedReason: null, variacao };
  }

  if (await clickByPattern(page, ADD_TO_CART_RE, { maxLen: 60 })) {
    await sleep(SETTLE_MS);
    if (!CHECKOUT_URL_RE.test(page.url())) {
      await page.goto("https://www.mercadolivre.com.br/gz/cart", { waitUntil: "domcontentloaded", timeout: NAV_WAIT_MS }).catch(() => {});
    }
    await clickByPattern(page, CONTINUE_RE, { maxLen: 60 });
    if (await esperarSaida()) return { reached: true, via: "carrinho", url: page.url(), blockedReason: null, variacao };
    return { reached: false, via: "carrinho", url: page.url(), blockedReason: null, variacao };
  }

  return { reached: false, via: null, url: page.url(), blockedReason: null, variacao };
}

// A página onde a gente PAROU é mesmo a de um produto?
//
// Nasceu de um teste que devolveu "a página oferece 22 cupons" para um tênis: o
// link colado vinha do perfil de afiliado (`source=affiliate-profile`), e o ML
// mandou a sessão do sistema para `/social/<apelido>/lists` — a vitrine do
// afiliado, que é uma página cheia de cupons e nenhum deles do produto. Ler
// cupom de uma página que não é a do produto não é resultado ruim, é resultado
// FALSO: vira "esse produto tem 22 cupons" na tela.
//
// Puro, e por isso testado sem navegador.
function isProductPage(finalUrl) {
  let u;
  try { u = new URL(String(finalUrl || "")); } catch { return false; }
  const caminho = decodeURIComponent(u.pathname);

  // O perfil/vitrine do afiliado nunca é produto.
  if (/^\/social\//i.test(caminho)) return false;

  return /\/p\/MLB\d+/i.test(caminho)
      || /\/up\/MLBU\d+/i.test(caminho)
      || /\/MLB-?\d{6,}/i.test(caminho)
      || /^produto\./i.test(u.hostname);
}

// O que esta tela tem de cupom — e são DUAS coisas diferentes:
//
//   `campo` — um input de cupom à mostra. Aqui não há dúvida: é digitar e aplicar.
//   `linha` — só um texto ("Cupons", "Inserir código do cupom") que PODE abrir um
//             popup. O "Resumo da compra" mostra essa linha desde a tela de
//             entrega, e ali ela não abre nada.
//
// Juntar as duas num único booleano era o bug: a automação declarava "achei o
// cupom" na tela de entrega, clicava numa linha morta e devolvia "não achei o
// campo" como se o layout do ML tivesse mudado.
function hasCouponEntry(page) {
  return page.evaluate((source, flags) => {
    const rx = new RegExp(source, flags);
    const campo = Array.from(document.querySelectorAll("input")).some(el => {
      const pista = `${el.name || ""} ${el.id || ""} ${el.placeholder || ""} ${el.getAttribute("aria-label") || ""}`;
      return el.offsetParent !== null && /cupom|coupon|c[óo]digo de desconto/i.test(pista);
    });
    const linha = Array.from(document.querySelectorAll("button, [role='button'], a, label, span"))
      .some(el => {
        const t = (el.textContent || "").replace(/\s+/g, " ").trim();
        return el.offsetParent !== null && t && t.length <= 60 && rx.test(t);
      });
    return { campo, linha };
  }, COUPON_OPEN_RE.source, COUPON_OPEN_RE.flags).catch(() => ({ campo: false, linha: false }));
}

// Estamos na tela de PAGAMENTO? É lá — e só lá — que a linha "Inserir código do
// cupom" do resumo abre o popup de verdade.
async function isPaymentStep(page) {
  const { titulo } = await readStepHeading(page);
  if (PAYMENT_STEP_RE.test(titulo || "")) return true;
  const { bodyText } = await snapshotPage(page).catch(() => ({ bodyText: "" }));
  return PAYMENT_STEP_RE.test(bodyText || "");
}

// Marca a primeira opção de um passo que exige escolha (forma de entrega, por
// exemplo) quando nenhuma veio marcada — senão o "Continuar" não sai do lugar.
//
// O rádio do ML é um <input> ESCONDIDO atrás do desenho do Andes: quem recebe o
// clique de verdade é o <label for="...">. Clicar no input marca a bolinha e não
// avisa o React, aí o "Continuar" é enviado sem forma de entrega e o checkout
// morre com "Ocorreu um problema" — foi exatamente assim que a sonda o derrubou.
//
// Devolve { needed, checked }: `checked:false` significa "não consegui escolher",
// e nesse caso é melhor parar do que clicar em Continuar e quebrar a tela.
function selectFirstOption(page) {
  return page.evaluate(() => {
    const radios = Array.from(document.querySelectorAll("input[type='radio']")).filter(el => !el.disabled);
    if (!radios.length) return { needed: false, checked: true };
    if (radios.some(el => el.checked)) return { needed: true, checked: true };

    const alvo = radios[0];
    const label = (alvo.id && document.querySelector(`label[for="${CSS.escape(alvo.id)}"]`)) || alvo.closest("label");
    (label || alvo).click();
    return {
      needed: true,
      checked: Array.from(document.querySelectorAll("input[type='radio']")).some(el => el.checked),
    };
  });
}

// Como se chama a tela em que estamos. Serve só pra contar depois onde a
// automação parou: sem isso, "parei depois de 4 passos" não diz nada a quem
// precisa consertar — nem pra ferramenta, nem pra quem lê o resultado no admin.
function readStepHeading(page) {
  return page.evaluate(() => {
    const visivel = (el) => el.offsetParent !== null && (el.textContent || "").trim();
    const titulo = Array.from(document.querySelectorAll("h1, h2, [role='heading']"))
      .filter(visivel)
      .map(el => el.textContent.replace(/\s+/g, " ").trim())
      .find(t => t.length <= 90) || "";
    return { titulo };
  }).catch(() => ({ titulo: "" }));
}

// Uma "foto" barata da tela, só pra saber se ela mudou. O título sozinho não
// serve: o checkout tem duas telas seguidas chamadas "Escolha quando sua compra
// chegará", e a URL fica igual entre passos da SPA.
function pageFingerprint(page) {
  return page.evaluate(() => {
    const t = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
    return `${location.pathname}|${t.slice(0, 400)}`;
  }).catch(() => "");
}

// Espera a tela virar outra depois do clique. Devolve false quando nada mudou —
// e é isso que separa "andei um passo" de "cliquei no vazio".
async function waitForStepChange(page, antes, ms = STEP_CHANGE_WAIT_MS) {
  for (let i = 0; i < Math.ceil(ms / 500); i++) {
    await sleep(500);
    const agora = await pageFingerprint(page);
    if (agora && antes && agora !== antes) return true;
  }
  return false;
}

// O checkout do ML caiu? Devolve o código do erro (ou "" quando caiu sem código),
// e null quando a tela está normal.
// O `bodyText` sozinho não bastava: em 18/08 a tela era só o título "Ocorreu um
// problema", sem o "tente novamente" que a CHECKOUT_ERROR_RE exige a até 140
// chars de distância. O resultado saiu como "não existe botão Continuar nessa
// tela" — verdade, e mandando consertar o lugar errado: o problema era do ML.
const CHECKOUT_ERROR_TITLE_RE = /^\s*(ocorreu um problema|algo deu errado|tivemos um problema)/i;

async function readCheckoutError(page) {
  const { bodyText } = await snapshotPage(page).catch(() => ({ bodyText: "" }));
  const { titulo } = await readStepHeading(page);
  const caiu = CHECKOUT_ERROR_RE.test(bodyText || "") || CHECKOUT_ERROR_TITLE_RE.test(titulo || "");
  if (!caiu) return null;
  return (String(bodyText || "").match(CHECKOUT_ERROR_CODE_RE) || [""])[0];
}

// Espera a tela PARAR de mexer antes de clicar. Marcar a forma de entrega dispara
// recálculo de frete, e clicar em "Continuar" no meio disso é o que derruba o
// checkout do ML na tela seguinte ("Ocorreu um problema"). Um humano leva segundos
// pra achar o botão; a automação clicava no mesmo instante.
async function waitForQuiet(page, ms = QUIET_WAIT_MS) {
  let anterior = await pageFingerprint(page);
  let iguais = 0;
  for (let i = 0; i < Math.ceil(ms / 500); i++) {
    await sleep(500);
    const agora = await pageFingerprint(page);
    iguais = agora && agora === anterior ? iguais + 1 : 0;
    anterior = agora;
    if (iguais >= 2) return true;   // 1s parada já basta
  }
  return false;
}

// Caminha pelo checkout até a tela que tem cupom. Só clica em "Continuar" (regex
// ancorada) — nunca em pagar/confirmar —, então o pior caso é parar antes da hora.
//
// Vai anotando a trilha (tela por tela, o que foi clicado, por que parou). Quando
// o ML mudar o fluxo, é a trilha que diz em qual tela consertar — a primeira
// versão só devolvia o número de passos, e isso não bastou pra achar o problema.
//
// `tentarAbrir(page)` é chamado quando a tela mostra por onde entrar com o cupom;
// ele devolve `{ found }`. Existe como callback (e não depois, no chamador) por
// causa do desfecho que mais aparecia no histórico: clicar na linha do cupom e o
// campo não abrir. Antes isso encerrava a caminhada e virava veredito
// "indeterminado"; agora é só mais uma tela que não deu, e o checkout continua
// andando até a próxima.
async function advanceToCouponStep(page, { onStep = null, tentarAbrir = null } = {}) {
  const trail = [];
  let passos = 0;
  let motivo = "limite-de-passos";
  let jaRecarregou = false;
  let erroFinal = "";
  let abertura = null;

  for (; passos < MAX_CHECKOUT_STEPS; passos++) {
    const { titulo } = await readStepHeading(page);
    const passo = { passo: passos + 1, url: page.url(), titulo, escolha: null, clicou: null, mudou: null, erro: null, parou: null };
    trail.push(passo);
    if (onStep) await onStep(passos + 1, page);

    const entrada = await hasCouponEntry(page);
    // Um campo à mostra é resposta fechada — não interessa em que tela estamos.
    // Já a LINHA do resumo só vale na tela de pagamento: nas de entrega ela está
    // lá o tempo todo e não abre nada.
    const valeTentar = entrada.campo || (entrada.linha && await isPaymentStep(page));
    if (valeTentar) {
      passo.cupom = entrada.campo ? "campo" : "linha";
      if (!tentarAbrir) {
        passo.parou = "achei-o-cupom";
        return { reached: true, steps: passos, trail, motivo: "achei-o-cupom", abertura: null };
      }
      abertura = await tentarAbrir(page);
      if (abertura?.found) {
        passo.parou = "achei-o-cupom";
        return { reached: true, steps: passos, trail, motivo: "achei-o-cupom", abertura };
      }
      // Não abriu. Segue o checkout: pode ser que o cupom só apareça de verdade
      // um passo à frente.
      passo.parou = "cupom-nao-abriu";
      motivo = "cupom-nao-abriu";
    }

    // O checkout do ML caiu. Ele mesmo pede "tente novamente", e recarregar a URL
    // do passo costuma trazer a tela de volta — vale uma vez. Sem isso o resultado
    // dizia "não existe botão Continuar nessa tela", que é verdade e não explica
    // nada: a tela era um erro do ML, não um passo do checkout.
    const erro = await readCheckoutError(page);
    if (erro !== null) {
      passo.erro = erro || "sem código";
      erroFinal = passo.erro;
      if (jaRecarregou) { passo.parou = motivo = "checkout-quebrou"; break; }
      jaRecarregou = true;
      passo.parou = "recarreguei";
      await page.reload({ waitUntil: "domcontentloaded", timeout: NAV_WAIT_MS }).catch(() => {});
      await waitForCheckoutReady(page);
      continue;
    }

    const opcao = await selectFirstOption(page);
    passo.escolha = !opcao.needed ? "nada a escolher" : (opcao.checked ? "opção marcada" : "não consegui marcar");
    await sleep(700);
    // Sem escolher a opção do passo, "Continuar" derruba o checkout. Parar aqui é
    // um resultado honesto; quebrar a tela e reportar "indeterminado" não é.
    if (!opcao.checked) { passo.parou = motivo = "opcao-nao-marcada"; break; }

    // Só conta como passo andado quando a tela realmente muda. Sem isso, um clique
    // que não pegou (botão ainda desabilitado, tela remontando) era contado como
    // avanço: a sonda gastou os 6 passos batendo no mesmo "Escolha a forma de
    // entrega" e ainda relatou "andei 6 telas" sem ter saído da primeira.
    // Deixar a tela assentar antes de clicar: marcar a entrega dispara recálculo
    // de frete, e "Continuar" no meio disso derruba o checkout do ML.
    await waitForQuiet(page);

    let clicou = null;
    let mudou = false;
    for (let tentativa = 0; tentativa < 2 && !mudou; tentativa++) {
      const antes = await pageFingerprint(page);
      clicou = await clickByPattern(page, CONTINUE_STEP_RE, { maxLen: 30 });
      if (!clicou) { await sleep(SETTLE_MS); continue; }   // botão ainda montando/desabilitado
      mudou = await waitForStepChange(page, antes);
    }
    passo.clicou = clicou;
    passo.mudou = clicou ? mudou : null;
    if (!clicou) { passo.parou = motivo = "sem-botao-continuar"; break; }
    if (!mudou) { passo.parou = motivo = "tela-nao-mudou"; break; }

    await waitForCheckoutReady(page);
  }

  // Se em alguma tela a linha do cupom foi clicada e o campo não abriu, é ISSO
  // que explica o fim da caminhada — mesmo que ela tenha morrido depois num
  // "sem botão Continuar" (na tela de pagamento não existe "Continuar", só
  // "Pagar", e a automação nunca encosta nele).
  const motivoFinal = abertura && !abertura.found ? "cupom-nao-abriu" : motivo;
  return { reached: false, steps: passos, trail, erro: erroFinal || null, motivo: motivoFinal, abertura };
}

// Abre o campo de cupom do checkout, digita o código e aplica.
// Devolve { fieldFound, applied }.
// Existe algum campo de digitar cupom À MOSTRA nesta tela?
function findCouponInput(page) {
  return page.evaluate(() => {
    const campos = Array.from(document.querySelectorAll("input"))
      .filter(el => el.offsetParent !== null && !el.disabled && el.type !== "hidden" && el.type !== "radio" && el.type !== "checkbox");
    const pista = (el) => `${el.name || ""} ${el.id || ""} ${el.placeholder || ""} ${el.getAttribute("aria-label") || ""}`;
    return !!(campos.find(el => /cupom|c[óo]digo|coupon|discount/i.test(pista(el))) || (campos.length === 1 ? campos[0] : null));
  }).catch(() => false);
}

// Clica no "Inserir código do cupom". Na tela "Escolha como pagar" ele não é um
// campo à mostra nem uma opção da lista de pagamento: é um link no "Resumo da
// compra", na coluna da direita, logo abaixo do frete — e abre um POPUP. E quem
// tem o texto costuma ser um <span> lá no fundo, que não escuta clique — o clique
// útil é o do ancestral. `nivel` diz quantos degraus subir: 0 é o clicável mais
// próximo, 1..n vai subindo quando o de baixo não fez nada.
function clickCouponRow(page, nivel) {
  return page.evaluate((source, flags, nivel) => {
    const rx = new RegExp(source, flags);
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
  }, COUPON_OPEN_RE.source, COUPON_OPEN_RE.flags, nivel);
}

// Abre a tela/campo do cupom e espera ela montar. Devolve o que foi clicado e onde
// a gente parou — sem isso, "não achei o campo" não diz se o clique não pegou ou
// se a tela seguinte é que mudou.
async function openCouponField(page) {
  const tentativas = [];

  for (let nivel = 0; nivel <= 3; nivel++) {
    if (await findCouponInput(page)) {
      return { found: true, tentativas, url: page.url(), titulo: (await readStepHeading(page)).titulo };
    }

    const clicou = await clickCouponRow(page, nivel);
    tentativas.push({ nivel, clicou: clicou?.texto || null, tag: clicou?.tag || null });
    if (!clicou) break;

    // A linha do cupom navega pra outro passo do checkout: 1,5s não bastava.
    for (let i = 0; i < Math.ceil(COUPON_OPEN_WAIT_MS / 500); i++) {
      await sleep(500);
      if (await findCouponInput(page)) {
        return { found: true, tentativas, url: page.url(), titulo: (await readStepHeading(page)).titulo };
      }
    }
  }

  return { found: false, tentativas, url: page.url(), titulo: (await readStepHeading(page)).titulo };
}

// Abre o campo de cupom do checkout, digita o código e aplica.
// Devolve { stepReached, fieldFound, applied, couponOpen, steps, trail, motivo }.
async function applyCouponAtCheckout(page, code, { onStep = null, onStage = null } = {}) {
  // O total tem que ser lido na MESMA tela nos dois momentos. Lendo o "antes" na
  // tela de entrega e o "depois" na de pagamento, os dois números são de coisas
  // diferentes (com e sem frete) — e uma queda dessas viraria "cupom válido" sem
  // que cupom nenhum tivesse entrado. É a prova mais forte do veredito; não pode
  // ser comparação de laranja com banana. Por isso ele é lido AQUI, dentro do
  // callback: é o último instante antes de o popup do cupom cobrir a tela.
  let totalBefore = null;

  const caminho = await advanceToCouponStep(page, {
    onStep,
    tentarAbrir: async (p) => {
      totalBefore = extractCheckoutTotal((await snapshotPage(p)).bodyText);
      const r = await openCouponField(p);
      if (onStage) await onStage("cupom-aberto", p);
      return r;
    },
  });

  const trilha = { steps: caminho.steps, trail: caminho.trail, motivo: caminho.motivo };
  const abertura = caminho.abertura || null;
  if (!caminho.reached) {
    return { stepReached: !!abertura, fieldFound: false, applied: false, couponOpen: abertura, totalBefore, totalAfter: null, ...trilha };
  }

  const fieldFound = await page.evaluate((valor) => {
    const campos = Array.from(document.querySelectorAll("input"))
      .filter(el => el.offsetParent !== null && !el.disabled && el.type !== "hidden" && el.type !== "radio" && el.type !== "checkbox");
    const pista = (el) => `${el.name || ""} ${el.id || ""} ${el.placeholder || ""} ${el.getAttribute("aria-label") || ""}`;
    const alvo = campos.find(el => /cupom|c[óo]digo|coupon|discount/i.test(pista(el)))
              || (campos.length === 1 ? campos[0] : null);
    if (!alvo) return false;
    alvo.focus();
    // O React do ML não enxerga `el.value = x`: o setter nativo + o evento é o que
    // faz o estado do componente (e o botão "Aplicar") acompanhar o que foi digitado.
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(alvo, valor);
    alvo.dispatchEvent(new Event("input", { bubbles: true }));
    alvo.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }, code);

  if (!fieldFound) return { stepReached: true, fieldFound: false, applied: false, couponOpen: abertura, totalBefore, totalAfter: null, ...trilha };

  let botao = await clickByPattern(page, COUPON_APPLY_RE, { maxLen: 30 });
  if (!botao) botao = await clickByPattern(page, COUPON_APPLY_FALLBACK_RE, { maxLen: 30 });
  if (!botao) {
    await page.keyboard.press("Enter");   // alguns layouts só têm o Enter
    botao = "Enter";
  }
  await sleep(APPLY_WAIT_MS);

  // O total DEPOIS tem que ser lido na mesma tela do total ANTES (ver acima). A
  // tela de digitar o código costuma não ter total nenhum: depois de aplicar, o ML
  // volta pro resumo. Por isso espera o número aparecer em vez de ler null na hora
  // e jogar fora a única prova forte que o veredito tem.
  let totalAfter = null;
  for (let i = 0; i < Math.ceil(TOTAL_WAIT_MS / 1000); i++) {
    totalAfter = extractCheckoutTotal((await snapshotPage(page)).bodyText);
    if (totalAfter !== null) break;
    await sleep(1000);
  }
  return { stepReached: true, fieldFound: true, applied: true, botao, couponOpen: abertura, totalBefore, totalAfter, ...trilha };
}

// Tira o item do carrinho — só faz sentido quando o plano B foi usado. Best-effort
// de propósito: falhar aqui não pode derrubar o teste, mas deixar lixo no carrinho
// da conta do sistema também não é aceitável, então tenta sempre.
async function removeFromCart(page) {
  try {
    await page.goto("https://www.mercadolivre.com.br/gz/cart", { waitUntil: "domcontentloaded", timeout: NAV_WAIT_MS });
    await sleep(SETTLE_MS);
    const removed = await clickByPattern(page, CART_REMOVE_RE, { maxLen: 30 });
    await sleep(SETTLE_MS);
    return !!removed;
  } catch {
    return false;
  }
}

// Por que a caminhada pelo checkout parou, em português e apontando a tela. Um
// número de passos sozinho não diz onde consertar; o nome da última tela diz.
function describeStall({ steps = 0, trail = [], motivo = "" } = {}) {
  const ultima = trail[trail.length - 1];
  const onde = ultima?.titulo ? `Parei em "${ultima.titulo}"` : `Parei depois de ${steps} passo(s)`;
  const porque = {
    "opcao-nao-marcada": "essa tela pede uma escolha que a ferramenta não sabe fazer (a opção não ficou marcada), e clicar em Continuar assim derruba o checkout.",
    "tela-nao-mudou": "cliquei em \"Continuar\" e a tela continuou a mesma — o botão provavelmente está desabilitado esperando alguma coisa (frete recalculando, um dado que a ferramenta não preenche).",
    "sem-botao-continuar": "não existe um botão \"Continuar\" nessa tela — daqui pra frente só há botões de pagar/confirmar, e a ferramenta nunca clica neles.",
    "limite-de-passos": `andei ${steps} tela(s) e o campo de cupom não apareceu em nenhuma.`,
    "cupom-nao-abriu": "achei a linha do cupom na tela de pagamento, cliquei nela e o campo pra digitar não abriu — e daí pra frente o checkout não tinha mais para onde avançar.",
    "checkout-quebrou": `o checkout do ML caiu com "Ocorreu um problema"${ultima?.erro ? ` (${ultima.erro})` : ""} e não voltou nem depois de recarregar. É erro do lado deles: espere alguns minutos e teste de novo.`,
  }[motivo] || "o checkout mudou de forma no meio do caminho.";
  return `Cheguei no checkout mas não avancei até a tela do cupom. ${onde}: ${porque}`;
}

// Por que o campo do cupom não apareceu. Separa as duas histórias: "cliquei na
// linha e a tela seguinte não tem campo" é uma coisa; "não achei nem onde clicar"
// é outra, e cada uma se conserta em lugar diferente.
function describeCouponOpen(abertura) {
  const onde = abertura?.titulo ? ` Parei em "${abertura.titulo}".` : "";
  const cliques = (abertura?.tentativas || []).filter(t => t.clicou);
  if (!cliques.length) {
    return `Cheguei na tela que tem cupom, mas não achei onde clicar pra abrir o campo.${onde} O layout do ML provavelmente mudou.`;
  }
  return `Cliquei em "${cliques[0].clicou}" (${cliques.length} tentativa(s)) e o campo pra digitar o código não apareceu.${onde} O ML pode ter pedido mais um passo antes do cupom.`;
}

// O fluxo inteiro, de ponta a ponta. `onStage(nome, page)` é chamado ao fim de
// cada etapa — é por onde o dump salva HTML e print sem que o fluxo saiba disso.
// Sempre fecha o navegador.
async function runCouponFlow(cookie, { url, code = null, mode = "leitura" } = {}, { captureAll = false, onStage = null } = {}) {
  const state = { coupon: [], all: [] };
  const stage = async (nome, page) => { if (onStage) await onStage(nome, page); };

  const r = await withMLSessionPage(cookie, url, (page) => collectCouponResponses(page, state, { captureAll }), {
    waitUntil: "domcontentloaded",
    timeout: NAV_WAIT_MS,
  });

  const out = {
    finalUrl: r.finalUrl,
    title: r.title,
    pdpBlocked: r.blocked,
    clipped: [],
    checkout: { attempted: false, reached: false, via: null, url: null, blockedReason: null, stepReached: false, steps: 0, trail: [], couponOpen: null, fieldFound: false, applied: false, cartUsed: false, cartCleaned: null },
    totalBefore: null,
    totalAfter: null,
    verdict: null,
    responses: state.coupon,
    allResponses: state.all,
  };

  try {
    await sleep(SETTLE_MS);   // a PDP ainda pinta preço/promoção por JS
    await stage("pdp", r.page);

    if (r.blocked?.blocked) {
      out.verdict = classifyCouponResult({ finalUrl: r.finalUrl, bodyText: r.bodyText });
      return out;
    }

    // Antes de ler cupom nenhum: isto é a página de um produto? Um link de perfil
    // de afiliado leva a sessão do sistema pra vitrine do afiliado, e os cupons
    // de lá não são deste produto.
    if (!isProductPage(r.finalUrl)) {
      out.notProductPage = true;
      out.verdict = {
        ok: false, status: "indeterminado", discount: null,
        reason: `Esse link não abriu a página de um produto — a sessão do sistema parou em ${r.finalUrl}. Link de perfil de afiliado ("source=affiliate-profile", "/social/…") leva pra vitrine do afiliado, não pro produto: abra o produto no ML e cole o link direto dele.`,
      };
      return out;
    }

    out.clipped = parseProductCoupons(await readProductCouponTexts(r.page));

    if (mode !== "checkout" || !code) return out;

    out.checkout.attempted = true;
    const ida = await goToCheckout(r.page);
    out.checkout.reached = ida.reached;
    out.checkout.via = ida.via;
    out.checkout.url = ida.url;
    out.checkout.blockedReason = ida.blockedReason || null;
    out.checkout.variacao = ida.variacao || null;
    out.checkout.cartUsed = ida.via === "carrinho";
    await stage("checkout", r.page);

    if (!ida.reached) {
      out.verdict = {
        ok: false, status: "indeterminado", discount: null,
        reason: ida.blockedReason
          ? (ida.variacao
              ? `O produto não pode ser comprado direto nem depois de eu escolher "${ida.variacao}": "${ida.blockedReason}". Escolha a variação na página do ML e cole aqui o link já com ela.`
              : `O produto não pode ser comprado direto: "${ida.blockedReason}". Escolha a variação na página do ML e cole aqui o link já com ela.`)
          : `Não deu pra chegar no checkout a partir da página do produto (parou em ${ida.url}). A tela de compra pode ter mudado.`,
      };
      return out;
    }

    const antes = await snapshotPage(r.page);
    out.checkout.totalAtEntry = extractCheckoutTotal(antes.bodyText);

    const aplicou = await applyCouponAtCheckout(r.page, code, {
      onStep: (n, page) => stage(`passo-${n}`, page),
      onStage: stage,
    });
    out.checkout.fieldFound = aplicou.fieldFound;
    out.checkout.applied = aplicou.applied;
    out.checkout.stepReached = !!aplicou.stepReached;
    out.checkout.steps = aplicou.steps ?? 0;
    out.checkout.trail = aplicou.trail || [];
    out.checkout.couponOpen = aplicou.couponOpen || null;
    out.checkout.botaoCupom = aplicou.botao || null;
    // Os dois totais vêm da tela do cupom, medidos com o mesmo régua.
    out.totalBefore = aplicou.totalBefore ?? null;
    out.totalAfter = aplicou.totalAfter ?? null;
    await stage("apos-cupom", r.page);

    if (!aplicou.fieldFound) {
      out.verdict = {
        ok: false, status: "indeterminado", discount: null,
        reason: aplicou.stepReached
          ? describeCouponOpen(aplicou.couponOpen)
          : describeStall(aplicou),
      };
      return out;
    }

    const depois = await snapshotPage(r.page);
    out.finalUrl = r.page.url();

    const blockedNow = await detectBlockPage(r.page, "Mercado Livre");
    out.verdict = classifyCouponResult({
      finalUrl: out.finalUrl,
      bodyText: blockedNow?.blocked ? `${depois.bodyText}\n${blockedNow.reason}` : depois.bodyText,
      apiJson: state.coupon.map(x => x.json),
      totalBefore: out.totalBefore,
      totalAfter: out.totalAfter,
    });
    return out;
  } finally {
    // O carrinho da conta do sistema não pode ficar sujo por causa de um teste.
    if (out.checkout.cartUsed) {
      out.checkout.cartCleaned = await removeFromCart(r.page).catch(() => false);
    }
    await r.browser.close().catch(() => {});
  }
}

// ────────────────────────────────────────────────────────────────────────
// Prints do caminho
// ────────────────────────────────────────────────────────────────────────

// Devolve o `onStage` que salva o que a tela mostrava em cada etapa. `html:true`
// salva também o HTML (é o que o dump usa pra escrever seletor); o teste do admin
// fica só no print, que é o que se olha pra entender onde o robô parou.
// Falhar em salvar NUNCA derruba o teste: o print é diagnóstico, não o resultado.
function makeStageRecorder(outDir, { html = false } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const salvos = [];
  const onStage = async (nome, page) => {
    try {
      if (html) fs.writeFileSync(path.join(outDir, `${nome}.html`), await page.content());
      await page.screenshot({ path: path.join(outDir, `${nome}.png`), fullPage: true });
      salvos.push(`${nome}.png`);
    } catch (err) {
      console.warn(`[ml-coupon] não deu pra salvar a etapa "${nome}": ${err.message}`);
    }
  };
  return { onStage, salvos, outDir };
}

// Deixa só as `keep` rodadas mais novas. Sem isso, cada teste larga uns 10 MB de
// print em disco e ninguém lembra de limpar.
function pruneRuns(baseDir, keep = SHOTS_KEEP) {
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

// ────────────────────────────────────────────────────────────────────────
// Histórico (últimos testes, pra tela do admin)
// ────────────────────────────────────────────────────────────────────────

function readHistory() {
  const raw = appConfig.get(HISTORY_KEY);
  return Array.isArray(raw) ? raw : [];
}

function pushHistory(entry) {
  const next = [entry, ...readHistory()].slice(0, HISTORY_MAX);
  appConfig.set(HISTORY_KEY, next);
  return next;
}

// ────────────────────────────────────────────────────────────────────────
// Teste sob demanda (o botão do admin)
// ────────────────────────────────────────────────────────────────────────

// Um teste por vez: cada um abre um Chrome e mexe na conta do sistema. Dois
// simultâneos dobram a chance de CAPTCHA e podem brigar pelo mesmo carrinho.
let _running = null;
// O que o caminho rápido apurou quando ele NÃO concluiu. Vai junto no resultado
// do checkout: "o cupom existe e está valendo, só não sei se cobre este produto"
// é metade da resposta, e some se não for carregada adiante.
let _quickPendente = null;

// O caminho rápido linha a linha, no mesmo formato do `buildChecks`.
function buildQuickChecks(quick) {
  const checks = [
    { key: "palavra", label: "O ML reconhece a palavra", ok: !!quick.campaignId,
      value: quick.campaignId ? `campanha ${quick.campaignId}` : (quick.mlMessage || "não") },
    { key: "cupom", label: "Cupom no sistema", ok: !!quick.coupon,
      value: quick.coupon ? (quick.coupon.title || quick.coupon.campaignId) : "não está aqui" },
    { key: "vitrine", label: "Produto na vitrine do cupom",
      ok: quick.cobertura === "na-vitrine",
      value: { "na-vitrine": "sim", "fora-da-vitrine": "não", "sem-vitrine": "vitrine nunca raspada" }[quick.cobertura] || "—" },
    { key: "preco", label: "Preço antes → depois", ok: Number.isFinite(quick.priceAfter),
      value: `${formatMoney(quick.priceBefore)} → ${formatMoney(quick.priceAfter)}` },
    { key: "veredito", label: "Veredito", ok: quick.status === "valido", value: quick.reason },
  ];
  return checks;
}

// A trilha do checkout em uma linha: "Entrega → Pagamento". É o que a tela do
// admin mostra pra dizer até onde a automação chegou.
function describeTrail(trail) {
  if (!Array.isArray(trail) || !trail.length) return "";
  return trail.map(p => p.titulo || "(tela sem título)").join(" → ");
}

// O que a tela mostra linha a linha. Mesma ideia do `checks` do testLink.
function buildChecks(flow, { mode, code }) {
  const checks = [
    { key: "pdp", label: "Página do produto abriu", ok: !flow.pdpBlocked?.blocked, value: flow.title || flow.finalUrl },
    { key: "cupom-na-pagina", label: "Cupom oferecido pela própria página", ok: flow.clipped.length > 0,
      value: flow.clipped.length ? flow.clipped.map(c => c.label).join(" · ") : "nenhum" },
  ];
  if (mode !== "checkout" || !code) return checks;

  checks.push(
    { key: "checkout", label: "Chegou no checkout", ok: flow.checkout.reached,
      value: flow.checkout.reached ? `via ${flow.checkout.via}` : (flow.checkout.blockedReason || flow.checkout.url) },
    { key: "campo-cupom", label: "Campo de cupom encontrado", ok: flow.checkout.fieldFound,
      value: flow.checkout.fieldFound
        ? "sim"
        : (flow.checkout.stepReached
            ? "chegou na tela, sem o campo"
            : `parou em ${describeTrail(flow.checkout.trail) || `${flow.checkout.steps ?? 0} passo(s)`}`) },
    { key: "total", label: "Total antes → depois", ok: Number.isFinite(flow.totalAfter),
      value: `${formatMoney(flow.totalBefore)} → ${formatMoney(flow.totalAfter)}` },
    { key: "veredito", label: "Resposta do ML ao código", ok: flow.verdict?.status === "valido", value: flow.verdict?.reason || "—" },
  );
  return checks;
}

// A entrada do teste, validada. Vale para os dois caminhos (o Chrome do servidor
// e o do admin): a URL passa pelo urlGuard, o código é normalizado e o modo é uma
// lista fechada. Sem isto, o caminho local teria a própria validação — e a porta
// de fora ficaria mais frouxa que a de dentro.
async function validarPedido({ url, code = null, mode = "leitura" } = {}) {
  const { url: cleanUrl, store } = await urlGuard.assertStoreUrl(url);
  if (store !== "Mercado Livre") {
    throw new Error("Por enquanto só testo cupom de produto do Mercado Livre.");
  }
  const cleanCode = normalizeCode(code);
  const cleanMode = ["checkout", "rapido", "leitura"].includes(mode) ? mode : "leitura";
  if (cleanMode !== "leitura" && !cleanCode) {
    throw new Error("Escreva o código do cupom pra testar (ou use o modo só leitura).");
  }
  return { url: cleanUrl, store, code: cleanCode, mode: cleanMode };
}

// O resultado como a tela do admin espera. Comum aos dois caminhos: o veredito, os
// `checks` e os totais saem das mesmas funções, então um teste feito no Chrome do
// admin e um feito no servidor se leem igual.
function montarResultado({ flow, verdict, url, code, mode, store, t0, quick = null, shots = null, fonte = null }) {
  return {
    at: new Date().toISOString(),
    durationMs: Date.now() - t0,
    url,
    code,
    mode,
    store,
    status: verdict.status,
    reason: verdict.reason,
    discount: verdict.discount,
    clipped: flow.clipped,
    totalBefore: flow.totalBefore,
    totalAfter: flow.totalAfter,
    checkout: flow.checkout,
    finalUrl: flow.finalUrl,
    fonte: fonte || (mode === "leitura" ? "leitura" : "checkout"),
    // O que o caminho rápido apurou antes de passar a bola. Sem isso a tela
    // esquece que o ML já disse que o cupom existe e está valendo.
    quick,
    checks: buildChecks(flow, { mode, code }),
    shots,
  };
}

// ────────────────────────────────────────────────────────────────────────
// O mesmo teste, no Chrome do admin (a extensão)
// ────────────────────────────────────────────────────────────────────────
//
// Desde 25/08/2026 o ML barra o navegador automatizado com CAPTCHA já na página do
// produto — o caminho de cima quase nunca chega ao checkout. Numa aba do Chrome do
// admin, com a sessão dele, o checkout é só o checkout.
//
// A divisão é a de sempre: a extensão CAMINHA (clica em "Continuar", digita o
// código, lê a tela) e devolve material cru; a leitura do que aquilo significa —
// `classifyCouponResult`, `extractCheckoutTotal`, `parseProductCoupons` — continua
// aqui, nas mesmas funções puras do caminho antigo.

// Passo 1: o caminho rápido, que responde sem abrir nada. Devolve
// `{ conclui: true, result }` quando já dá pra responder, ou o pedido validado
// para a extensão executar.
async function prepararTesteLocal({ url, code = null, mode = "checkout" } = {}) {
  const pedido = await validarPedido({ url, code, mode });
  const t0 = Date.now();

  if (pedido.mode !== "leitura") {
    // O caminho rápido pode precisar do Chrome do SERVIDOR (para descobrir a
    // palavra na aba /cupons) e falhar por falta de cookie. Isso não pode matar o
    // teste inteiro: quem vai caminhar pelo checkout é a aba do admin, que não
    // depende do cookie do servidor pra nada. No modo "rapido" a falha é o
    // resultado — não há para onde seguir.
    let quick = null;
    let quickErro = null;
    try {
      quick = await require("../coupons/quick-check").quickCheck({ url: pedido.url, code: pedido.code });
    } catch (err) {
      if (pedido.mode === "rapido") throw err;
      quickErro = err.message;
    }
    if (quick && (quick.conclui || pedido.mode === "rapido")) {
      const result = {
        at: new Date().toISOString(), durationMs: Date.now() - t0,
        url: pedido.url, code: pedido.code, mode: pedido.mode, store: pedido.store,
        status: quick.status, reason: quick.reason, discount: quick.discount,
        fonte: "rapido", quick, clipped: [],
        totalBefore: quick.priceBefore ?? null, totalAfter: quick.priceAfter ?? null,
        checkout: null, finalUrl: pedido.url, checks: buildQuickChecks(quick), shots: null,
      };
      pushHistory({ at: result.at, durationMs: result.durationMs, url: result.url, code: result.code,
        mode: result.mode, status: result.status, reason: result.reason, discount: result.discount, fonte: result.fonte });
      return { conclui: true, result };
    }
    return { conclui: false, ...pedido, quick, quickErro };
  }
  return { conclui: false, ...pedido, quick: null };
}

// Passo 2: o material que a extensão trouxe vira resultado.
//
// `material` é o que `extension/checkout.js` devolve — nada interpretado: URLs,
// textos de tela, os corpos JSON que o checkout buscou e a trilha do que foi
// clicado. Os totais saem do `extractCheckoutTotal` daqui, sobre o texto das telas
// certas: o "antes" e o "depois" TÊM que ser da mesma tela, senão a queda é de
// frete e não de cupom — e isso viraria "cupom válido" sem cupom nenhum.
async function resultadoTesteLocal({ url, code = null, mode = "checkout", material = {}, quick = null } = {}) {
  const pedido = await validarPedido({ url, code, mode });
  const t0 = Number(material.t0) || Date.now();
  const checkout = material.checkout || {};

  const flow = {
    finalUrl: material.finalUrl || pedido.url,
    title: material.title || null,
    pdpBlocked: material.muro ? { blocked: true, kind: material.muro, reason: material.motivo || null } : null,
    clipped: parseProductCoupons(material.clippedTexts || []),
    checkout: {
      attempted: !!checkout.attempted, reached: !!checkout.reached, via: checkout.via || null,
      url: checkout.url || null, blockedReason: checkout.blockedReason || null,
      variacao: checkout.variacao || null,
      stepReached: !!checkout.stepReached, steps: checkout.steps ?? 0, trail: checkout.trail || [],
      couponOpen: checkout.couponOpen || null, botaoCupom: checkout.botao || null,
      fieldFound: !!checkout.fieldFound, applied: !!checkout.applied,
      cartUsed: checkout.via === "carrinho", cartCleaned: checkout.cartCleaned ?? null,
      totalAtEntry: extractCheckoutTotal(material.bodyTextAoEntrar || ""),
    },
    totalBefore: extractCheckoutTotal(material.bodyTextAntes || ""),
    totalAfter: extractCheckoutTotal(material.bodyTextDepois || ""),
  };

  let verdict;
  if (material.muro) {
    verdict = classifyCouponResult({ finalUrl: flow.finalUrl, bodyText: material.bodyTextDepois || material.bodyTextAntes || "" });
  } else if (material.notProductPage) {
    verdict = { ok: false, status: "indeterminado", discount: null,
      reason: `Esse link não abriu a página de um produto — a aba parou em ${flow.finalUrl}. Link de perfil de afiliado ("source=affiliate-profile", "/social/…") leva pra vitrine do afiliado, não pro produto: abra o produto no ML e cole o link direto dele.` };
  } else if (pedido.mode !== "checkout" || !pedido.code) {
    verdict = { ok: true, status: "leitura", discount: null,
      reason: flow.clipped.length
        ? `A página oferece ${flow.clipped.length} cupom(ns). Nenhum código foi testado no checkout.`
        : "A página não oferece nenhum cupom, e nenhum código foi testado no checkout." };
  } else if (!checkout.reached) {
    verdict = { ok: false, status: "indeterminado", discount: null,
      reason: checkout.blockedReason
        ? (checkout.variacao
            ? `O produto não pode ser comprado direto nem depois de eu escolher "${checkout.variacao}": "${checkout.blockedReason}". Escolha a variação na página do ML e cole aqui o link já com ela.`
            : `O produto não pode ser comprado direto: "${checkout.blockedReason}". Escolha a variação na página do ML e cole aqui o link já com ela.`)
        : `Não deu pra chegar no checkout a partir da página do produto (parou em ${checkout.url}). A tela de compra pode ter mudado.` };
  } else if (!checkout.fieldFound) {
    verdict = { ok: false, status: "indeterminado", discount: null,
      reason: checkout.stepReached ? describeCouponOpen(checkout.couponOpen) : describeStall(checkout) };
  } else {
    verdict = classifyCouponResult({
      finalUrl: flow.finalUrl,
      bodyText: material.bodyTextDepois || "",
      apiJson: (material.respostas || []).map((corpo) => { try { return JSON.parse(corpo); } catch { return null; } }).filter(Boolean),
      totalBefore: flow.totalBefore,
      totalAfter: flow.totalAfter,
    });
  }

  const out = montarResultado({
    flow, verdict, url: pedido.url, code: pedido.code, mode: pedido.mode, store: pedido.store, t0,
    quick, fonte: pedido.mode === "leitura" ? "leitura" : "checkout-extensao",
  });
  pushHistory({ at: out.at, durationMs: out.durationMs, url: out.url, code: out.code,
    mode: out.mode, status: out.status, reason: out.reason, discount: out.discount, fonte: out.fonte });
  return out;
}

// Testa UM cupom, na hora. Não grava nada na fila e não envia nada — é o irmão do
// tester.testLink, no mesmo formato de retorno.
async function testCoupon({ url, code = null, mode = "leitura" } = {}) {
  if (_running) throw new Error("Já tem um teste de cupom rodando — espere ele terminar.");

  // É a MESMA conta do ML da rodada de cupons e do Hub. Dois Chromes nela ao
  // mesmo tempo dobram a chance de CAPTCHA — e o CAPTCHA vale pra conta, então
  // derruba os três juntos. É a mesma recusa que o `startImport` já faz.
  const mlCupons = require("./ml-cupons");
  if (mlCupons.isRunning()) {
    throw new Error("Tem uma rodada de cupons do ML rodando — espere ela terminar para testar um cupom.");
  }

  // A trava tem que valer para o teste INTEIRO, caminho rápido incluído: ele
  // também pode abrir um Chrome (o teste de palavra na aba /cupons). Marcar só na
  // hora do checkout deixava duas requisições passarem pela guarda acima e
  // chegarem juntas na conta do sistema.
  _running = executarTeste({ url, code, mode });
  try {
    const out = await _running;
    pushHistory({
      at: out.at, durationMs: out.durationMs, url: out.url, code: out.code,
      mode: out.mode, status: out.status, reason: out.reason, discount: out.discount, fonte: out.fonte,
    });
    return out;
  } finally {
    _running = null;
    _quickPendente = null;
    pruneRuns(SHOTS_DIR);
  }
}

async function executarTeste({ url, code = null, mode = "leitura" } = {}) {
  const affiliate = require("./affiliate");   // lazy: evita ciclo no boot
  const session = affiliate.getScraperMLSession();
  if (!session) {
    throw new Error("Sem sessão do Mercado Livre do sistema — cole o cookie em Admin › Mercado Livre.");
  }

  const { url: cleanUrl, store, code: cleanCode, mode: cleanMode } = await validarPedido({ url, code, mode });

  // O caminho rápido primeiro: ele responde pelo que o sistema já sabe, em
  // segundos e sem levar o produto ao checkout. O checkout só continua existindo
  // pro que ele não conclui — e desde 25/08/2026 o ML barra o Chrome com CAPTCHA
  // já na página do produto, então quanto menos se depender dele, melhor.
  if (cleanMode !== "leitura") {
    const t0Rapido = Date.now();
    const quick = await require("../coupons/quick-check").quickCheck({ url: cleanUrl, code: cleanCode });
    if (quick.conclui || cleanMode === "rapido") {
      return {
        at: new Date().toISOString(),
        durationMs: Date.now() - t0Rapido,
        url: cleanUrl, code: cleanCode, mode: cleanMode, store,
        status: quick.status,
        reason: quick.reason,
        discount: quick.discount,
        fonte: "rapido",
        quick,
        clipped: [],
        totalBefore: quick.priceBefore ?? null,
        totalAfter: quick.priceAfter ?? null,
        checkout: null,
        finalUrl: cleanUrl,
        checks: buildQuickChecks(quick),
        shots: null,
      };
    }
    // Não concluiu e o modo permite ir adiante: o checkout assume, e o que o
    // caminho rápido descobriu vai junto no resultado.
    _quickPendente = quick;
  }

  const t0 = Date.now();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  // Print de cada etapa, sempre. Quando o teste dá "indeterminado", a pergunta
  // seguinte é sempre "o que estava na tela?" — e antes só o dump respondia isso,
  // rodado depois, quando a tela já podia estar diferente.
  const shots = makeStageRecorder(path.join(SHOTS_DIR, stamp));

  const flow = await runCouponFlow(session.cookie, { url: cleanUrl, code: cleanCode, mode: cleanMode }, { onStage: shots.onStage });
  const verdict = flow.verdict || {
    ok: true, status: "leitura", discount: null,
    reason: flow.clipped.length
      ? `A página oferece ${flow.clipped.length} cupom(ns). Nenhum código foi testado no checkout.`
      : "A página não oferece nenhum cupom, e nenhum código foi testado no checkout.",
  };

  return montarResultado({
    flow, verdict, url: cleanUrl, code: cleanCode, mode: cleanMode, store, t0,
    quick: _quickPendente,
    shots: { dir: shots.outDir, files: shots.salvos },
  });
}

function isRunning() {
  return !!_running;
}

// ────────────────────────────────────────────────────────────────────────
// Dump — a sonda que se roda quando o ML muda a tela
// ────────────────────────────────────────────────────────────────────────

// Salva em disco tudo que o fluxo viu: HTML e print de cada etapa, todas as
// respostas JSON do ML e um resumo. É o que permite escrever seletor olhando a
// página de verdade, do mesmo jeito que o dumpHub fez pelo Hub.
// NUNCA grava o cookie nem cabeçalhos de autenticação.
async function dumpCoupon(cookie, { url, code = null, mode = "checkout" } = {}, outDir) {
  const { onStage } = makeStageRecorder(outDir, { html: true });
  const flow = await runCouponFlow(cookie, { url, code, mode }, { captureAll: true, onStage });

  fs.writeFileSync(path.join(outDir, "coupon-xhr.json"), JSON.stringify(flow.allResponses, null, 2));
  fs.writeFileSync(path.join(outDir, "coupon-responses.json"), JSON.stringify(flow.responses, null, 2));
  fs.writeFileSync(path.join(outDir, "coupon-meta.json"), JSON.stringify({
    at: new Date().toISOString(),
    url, code, mode,
    finalUrl: flow.finalUrl,
    title: flow.title,
    blocked: flow.pdpBlocked,
    clipped: flow.clipped,
    checkout: flow.checkout,
    totalBefore: flow.totalBefore,
    totalAfter: flow.totalAfter,
    verdict: flow.verdict,
    xhrCount: flow.allResponses.length,
    couponXhrCount: flow.responses.length,
  }, null, 2));

  return {
    outDir,
    verdict: flow.verdict,
    clipped: flow.clipped,
    checkout: flow.checkout,
    xhrCount: flow.allResponses.length,
    couponXhrCount: flow.responses.length,
    finalUrl: flow.finalUrl,
  };
}

module.exports = {
  prepararTesteLocal,
  resultadoTesteLocal,
  validarPedido,
  testCoupon,
  dumpCoupon,
  readHistory,
  isRunning,
  // puros — expostos pros testes
  parseMoney,
  formatMoney,
  normalizeCode,
  extractCheckoutTotal,
  parseProductCoupons,
  describeTrail,
  describeStall,
  describeCouponOpen,
  collectMessages,
  classifyCouponResult,
  buildChecks,
  buildQuickChecks,
  isProductPage,
  VERDICT_PATTERNS,
  HISTORY_MAX,
};
