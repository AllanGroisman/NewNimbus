// Persistência Postgres do módulo billing.

const { prisma } = require("../db");
const stripe = require("./stripe");

// Assinatura de OUTRO modo do Stripe não vale agora: os IDs de customer e de
// subscription só existem no modo em que nasceram, então usá-los daria erro em
// toda chamada (portal, faturas, sync). Em vez disso a linha aparece como "sem
// plano" enquanto o sistema está no outro modo — e volta ao normal quando o
// admin volta o modo. Nada é apagado.
// `crossMode` deixa a UI explicar a situação em vez de sumir com o plano.
//
// Os campos do trial manual passam intactos pelo spread, de propósito: a cortesia
// não é um objeto do Stripe e não tem modo — uma conta com assinatura do outro
// modo continua tendo a cortesia que o admin deu.
function maskCrossMode(row) {
  if (!row || !row.stripeMode || row.stripeMode === stripe.mode()) return row;
  return {
    ...row,
    planId: "free",
    status: "inactive",
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    pastDueSince: null,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    crossMode: row.stripeMode,
  };
}

// Leitura do app (gating, /api/billing/me, portal, scheduler) — passa pela
// máscara de modo. O webhook usa getByCustomerId/getBySubscriptionId, que
// devolvem a linha crua de propósito.
async function getByUserId(userId) {
  return maskCrossMode(await prisma().subscription.findUnique({ where: { userId } }));
}

// Linha crua, sem máscara de modo — usada pelos snapshots antes/depois do
// webhook. Com a máscara, uma assinatura do outro modo apareceria como
// "free/inactive" e o comparador enxergaria transições que nunca aconteceram
// (ex.: mandaria "pagamento falhou" só porque o admin trocou o modo do Stripe).
async function getRawByUserId(userId) {
  if (!userId) return null;
  return prisma().subscription.findUnique({ where: { userId } });
}

// Assinaturas que o job de lembretes precisa olhar: as em teste (pra avisar
// antes de virar cobrança) e as em atraso (pra avisar antes de o acesso cair).
// Sem máscara de modo — quem filtra por modo é o reminders.js, que sabe o modo
// ativo. A tabela tem uma linha por usuário, então não há paginação.
async function listForReminders() {
  return prisma().subscription.findMany({
    where: { status: { in: ["trialing", "past_due", "unpaid"] } },
    include: {
      user: { select: { id: true, email: true, name: true, role: true, suspended: true } },
    },
  });
}

// Cortesias que já venceram e ainda não foram encerradas. Serve pra varredura que
// repausa as campanhas que só cabiam no plano da cortesia — o gating em si já
// expira sozinho (é data), o que fica velho é o `planPaused`.
//
// `listForReminders` não serve aqui: ela filtra por `status`, e conta em cortesia
// costuma estar em "inactive"/"canceled". O filtro por `manualTrialEndedAt: null`
// é o que faz cada concessão ser processada uma vez só, e não a cada 6h pra sempre.
async function listExpiredManualTrials(now = new Date()) {
  return prisma().subscription.findMany({
    where: {
      manualTrialPlanId: { not: null },
      manualTrialEndsAt: { lt: now instanceof Date ? now : new Date(now) },
      manualTrialEndedAt: null,
    },
    include: { user: { select: { id: true, role: true } } },
  });
}

async function getByCustomerId(stripeCustomerId) {
  if (!stripeCustomerId) return null;
  return prisma().subscription.findUnique({ where: { stripeCustomerId } });
}

async function getBySubscriptionId(stripeSubscriptionId) {
  if (!stripeSubscriptionId) return null;
  return prisma().subscription.findUnique({ where: { stripeSubscriptionId } });
}

// Linha crua (sem máscara de modo) da assinatura nascida de uma Checkout
// Session — é como o resgate em /bem-vindo acha a conta provisionada.
async function getByCheckoutSessionId(checkoutSessionId) {
  if (!checkoutSessionId) return null;
  return prisma().subscription.findUnique({ where: { checkoutSessionId } });
}

// Marca o resgate do checkout público como consumido. Uso único: o session_id
// viaja na URL de retorno do Stripe, então só a primeira chamada abre sessão.
// Retorna false se já estava carimbado (ou se a linha sumiu).
async function markClaimed(userId) {
  const r = await prisma().subscription.updateMany({
    where: { userId, claimedAt: null },
    data: { claimedAt: new Date() },
  });
  return r.count > 0;
}

async function ensureForUser(userId, defaults = {}) {
  const existing = await prisma().subscription.findUnique({ where: { userId } });
  // Mascarada também: o checkout precisa criar um customer NOVO no modo atual
  // em vez de reaproveitar o customer do outro modo (que o Stripe não conhece).
  if (existing) return maskCrossMode(existing);
  return prisma().subscription.create({
    data: {
      userId,
      planId: defaults.planId || "free",
      status: defaults.status || "inactive",
      currentPeriodEnd: defaults.currentPeriodEnd ? new Date(defaults.currentPeriodEnd) : null,
      cancelAtPeriodEnd: !!defaults.cancelAtPeriodEnd,
      stripeCustomerId: defaults.stripeCustomerId || null,
      stripeSubscriptionId: defaults.stripeSubscriptionId || null,
      stripeMode: defaults.stripeMode || null,
    },
  });
}

const PAST_DUE_STATUSES = new Set(["past_due", "unpaid"]);

async function update(userId, patch) {
  const data = { ...patch };
  if (patch.currentPeriodEnd) data.currentPeriodEnd = new Date(patch.currentPeriodEnd);
  if (patch.trialUsedAt) data.trialUsedAt = new Date(patch.trialUsedAt);
  for (const k of ["manualTrialStartedAt", "manualTrialEndsAt", "manualTrialEndedAt"]) {
    if (patch[k]) data[k] = new Date(patch[k]);
  }
  // trialEnd, trialFromManual e manualTrialCancel vêm de normalizeSubscription
  // mas não são coluna — são recados pro chamador, não estado persistido.
  delete data.trialEnd;
  delete data.trialFromManual;
  delete data.manualTrialCancel;
  // crossMode é anotação da máscara de leitura, não coluna.
  delete data.crossMode;

  // Toda escrita que linka um objeto do Stripe carimba o modo. Quem chama sem
  // informar (ex.: update só de planId interno) mantém o modo já gravado.
  if (data.stripeMode === undefined && (data.stripeCustomerId || data.stripeSubscriptionId)) {
    data.stripeMode = stripe.mode();
  }

  // pastDueSince é derivado do status e marcado aqui porque este é o funil
  // único de escrita (webhook e reconcile passam por aqui). Marca na PRIMEIRA
  // transição pra atraso (não renova a cada webhook) e limpa quando volta a
  // ficar em dia — é o relógio da carência de 3 dias.
  if (data.status && data.pastDueSince === undefined) {
    if (PAST_DUE_STATUSES.has(data.status)) {
      const existing = await prisma().subscription.findUnique({
        where: { userId }, select: { pastDueSince: true },
      });
      data.pastDueSince = existing?.pastDueSince || new Date();
    } else if (data.status === "active" || data.status === "trialing") {
      data.pastDueSince = null;
    }
  }

  return prisma().subscription.upsert({
    where: { userId },
    create: {
      userId,
      planId: data.planId || "free",
      status: data.status || "inactive",
      currentPeriodEnd: data.currentPeriodEnd || null,
      cancelAtPeriodEnd: !!data.cancelAtPeriodEnd,
      trialUsedAt: data.trialUsedAt || null,
      pastDueSince: data.pastDueSince || null,
      stripeCustomerId: data.stripeCustomerId || null,
      stripeSubscriptionId: data.stripeSubscriptionId || null,
      stripeMode: data.stripeMode || null,
      checkoutSessionId: data.checkoutSessionId || null,
      claimedAt: data.claimedAt || null,
      signupSource: data.signupSource || null,
      // Sem isto, conceder cortesia pra quem nunca teve linha de assinatura criaria
      // a linha SEM a cortesia — o upsert só copia o que está listado aqui.
      manualTrialPlanId: data.manualTrialPlanId || null,
      manualTrialStartedAt: data.manualTrialStartedAt || null,
      manualTrialEndsAt: data.manualTrialEndsAt || null,
      manualTrialEndedAt: data.manualTrialEndedAt || null,
      manualTrialGrantedBy: data.manualTrialGrantedBy || null,
      manualTrialNote: data.manualTrialNote || null,
    },
    update: data,
  });
}

async function isWebhookProcessed(eventId) {
  const r = await prisma().webhookEvent.findUnique({ where: { id: eventId } });
  return !!r;
}

// Insere atomicamente; conflito (id duplicado) = já processado, retorna false.
async function markWebhookProcessed(eventId, type) {
  try {
    await prisma().webhookEvent.create({ data: { id: eventId, type } });
    return true;
  } catch (err) {
    if (err.code === "P2002") return false; // unique violation
    throw err;
  }
}

module.exports = {
  getByUserId,
  getRawByUserId,
  listForReminders,
  listExpiredManualTrials,
  getByCustomerId,
  getBySubscriptionId,
  getByCheckoutSessionId,
  markClaimed,
  ensureForUser,
  update,
  isWebhookProcessed,
  markWebhookProcessed,
};
