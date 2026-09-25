// Esvaziar o carrinho do Mercado Livre (task 18), a pedido de Admin › Cupom ›
// Config Test.
//
// O carrinho é da CONTA, não da aba: o plano B do checkout (checkout.js) põe o
// produto lá, e quando a limpeza do fim do teste falha — aba fechada no meio, muro,
// timeout — o item fica. Com o tempo o carrinho vira uma pilha que muda os cupons
// que o checkout oferece (o ML calcula sobre o carrinho COMBINADO). Este comando
// tira tudo, um item por vez, do jeito que uma pessoa tiraria.
//
// Os freios:
//   - só clica em "Excluir/Remover" (e no "Excluir" da confirmação, se o ML pedir);
//     nunca em comprar, continuar ou salvar;
//   - não mexe nos "Salvos para depois": o botão que estiver depois do título dessa
//     seção fica de fora;
//   - cada clique precisa fazer o carrinho encolher; se não encolher, ele recarrega
//     uma vez e, se ainda assim nada mudar, desiste em vez de clicar em laço.

import { sleep, abrir, irPara, fechar, avaliar, esperarHumano, classificarMuro } from "./aba.js";

const CART_URL = "https://www.mercadolivre.com.br/gz/cart";
// Gêmeo do CART_REMOVE_SRC do checkout.js.
const REMOVER_SRC = "^(excluir|remover|tirar)( produto| item| do carrinho)?$";
const SETTLE_MS = 1500;
const ENCOLHER_ESPERA_MS = 8000;
// Teto de cliques: um carrinho do ML não passa disso, e laço sem teto é o que não
// pode existir numa ferramenta que clica sozinha na conta.
const MAX_ITENS = 100;

// ── o que roda DENTRO da página ──────────────────────────────────────────
//   estado  → quantos botões de remover há no carrinho (e o título de cada item)
//   remover → clica no primeiro
//   confirmar → o "Excluir" do modal de confirmação, se ele abriu
function naPagina_carrinho(acao, removerSrc) {
  const limpa = (t) => String(t || "").replace(/\s+/g, " ").trim();
  const visivel = (el) => el.offsetParent !== null || el.getClientRects().length > 0;
  const re = new RegExp(removerSrc, "i");
  const texto = limpa(document.body?.innerText).slice(0, 4000);

  if (acao === "confirmar") {
    const modal = Array.from(document.querySelectorAll(".andes-modal, [role='dialog'], [aria-modal='true']")).find(visivel);
    if (!modal) return { ok: false };
    const b = Array.from(modal.querySelectorAll("button, a, [role='button']"))
      .find(el => visivel(el) && /^(excluir|remover|sim|confirmar)\b/i.test(limpa(el.textContent)));
    if (!b) return { ok: false };
    b.click();
    return { ok: true, rotulo: limpa(b.textContent) };
  }

  // A seção "Salvos (para depois)" quando ela vem na MESMA página, abaixo do
  // carrinho. Quando ela é uma aba (`role=tab`), o conteúdo dela nem está visível.
  const salvos = Array.from(document.querySelectorAll("h1, h2, h3, h4, p, span, div, button, a"))
    .find(el => !el.closest("[role='tab']") && visivel(el) && el.children.length <= 1
      && /^(produtos )?salvos( para depois)?( \(\d+\))?$/i.test(limpa(el.textContent)));
  const antesDosSalvos = (el) => !salvos || !!(salvos.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING);

  const vistos = new Set();
  const botoes = [];
  for (const el of document.querySelectorAll("button, a, [role='button']")) {
    if (vistos.has(el) || !visivel(el) || !re.test(limpa(el.textContent))) continue;
    if (el.disabled === true || el.getAttribute("aria-disabled") === "true") continue;
    if (el.closest(".andes-modal, [role='dialog']")) continue;
    if (!antesDosSalvos(el)) continue;
    vistos.add(el);
    botoes.push(el);
  }

  // O nome do item, para a tela dizer O QUE saiu. Melhor esforço: o alt da foto
  // ou o link do produto dentro do bloco do item.
  const tituloDe = (el) => {
    for (let p = el.parentElement, i = 0; p && i < 8; p = p.parentElement, i++) {
      const img = p.querySelector("img[alt]");
      const link = Array.from(p.querySelectorAll("a[href]")).find(a => /MLB|\/p\/|produto\.mercadolivre/i.test(a.href) && limpa(a.textContent).length > 3);
      const t = limpa(link?.textContent) || limpa(img?.alt);
      if (t) return t.slice(0, 120);
    }
    return null;
  };

  if (acao === "remover") {
    const b = botoes[0];
    if (!b) return { ok: false };
    const titulo = tituloDe(b);
    b.click();
    return { ok: true, titulo };
  }

  return {
    url: location.href,
    tituloDaAba: document.title,
    texto,
    botoes: botoes.length,
    itens: botoes.map(tituloDe),
    vazio: /(seu )?carrinho est[áa] vazio|n[ãa]o h[áa] produtos no (seu )?carrinho/i.test(texto),
    temSalvos: !!salvos,
  };
}

export async function esvaziarCarrinho(_msg, progresso) {
  const tabId = await abrir(CART_URL);
  const estado = () => avaliar(tabId, naPagina_carrinho, ["estado", REMOVER_SRC], { mundoDaPagina: true });
  const removidos = [];

  try {
    await sleep(SETTLE_MS);   // o carrinho pinta os itens por JS depois do load
    let e = await estado();

    if (!e.botoes && !e.vazio) {
      const muro = classificarMuro(e.url, e.texto, e.tituloDaAba);
      if (muro) {
        const reler = async () => { const t = await estado(); return { muro: t.botoes || t.vazio ? null : classificarMuro(t.url, t.texto, t.tituloDaAba) }; };
        const ok = await esperarHumano(tabId, reler, () => progresso({ tipo: "muro", muro }));
        if (!ok) return { removidos: 0, itens: [], restantes: null, vazio: false, motivo: `o Mercado Livre pediu ${muro} e ninguém resolveu a tempo` };
        await irPara(tabId, CART_URL);
        await sleep(SETTLE_MS);
        e = await estado();
      }
    }

    progresso({ tipo: "carrinho", itens: e.botoes });
    let recarregou = false;

    while (e.botoes > 0 && removidos.length < MAX_ITENS) {
      const antes = e.botoes;
      const r = await avaliar(tabId, naPagina_carrinho, ["remover", REMOVER_SRC], { mundoDaPagina: true });
      if (!r?.ok) break;

      // Espera o carrinho encolher. Se o ML abriu uma confirmação, ela é clicada
      // aqui mesmo — e só ela: o "Excluir" do modal, nunca outro botão.
      let encolheu = false;
      for (let t = 0; t < ENCOLHER_ESPERA_MS; t += 500) {
        await sleep(500);
        await avaliar(tabId, naPagina_carrinho, ["confirmar", REMOVER_SRC], { mundoDaPagina: true }).catch(() => null);
        e = await estado().catch(() => e);
        if (e.botoes < antes || e.vazio) { encolheu = true; break; }
      }

      if (encolheu) {
        removidos.push(r.titulo || null);
        recarregou = false;
        progresso({ tipo: "removeu", titulo: r.titulo || null, n: removidos.length, restantes: e.botoes });
        await sleep(400 + Math.floor(Math.random() * 400));
        continue;
      }

      // Não encolheu: às vezes a lista só atualiza no reload. Uma vez; na segunda
      // sem mudança, para — clicar de novo no mesmo botão é o laço que não se quer.
      if (recarregou) return { removidos: removidos.length, itens: removidos, restantes: e.botoes, vazio: false, motivo: "cliquei em excluir e o carrinho não mudou" };
      recarregou = true;
      await irPara(tabId, CART_URL);
      await sleep(SETTLE_MS);
      e = await estado();
      if (e.botoes < antes) { removidos.push(r.titulo || null); progresso({ tipo: "removeu", titulo: r.titulo || null, n: removidos.length, restantes: e.botoes }); }
    }

    // A conferência final vem de um carrinho recarregado, não da tela que a gente
    // mesmo mexeu: é o que o ML guardou que conta.
    await irPara(tabId, CART_URL);
    await sleep(SETTLE_MS);
    e = await estado();
    return {
      removidos: removidos.length,
      itens: removidos,
      restantes: e.botoes,
      vazio: e.botoes === 0,
      temSalvos: e.temSalvos,
      motivo: e.botoes === 0 ? null
        : removidos.length >= MAX_ITENS ? `parei no teto de ${MAX_ITENS} itens`
        : "sobrou item que não consegui tirar",
    };
  } finally {
    await fechar(tabId);
  }
}
