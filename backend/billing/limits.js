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

// Plano efetivo: o que o usuário pode usar AGORA. trialing/active = planId real;
// qualquer outro status (past_due, canceled, …) cai pra free.
// Admins recebem Business permanentemente — bypass de gating.
function effectivePlanId(sub, userRole) {
  if (userRole === "admin") return "business";
  if (!sub) return "free";
  const active = sub.status === "active" || sub.status === "trialing";
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

// Helper de gating — retorna { ok, error?, limit?, current?, planRequired? }
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
      error: `Feature "${key}" não disponível no plano atual`,
      planRequired: "pro",
    };
  }
  if (current > limit) {
    return {
      ok: false,
      error: `Limite de ${key} excedido (${current}/${limit})`,
      limit,
      current,
      planRequired: suggestUpgrade(sub, key, current),
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
  effectivePlanId,
  getLimits,
  getPlan,
  checkLimit,
};
