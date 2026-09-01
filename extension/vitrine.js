// A vitrine de UM cupom: abre `lista.mercadolivre.com.br/_Container_…` numa aba,
// lê os cards, pagina e devolve.
//
// Era o corpo inteiro do `background.js` quando a extensão tinha um comando só.
// O comportamento aqui não mudou de propósito — os testes da tela cobrem este
// caminho, e a fase de reorganização não é hora de mexer nele.

import { sleep, abrir, irPara, fechar, injetarArquivo, esperarHumano } from "./aba.js";

const PAGINAS_MAX = 6;              // teto de páginas, quando a tela não manda outro
const TAMANHO_PAGINA = 48;          // o `_Desde_` do ML anda de 48 em 48 (1, 49, 97…)
const PRODUTOS_MAX = 500;           // o mesmo teto do servidor; a tela manda o da config
const PAUSA_PAGINA_MS = 1200;

// Gêmeo de `backend/scraping/ml-cupons.js:containerPageUrl`. O ML não pagina com
// `?page=`: ele põe `_Desde_<offset+1>` no CAMINHO, antes da query.
export function urlDaPagina(url, n) {
  if (n <= 1) return url;
  const u = new URL(url);
  u.pathname = `${u.pathname.replace(/_Desde_\d+/i, "")}_Desde_${(n - 1) * TAMANHO_PAGINA + 1}`;
  return u.href;
}

const colherAba = (tabId) => injetarArquivo(tabId, "colher.js").then(r => r || { produtos: [], muro: null });

// Devolve { produtos, parcial, motivo, paginas }.
//
// São DOIS tetos e os dois são necessários: `paginas` limita quantas abas se abre
// (o custo na conta do ML), `maxProdutos` limita quanto se traz. O segundo entrou
// depois de uma vitrine devolver 1040 produtos em 11 páginas — o `_Desde_` anda de
// 48 em 48, mas a página que ele abre não mostra só 48, então contar página não
// prevê quantidade. Sem este teto o lote chegava no servidor acima do limite dele e
// era RECUSADO inteiro: 22 abas abertas na conta para gravar zero produto.
export async function raspar({ containerUrl, paginas = PAGINAS_MAX, maxProdutos = PRODUTOS_MAX }, progresso) {
  const teto = Math.max(1, Number(maxProdutos) || PRODUTOS_MAX);
  const tabId = await abrir(urlDaPagina(containerUrl, 1));
  const vistos = new Set();
  const produtos = [];
  let parcial = false;
  let motivo = null;
  let n = 0;

  try {
    for (n = 1; n <= paginas; n++) {
      if (n > 1) await irPara(tabId, urlDaPagina(containerUrl, n));
      let r = await colherAba(tabId);

      if (r.muro) {
        const resolvido = await esperarHumano(tabId, () => colherAba(tabId), () => progresso({ tipo: "muro", muro: r.muro, pagina: n }));
        if (!resolvido) { parcial = true; motivo = "o Mercado Livre pediu verificação e ela não foi resolvida"; break; }
        r = await colherAba(tabId);
      }

      // Página sem card é o fim da lista — o ML não diz quantas páginas tem.
      if (!r.produtos.length) break;

      let novos = 0;
      for (const p of r.produtos) {
        if (!p.link || vistos.has(p.link)) continue;
        vistos.add(p.link);
        produtos.push(p);
        novos++;
      }
      progresso({ tipo: "pagina", pagina: n, produtos: produtos.length });

      // O ML começou a repetir: passou da última página.
      if (!novos) break;

      // Cheio. Corta no teto e para — `parcial` porque a vitrine continuava
      // rendendo: gravar isto como lista fechada faria o sistema dizer "não vale
      // aqui" para produto que o cupom cobre.
      if (produtos.length >= teto) {
        produtos.length = teto;
        parcial = true;
        motivo = `parei no teto de ${teto} produtos`;
        break;
      }

      // Bateu o teto com a lista ainda rendendo: sobrou vitrine lá, e isso é
      // parcial. Gravar como lista fechada faria o sistema dizer "não vale aqui"
      // para produto que o cupom cobre.
      if (n === paginas) { parcial = true; motivo = `parei no teto de ${paginas} páginas`; }

      await sleep(PAUSA_PAGINA_MS);
    }
  } finally {
    await fechar(tabId);
  }

  return { produtos, parcial, motivo, paginas: Math.min(n, paginas) };
}
