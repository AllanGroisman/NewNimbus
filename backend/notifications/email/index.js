// E-mails transacionais do Nimbus (cobrança e segurança da conta).
//
// Uso:
//   const emails = require("../notifications/email");
//   emails.sendAsync("password_changed", { to, name, userId }, { throttleMs: 10*60*1000 });
//
// `sendAsync` NUNCA rejeita: nenhum aviso de e-mail pode derrubar um webhook do
// Stripe nem uma rota de conta. O desfecho fica no log (tabela email_log).
//
// Este módulo não pode requerer `auth` nem `billing/index` — quem resolve o
// usuário é quem chama. Só depende de db, config e billing/limits (folha).

const logger = require("../../infra/logger");
const registry = require("./registry");
const render = require("./render");
const transport = require("./transport");
const log = require("./log");

// Envia de fato. Devolve {ok, sent|deduped|skipped, reason?}. Só use direto
// quando o resultado importar (testes, rota de reenvio); no resto, sendAsync.
async function send(kind, payload = {}, opts = {}) {
  const template = registry.get(kind);
  if (!template) throw new Error(`[email] template desconhecido: ${kind}`);

  // Desligado pelo Admin (tela Admin › E-mails). Checagem num ponto só, antes
  // de qualquer escrita no email_log: um e-mail desligado não deixa rastro de
  // "quase enviado". Os e-mails com link não podem ser desligados (render.js).
  if (!render.isEnabled(kind)) return { ok: true, skipped: true, reason: "desligado" };

  const to = payload.to;
  if (!to) return { ok: false, reason: "sem_destinatario" };

  const userId = payload.userId || null;

  // Janela de silêncio por (usuário, tipo) — para os avisos sem âncora natural.
  if (opts.throttleMs && await log.recentlySent(userId, kind, opts.throttleMs)) {
    return { ok: true, deduped: true, reason: "throttle" };
  }

  // Sem dedupeKey explícita não há dedupe: a chave vira única por envio, e a
  // linha existe só como histórico.
  const dedupeKey = opts.dedupeKey || `${kind}:${userId || to}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;

  const row = await log.claim({ kind, userId, to, dedupeKey });
  // Alguém já reservou esta chave — o e-mail já saiu (ou está saindo).
  if (!row) return { ok: true, deduped: true, reason: "dedupe" };

  // Reservar antes de enviar significa que um SMTP fora do ar queima a chave e
  // perde o e-mail. É o mesmo trade-off já aceito no webhook do Stripe: melhor
  // perder um aviso do que mandar o mesmo aviso em loop. A linha fica com
  // status "error" e dá pra reenviar na mão.
  try {
    const { subject, html, text } = template(payload);
    const res = await transport.sendMail({ to, subject, html, text });
    await log.finish(row.id, res.delivered ? "sent" : `skipped_${res.reason}`);
    return { ok: true, sent: !!res.delivered, reason: res.reason };
  } catch (err) {
    await log.finish(row.id, "error", err.message).catch(() => {});
    throw err;
  }
}

// Fire-and-forget: dispara e esquece. Retorna void de propósito, pra ninguém
// dar await sem querer e acoplar o tempo de resposta ao SMTP.
function sendAsync(kind, payload = {}, opts = {}) {
  send(kind, payload, opts).catch(err => {
    logger.error({ err: err.message, kind, to: payload?.to }, "[email] falha ao enviar");
  });
}

module.exports = { send, sendAsync, kinds: registry.kinds, log };
