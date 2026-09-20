// O modelo da página do ML, lido de dentro da aba — não o DOM.
//
// A página de cupons do ML é uma aplicação nordic: os cupons chegam num JSON
// pendurado em `window._n.ctx.r`, e o backend já lê exatamente isso
// (`ml-cupons.js:readPageProps` e `readLanding`). Ler o mesmo objeto aqui é o que
// permite entregar o material CRU para o servidor e deixar o parse — que é puro e
// já tem teste — onde ele está. Nada de `parseFilterProps` duplicado nesta pasta.
//
// Exige `world: "MAIN"`: no mundo isolado da extensão esses globais não existem.

import { abrir, fechar, avaliar, esperarHumano, classificarMuro } from "./aba.js";

// As chaves do `pageProps` que interessam. O objeto inteiro traz tema, i18n e
// tracking — mandar tudo para o servidor seria um corpo de megabytes por página.
//
// `availableGroupingsKeys` é a lista das categorias que a conta tem (16 strings,
// nada de peso) e não fala dos cupons desta página: é o que diz ao servidor QUE
// verticais existem. Sem ela a rodada só conhecia as categorias que já tinha
// visitado — e como só se visita o que se conhece, ela ficou presa em três por
// meses (task 14). O nome bonito de cada uma vem dentro do `filteredCouponsData`
// (`appliedFilters`), que já vinha.
export const CHAVES_PADRAO = ["filteredCouponsData", "activeCouponsData", "availableGroupingsKeys"];

// Roda DENTRO da página. Serializada pelo `executeScript`, então é auto-contida:
// não pode usar nada deste arquivo.
function lerModeloNaPagina(chaves) {
  const raiz = window._n?.ctx?.r || window.__PRELOADED_STATE__ || window.__NORDIC_RENDERING_CTX__ || null;

  // Gêmeo do `readLanding`: o `landingData` é a aba /cupons; o `filteredCouponsData`
  // é a lista paginada. Os dois vivem no mesmo modelo, em lugares diferentes.
  const buscarLanding = (obj, nivel = 0) => {
    if (!obj || typeof obj !== "object" || nivel > 6) return null;
    if (obj.landingData && typeof obj.landingData === "object") return obj.landingData;
    if (Array.isArray(obj.groupings) && (obj.totalCouponsQuantity || obj.header)) return obj;
    for (const v of Object.values(obj)) {
      const f = buscarLanding(v, nivel + 1);
      if (f) return f;
    }
    return null;
  };

  const inteiro = raiz?.appProps?.pageProps || null;
  let props = null;
  if (inteiro) {
    props = {};
    for (const k of chaves) if (inteiro[k] !== undefined) props[k] = inteiro[k];
  }

  let landing = null;
  try { landing = JSON.parse(JSON.stringify(buscarLanding(raiz) || null)); } catch { landing = null; }
  try { props = props ? JSON.parse(JSON.stringify(props)) : null; } catch { props = null; }

  return {
    props,
    landing,
    url: location.href,
    titulo: document.title || "",
    // Só o começo: é o bastante para reconhecer o muro e não vira corpo gigante.
    texto: (document.body?.innerText || "").slice(0, 3000),
  };
}

// Lê o modelo da aba já aberta e diz se aquilo era um muro. `vazio` decide o que
// conta como "não veio nada" — sem isso, uma página de CAPTCHA e uma página de
// lista legitimamente vazia ficariam indistinguíveis.
export async function lerModelo(tabId, { chaves = CHAVES_PADRAO, vazio = (r) => !r?.props && !r?.landing } = {}) {
  const r = await avaliar(tabId, lerModeloNaPagina, [chaves], { mundoDaPagina: true });
  const lido = r || { props: null, landing: null, url: "", titulo: "", texto: "" };
  return { ...lido, muro: vazio(lido) ? classificarMuro(lido.url, lido.texto, lido.titulo) : null };
}

// Abre uma URL, lê o modelo e fecha. É o comando avulso — os laços (lista de
// cupons, palavra) reaproveitam a mesma aba e chamam `lerModelo` direto.
export async function props({ url, chaves }, progresso) {
  const tabId = await abrir(url);
  try {
    let r = await lerModelo(tabId, { chaves });
    if (r.muro) {
      const resolvido = await esperarHumano(tabId, () => lerModelo(tabId, { chaves }), () => progresso({ tipo: "muro", muro: r.muro }));
      if (!resolvido) return { ...r, motivo: "o Mercado Livre pediu verificação e ela não foi resolvida" };
      r = await lerModelo(tabId, { chaves });
    }
    return r;
  } finally {
    await fechar(tabId);
  }
}
