// A ponte entre a página do admin e a extensão.
//
// A página do sistema e a extensão são mundos separados de propósito: a página não
// enxerga `chrome.*`, e a extensão não enxerga o JavaScript da página. Este arquivo
// é o único ponto de contato, e ele passa MENSAGEM, nunca credencial: quem grava no
// sistema é o próprio site, com a sessão que o Allan já tem aberta.

const DE = "nimbus-coletor";
const PARA = "nimbus-admin";

// Avisa a página que a extensão está instalada — é o que acende o botão. Vai uma
// vez na carga e outra a cada pedido de quem chegou depois (React montando tarde).
function anunciar() {
  window.postMessage({ de: DE, tipo: "pronto", versao: chrome.runtime.getManifest().version }, window.location.origin);
}
anunciar();

window.addEventListener("message", (ev) => {
  // Só mensagem da própria página. Sem isto, um iframe de terceiro poderia pedir
  // uma raspagem em nome do admin.
  if (ev.source !== window || ev.origin !== window.location.origin) return;
  const msg = ev.data;
  if (!msg || msg.de !== PARA) return;

  if (msg.tipo === "ping") { anunciar(); return; }

  if (msg.tipo === "raspar") {
    chrome.runtime.sendMessage(
      { tipo: "raspar", containerUrl: msg.containerUrl, paginas: msg.paginas },
      (resposta) => {
        const erro = chrome.runtime.lastError?.message;
        window.postMessage({
          de: DE, tipo: "resultado", id: msg.id,
          ...(erro ? { ok: false, erro } : resposta),
        }, window.location.origin);
      },
    );
  }
});

// O progresso vem do background por outro caminho (tabs.sendMessage) e é repassado
// para a página do mesmo jeito.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.de === DE && msg.tipo === "progresso") {
    window.postMessage(msg, window.location.origin);
  }
});
