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
  naPagina_paginaDosCupons, naPagina_buscarPagina, naPagina_irParaProduto,
} from "./checkout.js";

const INSERIR_ESPERA_MS = 2000;
const VARIACAO_ESPERA_MS = 2000;
const VARIACAO_VOLTAS = 3;
const RESPOSTA_ESPERA_MS = 8000;
const MODAL_ESPERA_MS = 15000;
const TETO_HTML_CUPONS = 400_000;
// Modo depuração: a aba abre na frente e cada passo espera isto, com uma faixa no
// topo da página dizendo qual é — para o admin ver se o caminho é o certo.
const DEPURAR_PAUSA_MS = 3000;

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

  // Todos os cartões APLICADOS agora, venham com "Com <CÓDIGO>" ou não: o ML às
  // vezes mostra o cupom aplicado só com o nome da campanha (SITE250930). Quem
  // chama compara antes × depois do "Inserir" — um aplicado novo é o do código.
  const aplicados = [];
  for (const b of doc.querySelectorAll("button, [role='button']")) {
    if (!/^aplicad/i.test(limpa(b.textContent))) continue;
    const travado = b.disabled === true || /andes-button--disabled/.test(b.className || "")
      || b.getAttribute("aria-disabled") === "true";
    let el = b.parentElement;
    for (let i = 0; i < 8 && el && el !== doc.body && !/OFF|R\$/i.test(textoDe(el)); i++) el = el.parentElement;
    if (!el || el === doc.body || (campo && el.contains(campo))) continue;
    const check = !!el.querySelector("[class*='check' i], [class*='success' i]");
    if (!travado && !check) continue;
    // Com as quebras de linha: o servidor tira o nome do cupom da primeira linha.
    aplicados.push({ texto: String(textoDe(el)).trim().slice(0, 1500) });
  }

  const ctl = (campo && campo.closest(".andes-form-control")) || doc.querySelector(".andes-form-control--error");
  let erroCampo = null;
  if (ctl && /andes-form-control--error/.test(ctl.className || "")) {
    // Só o texto da mensagem: o Andes põe antes dela um rótulo "Erro" escondido
    // (leitor de tela) e um ícone, e o innerText do bloco trazia "Erro O cupom…".
    const msg = ctl.querySelector(".andes-form-control__message") || ctl.querySelector(".andes-form-control__bottom");
    const copia = (msg || ctl).cloneNode(true);
    copia.querySelectorAll(".andes-visually-hidden, [class*='visually-hidden'], svg, [class*='icon' i]").forEach(el => el.remove());
    erroCampo = limpa(textoDe(copia)).replace(/^Erro[:\s]+(?=\p{Lu})/u, "").slice(0, 300) || null;
  }

  const texto = limpa(textoDe(doc.body));
  const eco = texto.match(/voc[êe] est[áa] economizando[^|]{0,60}?cupo(m|ns)/i);
  return {
    onde,
    pronto: !!campo || !!cartao,
    campo: !!campo,
    cartao,
    aplicados,
    erroCampo,
    economia: eco ? eco[0] : null,
    texto: texto.slice(0, 4000),
  };
}

// Os dados do produto, lidos na PDP antes de sair dela: se o cupom valer, o
// servidor põe o produto no catálogo com ele (repasse/coupon-autotest.js
// :garantirNoCatalogo). Mesmos seletores do scraper do servidor
// (backend/scraping/scraper.js, o evaluate da PDP do ML) — tudo lido dentro da
// caixa de preço do produto principal, nunca do carrossel de recomendações.
export function naPagina_produto() {
  const limpa = (t) => String(t || "").replace(/\s+/g, " ").trim();
  const meta = (sel) => document.querySelector(sel)?.getAttribute("content")?.trim() || null;
  const moneyIn = (root, sel) => {
    const frac = root?.querySelector(`${sel} .andes-money-amount__fraction`);
    if (!frac) return null;
    const cents = root.querySelector(`${sel} .andes-money-amount__cents`);
    const v = parseFloat(`${frac.textContent.trim().replace(/\./g, "")}.${cents ? cents.textContent.trim() : "00"}`);
    return Number.isFinite(v) ? v : null;
  };

  const name = limpa(document.querySelector("h1.ui-pdp-title, .ui-pdp-title")?.textContent)
    || meta('meta[property="og:title"]') || null;
  const caixa = document.querySelector(".ui-pdp-price__main-container")
    || document.querySelector("#price_container")
    || document.querySelector(".ui-pdp-container__row--price")
    || document.querySelector(".ui-pdp-price");

  let price = moneyIn(caixa, ".andes-money-amount:not(.andes-money-amount--previous)");
  if (price == null) {
    const v = parseFloat(String(meta('meta[itemprop="price"]') || "").replace(",", "."));
    if (Number.isFinite(v)) price = v;
  }
  if (price == null) {
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const json = JSON.parse(s.textContent);
        const offers = [].concat(json.offers || json["@graph"]?.flatMap(g => g.offers || []) || []);
        const v = parseFloat(offers.find(o => o && o.price != null)?.price);
        if (Number.isFinite(v)) { price = v; break; }
      } catch { /* JSON-LD malformado */ }
    }
  }
  const originalPrice = moneyIn(caixa, ".andes-money-amount--previous");
  const pct = caixa?.querySelector(".andes-money-amount__discount")?.textContent.match(/(\d+)%/);
  const imgEl = document.querySelector(".ui-pdp-gallery__figure img, figure.ui-pdp-gallery__figure img, .ui-pdp-image");
  const img = imgEl?.getAttribute("data-zoom") || meta('meta[property="og:image"]') || imgEl?.getAttribute("src") || null;
  const sold = (document.body?.innerText || document.body?.textContent || "")
    .match(/\+?\s*[\d.,]+\s*(?:mil\s*|mi\s*)?vendid[oa]s?/i);

  return {
    name,
    price,
    originalPrice,
    discount: pct ? parseInt(pct[1], 10) : null,
    img,
    sold: sold ? sold[0] : null,
  };
}

// As variações do produto (tamanho, cor, voltagem…). Sem uma opção escolhida em
// cada grupo, o "Comprar agora" não sai da página e o ML mostra "Escolha Tamanho
// para continuar com sua compra.". `clicar` = escolhe a PRIMEIRA opção disponível
// de cada grupo que ainda não tem escolha; sem ele, só lê.
//
// O clique é sempre no ELEMENTO: a página rola sozinha depois de escolher, e
// coordenada fixa acertaria outra coisa (o seletor de quantidade fica logo acima).
export function naPagina_variacoes(clicar) {
  const limpa = (t) => String(t || "").normalize("NFC").replace(/\s+/g, " ").trim();
  const OPCAO = ".ui-pdp-outside_variations__thumbnails__item";
  const nomeDa = (el) => {
    const t = limpa(el.textContent);
    if (t) return t;
    const a = limpa(el.getAttribute("aria-label"));
    return a.includes(",") ? limpa(a.slice(a.indexOf(",") + 1)) : a;
  };
  const indisponivel = (el) => /--DISABLED|--disabled|--unavailable/.test(el.className || "")
    || el.getAttribute("aria-disabled") === "true";

  const grupos = [];
  for (const g of document.querySelectorAll(".ui-pdp-outside_variations__picker")) {
    const opcoes = Array.from(g.querySelectorAll(OPCAO));
    // O rótulo é o texto do grupo sem o das opções ("Tamanho: Escolha").
    const copia = g.cloneNode(true);
    copia.querySelectorAll(OPCAO).forEach(el => el.remove());
    const rotulo = limpa(copia.textContent).slice(0, 80);
    const escolhida = opcoes.find(o => /--SELECTED/.test(o.className || ""));
    const pedeEscolha = /\bescolha\b/i.test(rotulo);
    let clicou = null;
    if (clicar && (!escolhida || pedeEscolha)) {
      const alvo = opcoes.find(o => !indisponivel(o) && !/--SELECTED/.test(o.className || ""));
      if (alvo) { alvo.click(); clicou = nomeDa(alvo); }
    }
    grupos.push({ rotulo, escolhida: escolhida ? nomeDa(escolhida) : null, clicou, opcoes: opcoes.length });
  }

  const texto = limpa(document.body?.textContent);
  const alerta = texto.match(/Escolha [^.]{1,40}? para continuar com sua compra\.?/i);
  return {
    grupos,
    faltando: grupos.filter(g => (!g.escolhida || /\bescolha\b/i.test(g.rotulo)) && !g.clicou).map(g => g.rotulo),
    alerta: alerta ? alerta[0] : null,
  };
}

// O link do Resumo da compra que abre o modal "Cupons". Tem dois textos:
// "Cupons (N/M em uso)" com cupom aplicado e "Inserir código do cupom" sem nenhum —
// e aí o código com certeza não está aplicado.
export function naPagina_linkDosCupons() {
  const limpa = (t) => String(t || "").normalize("NFC").replace(/\s+/g, " ").trim();
  for (const el of document.querySelectorAll("a, button, [role='button']")) {
    const t = limpa(el.textContent);
    if (/^cupons?\s*\(/i.test(t) || /^inserir c[óo]digo do cupom$/i.test(t)) {
      el.click();
      return { texto: t.slice(0, 60), semCupom: /^inserir/i.test(t) };
    }
  }
  return null;
}

// A faixa do modo depuração, fixa no topo da página. Uma só: cada passo troca o texto.
export function naPagina_faixaDepuracao(rotulo) {
  let el = document.getElementById("__nimbus_depuracao");
  if (!el) {
    el = document.createElement("div");
    el.id = "__nimbus_depuracao";
    el.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:2147483647;padding:8px 14px;"
      + "background:#fde047;color:#111;font:600 14px/1.3 system-ui,sans-serif;"
      + "box-shadow:0 2px 6px rgba(0,0,0,.3);pointer-events:none";
    (document.body || document.documentElement).appendChild(el);
  }
  el.textContent = `🐞 Nimbus: ${rotulo}`;
  return true;
}

function ehLanding(url) {
  try { return /^\/social\//i.test(decodeURIComponent(new URL(String(url || "")).pathname)); } catch { return false; }
}

// ── o comando ────────────────────────────────────────────────────────────

export async function cupomNoCheckout({ url, code, tempos = null, depurar = false }, progresso) {
  const T = lerTempos(tempos);
  const codigo = String(code || "").trim().toUpperCase();
  if (!url || !codigo) throw new Error("faltou o link do produto ou o código");

  const tabId = await abrir(url, { ativa: !!depurar });
  const material = {
    t0: Date.now(),
    code: codigo,
    finalUrl: null, muro: null, motivo: null, notProductPage: false,
    checkout: { attempted: false, reached: false, via: null, url: null, blockedReason: null, variacao: null, seguro: null },
    modal: { aberto: false, onde: null, campo: false, link: null, semCupom: false, tentativas: [], planoB: false },
    cartaoAntes: null, cartaoDepois: null, erroCampo: null, economia: null,
    aplicadosAntes: [], aplicadosDepois: [],
    digitou: null, inseriu: null,
    variacao: null, variacaoFaltando: null,
    resumoAntes: "", resumoDepois: "", textoDoModal: "",
    htmlCupons: null,
    produto: null,
    landing: null,
  };

  const foto = () => avaliar(tabId, naPagina_foto, [], { mundoDaPagina: true })
    .then(r => r || { url: "", titulo: "", tituloDaAba: "", texto: "", digital: "", respostas: [] });
  // Sem `depurar` não faz nada. Com ele: avisa a tela, escreve na faixa e espera.
  const passo = async (rotulo) => {
    if (!depurar) return;
    progresso({ tipo: "passo-depuracao", rotulo });
    await avaliar(tabId, naPagina_faixaDepuracao, [rotulo], { mundoDaPagina: true }).catch(() => {});
    await sleep(DEPURAR_PAUSA_MS);
  };
  // Os cliques do `irAoCheckout` também passam pelo `passo` — a regex buscada diz
  // em que botão ele vai clicar.
  const clicar = async (src, maxLen) => {
    await passo(`procurando o botão ${src}`);
    return avaliar(tabId, naPagina_clicarPorTexto, [src, maxLen], { mundoDaPagina: true });
  };
  const modal = (acao) => avaliar(tabId, naPagina_modalCupons, [acao, codigo], { mundoDaPagina: true })
    .then(r => r || { onde: null, pronto: false });

  try {
    await avaliar(tabId, naPagina_espiao, [API_RE], { mundoDaPagina: true });
    await sleep(T.settleMs);

    let tela = await foto();
    material.finalUrl = tela.url;
    await passo(`página aberta: ${tela.url}`);

    // O muro: a extensão não contorna — traz a aba pra frente e espera o humano.
    const olharMuro = async () => {
      const t = await foto();
      return { muro: classificarMuro(t.url, t.texto, t.tituloDaAba) };
    };
    // false = o muro ficou sem resolver e o material já diz isso.
    const passarDoMuro = async () => {
      const muro = (await olharMuro()).muro;
      if (!muro) return true;
      const resolvido = await esperarHumano(tabId, olharMuro, () => progresso({ tipo: "muro", muro }));
      if (!resolvido) {
        material.muro = muro;
        material.motivo = "o Mercado Livre pediu verificação e ela não foi resolvida";
        return false;
      }
      tela = await foto();
      material.finalUrl = tela.url;
      return true;
    };
    if (!(await passarDoMuro())) return material;

    // Link de afiliado (meli.la → /social/…): a landing não é o produto. Vai até a
    // PDP pelo "Ir para o produto" (ou pelo card em destaque), como o repasse faz.
    if (ehLanding(tela.url)) {
      await passo("link de afiliado: indo para o produto");
      const ir = await avaliar(tabId, naPagina_irParaProduto, [], { mundoDaPagina: true }).catch(() => null);
      material.landing = { de: tela.url, via: ir?.via || null, falhou: false };
      if (ir?.href) await irPara(tabId, ir.href);
      await sleep(T.settleMs);
      tela = await foto();
      material.finalUrl = tela.url;
      if (!(await passarDoMuro())) return material;
    }

    if (!ehPaginaDeProduto(tela.url)) {
      await passo(`não é página de produto (${tela.url}) — parando`);
      material.notProductPage = true;
      if (material.landing) material.landing.falhou = true;
      return material;
    }

    // Antes das variações e do "Comprar agora": é aqui que a PDP está inteira.
    material.produto = await avaliar(tabId, naPagina_produto, [], { mundoDaPagina: true }).catch(() => null) || null;
    await passo(`produto: ${material.produto?.name || "?"} · R$ ${material.produto?.price ?? "?"}`);

    // ── as variações, antes do "Comprar agora" ──
    // Os grupos podem depender um do outro (a cor libera tamanhos), por isso em
    // voltas, até ninguém mais precisar de escolha.
    const escolhidos = new Set();
    const prefixo = (rotulo) => String(rotulo || "").split(":")[0].trim();
    const lerVariacoes = () => avaliar(tabId, naPagina_variacoes, [false], { mundoDaPagina: true })
      .then(r => r || { grupos: [], faltando: [], alerta: null });
    const escolherVariacoes = async () => {
      for (let volta = 0; volta < VARIACAO_VOLTAS; volta++) {
        const r = await avaliar(tabId, naPagina_variacoes, [true], { mundoDaPagina: true }) || { grupos: [] };
        const clicados = (r.grupos || []).filter(g => g.clicou);
        if (!clicados.length) break;
        for (const g of clicados) escolhidos.add(prefixo(g.rotulo));
        progresso({ tipo: "variacao", escolhas: clicados.map(g => g.clicou) });
        await passo(`variação escolhida: ${clicados.map(g => g.clicou).join(", ")}`);
        await sleep(VARIACAO_ESPERA_MS);   // a página não recarrega, mas repinta
      }
      const final = await lerVariacoes();
      const escolha = (final.grupos || [])
        .filter(g => g.escolhida && escolhidos.has(prefixo(g.rotulo)))
        .map(g => (g.rotulo.includes(g.escolhida) ? g.rotulo : `${prefixo(g.rotulo)}: ${g.escolhida}`));
      material.variacao = escolha.length ? escolha.join(" · ") : null;
      return final;
    };
    await escolherVariacoes();

    // ── até o checkout ──
    // Sem o carrinho: ele é o único caminho que deixa rastro na conta, e o cupom
    // do carrinho combinado não é a resposta para ESTE produto.
    material.checkout.attempted = true;
    await passo("indo ao checkout (Comprar agora)");
    let ida = await irAoCheckout(tabId, { foto, clicar, progresso, T, semCarrinho: true });
    // Ficou na página do produto pedindo variação ("Escolha Tamanho para
    // continuar…"): escolhe de novo e tenta mais uma vez.
    if (!ida.reached && ehPaginaDeProduto((await foto()).url)) {
      const trava = await lerVariacoes();
      if (trava.alerta || trava.faltando?.length) {
        await escolherVariacoes();
        ida = await irAoCheckout(tabId, { foto, clicar, progresso, T, semCarrinho: true });
        if (!ida.reached) {
          const ainda = await lerVariacoes();
          if (ainda.alerta || ainda.faltando?.length) {
            material.variacaoFaltando = ainda.alerta || `Escolha: ${ainda.faltando.join(", ")}`;
          }
        }
      }
    }
    Object.assign(material.checkout, ida);
    if (!ida.reached) {
      await passo(`não chegou ao checkout${material.variacaoFaltando ? ` (${material.variacaoFaltando})` : ""} — parando`);
      return material;
    }
    await passo(`no checkout (via ${ida.via || "?"})`);

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
    await passo("abrindo o modal Cupons");
    let estado = await modal("estado");
    if (!estado.pronto) {
      const link = await avaliar(tabId, naPagina_linkDosCupons, [], { mundoDaPagina: true });
      await passo(link ? `clicou no link "${link.texto}"` : "link dos cupons não achado");
      if (link) {
        material.modal.link = link.texto;
        material.modal.semCupom = !!link.semCupom;
        for (let i = 0; i < Math.ceil(MODAL_ESPERA_MS / 500); i++) {
          await sleep(500);
          estado = await modal("estado");
          if (estado.pronto) break;
        }
      }
    }
    for (let nivel = 0; nivel <= 2 && !estado.pronto; nivel++) {
      await passo(`modal não abriu: tentando a linha do cupom (nível ${nivel})`);
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
      await passo("modal não abriu: plano B, abrindo a página /cupons/cho");
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
    if (!estado.pronto) {
      await passo("o modal Cupons não abriu — parando");
      return material;
    }

    // ── o cupom já está aplicado? ──
    // "Inserir código do cupom" = nenhum cupom aplicado: vai direto digitar.
    material.cartaoAntes = material.modal.semCupom ? null : (estado.cartao || null);
    material.economia = estado.economia || null;
    await passo(material.cartaoAntes?.aplicado
      ? `${codigo} já está aplicado — não vai digitar`
      : estado.campo ? `modal aberto (${estado.onde}); ${codigo} não aplicado` : `modal aberto (${estado.onde}), mas sem o campo do código`);
    material.aplicadosAntes = (estado.aplicados || []).map(a => a.texto);
    if (!material.cartaoAntes?.aplicado && estado.campo) {
      // ── ativar pelo código ──
      const jaEstavam = new Set(material.aplicadosAntes);
      const aplicadoNovo = (e) => (e.aplicados || []).find(a => !jaEstavam.has(a.texto)) || null;
      await passo(`digitando ${codigo}`);
      material.digitou = await modal("digitar");
      await sleep(600);   // o React habilita o "Inserir" depois do input
      await passo(`clicando em Inserir (campo: ${material.digitou?.valor ?? "?"})`);
      material.inseriu = await modal("inserir");
      progresso({ tipo: "aplicado", code: codigo });
      await sleep(INSERIR_ESPERA_MS);
      for (let i = 0; i < Math.ceil(RESPOSTA_ESPERA_MS / 500); i++) {
        estado = await modal("estado");
        if (estado.erroCampo || estado.cartao?.aplicado || aplicadoNovo(estado)) break;
        await sleep(500);
      }
      material.erroCampo = estado.erroCampo || null;
      material.cartaoDepois = estado.cartao || null;
      material.aplicadosDepois = (estado.aplicados || []).map(a => a.texto);
      // Sem o cartão "Com <CÓDIGO>" aplicado: o cartão que virou aplicado depois do
      // "Inserir" é o do código, com o nome que o ML quiser dar.
      const novo = !material.erroCampo && !material.cartaoDepois?.aplicado ? aplicadoNovo(estado) : null;
      if (novo) material.cartaoDepois = { texto: novo.texto, aplicado: true, porNome: false };
      material.economia = estado.economia || material.economia;
      material.textoDoModal = estado.texto || material.textoDoModal;
      await passo(material.erroCampo ? `ML recusou: ${material.erroCampo}`
        : material.cartaoDepois?.porNome === false ? `aplicado (reconhecido pelo cartão novo: "${material.cartaoDepois.texto.slice(0, 60)}")`
        : material.cartaoDepois?.aplicado ? `${codigo} aplicado` : "sem resposta clara do ML");
    }

    // A página dos cupons, lida de novo depois do "Inserir": ela diz a campanha.
    if (enderecoDosCupons) {
      const pagina = await avaliar(tabId, naPagina_buscarPagina, [enderecoDosCupons, TETO_HTML_CUPONS], { mundoDaPagina: true }).catch(() => null);
      material.htmlCupons = pagina?.ok ? pagina.html : null;
    }

    // O resumo DEPOIS: "Cupons (N/M em uso)", o desconto e o total. Lido com o
    // modal JÁ FECHADO — com ele aberto o resumo de baixo ainda não tinha se
    // atualizado (SITE250930). No plano B a aba é a dos cupons: não há resumo.
    await passo("fechando o modal");
    if (!material.modal.planoB) {
      await modal("fechar").catch(() => {});
      await sleep(T.settleMs);
      material.resumoDepois = (await foto()).texto;
      await passo(`resumo depois: ${(material.resumoDepois.match(/Cupons?\s*\([^)]*\)[^R]*(R\$\s?[\d.,]+)?/i) || ["sem “Cupons (N/M em uso)”"])[0]}`);
    }
    progresso({ tipo: "capturado" });
    return material;
  } finally {
    if (depurar) {
      await avaliar(tabId, naPagina_faixaDepuracao, ["fim — a aba fecha em instantes"], { mundoDaPagina: true }).catch(() => {});
      await sleep(DEPURAR_PAUSA_MS * 2);
    }
    await fechar(tabId);
  }
}
