// Testes dos limites por plano e helper de gating.
// Backend puro — não precisa de servidor.

import { describe, it, expect } from "vitest";
import "../helpers/env.js";
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const limits = require(path.resolve(__dirname, "..", "..", "backend", "billing", "limits.js"));

describe("billing/limits — effectivePlanId", () => {
  it("admin sempre cai em business, ignorando sub", () => {
    expect(limits.effectivePlanId(null, "admin")).toBe("business");
    expect(limits.effectivePlanId({ planId: "basic", status: "canceled" }, "admin")).toBe("business");
  });

  it("sem sub → free", () => {
    expect(limits.effectivePlanId(null)).toBe("free");
    expect(limits.effectivePlanId(undefined, "user")).toBe("free");
  });

  it("status não-ativo → free mesmo com planId pago", () => {
    expect(limits.effectivePlanId({ planId: "pro", status: "canceled" })).toBe("free");
    expect(limits.effectivePlanId({ planId: "pro", status: "past_due" })).toBe("free");
    expect(limits.effectivePlanId({ planId: "pro", status: "incomplete" })).toBe("free");
  });

  it("trialing e active → planId real", () => {
    expect(limits.effectivePlanId({ planId: "pro", status: "trialing" })).toBe("pro");
    expect(limits.effectivePlanId({ planId: "basic", status: "active" })).toBe("basic");
  });

  it("planId desconhecido → free", () => {
    expect(limits.effectivePlanId({ planId: "enterprise", status: "active" })).toBe("free");
  });
});

// Trial manual = cortesia dada pelo admin em Admin › Usuários. Nada a ver com o
// teste de R$1: não passa pelo Stripe e não consome trialUsedAt.
describe("billing/limits — trial manual (cortesia)", () => {
  const DIA = 24 * 60 * 60 * 1000;
  const emDias = n => new Date(Date.now() + n * DIA);
  const cortesia = (planId, dias, extra = {}) => ({
    planId: "free", status: "inactive",
    manualTrialPlanId: planId, manualTrialEndsAt: emDias(dias),
    ...extra,
  });

  it("manualTrialActive: só vale com plano conhecido e data no futuro", () => {
    expect(limits.manualTrialActive(null)).toBe(false);
    expect(limits.manualTrialActive({ planId: "free", status: "inactive" })).toBe(false);
    expect(limits.manualTrialActive(cortesia("pro", 5))).toBe(true);
    expect(limits.manualTrialActive(cortesia("pro", -1))).toBe(false);
    expect(limits.manualTrialActive(cortesia("enterprise", 5))).toBe(false);
    expect(limits.manualTrialActive({ manualTrialPlanId: "pro", manualTrialEndsAt: null })).toBe(false);
  });

  it("manualTrialDaysLeft: dias restantes, null sem cortesia vigente", () => {
    expect(limits.manualTrialDaysLeft(cortesia("pro", 7))).toBe(7);
    expect(limits.manualTrialDaysLeft(cortesia("pro", -3))).toBe(null);
    expect(limits.manualTrialDaysLeft(null)).toBe(null);
  });

  it("sem assinatura, a cortesia é o que vale", () => {
    expect(limits.effectivePlanId(cortesia("pro", 10))).toBe("pro");
    expect(limits.getLimits(cortesia("pro", 10)).groups).toBe(5);
  });

  it("assinatura paga VENCE a cortesia, mesmo sendo de plano menor", () => {
    const sub = cortesia("business", 10, { planId: "basic", status: "active" });
    expect(limits.effectivePlanId(sub)).toBe("basic");
    expect(limits.getLimits(sub).groups).toBe(1);
  });

  it("a cortesia reassume quando a assinatura cai, até a data de fim", () => {
    const cancelada = cortesia("pro", 10, { planId: "basic", status: "canceled" });
    expect(limits.effectivePlanId(cancelada)).toBe("pro");
  });

  it("cortesia vencida → free", () => {
    expect(limits.effectivePlanId(cortesia("pro", -1))).toBe("free");
  });

  // Assinar durante a cortesia: a assinatura nasce `trialing` (cobrança adiada
  // pro fim da cortesia) e a pessoa segue no plano da cortesia até lá. É o que
  // dá uma resposta só pro upgrade e pro downgrade.
  it("cobrança adiada: vale a cortesia até a assinatura começar a cobrar", () => {
    const adiada = cortesia("basic", 20, { planId: "pro", status: "trialing" });
    expect(limits.effectivePlanId(adiada)).toBe("basic");
    expect(limits.getLimits(adiada).groups).toBe(1);

    // Virou `active` (primeira cobrança): o plano contratado assume no mesmo
    // instante, sem degrau intermediário.
    expect(limits.effectivePlanId({ ...adiada, status: "active" })).toBe("pro");
  });

  it("o degrau da cobrança adiada também protege quem desce de plano", () => {
    // Cortesia Business + assinatura Basic: perder o Business no meio do prazo
    // prometido, sem estar pagando nada ainda, era o caso que motivou a regra.
    const adiada = cortesia("business", 20, { planId: "basic", status: "trialing" });
    expect(limits.effectivePlanId(adiada)).toBe("business");
    expect(limits.effectivePlanId({ ...adiada, status: "active" })).toBe("basic");
  });

  it("trial de R$1 comum (sem cortesia) segue valendo o plano contratado", () => {
    expect(limits.effectivePlanId({ planId: "basic", status: "trialing" })).toBe("basic");
    // Cortesia já vencida não segura mais nada.
    expect(limits.effectivePlanId(cortesia("business", -1, { planId: "basic", status: "trialing" }))).toBe("basic");
  });

  it("admin em cortesia continua business", () => {
    expect(limits.effectivePlanId(cortesia("basic", 20, { planId: "pro", status: "trialing" }), "admin")).toBe("business");
  });

  it("paidPlanId ignora a cortesia — é o que responde 'já é cliente?'", () => {
    // Sem isto, o checkout público bloquearia quem está em cortesia dizendo que
    // "já assina o plano Pro" — justamente quem a gente quer que assine no fim.
    expect(limits.paidPlanId(cortesia("pro", 10))).toBe("free");
    expect(limits.effectivePlanId(cortesia("pro", 10))).toBe("pro");
    expect(limits.paidPlanId(cortesia("pro", 10, { planId: "basic", status: "active" }))).toBe("basic");
    expect(limits.paidPlanId(null, "admin")).toBe("business");
  });

  it("carência do cartão continua vencendo a cortesia", () => {
    const sub = cortesia("business", 10, {
      planId: "basic", status: "past_due", pastDueSince: new Date(),
    });
    expect(limits.effectivePlanId(sub)).toBe("basic");
  });
});

describe("billing/limits — carência do past_due", () => {
  const daysAgo = (d) => new Date(Date.now() - d * 24 * 60 * 60 * 1000);

  it("cartão que falhou há 1 dia mantém o plano pago", () => {
    const sub = { planId: "pro", status: "past_due", pastDueSince: daysAgo(1) };
    expect(limits.inGracePeriod(sub)).toBe(true);
    expect(limits.effectivePlanId(sub)).toBe("pro");
  });

  it("passados os 3 dias, cai pra free", () => {
    const sub = { planId: "pro", status: "past_due", pastDueSince: daysAgo(4) };
    expect(limits.inGracePeriod(sub)).toBe(false);
    expect(limits.effectivePlanId(sub)).toBe("free");
  });

  it("unpaid usa a mesma carência; sem pastDueSince não há carência", () => {
    expect(limits.inGracePeriod({ planId: "pro", status: "unpaid", pastDueSince: daysAgo(2) })).toBe(true);
    expect(limits.inGracePeriod({ planId: "pro", status: "past_due" })).toBe(false);
  });

  it("canceled não ganha carência nenhuma", () => {
    const sub = { planId: "pro", status: "canceled", pastDueSince: daysAgo(1) };
    expect(limits.inGracePeriod(sub)).toBe(false);
    expect(limits.effectivePlanId(sub)).toBe("free");
  });

  it("graceEndsAt cai 3 dias depois do início do atraso", () => {
    const since = daysAgo(1);
    const end = limits.graceEndsAt({ planId: "pro", status: "past_due", pastDueSince: since });
    expect(end.getTime()).toBe(since.getTime() + limits.GRACE_MS);
  });
});

describe("billing/limits — checkLimit", () => {
  const proSub = { planId: "pro", status: "active" };
  const basicSub = { planId: "basic", status: "active" };

  it("free: rejeita qualquer grupo", () => {
    const r = limits.checkLimit(null, "groups", 1);
    expect(r.ok).toBe(false);
    expect(r.limit).toBe(0);
    expect(r.planRequired).toBe("basic");
  });

  it("basic: aceita 1 campanha, rejeita 2", () => {
    expect(limits.checkLimit(basicSub, "groups", 1).ok).toBe(true);
    const r = limits.checkLimit(basicSub, "groups", 2);
    expect(r.ok).toBe(false);
    expect(r.limit).toBe(1);
    expect(r.planRequired).toBe("pro");
  });

  it("pro: aceita 5 campanhas, rejeita 6", () => {
    expect(limits.checkLimit(proSub, "groups", 5).ok).toBe(true);
    const r = limits.checkLimit(proSub, "groups", 6);
    expect(r.ok).toBe(false);
    expect(r.planRequired).toBe("business");
  });

  it("whatsappGroupsPerCampaign: basic=3, pro=15, business=999", () => {
    expect(limits.checkLimit(basicSub, "whatsappGroupsPerCampaign", 3).ok).toBe(true);
    expect(limits.checkLimit(basicSub, "whatsappGroupsPerCampaign", 4).ok).toBe(false);
    expect(limits.checkLimit(proSub, "whatsappGroupsPerCampaign", 15).ok).toBe(true);
    expect(limits.checkLimit(proSub, "whatsappGroupsPerCampaign", 16).ok).toBe(false);
    expect(limits.checkLimit({ planId: "business", status: "active" }, "whatsappGroupsPerCampaign", 100).ok).toBe(true);
  });

  it("leadersPerCampaign: basic=1, pro=3, business=5", () => {
    expect(limits.checkLimit(basicSub, "leadersPerCampaign", 1).ok).toBe(true);
    const r = limits.checkLimit(basicSub, "leadersPerCampaign", 2);
    expect(r.ok).toBe(false);
    expect(r.planRequired).toBe("pro");
    expect(limits.checkLimit(proSub, "leadersPerCampaign", 3).ok).toBe(true);
    expect(limits.checkLimit(proSub, "leadersPerCampaign", 4).planRequired).toBe("business");
    const business = { planId: "business", status: "active" };
    expect(limits.checkLimit(business, "leadersPerCampaign", 5).ok).toBe(true);
    expect(limits.checkLimit(business, "leadersPerCampaign", 6).ok).toBe(false);
  });

  it("admin sempre passa, mesmo extrapolando", () => {
    const r = limits.checkLimit(null, "groups", 9999, "admin");
    expect(r.ok).toBe(true);
  });
});
