// Uma página da lista de cupons do ML, na aba do admin.
//
// A extensão NÃO decide nada aqui: ela abre a URL que o servidor mandou, lê o
// modelo cru da página e, se o servidor pedir, clica nos botões "Aplicar" cujos
// rótulos ele nomeou. Onde parar, quem ativar e o que aquilo significa continua
// tudo no backend (`coupons/sync.js` + `scraping/ml-cupons.js`), que é onde as
// regras já estão escritas e testadas.
//
// Por que a ativação passa pelo servidor no meio da página: dois cupons diferentes
// já apareceram na mesma página com o MESMO rótulo "Aplicar" (13999830 e 13373945,
// limites de desconto diferentes). Clicar no palpite ativa o cupom errado, e
// ativar é escrita irreversível na conta. Quem sabe distinguir é o `aAtivar`, que
// olha o modelo inteiro — então ele decide, e a extensão só executa.

import { sleep, abrir, irPara, fechar, avaliar, esperarHumano } from "./aba.js";
import { lerModelo } from "./props.js";

const PAUSA_APLICAR_MS = 1500;   // entre um "Aplicar" e o próximo
const ESPERA_XHR_MS = 1500;      // o ML atualiza o card por XHR; reler cedo devolve o estado velho

// Gêmeo de `ml-cupons.js:clicarAplicar`. Casar com vários botões é NORMAL — o ML
// repete o mesmo card em vários carrosséis —, então clicar no primeiro visível
// está certo. Botão desabilitado não conta: `.click()` nele não faz nada e quem
// pediu ficaria achando que ativou.
function clicarPeloRotulo(rotulo) {
  const bloqueado = (el) => el.disabled === true || el.getAttribute("aria-disabled") === "true";
  const candidatos = Array.from(document.querySelectorAll("[aria-label]"))
    .filter(el => el.getAttribute("aria-label") === rotulo && el.offsetParent !== null);
  for (const el of candidatos) {
    const clicavel = el.closest("button, [role='button'], a") || el;
    if (bloqueado(el) || bloqueado(clicavel)) continue;
    clicavel.click();
    return true;
  }
  return false;
}

// Uma página da lista. Chamada duas vezes por página, e é de propósito:
//
//   1. com `url` e sem `rotulos` → navega e devolve o modelo. A tela manda esse
//      modelo ao servidor, que responde QUEM ativar.
//   2. sem `url` e com `rotulos` → clica na página que já está aberta e relê.
//
// Os rótulos não podem vir junto do passo 1 porque eles saem da leitura DESTA
// página — quem os escolhe é o `aAtivar`, no servidor, olhando o modelo dela.
//
// `tabId` viaja de ida e volta: a rodada inteira acontece numa aba só, e abrir uma
// por página faria o ML ver dezenas de aberturas em sequência.
export async function lista({ url = null, tabId = null, rotulos = [] }, progresso) {
  const nova = tabId == null;
  let aba = tabId;
  if (nova) aba = await abrir(url);
  else if (url) await irPara(aba, url);

  try {
    let r = await lerModelo(aba);
    if (r.muro) {
      const resolvido = await esperarHumano(aba, () => lerModelo(aba), () => progresso({ tipo: "muro", muro: r.muro }));
      if (!resolvido) return { tabId: aba, muro: r.muro, props: null, motivo: "o Mercado Livre pediu verificação e ela não foi resolvida" };
      r = await lerModelo(aba);
    }

    let clicados = 0;
    const semBotao = [];
    for (const rotulo of rotulos) {
      const ok = await avaliar(aba, clicarPeloRotulo, [rotulo], { mundoDaPagina: true });
      if (ok) { clicados++; progresso({ tipo: "ativou", rotulo }); }
      // Rótulo que não achou botão não pode falhar calado: sem isso a rodada
      // termina com "0 ativados" sem dizer se ninguém precisava ou se o clique
      // não encontrou nada.
      else semBotao.push(rotulo);
      await sleep(PAUSA_APLICAR_MS + Math.floor(Math.random() * 600));
    }

    // Relê depois dos cliques: o cupom recém-ativado ganha `containerUrl`, e é
    // essa versão que precisa chegar ao servidor — a de antes não tem vitrine.
    if (clicados) {
      await sleep(ESPERA_XHR_MS);
      const depois = await lerModelo(aba);
      if (depois.props) r = depois;
    }

    return { tabId: aba, props: r.props, url: r.url, muro: null, clicados, semBotao };
  } catch (err) {
    if (nova) await fechar(aba);
    throw err;
  }
}

// A aba da rodada fica aberta entre uma página e outra; no fim alguém precisa
// fechá-la, e quem sabe que acabou é a tela.
export async function fecharAba({ tabId }) {
  if (tabId != null) await fechar(tabId);
  return { fechada: true };
}
