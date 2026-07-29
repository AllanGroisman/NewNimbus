// Persistência Postgres do módulo billing.

const { prisma } = require("../db");

async function getByUserId(userId) {
  return prisma().subscription.findUnique({ where: { userId } });
}

async function getByCustomerId(stripeCustomerId) {
  if (!stripeCustomerId) return null;
  return prisma().subscription.findUnique({ where: { stripeCustomerId } });
}

async function getBySubscriptionId(stripeSubscriptionId) {
  if (!stripeSubscriptionId) return null;
  return prisma().subscription.findUnique({ where: { stripeSubscriptionId } });
}

async function ensureForUser(userId, defaults = {}) {
  const existing = await prisma().subscription.findUnique({ where: { userId } });
  if (existing) return existing;
  return prisma().subscription.create({
    data: {
      userId,
      planId: defaults.planId || "free",
      status: defaults.status || "inactive",
      currentPeriodEnd: defaults.currentPeriodEnd ? new Date(defaults.currentPeriodEnd) : null,
      cancelAtPeriodEnd: !!defaults.cancelAtPeriodEnd,
      stripeCustomerId: defaults.stripeCustomerId || null,
      stripeSubscriptionId: defaults.stripeSubscriptionId || null,
    },
  });
}

const PAST_DUE_STATUSES = new Set(["past_due", "unpaid"]);

async function update(userId, patch) {
  const data = { ...patch };
  if (patch.currentPeriodEnd) data.currentPeriodEnd = new Date(patch.currentPeriodEnd);
  if (patch.trialUsedAt) data.trialUsedAt = new Date(patch.trialUsedAt);
  // trialEnd vem de normalizeSubscription mas não é coluna — nunca persistir.
  delete data.trialEnd;

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
  getByCustomerId,
  getBySubscriptionId,
  ensureForUser,
  update,
  isWebhookProcessed,
  markWebhookProcessed,
};
