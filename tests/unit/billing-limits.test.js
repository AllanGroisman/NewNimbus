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

  it("admin sempre passa, mesmo extrapolando", () => {
    const r = limits.checkLimit(null, "groups", 9999, "admin");
    expect(r.ok).toBe(true);
  });
});
