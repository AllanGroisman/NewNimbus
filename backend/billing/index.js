const store = require("./pg");
const limits = require("./limits");
const prices = require("./prices");

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
  // Dias até o fim do período atual — usado no banner "Sua assinatura termina em X dias".
  let daysUntilPeriodEnd = null;
  if (sub.currentPeriodEnd) {
    const ms = new Date(sub.currentPeriodEnd).getTime() - Date.now();
    daysUntilPeriodEnd = Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
  }
  return {
    planId: sub.planId,
    effectivePlan,
    status: sub.status,
    currentPeriodEnd: sub.currentPeriodEnd,
    cancelAtPeriodEnd: !!sub.cancelAtPeriodEnd,
    daysLeftInTrial,
    daysUntilPeriodEnd,
    limits: planLimits,
    hasStripeCustomer: !!sub.stripeCustomerId,
    isAdmin: userRole === "admin",
    // Trial de R$1 só pra quem nunca assinou nem usou trial (assinantes antigos
    // não têm trialUsedAt, mas têm stripeSubscriptionId).
    trialEligible: !sub.trialUsedAt && !sub.stripeSubscriptionId,
    // Catálogo público — frontend lê preços daqui em vez de hardcodar.
    plans: await publicPlans(),
  };
}

// Catálogo de planos assináveis exposto ao frontend (sem "free").
// Preço vem do Stripe quando disponível; limits.js é o fallback.
async function publicPlans() {
  const live = await prices.getPublicPrices();
  return ["basic", "pro", "business"].map((id) => ({
    id,
    label: limits.PLANS[id].label,
    priceBRL: live?.[id] ?? limits.PLANS[id].priceBRL,
    limits: limits.PLANS[id].limits,
  }));
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
