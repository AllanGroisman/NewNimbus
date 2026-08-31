// O cliente da extensão "Nimbus — coletor de vitrine" (pasta `extension/` na raiz).
//
// Por que existe: a vitrine de um cupom no Mercado Livre responde CAPTCHA para
// navegador automatizado — inclusive fora da VPS. Numa aba do Chrome do próprio
// admin, com a sessão dele, ela é só uma página. Mas esta tela não pode ler o
// conteúdo de uma aba do ML (mesma-origem), e é aí que a extensão entra: ela
// colhe e devolve por `postMessage`.
//
// A extensão NUNCA recebe credencial: ela entrega os produtos aqui, e quem grava
// no sistema é esta página, com o login que já está aberto.
//
// Isolado num arquivo porque é IO com o mundo de fora — é o que os testes fingem.

const DE = "nimbus-coletor";
const PARA = "nimbus-admin";
const TENTATIVAS_PRONTO = 5;
const INTERVALO_PING_MS = 300;
const TIMEOUT_MS = 5 * 60 * 1000;   // a coleta pode parar no meio esperando o humano

let info = null;   // null = ainda não perguntamos; { instalada, versao } depois

// A extensão se anuncia sozinha ao carregar. Quem monta depois (React) pergunta
// com um "ping" e espera um instante — sem resposta, ela não está instalada.
//
// Devolve `{ instalada, versao }`: a versão vem no próprio anúncio da ponte
// (`extension/ponte.js`) e a aba de diagnóstico precisa dela pra dizer QUAL
// extensão respondeu — "instalada" sozinho não distingue uma cópia velha.
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
        fim({ instalada: true, versao: ev.data.versao || null });
      }
    };
    window.addEventListener("message", ouvir);
    // Uma pergunta só perde a corrida: o content script entra em `document_idle` e
    // o React pode montar antes dele. Perguntar de novo é o que evita "não está
    // instalada" quando ela está.
    const perguntar = () => {
      if (restam-- <= 0) return fim({ instalada: false, versao: null });
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

// Pede a coleta de UMA vitrine. Devolve { produtos, parcial, motivo, paginas }.
//
// `onProgresso` recebe { tipo: "pagina" | "muro", ... }. O "muro" é o momento em
// que o ML pediu verificação: a extensão trouxe a aba para a frente e está
// esperando o humano — a tela precisa dizer isso, senão parece travamento.
export function raparVitrine(containerUrl, { paginas, onProgresso, timeoutMs = TIMEOUT_MS } = {}) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve, reject) => {
    const fim = () => {
      window.removeEventListener("message", ouvir);
      clearTimeout(timer);
    };
    const ouvir = (ev) => {
      if (ev.source !== window || ev.data?.de !== DE) return;
      const msg = ev.data;
      if (msg.tipo === "progresso") { onProgresso?.(msg); return; }
      if (msg.tipo !== "resultado" || msg.id !== id) return;
      fim();
      if (msg.ok) resolve({ produtos: msg.produtos || [], parcial: !!msg.parcial, motivo: msg.motivo || null, paginas: msg.paginas || 0 });
      else reject(new Error(msg.erro || "A extensão não conseguiu ler a vitrine."));
    };
    window.addEventListener("message", ouvir);
    const timer = setTimeout(() => { fim(); reject(new Error("A extensão não respondeu a tempo.")); }, timeoutMs);
    window.postMessage({ de: PARA, tipo: "raspar", id, containerUrl, paginas }, window.location.origin);
  });
}

// Só para os testes: zera o que já foi descoberto sobre a extensão.
export function _resetColetor() { info = null; }
