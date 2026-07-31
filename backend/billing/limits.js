// Limites por plano — fonte única de verdade, lida pelo gating do backend
// e exposta pro frontend via /api/billing/me.
//
// Terminologia:
//   numbers                     — números de WhatsApp conectados
//   groups                      — CAMPANHAS (model Group; cada Group tem fila própria)
//   whatsappGroupsPerCampaign   — grupos do WhatsApp anexados a UMA campanha
//   categoriesPerGroup          — categorias selecionadas em UMA campanha
//
// Quando o plano não tem assinatura paga (status diferente de active/trialing),
// o usuário cai em "free" — sem acesso a criar campanhas/números nem rodar scheduler.

const PLANS = {
  free: {
    label: "Free",
    priceBRL: 0,
    limits: {
      numbers: 0,
      groups: 0,
      whatsappGroupsPerCampaign: 0,
      categoriesPerGroup: 0,
    },
  },
  basic: {
    label: "Básico",
    priceBRL: 69.90,
    limits: {
      numbers: 1,
      groups: 1,
      whatsappGroupsPerCampaign: 3,
      categoriesPerGroup: 2,
    },
  },
  pro: {
    label: "Pro",
    priceBRL: 99.90,
    limits: {
      numbers: 3,
      groups: 5,
      whatsappGroupsPerCampaign: 15,
      categoriesPerGroup: 99,
    },
  },
  business: {
    label: "Business",
    priceBRL: 149.90,
    limits: {
      numbers: 5,
      groups: 999,
      whatsappGroupsPerCampaign: 999,
      categoriesPerGroup: 99,
    },
  },
};

// Carência de pagamento: cartão que falha (past_due/unpaid) não derruba o
// cliente na hora — o Stripe ainda vai tentar cobrar de novo. Durante estes
// 3 dias, contados de `pastDueSince`, o plano pago continua valendo.
const GRACE_MS = 3 * 24 * 60 * 60 * 1000;
const PAST_DUE_STATUSES = new Set(["past_due", "unpaid"]);

// true enquanto a assinatura em atraso ainda está dentro da carência.
// Sem `pastDueSince` (linha antiga, atraso de origem desconhecida) não há
// carência — comportamento conservador de antes.
function inGracePeriod(sub, now = Date.now()) {
  if (!sub || !PAST_DUE_STATUSES.has(sub.status)) return false;
  if (!sub.pastDueSince) return false;
  const since = new Date(sub.pastDueSince).getTime();
  if (!Number.isFinite(since)) return false;
  return now - since < GRACE_MS;
}

// Fim da carência em ms (ou null) — usado pelo banner "atualize o cartão até…".
function graceEndsAt(sub) {
  if (!sub?.pastDueSince || !PAST_DUE_STATUSES.has(sub.status)) return null;
  const since = new Date(sub.pastDueSince).getTime();
  if (!Number.isFinite(since)) return null;
  return new Date(since + GRACE_MS);
}

// Plano efetivo: o que o usuário pode usar AGORA. trialing/active = planId real;
// past_due/unpaid dentro da carência também. Qualquer outro caso cai pra free.
// Admins recebem Business permanentemente — bypass de gating.
function effectivePlanId(sub, userRole) {
  if (userRole === "admin") return "business";
  if (!sub) return "free";
  const active = sub.status === "active" || sub.status === "trialing" || inGracePeriod(sub);
  if (!active) return "free";
  return PLANS[sub.planId] ? sub.planId : "free";
}

function getLimits(sub, userRole) {
  const planId = effectivePlanId(sub, userRole);
  return PLANS[planId].limits;
}

function getPlan(planId) {
  return PLANS[planId] || PLANS.free;
}

// Ordem de grandeza dos planos. Usada pelo checkout público pra decidir entre
// bloquear a compra (mesmo plano ou pior) e mandar fazer upgrade (plano melhor),
// e pelo /api/billing/change-plan, que só aceita subir de plano — descer
// continua sendo pelo Customer Portal, que agenda a troca pro fim do período.
const PLAN_RANK = { free: 0, basic: 1, pro: 2, business: 3 };

function planRank(planId) {
  return PLAN_RANK[planId] ?? 0;
}

// true se `toPlanId` é estritamente maior que `fromPlanId`.
function isUpgrade(fromPlanId, toPlanId) {
  return planRank(toPlanId) > planRank(fromPlanId);
}

// Rótulos em pt-BR pra montar mensagem que o cliente entende — o texto antigo
// ("Limite de groups excedido (2/1)") aparecia cru na tela.
const LABELS = {
  groups: { one: "campanha ativa", many: "campanhas ativas", fix: "Pause uma campanha" },
  numbers: { one: "número de WhatsApp ativo", many: "números de WhatsApp ativos", fix: "Pause um número" },
  whatsappGroupsPerCampaign: {
    one: "grupo de WhatsApp por campanha", many: "grupos de WhatsApp por campanha",
    fix: "Remova grupos desta campanha",
  },
  categoriesPerGroup: {
    one: "categoria por campanha", many: "categorias por campanha",
    fix: "Remova categorias desta campanha",
  },
};

// Mensagem amigável do estouro de limite. Sem plano ativo (limite 0) o caminho
// é assinar; com plano, dá pra pausar/remover ou subir de plano.
function limitMessage(sub, key, current, limit, planRequired, userRole) {
  const label = LABELS[key] || { one: key, many: key, fix: "Remova itens" };
  const planLabel = getPlan(effectivePlanId(sub, userRole)).label;
  const upgradeLabel = getPlan(planRequired).label;
  const upgradeLimit = getPlan(planRequired).limits[key];
  if (!limit) {
    return `Você está sem plano ativo, então não dá para usar ${label.many}. Assine o ${upgradeLabel} para liberar.`;
  }
  const unit = limit === 1 ? label.one : label.many;
  const upgradePart = planRequired && upgradeLimit > limit
    ? ` ${label.fix} ou assine o ${upgradeLabel} para ter ${upgradeLimit}.`
    : ` ${label.fix}.`;
  return `Seu plano ${planLabel} permite ${limit} ${unit} e você já tem ${current}.${upgradePart}`;
}

// Helper de gating — retorna { ok, error?, code?, limit?, current?, planRequired? }
function checkLimit(sub, key, current, userRole) {
  // Admin bypass total — não checa limites mesmo se exceder business.
  if (userRole === "admin") return { ok: true, bypass: "admin" };
  const limits = getLimits(sub, userRole);
  const limit = limits[key];
  if (limit === undefined) return { ok: true };
  // Feature booleana (nenhuma hoje) — "pro" é só o default de sugestão.
  if (typeof limit === "boolean") {
    return limit ? { ok: true } : {
      ok: false,
      code: "plan_limit",
      key,
      error: `Este recurso não está disponível no seu plano.`,
      planRequired: "pro",
    };
  }
  if (current > limit) {
    const planRequired = suggestUpgrade(sub, key, current);
    return {
      ok: false,
      code: "plan_limit",
      key,
      error: limitMessage(sub, key, current, limit, planRequired, userRole),
      limit,
      current,
      planRequired,
    };
  }
  return { ok: true, limit, current };
}

// Sugere menor plano que comportaria `current` itens da chave dada.
// Se já está em free (sub=null/inativa), começa do basic.
function suggestUpgrade(sub, key, current) {
  const order = ["basic", "pro", "business"];
  const currentPlan = effectivePlanId(sub);
  const currentIdx = order.indexOf(currentPlan); // -1 se free
  const startIdx = currentIdx < 0 ? 0 : currentIdx + 1;
  for (let i = startIdx; i < order.length; i++) {
    const lim = PLANS[order[i]].limits[key];
    if (typeof lim === "boolean") { if (lim) return order[i]; }
    else if (current <= lim) return order[i];
  }
  return "business";
}

module.exports = {
  PLANS,
  PLAN_RANK,
  GRACE_MS,
  planRank,
  isUpgrade,
  effectivePlanId,
  inGracePeriod,
  graceEndsAt,
  getLimits,
  getPlan,
  checkLimit,
};
