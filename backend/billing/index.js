// Façade billing/ — seleciona JSON ou Postgres baseado em STORAGE_BACKEND.
// Mesmo padrão de storage/, catalog/, auth/, config/.

const { isPg } = require("../db");
const store = isPg() ? require("./pg") : require("./json");
const limits = require("./limits");

// Cria trial de 7 dias do plano Pro pra usuário recém-registrado.
// Idempotente — não sobrescreve sub existente.
async function startTrialFor(userId) {
  const existing = await store.getByUserId(userId);
  if (existing) return existing;
  const trialEnd = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  return store.ensureForUser(userId, {
    planId: "pro",
    status: "trialing",
    currentPeriodEnd: trialEnd,
  });
}

// Hidrata sub do usuário pra responder /api/billing/me e gating.
// Cria trial automaticamente em primeira leitura se ainda não houver row —
// cobre usuários que já existiam quando o billing foi implantado.
// Admin não recebe trial (bypass via limits.effectivePlanId).
async function getStatus(userId, userRole) {
  let sub = await store.getByUserId(userId);
  if (!sub && userRole !== "admin") {
    sub = await startTrialFor(userId);
  }
  if (!sub) {
    sub = {
      planId: "free",
      status: "inactive",
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
    };
  }
  const effectivePlan = limits.effectivePlanId(sub, userRole);
  const planLimits = limits.getLimits(sub, userRole);
  let daysLeftInTrial = null;
  if (sub.status === "trialing" && sub.currentPeriodEnd) {
    const ms = new Date(sub.currentPeriodEnd).getTime() - Date.now();
    daysLeftInTrial = Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
  }
  return {
    planId: sub.planId,
    effectivePlan,
    status: sub.status,
    currentPeriodEnd: sub.currentPeriodEnd,
    cancelAtPeriodEnd: !!sub.cancelAtPeriodEnd,
    daysLeftInTrial,
    limits: planLimits,
    hasStripeCustomer: !!sub.stripeCustomerId,
    isAdmin: userRole === "admin",
  };
}

// Indica se o scheduler pode processar grupos desse usuário.
// trialing/active = sim; qualquer outro = não. Admin sempre ativo.
function isActive(sub, userRole) {
  if (userRole === "admin") return true;
  if (!sub) return false;
  return sub.status === "active" || sub.status === "trialing";
}

module.exports = {
  ...store,
  startTrialFor,
  getStatus,
  isActive,
  limits,
};
