// Avisos de cobrança — decide QUANDO mandar e-mail a partir do que mudou na
// assinatura.
//
// Por que comparar snapshots em vez de reagir ao tipo do evento: o Stripe manda
// `customer.subscription.updated` para praticamente qualquer coisa (renovação,
// tentativa de cobrança, mudança de metadata) e reentrega eventos. Disparar por
// evento encheria a caixa do cliente. Aqui só a TRANSIÇÃO de estado gera e-mail,
// e a dedupeKey em notifications/email fecha o cerco contra reentrega.
//
// Este módulo não faz I/O no Stripe e nunca lança: é chamado de dentro do
// webhook, onde uma exceção viraria 500 e reentrega.

const emails = require("../notifications/email");
const auth = require("../auth");
const limits = require("./limits");
const stripe = require("./stripe");
const logger = require("../infra/logger");

const PAST_DUE = new Set(["past_due", "unpaid"]);
const EM_DIA = new Set(["active", "trialing"]);

function iso(d) {
  if (!d) return "";
  const dt = d instanceof Date ? d : new Date(d);
  return Number.isNaN(dt.getTime()) ? "" : dt.toISOString();
}

// Evento do modo teste não pode mandar e-mail pra cliente de verdade — e
// vice-versa. O webhook aceita os dois modos de propósito, então a checagem é aqui.
function modoBate(livemode) {
  if (livemode === undefined || livemode === null) return true;
  return livemode === (stripe.mode() === "live");
}

// Quem não deve receber aviso de cobrança: conta sem e-mail, suspensa (já
// recebeu o aviso de suspensão) e admin, que tem plano Business por bypass e
// receberia avisos que não correspondem à realidade dele.
function podeReceber(user) {
  return !!(user && user.email && !user.suspended && user.role !== "admin");
}

function base(user, sub) {
  return { to: user.email, name: user.name, userId: user.id, planLabel: limits.getPlan(sub?.planId).label };
}

// Compara antes/depois e devolve no máximo UM aviso: { kind, payload, dedupeKey }.
// Separado de `onSubscriptionChanged` pra ser testável sem banco nem e-mail.
function decidirAviso({ before, after, user }) {
  const antes = before || {};
  const depois = after || {};

  // 1. Cartão falhou — o mais urgente, ganha de qualquer outra mudança.
  if (!PAST_DUE.has(antes.status) && PAST_DUE.has(depois.status)) {
    return {
      kind: "payment_failed",
      payload: { ...base(user, depois), deadline: limits.graceEndsAt(depois) },
      dedupeKey: `payment_failed:${user.id}:${iso(depois.pastDueSince)}`,
    };
  }

  // 2. Voltou a ficar em dia depois de um atraso.
  if (PAST_DUE.has(antes.status) && depois.status === "active") {
    return {
      kind: "payment_recovered",
      payload: base(user, depois),
      dedupeKey: `payment_recovered:${user.id}:${iso(depois.currentPeriodEnd)}`,
    };
  }

  // 3. Trocou de plano. Só entre planos pagos: cair pra free é cancelamento,
  // que vem por subscription.deleted; sair de free é a primeira assinatura,
  // que já tem o e-mail de boas-vindas.
  if (antes.planId && depois.planId && antes.planId !== depois.planId
      && antes.planId !== "free" && depois.planId !== "free") {
    return {
      kind: "plan_changed",
      payload: {
        ...base(user, depois),
        fromPlanLabel: limits.getPlan(antes.planId).label,
        toPlanLabel: limits.getPlan(depois.planId).label,
        pausedGroups: 0,
        pausedNumbers: 0,
      },
      dedupeKey: `plan_changed:${user.id}:${antes.planId}:${depois.planId}:${iso(depois.currentPeriodEnd)}`,
    };
  }

  // 4. Cancelamento agendado / desfeito pelo Customer Portal.
  if (!antes.cancelAtPeriodEnd && depois.cancelAtPeriodEnd) {
    return {
      kind: "cancel_scheduled",
      payload: { ...base(user, depois), periodEnd: depois.currentPeriodEnd },
      dedupeKey: `cancel_scheduled:${user.id}:${iso(depois.currentPeriodEnd)}`,
    };
  }
  if (antes.cancelAtPeriodEnd && !depois.cancelAtPeriodEnd && EM_DIA.has(depois.status)) {
    return {
      kind: "cancel_reverted",
      payload: { ...base(user, depois), periodEnd: depois.currentPeriodEnd },
      dedupeKey: `cancel_reverted:${user.id}:${iso(depois.currentPeriodEnd)}`,
    };
  }

  return null;
}

// Chamado pelo webhook depois de gravar a assinatura e aplicar os limites.
// `planPaused` é o retorno de applyPlanLimits — quantos itens ficaram pausados
// pelo plano novo, pra o e-mail de troca de plano explicar o que sumiu da tela.
async function onSubscriptionChanged({ userId, before, after, livemode, planPaused, user }) {
  try {
    if (!modoBate(livemode)) return null;
    const dono = user || await auth.findById(userId);
    if (!podeReceber(dono)) return null;

    const aviso = decidirAviso({ before, after, user: dono });
    if (!aviso) return null;

    if (aviso.kind === "plan_changed") {
      aviso.payload.pausedGroups = (planPaused?.groups || []).length;
      aviso.payload.pausedNumbers = (planPaused?.numbers || []).length;
    }

    emails.sendAsync(aviso.kind, aviso.payload, { dedupeKey: aviso.dedupeKey });
    return aviso.kind;
  } catch (err) {
    logger.warn({ err: err.message, userId }, "[billing] aviso de cobrança falhou");
    return null;
  }
}

async function onSubscriptionDeleted({ userId, before, livemode, user }) {
  try {
    if (!modoBate(livemode)) return null;
    const dono = user || await auth.findById(userId);
    if (!podeReceber(dono)) return null;

    emails.sendAsync(
      "subscription_canceled",
      base(dono, before),
      // Ancorada no id da assinatura encerrada: a mesma sub só encerra uma vez.
      { dedupeKey: `subscription_canceled:${userId}:${before?.stripeSubscriptionId || iso(before?.currentPeriodEnd)}` },
    );
    return "subscription_canceled";
  } catch (err) {
    logger.warn({ err: err.message, userId }, "[billing] aviso de cancelamento falhou");
    return null;
  }
}

module.exports = { onSubscriptionChanged, onSubscriptionDeleted, decidirAviso, podeReceber };
