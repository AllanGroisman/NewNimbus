// Testar o cupom do REPASSE no checkout do produto que chegou com ele (task 7).
//
// O caminho: página do produto → "Comprar agora" → "Finalize sua compra" → o link
// "Cupons (N/M em uso)" do Resumo da compra → o modal "Cupons". O conteúdo do modal
// mora num IFRAME (`iframe#bf_coupons_iframe`, `/cupons/cho`) do mesmo domínio: é
// por isso que o `checkout.js` nunca achava o campo do código — ele procurava no
// documento de cima. Aqui tudo que é do modal é buscado DENTRO do iframe.
//
// Os freios são os do checkout.js: nunca clica em "Pagar e finalizar" (os únicos
// cliques são "Comprar agora", a linha dos cupons, "Inserir" e o "X"), não usa o
// carrinho e a aba é sempre fechada.
//
// Nada é interpretado aqui. Quem decide "ja_aplicado / aplicado_agora / falha" e
// lê as condições do cartão é o servidor (backend/repasse/checkout-cupom.js).

import { sleep, abrir, irPara, fechar, avaliar, esperarHumano, classificarMuro } from "./aba.js";
import {
  API_RE, COUPON_OPEN_SRC, lerTempos, ehPaginaDeProduto, irAoCheckout,
  naPagina_espiao, naPagina_foto, naPagina_clicarPorTexto, naPagina_clicarLinhaDoCupom,
  naPagina_paginaDosCupons, naPagina_buscarPagina,
} from "./checkout.js";

const INSERIR_ESPERA_MS = 2000;
const RESPOSTA_ESPERA_MS = 8000;
const MODAL_ESPERA_MS = 15000;
const TETO_HTML_CUPONS = 400_000;

// ── o que roda DENTRO da página ──────────────────────────────────────────
// Uma função só, com a ação como argumento: o executeScript serializa a função, e
// o "onde está o modal" precisa ser o mesmo em todas as ações.
//
//   estado  → o que o modal mostra agora (campo, cartão do código, erro do campo)
//   digitar → limpa o campo e digita o código, letra a letra
//   inserir → clica em "Inserir"
//   fechar  → o "X" do modal
export function naPagina_modalCupons(acao, codigo) {
  const limpa = (t) => String(t || "").replace(/\s+/g, " ").trim();
  const textoDe = (el) => (el ? (el.innerText ?? el.textContent ?? "") : "");

  if (acao === "fechar") {
    const x = document.querySelector(".andes-modal__close-button, button[aria-label*='fechar' i], button[aria-label*='close' i]");
    if (x) { x.click(); return { ok: true }; }
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return { ok: false };
  }

  // Onde está o modal: o iframe dentro da página de checkout, ou a própria página
  // `/cupons/cho` quando a aba foi mandada direto para ela (o plano B).
  let doc = null;
  let onde = null;
  const f = document.querySelector("iframe#bf_coupons_iframe") || document.querySelector("iframe[src*='/cupons/cho']");
  if (f) {
    try { doc = f.contentDocument; } catch { doc = null; }
    if (doc?.body) onde = "iframe"; else doc = null;
  }
  if (!doc && /\/cupons\/cho/.test(location.pathname)) { doc = document; onde = "pagina"; }
  if (!doc) return { onde: null, pronto: false, campo: false, cartao: null, erroCampo: null, economia: null };

  const W = doc.defaultView || window;
  const campo = doc.querySelector("#inputcode-textfield-inline")
    || doc.querySelector("input[placeholder*='código' i], input[placeholder*='codigo' i]");
  const alvo = String(codigo || "").trim().toUpperCase();

  if (acao === "digitar") {
    if (!campo || !alvo) return { ok: false };
    campo.focus();
    campo.click?.();
    // O React do ML não enxerga `el.value = x`: o setter nativo + o evento é o que
    // faz o "Inserir" acompanhar. Letra a letra, como quem digita.
    const setter = Object.getOwnPropertyDescriptor(W.HTMLInputElement.prototype, "value").set;
    setter.call(campo, "");
    campo.dispatchEvent(new W.Event("input", { bubbles: true }));
    for (let i = 1; i <= alvo.length; i++) {
      setter.call(campo, alvo.slice(0, i));
      campo.dispatchEvent(new W.Event("input", { bubbles: true }));
    }
    campo.dispatchEvent(new W.Event("change", { bubbles: true }));
    return { ok: true, valor: campo.value };
  }

  if (acao === "inserir") {
    const botoes = Array.from(doc.querySelectorAll("button, [role='button']"))
      .filter(b => /^inserir$/i.test(limpa(b.textContent)));
    // O mais perto do campo, quando há mais de um.
    const perto = campo && botoes.find(b => campo.closest("form, .andes-form-control")?.parentElement?.contains(b));
    const botao = perto || botoes[0];
    if (!botao) return { ok: false, motivo: "sem-botao" };
    if (botao.disabled === true || botao.getAttribute("aria-disabled") === "true") return { ok: false, motivo: "desabilitado" };
    botao.click();
    return { ok: true };
  }

  // ── estado ──
  const reCom = alvo ? new RegExp(`\\bcom\\s+${alvo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i") : null;
  // O cartão do código: o elemento mais interno com "Com <CÓDIGO>", subindo até o
  // bloco que tem o botão do cartão ("Aplicado" / "Aplicar").
  let cartao = null;
  if (reCom) {
    const folhas = Array.from(doc.querySelectorAll("body *"))
      .filter(el => reCom.test(limpa(el.textContent)) && !Array.from(el.children).some(c => reCom.test(limpa(c.textContent))));
    for (const folha of folhas) {
      let el = folha;
      for (let i = 0; i < 8 && el && el !== doc.body && !el.querySelector("button"); i++) el = el.parentElement;
      if (!el || el === doc.body || (campo && el.contains(campo))) continue;
      const botao = el.querySelector("button");
      const txtBotao = limpa(botao?.textContent);
      const desabilitado = !!botao && (botao.disabled === true
        || /andes-button--disabled/.test(botao.className || "")
        || botao.getAttribute("aria-disabled") === "true");
      const check = !!el.querySelector("[class*='check' i], [class*='success' i]");
      cartao = {
        texto: String(textoDe(el)).slice(0, 1500),
        botao: txtBotao || null,
        desabilitado,
        check,
        aplicado: /aplicad/i.test(txtBotao) && (desabilitado || check),
      };
      break;
    }
  }

  const ctl = (campo && campo.closest(".andes-form-control")) || doc.querySelector(".andes-form-control--error");
  let erroCampo = null;
  if (ctl && /andes-form-control--error/.test(ctl.className || "")) {
    const msg = ctl.querySelector(".andes-form-control__message, .andes-form-control__bottom");
    erroCampo = limpa(textoDe(msg || ctl)).slice(0, 300) || null;
  }

  const texto = limpa(textoDe(doc.body));
  const eco = texto.match(/voc[êe] est[áa] economizando[^|]{0,60}?cupo(m|ns)/i);
  return {
    onde,
    pronto: !!campo || !!cartao,
    campo: !!campo,
    cartao,
    erroCampo,
    economia: eco ? eco[0] : null,
    texto: texto.slice(0, 4000),
  };
}

// ── o comando ────────────────────────────────────────────────────────────

export async function cupomNoCheckout({ url, code, tempos = null }, progresso) {
  const T = lerTempos(tempos);
  const codigo = String(code || "").trim().toUpperCase();
  if (!url || !codigo) throw new Error("faltou o link do produto ou o código");

  const tabId = await abrir(url);
  const material = {
    t0: Date.now(),
    code: codigo,
    finalUrl: null, muro: null, motivo: null, notProductPage: false,
    checkout: { attempted: false, reached: false, via: null, url: null, blockedReason: null, variacao: null, seguro: null },
    modal: { aberto: false, onde: null, campo: false, tentativas: [], planoB: false },
    cartaoAntes: null, cartaoDepois: null, erroCampo: null, economia: null,
    digitou: null, inseriu: null,
    resumoAntes: "", resumoDepois: "", textoDoModal: "",
    htmlCupons: null,
  };

  const foto = () => avaliar(tabId, naPagina_foto, [], { mundoDaPagina: true })
    .then(r => r || { url: "", titulo: "", tituloDaAba: "", texto: "", digital: "", respostas: [] });
  const clicar = (src, maxLen) => avaliar(tabId, naPagina_clicarPorTexto, [src, maxLen], { mundoDaPagina: true });
  const modal = (acao) => avaliar(tabId, naPagina_modalCupons, [acao, codigo], { mundoDaPagina: true })
    .then(r => r || { onde: null, pronto: false });

  try {
    await avaliar(tabId, naPagina_espiao, [API_RE], { mundoDaPagina: true });
    await sleep(T.settleMs);

    let tela = await foto();
    material.finalUrl = tela.url;

    // O muro: a extensão não contorna — traz a aba pra frente e espera o humano.
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
        return material;
      }
      tela = await foto();
      material.finalUrl = tela.url;
    }

    if (!ehPaginaDeProduto(tela.url)) {
      material.notProductPage = true;
      return material;
    }

    // ── até o checkout ──
    // Sem o carrinho: ele é o único caminho que deixa rastro na conta, e o cupom
    // do carrinho combinado não é a resposta para ESTE produto.
    material.checkout.attempted = true;
    const ida = await irAoCheckout(tabId, { foto, clicar, progresso, T, semCarrinho: true });
    Object.assign(material.checkout, ida);
    if (!ida.reached) return material;

    const noCheckout = await foto();
    material.resumoAntes = noCheckout.texto;
    const muroNoCheckout = classificarMuro(noCheckout.url, noCheckout.texto, noCheckout.tituloDaAba);
    if (muroNoCheckout) { material.muro = muroNoCheckout; return material; }

    // O endereço da página dos cupons sai do HTML do checkout ANTES de abrir o
    // modal: é o plano B se o clique não montar o iframe, e é de onde vem a
    // campanha do código (o modelo `buyingFlowData` que o servidor já lê).
    const enderecoDosCupons = await avaliar(tabId, naPagina_paginaDosCupons, [], { mundoDaPagina: true }).catch(() => null);

    // ── o modal "Cupons" ──
    progresso({ tipo: "cupons-modal" });
    let estado = await modal("estado");
    for (let nivel = 0; nivel <= 2 && !estado.pronto; nivel++) {
      const clicou = await avaliar(tabId, naPagina_clicarLinhaDoCupom, [COUPON_OPEN_SRC, nivel], { mundoDaPagina: true });
      material.modal.tentativas.push({ nivel, clicou: clicou?.texto || null });
      if (!clicou) break;
      for (let i = 0; i < Math.ceil(MODAL_ESPERA_MS / 500); i++) {
        await sleep(500);
        estado = await modal("estado");
        if (estado.pronto) break;
      }
    }
    // Plano B: o clique não montou o iframe. A mesma página, aberta na própria aba.
    if (!estado.pronto && enderecoDosCupons) {
      material.modal.planoB = true;
      await irPara(tabId, enderecoDosCupons).catch(() => {});
      for (let i = 0; i < Math.ceil(MODAL_ESPERA_MS / 500); i++) {
        estado = await modal("estado");
        if (estado.pronto) break;
        await sleep(500);
      }
    }
    material.modal.aberto = !!estado.pronto;
    material.modal.onde = estado.onde || null;
    material.modal.campo = !!estado.campo;
    material.textoDoModal = estado.texto || "";
    if (!estado.pronto) return material;

    // ── o cupom já está aplicado? ──
    material.cartaoAntes = estado.cartao || null;
    material.economia = estado.economia || null;
    if (!material.cartaoAntes?.aplicado && estado.campo) {
      // ── ativar pelo código ──
      material.digitou = await modal("digitar");
      await sleep(600);   // o React habilita o "Inserir" depois do input
      material.inseriu = await modal("inserir");
      progresso({ tipo: "aplicado", code: codigo });
      await sleep(INSERIR_ESPERA_MS);
      for (let i = 0; i < Math.ceil(RESPOSTA_ESPERA_MS / 500); i++) {
        estado = await modal("estado");
        if (estado.erroCampo || estado.cartao?.aplicado) break;
        await sleep(500);
      }
      material.erroCampo = estado.erroCampo || null;
      material.cartaoDepois = estado.cartao || null;
      material.economia = estado.economia || material.economia;
      material.textoDoModal = estado.texto || material.textoDoModal;
    }

    // O resumo DEPOIS: "Cupons (N/M em uso)", o desconto e o total. Só existe com
    // o modal por cima da página de checkout (no plano B a aba é a de cupons).
    if (!material.modal.planoB) {
      await sleep(T.settleMs);
      material.resumoDepois = (await foto()).texto;
    }

    // A página dos cupons, lida de novo depois do "Inserir": ela diz a campanha.
    if (enderecoDosCupons) {
      const pagina = await avaliar(tabId, naPagina_buscarPagina, [enderecoDosCupons, TETO_HTML_CUPONS], { mundoDaPagina: true }).catch(() => null);
      material.htmlCupons = pagina?.ok ? pagina.html : null;
    }

    if (!material.modal.planoB) await modal("fechar").catch(() => {});
    progresso({ tipo: "capturado" });
    return material;
  } finally {
    await fechar(tabId);
  }
}
