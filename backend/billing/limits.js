// Limites por plano — fonte única de verdade, lida pelo gating do backend
// e exposta pro frontend via /api/billing/me.
//
// Terminologia:
//   numbers                     — números de WhatsApp conectados
//   groups                      — CAMPANHAS (model Group; cada Group tem fila própria)
//   whatsappGroupsPerCampaign   — grupos do WhatsApp anexados a UMA campanha
//   categoriesPerGroup          — categorias selecionadas em UMA campanha
//   leadersPerCampaign          — grupos líderes de UMA campanha de repasse
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
      leadersPerCampaign: 0,
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
      leadersPerCampaign: 1,
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
      leadersPerCampaign: 3,
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
      leadersPerCampaign: 5,
    },
  },
};

// Quanto custa o teste de 7 dias, em centavos. Quem cobra de verdade é o price
// STRIPE_PRICE_TRIAL_FEE do dashboard — esta constante existe só pra escrever
// "R$ 1,00" no e-mail de confirmação sem ir buscar a fatura no Stripe. Mesmo
// acordo do priceBRL acima: se mudar no Stripe, mude aqui.
const TRIAL_FEE_CENTS = 100;

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

// Trial manual (cortesia do admin) vigente? Só olha a data — de propósito: é
// justamente ele que segura a conta quando não existe assinatura nenhuma, então
// não pode depender de status do Stripe. Plano desconhecido não vale nada.
function manualTrialActive(sub, now = Date.now()) {
  if (!sub?.manualTrialPlanId || !sub.manualTrialEndsAt) return false;
  if (!PLANS[sub.manualTrialPlanId]) return false;
  const end = new Date(sub.manualTrialEndsAt).getTime();
  return Number.isFinite(end) && end > now;
}

// Dias que faltam da cortesia (null se não há uma vigente) — os selos do admin e
// as telas do cliente leem daqui em vez de refazer a conta de data cada um.
function manualTrialDaysLeft(sub, now = Date.now()) {
  if (!manualTrialActive(sub, now)) return null;
  const ms = new Date(sub.manualTrialEndsAt).getTime() - now;
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}

// O plano que a ASSINATURA garante agora, ignorando a cortesia do admin.
// trialing/active = planId real; past_due/unpaid dentro da carência também.
//
// Existe separado de `effectivePlanId` porque quem pergunta "esta pessoa já é
// cliente?" — o checkout público, que bloqueia quem já assina — não pode
// confundir cortesia com assinatura: senão a cortesia impediria a compra.
function paidPlanId(sub, userRole) {
  if (userRole === "admin") return "business";
  if (!sub) return "free";
  const pago = sub.status === "active" || sub.status === "trialing" || inGracePeriod(sub);
  if (!pago) return "free";
  return PLANS[sub.planId] ? sub.planId : "free";
}

// Plano efetivo: o que o usuário pode usar AGORA.
//
// Ordem: admin → cortesia enquanto a cobrança não começou → assinatura paga →
// cortesia → free.
//
// O degrau do meio é o que faz "assinei durante a cortesia" ter uma resposta só,
// em vez de uma pra upgrade e outra pra downgrade: dentro da janela sem cobrança
// a pessoa segue no plano da cortesia, e o plano contratado assume no MESMO
// instante da primeira cobrança (o Stripe vira `trialing` → `active`). Quem não
// quis esperar escolheu "começar agora" no checkout, e aí não há trial nenhum —
// a assinatura nasce `active` e cai direto no degrau seguinte.
function effectivePlanId(sub, userRole) {
  // Bypass explícito: com o degrau da cortesia logo abaixo, delegar o admin pro
  // paidPlanId deixaria um admin em cortesia cair no plano da cortesia.
  if (userRole === "admin") return "business";
  if (manualTrialActive(sub) && sub.status === "trialing") return sub.manualTrialPlanId;
  // Fora da janela sem cobrança, quem paga tem o que contratou — mesmo que a
  // cortesia guardada seja de um plano maior. Ela fica dormente e reassume
  // sozinha se a assinatura cair antes da data de fim dela.
  const pago = paidPlanId(sub, userRole);
  if (pago !== "free") return pago;
  if (manualTrialActive(sub)) return sub.manualTrialPlanId;
  return "free";
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
  leadersPerCampaign: {
    one: "grupo líder por campanha", many: "grupos líderes por campanha",
    fix: "Remova um grupo líder desta campanha",
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
  TRIAL_FEE_CENTS,
  planRank,
  isUpgrade,
  effectivePlanId,
  paidPlanId,
  manualTrialActive,
  manualTrialDaysLeft,
  inGracePeriod,
  graceEndsAt,
  getLimits,
  getPlan,
  checkLimit,
};
