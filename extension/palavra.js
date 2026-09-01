// Testar uma PALAVRA (tipo BRINQUEDOS) no "Inserir código do cupom" da aba
// /cupons — na aba do próprio admin.
//
// É a única forma de descobrir a que campanha uma palavra pertence: a página não
// lista as palavras em lugar nenhum. Até aqui isso rodava com o Chrome do servidor,
// que é justamente o que o ML barra com CAPTCHA.
//
// A resposta do ML chega por XHR, não pelo DOM — o texto na tela é resumo. Por isso
// existe um espião de `fetch`/`XMLHttpRequest` injetado no mundo da página ANTES do
// clique: ele guarda os corpos crus num array e a extensão os recolhe depois. Nada é
// interpretado aqui: quem lê é o `lerRespostaDeCodigo` no servidor, o mesmo que lê a
// resposta do caminho antigo.

import { sleep, abrir, fechar, avaliar, esperarHumano, classificarMuro } from "./aba.js";

const CUPONS_URL = "https://www.mercadolivre.com.br/cupons";
// Gêmeos de `ml-cupons.js`: CODE_OPEN_RE, CODE_APPLY_RE e COUPON_API_RE. Ficam em
// texto porque a função é serializada para dentro da página.
const ABRIR_RE = "^(inserir|adicionar) c[óo]digo( do cupom)?$";
const APLICAR_RE = "^(adicionar|inserir|aplicar) cupom$";
const API_RE = "(coupon|cupon|smart-coupons)";
const ESPERA_RESPOSTA_MS = 500;
const TENTATIVAS_RESPOSTA = 12;   // 12 × 500ms = os mesmos 6s do caminho do servidor

// ── funções que rodam DENTRO da página (serializadas, sem fechar sobre nada) ──

// O espião. Envolve `fetch` e `XMLHttpRequest` uma única vez e guarda os corpos
// das respostas que falam de cupom. Não altera nada do que a página faz: lê uma
// cópia (`clone()`) e devolve a original.
function instalarEspiao(apiRe) {
  if (window.__nimbusEspiao) return true;
  const re = new RegExp(apiRe, "i");
  const guardados = [];
  window.__nimbusEspiao = guardados;

  const fetchOriginal = window.fetch;
  window.fetch = function (...args) {
    return fetchOriginal.apply(this, args).then((res) => {
      try {
        if (re.test(res.url)) res.clone().text().then(t => guardados.push(t)).catch(() => {});
      } catch { /* resposta opaca — segue */ }
      return res;
    });
  };

  const abrirOriginal = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (metodo, url, ...resto) {
    this.addEventListener("load", () => {
      try { if (re.test(String(url))) guardados.push(this.responseText); } catch { /* corpo binário */ }
    });
    return abrirOriginal.call(this, metodo, url, ...resto);
  };
  return true;
}

// Clica no botão cujo texto casa com o padrão. Gêmeo de
// `ml-session-page.js:clickByPattern`: o `maxLen` evita casar um parágrafo inteiro
// que por acaso contenha a frase.
function clicarPorTexto(padrao, maxLen) {
  const re = new RegExp(padrao, "i");
  const alvos = Array.from(document.querySelectorAll("button, a, [role='button'], span, div"));
  for (const el of alvos) {
    const txt = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (!txt || txt.length > maxLen || !re.test(txt)) continue;
    if (el.offsetParent === null) continue;
    const clicavel = el.closest("button, a, [role='button']") || el;
    if (clicavel.disabled === true || clicavel.getAttribute("aria-disabled") === "true") continue;
    clicavel.click();
    return true;
  }
  return false;
}

// Digita no campo do cupom. O React do ML não enxerga `el.value = x` — é preciso
// o setter do protótipo, como no checkout.
function digitar(valor) {
  const campos = Array.from(document.querySelectorAll("input"))
    .filter(el => el.offsetParent !== null && !el.disabled && el.type !== "hidden");
  const alvo = campos.find(el => /cupom|c[óo]digo|coupon/i.test(`${el.name || ""} ${el.id || ""} ${el.placeholder || ""} ${el.getAttribute("aria-label") || ""}`))
            || (campos.length === 1 ? campos[0] : null);
  if (!alvo) return false;
  alvo.focus();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(alvo, valor);
  alvo.dispatchEvent(new Event("input", { bubbles: true }));
  alvo.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

function colherEspiao() {
  return {
    respostas: (window.__nimbusEspiao || []).slice(),
    url: location.href,
    titulo: document.title || "",
    texto: (document.body?.innerText || "").slice(0, 3000),
  };
}

// ── o comando ────────────────────────────────────────────────────────────

// Devolve { respostas, bodyText, muro, motivo } — material cru. O veredito é do
// servidor.
export async function palavra({ word }, progresso) {
  const code = String(word || "").trim();
  if (!code) throw new Error("Escreva a palavra do cupom.");

  const tabId = await abrir(CUPONS_URL);
  try {
    const olhar = async () => {
      const r = await avaliar(tabId, colherEspiao, [], { mundoDaPagina: true });
      const lido = r || { respostas: [], url: "", titulo: "", texto: "" };
      return { ...lido, muro: classificarMuro(lido.url, lido.texto, lido.titulo) };
    };

    let visto = await olhar();
    if (visto.muro) {
      const resolvido = await esperarHumano(tabId, olhar, () => progresso({ tipo: "muro", muro: visto.muro }));
      if (!resolvido) return { respostas: [], muro: visto.muro, motivo: "o Mercado Livre pediu verificação e ela não foi resolvida" };
    }

    // O espião entra antes do clique: a resposta que interessa é a que o "Aplicar"
    // dispara, e o que já passou não volta.
    await avaliar(tabId, instalarEspiao, [API_RE], { mundoDaPagina: true });

    if (!await avaliar(tabId, clicarPorTexto, [ABRIR_RE, 40], { mundoDaPagina: true })) {
      return { respostas: [], muro: null, motivo: 'Não achei o "Inserir código do cupom" na página.' };
    }
    await sleep(1500);
    progresso({ tipo: "digitando", word: code });

    if (!await avaliar(tabId, digitar, [code], { mundoDaPagina: true })) {
      return { respostas: [], muro: null, motivo: 'Abri o "Inserir código" mas não achei onde digitar.' };
    }
    await avaliar(tabId, clicarPorTexto, [APLICAR_RE, 30], { mundoDaPagina: true });

    // A resposta chega por XHR e demora. Devolver tudo que o espião juntou é de
    // propósito: escolher qual delas vale é decisão do servidor.
    let colhido = null;
    for (let i = 0; i < TENTATIVAS_RESPOSTA; i++) {
      await sleep(ESPERA_RESPOSTA_MS);
      colhido = await avaliar(tabId, colherEspiao, [], { mundoDaPagina: true });
      if (colhido?.respostas?.length) break;
    }

    return { respostas: colhido?.respostas || [], bodyText: colhido?.texto || "", muro: null, motivo: null };
  } finally {
    await fechar(tabId);
  }
}
