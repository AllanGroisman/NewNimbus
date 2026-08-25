// Aviso ao admin quando a geração de link de afiliado do Mercado Livre para de
// funcionar por cookie vencido (HTTP 401/403 no createLink).
//
// Por que existe: em 25/08/2026 o cookie de uma conta venceu e ninguém soube — os
// itens saíam da fila e sumiam no envio, e a única pista era uma linha de console.
//
// Nunca um aviso por link: o `stateAlert` do user-notifier já resolve o debounce
// (só avisa depois de um período ruim contínuo, e avisa de novo quando normaliza).
// A carência aqui é maior que a padrão de 60 s porque o createLink só roda quando
// há envio — um 401 isolado no meio de uma rajada não pode virar mensagem.
const { stateAlert } = require("./user-notifier");
const adminNotifier = require("./admin-notifier");

const GRACE_MS = Number(process.env.ML_COOKIE_ALERT_GRACE_MS) || 15 * 60 * 1000;

// ok=true quando o createLink respondeu (cookie vivo); false no 401/403.
function mlCookieState(userId, ok, tag) {
  stateAlert(`ml-cookie:${userId}`, !ok, {
    graceMs: GRACE_MS,
    onDown: () => adminNotifier.notifyMLCookieExpired({ tag }),
    onRecover: () => adminNotifier.notifyMLCookieRecovered({ tag }),
  });
}

module.exports = { mlCookieState, GRACE_MS };
