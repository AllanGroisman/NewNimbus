// O cliente da extensão "Nimbus — cupons no meu Chrome" (pasta `extension/` na raiz).
//
// Por que existe: o Mercado Livre responde CAPTCHA para navegador automatizado —
// inclusive fora da VPS. Numa aba do Chrome do próprio admin, com a sessão dele,
// as mesmas páginas são só páginas. Mas esta tela não pode ler o conteúdo de uma
// aba do ML (mesma-origem), e é aí que a extensão entra: ela colhe e devolve por
// `postMessage`.
//
// A extensão NUNCA recebe credencial: ela entrega o material cru aqui, e quem
// grava no sistema é esta página, com o login que já está aberto. E ela entrega
// material CRU de propósito — quem interpreta são as funções puras do servidor,
// que já existem e já têm teste.
//
// Isolado num arquivo porque é IO com o mundo de fora — é o que os testes fingem.

const DE = "nimbus-coletor";
const PARA = "nimbus-admin";
const TENTATIVAS_PRONTO = 5;
const INTERVALO_PING_MS = 300;
const TIMEOUT_MS = 5 * 60 * 1000;   // a coleta pode parar no meio esperando o humano

let info = null;   // null = ainda não perguntamos; { instalada, versao, comandos } depois

// A extensão se anuncia sozinha ao carregar. Quem monta depois (React) pergunta
// com um "ping" e espera um instante — sem resposta, ela não está instalada.
//
// Devolve `{ instalada, versao, comandos }`. A versão vem no anúncio da ponte
// (`extension/ponte.js`) e a aba de diagnóstico precisa dela pra dizer QUAL
// extensão respondeu — "instalada" sozinho não distingue uma cópia velha. Os
// `comandos` são a lista que aquela cópia entende: é o que permite uma tela nova
// dizer "atualize a extensão" em vez de esperar por uma resposta que não vem.
export function coletorInfo({ tentativas = TENTATIVAS_PRONTO } = {}) {
  if (info !== null) return Promise.resolve(info);
  return new Promise((resolve) => {
    let timer = null;
    let restam = tentativas;
    const fim = (v) => {
      window.removeEventListener("message", ouvir);
      clearTimeout(timer);
      info = v;
      resolve(v);
    };
    const ouvir = (ev) => {
      if (ev.source === window && ev.data?.de === DE && ev.data.tipo === "pronto") {
        fim({ instalada: true, versao: ev.data.versao || null, comandos: ev.data.comandos || [] });
      }
    };
    window.addEventListener("message", ouvir);
    // Uma pergunta só perde a corrida: o content script entra em `document_idle` e
    // o React pode montar antes dele. Perguntar de novo é o que evita "não está
    // instalada" quando ela está.
    const perguntar = () => {
      if (restam-- <= 0) return fim({ instalada: false, versao: null, comandos: [] });
      window.postMessage({ de: PARA, tipo: "ping" }, window.location.origin);
      timer = setTimeout(perguntar, INTERVALO_PING_MS);
    };
    perguntar();
  });
}

// O mesmo, reduzido a sim/não — é o que a maior parte da tela precisa.
export function coletorPronto(opts) {
  return coletorInfo(opts).then(i => i.instalada);
}

// A extensão instalada entende ESTE comando? Cópia antiga responde ao ping mas não
// ao comando novo, e sem esta pergunta a tela ficaria esperando o timeout.
export function coletorEntende(comando, opts) {
  return coletorInfo(opts).then(i => i.instalada && (i.comandos || []).includes(comando));
}

// Um pedido à extensão. Devolve o que o comando devolveu, sem o `ok`.
//
// `onProgresso` recebe o evento do comando — `{ tipo: "pagina" | "muro", … }`. O
// "muro" é o momento em que o ML pediu verificação: a extensão trouxe a aba para a
// frente e está esperando o humano — a tela precisa dizer isso, senão parece
// travamento.
export function pedirAoColetor(tipo, payload = {}, { onProgresso, timeoutMs = TIMEOUT_MS } = {}) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve, reject) => {
    const fim = () => {
      window.removeEventListener("message", ouvir);
      clearTimeout(timer);
    };
    const ouvir = (ev) => {
      if (ev.source !== window || ev.data?.de !== DE) return;
      const msg = ev.data;
      // O progresso de outro pedido não é deste: o id separa (a colheita em lote
      // dispara um comando por cupom).
      if (msg.tipo === "progresso") { if (!msg.id || msg.id === id) onProgresso?.(msg.evento || msg); return; }
      if (msg.tipo !== "resultado" || msg.id !== id) return;
      fim();
      // O envelope (`de`, `tipo`, `id`, `ok`) fica no transporte; para quem chamou
      // só interessa o que o comando devolveu.
      if (!msg.ok) return reject(new Error(msg.erro || "A extensão não conseguiu fazer isso."));
      const r = { ...msg };
      for (const k of ["de", "tipo", "id", "ok"]) delete r[k];
      resolve(r);
    };
    window.addEventListener("message", ouvir);
    const timer = setTimeout(() => { fim(); reject(new Error("A extensão não respondeu a tempo.")); }, timeoutMs);
    window.postMessage({ de: PARA, tipo, id, ...payload }, window.location.origin);
  });
}

// Pede a coleta de UMA vitrine. Devolve { produtos, parcial, motivo, paginas }.
export function raparVitrine(containerUrl, { paginas, maxProdutos, onProgresso, timeoutMs } = {}) {
  return pedirAoColetor("raspar", { containerUrl, paginas, maxProdutos }, { onProgresso, timeoutMs })
    .then(r => ({ produtos: r.produtos || [], parcial: !!r.parcial, motivo: r.motivo || null, paginas: r.paginas || 0 }));
}

// Uma página da lista de cupons, na aba da rodada. Ver `extension/lista.js`: com
// `url` ela navega e lê; com `rotulos` ela clica nos "Aplicar" que o servidor
// escolheu e relê. Devolve { tabId, props, muro, clicados, semBotao }.
export function paginaDeCupons({ url, tabId, rotulos } = {}, { onProgresso, timeoutMs } = {}) {
  return pedirAoColetor("lista", { url, tabId, rotulos }, { onProgresso, timeoutMs });
}

// Fecha a aba que a rodada vinha reaproveitando. Quem sabe que acabou é a tela.
export function fecharAbaDoColetor(tabId) {
  if (tabId == null) return Promise.resolve({ fechada: false });
  return pedirAoColetor("fechar-aba", { tabId }).catch(() => ({ fechada: false }));
}

// Testa uma palavra no "Inserir código do cupom", na aba do admin. Devolve o
// material cru — { respostas, bodyText, muro, motivo } —, nunca um veredito: quem
// lê a resposta do ML é o servidor, com a mesma função dos dois caminhos.
export function testarPalavraNoChrome(word, { onProgresso, timeoutMs } = {}) {
  return pedirAoColetor("palavra", { word }, { onProgresso, timeoutMs });
}

// Leva o produto ao checkout e aplica o código, na aba do admin. Devolve material
// cru — telas, trilha e os corpos JSON que o checkout buscou. NUNCA finaliza
// compra: a extensão só clica em rótulo do tipo "Continuar".
export function testarCupomNoChrome({ url, code, mode = "checkout" }, { onProgresso, timeoutMs } = {}) {
  return pedirAoColetor("checkout", { url, code, mode }, { onProgresso, timeoutMs });
}

// A SONDA da task 12: leva o produto até a tela dos cupons do checkout e fotografa,
// sem digitar nada. Devolve o material cru — o servidor só guarda.
//
// `rapido`, `semCarrinho` e `tempos` são do lote (data/sondaLote.js) e só a
// extensão que anuncia "cupons-checkout-v2" os entende — quem chama confere antes.
export function sondarCuponsNoCheckout(url, { onProgresso, timeoutMs, rapido, semCarrinho, tempos } = {}) {
  if (!rapido && !semCarrinho && !tempos) return pedirAoColetor("cupons-checkout", { url }, { onProgresso, timeoutMs });
  return pedirAoColetor("cupons-checkout-v2", { url, rapido: !!rapido, semCarrinho: !!semCarrinho, tempos: tempos || null }, { onProgresso, timeoutMs });
}

// O cupom do repasse no checkout do produto que chegou com ele (task 7): abre o
// modal "Cupons", digita o código e lê o que o ML respondeu. Material cru.
export function cupomNoCheckout({ url, code }, { onProgresso, timeoutMs } = {}) {
  return pedirAoColetor("cupom-no-checkout", { url, code }, { onProgresso, timeoutMs });
}

// Lê o modelo (JSON do nordic) de uma página do ML. Devolve { props, landing, url, muro }.
export function lerPropsDaPagina(url, { chaves, onProgresso, timeoutMs } = {}) {
  return pedirAoColetor("props", { url, chaves }, { onProgresso, timeoutMs });
}

// Só para os testes: zera o que já foi descoberto sobre a extensão.
export function _resetColetor() { info = null; }
