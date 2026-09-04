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
    // não têm trialUsedAt, mas têm stripeSubscriptionId). A cortesia do admin NÃO
    // entra nesta conta: quem ganhou cortesia continua podendo fazer o teste de R$1.
    trialEligible: !sub.trialUsedAt && !sub.stripeSubscriptionId,
    // Cortesia do admin — null quando a conta nunca recebeu uma. `active` é o que
    // vale agora; `dormant` é a cortesia ainda na validade que está perdendo pra
    // uma assinatura paga (e volta a valer se ela cair).
    manualTrial: manualTrialInfo(sub),
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

// Leva o email novo da conta pro Customer do Stripe. Chamado depois que a
// pessoa confirma a troca de email — recibo e aviso de cartão vencido precisam
// chegar no endereço em que ela realmente lê.
//
// Nunca derruba a troca de email: se o Stripe estiver fora do ar ou a conta não
// tiver customer, só registra e segue. E não mexe em customer de outro modo —
// um id de "test" não existe na conta "live" e a chamada só tomaria 404.
async function syncCustomerEmail(userId, email) {
  try {
    const sub = await store.getByUserId(userId);
    if (!sub?.stripeCustomerId) return { ok: false, reason: "sem_customer" };
    if (sub.stripeMode && sub.stripeMode !== stripe.mode()) {
      return { ok: false, reason: "modo_diferente" };
    }
    await stripe.updateCustomerEmail(sub.stripeCustomerId, email);
    return { ok: true };
  } catch (err) {
    console.error("[billing] syncCustomerEmail:", err.message);
    return { ok: false, reason: "erro" };
  }
}

// Resumo da cortesia pro frontend (admin e cliente). null = nunca recebeu uma.
function manualTrialInfo(sub) {
  if (!sub?.manualTrialPlanId || !sub.manualTrialEndsAt) return null;
  const active = limits.manualTrialActive(sub);
  const pago = sub.status === "active" || sub.status === "trialing" || limits.inGracePeriod(sub);
  return {
    planId: sub.manualTrialPlanId,
    planLabel: limits.getPlan(sub.manualTrialPlanId).label,
    endsAt: sub.manualTrialEndsAt,
    daysLeft: limits.manualTrialDaysLeft(sub),
    active,
    // Na validade, mas coberta por assinatura paga — não é o que vale agora.
    dormant: active && pago,
    note: sub.manualTrialNote || null,
    grantedBy: sub.manualTrialGrantedBy || null,
    startedAt: sub.manualTrialStartedAt || null,
  };
}

// Indica se o scheduler pode processar grupos desse usuário.
// trialing/active = sim; past_due/unpaid dentro da carência de 3 dias também;
// cortesia do admin na validade também. Qualquer outro = não. Admin sempre ativo.
function isActive(sub, userRole) {
  if (userRole === "admin") return true;
  if (!sub) return false;
  return sub.status === "active" || sub.status === "trialing"
    || limits.inGracePeriod(sub) || limits.manualTrialActive(sub);
}

// ── Trial manual (cortesia do admin) ─────────────────────────────────────
//
// Nada aqui toca no Stripe nem em `trialUsedAt`: é acesso concedido à mão pelo
// admin, e o único registro dele são as colunas manualTrial* da assinatura. Quem
// resolve o que a cortesia vale é limits.effectivePlanId.

const MANUAL_TRIAL_PLANS = ["basic", "pro", "business"];
const MANUAL_TRIAL_MAX_DAYS = 365;

// Concede ou renova a cortesia. Sempre reescreve: conceder por cima de uma
// cortesia viva ou já vencida redefine plano, início e fim, e limpa o carimbo de
// encerramento (é uma concessão nova, tem que ser varrida de novo quando vencer).
async function grantManualTrial(userId, { planId, days, grantedBy = null, note = null } = {}) {
  if (!MANUAL_TRIAL_PLANS.includes(planId)) {
    throw new Error(`Plano inválido para trial manual: escolha ${MANUAL_TRIAL_PLANS.join(", ")}`);
  }
  const dias = Number(days);
  if (!Number.isInteger(dias) || dias < 1 || dias > MANUAL_TRIAL_MAX_DAYS) {
    throw new Error(`Duração inválida: informe de 1 a ${MANUAL_TRIAL_MAX_DAYS} dias`);
  }
  const agora = new Date();
  const fim = new Date(agora.getTime() + dias * 24 * 60 * 60 * 1000);
  return store.update(userId, {
    manualTrialPlanId: planId,
    manualTrialStartedAt: agora,
    manualTrialEndsAt: fim,
    manualTrialEndedAt: null,
    manualTrialGrantedBy: grantedBy,
    manualTrialNote: note ? String(note).slice(0, 300) : null,
  });
}

// Encerra a cortesia agora. Move a data de fim pro instante atual (é o que faz
// manualTrialActive virar false na hora) e carimba o encerramento pra varredura
// não pegar de novo. Plano e observação ficam como histórico.
async function revokeManualTrial(userId) {
  const sub = await store.getRawByUserId(userId);
  if (!sub?.manualTrialPlanId) throw new Error("Este usuário não tem trial manual");
  const agora = new Date();
  return store.update(userId, {
    manualTrialEndsAt: agora,
    manualTrialEndedAt: agora,
  });
}

module.exports = {
  ...store,
  getStatus,
  publicPlans,
  syncCustomerEmail,
  isActive,
  manualTrialInfo,
  grantManualTrial,
  revokeManualTrial,
  MANUAL_TRIAL_PLANS,
  limits,
  enforce,
  // require tardio: provision.js requer ../auth, que não conhece billing —
  // manter aqui embaixo evita surpresa de ordem de carregamento.
  get provision() { return require("./provision"); },
  // Mesmo motivo do provision: notify.js requer ../auth.
  get notify() { return require("./notify"); },
};
