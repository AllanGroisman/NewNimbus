const store = require("./pg");
const limits = require("./limits");

// Hidrata sub do usuário pra responder /api/billing/me e gating.
// Sem row = free/inactive (sem acesso até assinar). Não há mais trial automático.
// Admin recebe Business via bypass em limits.effectivePlanId.
async function getStatus(userId, userRole) {
  let sub = await store.getByUserId(userId);
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
  getStatus,
  isActive,
  limits,
};
