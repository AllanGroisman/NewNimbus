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

async function update(userId, patch) {
  const data = { ...patch };
  if (patch.currentPeriodEnd) data.currentPeriodEnd = new Date(patch.currentPeriodEnd);
  return prisma().subscription.upsert({
    where: { userId },
    create: {
      userId,
      planId: data.planId || "free",
      status: data.status || "inactive",
      currentPeriodEnd: data.currentPeriodEnd || null,
      cancelAtPeriodEnd: !!data.cancelAtPeriodEnd,
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
