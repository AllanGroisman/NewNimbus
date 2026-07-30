const store = require("./pg");
const limits = require("./limits");
const prices = require("./prices");
const stripe = require("./stripe");
const enforce = require("./enforce");

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
  // Carência de pagamento — o cliente segue com o plano por 3 dias após a
  // falha do cartão; o frontend usa isto pro banner com a data limite.
  const inGrace = limits.inGracePeriod(sub);
  const graceEndsAt = inGrace ? limits.graceEndsAt(sub) : null;

  return {
    planId: sub.planId,
    effectivePlan,
    status: sub.status,
    currentPeriodEnd: sub.currentPeriodEnd,
    cancelAtPeriodEnd: !!sub.cancelAtPeriodEnd,
    daysLeftInTrial,
    daysUntilPeriodEnd,
    inGrace,
    graceEndsAt,
    limits: planLimits,
    hasStripeCustomer: !!sub.stripeCustomerId,
    isAdmin: userRole === "admin",
    // Modo do Stripe valendo agora — a página de assinatura avisa o admin
    // quando o sistema está em modo teste.
    stripeMode: stripe.mode(),
    // Trial de R$1 só pra quem nunca assinou nem usou trial (assinantes antigos
    // não têm trialUsedAt, mas têm stripeSubscriptionId).
    trialEligible: !sub.trialUsedAt && !sub.stripeSubscriptionId,
    // Catálogo público — frontend lê preços daqui em vez de hardcodar.
    plans: await publicPlans(),
  };
}

// Catálogo de planos assináveis exposto ao frontend (sem "free").
// Nome e preço vêm do Stripe quando disponíveis; limits.js é o fallback — o
// site nunca fica sem catálogo se o Stripe estiver fora do ar.
async function publicPlans() {
  const live = await prices.getPublicPrices();
  return ["basic", "pro", "business"].map((id) => ({
    id,
    label: live?.[id]?.name || limits.PLANS[id].label,
    priceBRL: live?.[id]?.priceBRL ?? limits.PLANS[id].priceBRL,
    priceId: live?.[id]?.priceId || null,
    limits: limits.PLANS[id].limits,
  }));
}

// Indica se o scheduler pode processar grupos desse usuário.
// trialing/active = sim; past_due/unpaid dentro da carência de 3 dias também.
// Qualquer outro = não. Admin sempre ativo.
function isActive(sub, userRole) {
  if (userRole === "admin") return true;
  if (!sub) return false;
  return sub.status === "active" || sub.status === "trialing" || limits.inGracePeriod(sub);
}

module.exports = {
  ...store,
  getStatus,
  publicPlans,
  isActive,
  limits,
  enforce,
};
