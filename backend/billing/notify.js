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
const emailLog = require("../notifications/email/log");
const auth = require("../auth");
const limits = require("./limits");
const stripe = require("./stripe");
const store = require("./pg");
const logger = require("../infra/logger");

const PAST_DUE = new Set(["past_due", "unpaid"]);
const EM_DIA = new Set(["active", "trialing"]);

// Quem assina pela landing recebe o "crie sua senha", que já abre com "pagamento
// confirmado". Se o webhook mandasse o "assinatura confirmada" logo atrás seriam
// dois e-mails dizendo a mesma coisa — esta janela cobre a distância entre os
// dois eventos do Stripe (checkout.session.completed e subscription.created).
const JANELA_BOAS_VINDAS_MS = 30 * 60 * 1000;

// Faturas que NÃO viram recibo: a primeira da assinatura já foi confirmada pelo
// `subscription_started`, e fatura de R$ 0 (crédito, trial sem cobrança) não é
// pagamento. Assim cada cobrança gera exatamente um e-mail.
const RECIBO_MOTIVOS = new Set(["subscription_cycle", "subscription_update"]);

// Valor mensal do plano em centavos, pelo catálogo local (limits.js). Não vale a
// pena ir ao Stripe por isso dentro do webhook — e limits.js já é o fallback
// oficial de preço quando o catálogo remoto não responde (billing/prices.js).
function centavosDoPlano(planId) {
  const preco = limits.getPlan(planId)?.priceBRL;
  return Number.isFinite(preco) ? Math.round(preco * 100) : null;
}

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

// Quem não deve receber aviso de cobrança: conta sem e-mail e conta suspensa
// (que já recebeu o aviso de suspensão). Admin recebe como qualquer cliente —
// ele tem Business por bypass de gating, mas se tem assinatura de verdade os
// avisos valem pra ele igual, e sem isso não dá pra testar cobrança na prática.
function podeReceber(user) {
  return !!(user && user.email && !user.suspended);
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

  // 3. Assinou pela primeira vez (ou voltou depois de cancelar): free/sem plano
  // → plano pago em dia. É o comprovante de que o pagamento entrou — no teste de
  // R$ 1,00 é ele que avisa quando e quanto será a cobrança cheia.
  // A dedupeKey ancorada no id da assinatura segura as reentregas do Stripe, e
  // depois do primeiro evento `antes` já é pago, então a regra nem é alcançada.
  const eraPago = !!antes.planId && antes.planId !== "free";
  if (!eraPago && depois.planId && depois.planId !== "free" && EM_DIA.has(depois.status)) {
    const trial = depois.status === "trialing";
    // Início adiado pela cortesia do admin: o status é "trialing" igual ao teste
    // de R$1, mas nada foi cobrado agora — dizer "recebemos seu pagamento" seria
    // mentira. A cortesia ainda vigente é o que separa um caso do outro.
    const adiado = trial && limits.manualTrialActive(depois);
    const mensal = centavosDoPlano(depois.planId);
    return {
      kind: "subscription_started",
      payload: {
        ...base(user, depois),
        trial,
        deferred: adiado,
        // No teste, o que a pessoa pagou agora foi a taxa de R$ 1,00 — o valor
        // do plano só entra na frase sobre a próxima cobrança. No início adiado
        // não houve cobrança nenhuma.
        amount: adiado ? 0 : trial ? limits.TRIAL_FEE_CENTS : mensal,
        planAmount: mensal,
        currency: "brl",
        // Em trial, currentPeriodEnd é o fim do teste (é quando a cobrança cheia
        // acontece); fora dele, a data da próxima renovação. Serve aos dois.
        periodEnd: depois.currentPeriodEnd,
      },
      dedupeKey: `subscription_started:${user.id}:${depois.stripeSubscriptionId || iso(depois.currentPeriodEnd)}`,
    };
  }

  // 4. Trocou de plano. Só entre planos pagos: cair pra free é cancelamento,
  // que vem por subscription.deleted; sair de free é a primeira assinatura,
  // que a regra acima já cobre.
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

  // 5. Cancelamento agendado / desfeito pelo Customer Portal.
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

    // Conta que nasceu deste mesmo pagamento já recebeu o "crie sua senha", que
    // abre confirmando o pagamento. Um só basta.
    if (aviso.kind === "subscription_started"
        && await emailLog.recentlySent(userId, "welcome_set_password", JANELA_BOAS_VINDAS_MS)) {
      return null;
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

// Dono de um objeto do Stripe que só traz o customer (fatura, cobrança).
// getByCustomerId devolve a linha CRUA de propósito: a máscara de modo faria a
// assinatura do outro modo parecer free e o e-mail sairia com o plano errado.
async function donoDoCustomer(customer) {
  const customerId = typeof customer === "string" ? customer : customer?.id;
  if (!customerId) return { sub: null, user: null };
  const sub = await store.getByCustomerId(customerId);
  if (!sub) return { sub: null, user: null };
  return { sub, user: await auth.findById(sub.userId) };
}

// Recibo das cobranças recorrentes — `invoice.payment_succeeded`.
// A primeira fatura da assinatura (billing_reason "subscription_create", que é
// onde entra a taxa de R$ 1,00 do teste) fica de fora: quem confirma aquela é o
// `subscription_started`, senão o cliente recebe dois e-mails da mesma cobrança.
async function onInvoicePaid({ invoice, livemode }) {
  try {
    if (!modoBate(livemode)) return null;
    const pago = Number(invoice?.amount_paid) || 0;
    if (pago <= 0) return null;
    if (!RECIBO_MOTIVOS.has(String(invoice?.billing_reason || ""))) return null;

    const { sub, user } = await donoDoCustomer(invoice?.customer);
    if (!sub || !podeReceber(user)) return null;

    emails.sendAsync(
      "payment_receipt",
      {
        ...base(user, sub),
        amount: pago,
        currency: invoice.currency,
        // status_transitions.paid_at vem em segundos (epoch), como todo
        // timestamp do Stripe.
        paidAt: invoice?.status_transitions?.paid_at
          ? new Date(invoice.status_transitions.paid_at * 1000)
          : new Date(),
        periodEnd: sub.currentPeriodEnd,
        invoiceUrl: invoice?.hosted_invoice_url || "",
      },
      { dedupeKey: `payment_receipt:${user.id}:${invoice.id}` },
    );
    return "payment_receipt";
  } catch (err) {
    logger.warn({ err: err.message, invoice: invoice?.id }, "[billing] recibo de pagamento falhou");
    return null;
  }
}

// Estorno — `charge.refunded`. Vale pro integral e pro parcial; o Stripe reenvia
// o evento a cada novo estorno da mesma cobrança, e por isso o valor acumulado
// entra na dedupeKey (dois estornos parciais = dois e-mails, um por valor).
async function onChargeRefunded({ charge, livemode }) {
  try {
    if (!modoBate(livemode)) return null;
    const devolvido = Number(charge?.amount_refunded) || 0;
    if (devolvido <= 0) return null;

    const { sub, user } = await donoDoCustomer(charge?.customer);
    if (!sub || !podeReceber(user)) return null;

    emails.sendAsync(
      "refund_issued",
      {
        ...base(user, sub),
        amount: devolvido,
        currency: charge.currency,
        partial: devolvido < (Number(charge?.amount) || 0),
        refundedAt: new Date(),
      },
      { dedupeKey: `refund_issued:${user.id}:${charge.id}:${devolvido}` },
    );
    return "refund_issued";
  } catch (err) {
    logger.warn({ err: err.message, charge: charge?.id }, "[billing] aviso de reembolso falhou");
    return null;
  }
}

module.exports = {
  onSubscriptionChanged,
  onSubscriptionDeleted,
  onInvoicePaid,
  onChargeRefunded,
  decidirAviso,
  podeReceber,
};
