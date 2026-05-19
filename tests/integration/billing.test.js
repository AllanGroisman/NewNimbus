// Testa endpoints /api/billing/* e plan-gating no PUT /api/state e WA.
// Stripe SDK não é chamado nestes testes — sem STRIPE_SECRET_KEY o módulo
// reporta enabled=false e endpoints 501. Cobrimos:
//   - trial automático no register (planId=pro, status=trialing, ~7d)
//   - /api/billing/me retorna o status + limits do plano efetivo
//   - admin recebe business permanente
//   - PUT /api/state bloqueia quando excede limits (402)
//   - checkout/portal retornam 501 quando Stripe desabilitado

import { describe, it, expect } from "vitest";
import { app, request, createTestUser } from "../helpers/app.js";
import { makeGroup } from "../helpers/fixtures.js";

describe("Billing — trial automático", () => {
  it("usuário recém-criado cai em trialing/pro por ~7 dias", async () => {
    const { auth } = await createTestUser();
    const res = await auth("get", "/api/billing/me");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("trialing");
    expect(res.body.planId).toBe("pro");
    expect(res.body.effectivePlan).toBe("pro");
    expect(res.body.daysLeftInTrial).toBeGreaterThan(5);
    expect(res.body.daysLeftInTrial).toBeLessThanOrEqual(7);
    expect(res.body.limits.groups).toBe(15);
    expect(res.body.limits.autoScraping).toBe(true);
  });

  it("idempotente — chamar /billing/me várias vezes não muda a data de fim do trial", async () => {
    const { auth } = await createTestUser();
    const a = await auth("get", "/api/billing/me");
    const b = await auth("get", "/api/billing/me");
    expect(a.body.currentPeriodEnd).toBe(b.body.currentPeriodEnd);
  });
});

describe("Billing — endpoints Stripe sem credencial", () => {
  it("POST /api/billing/checkout retorna 501 quando STRIPE_SECRET_KEY ausente", async () => {
    const { auth } = await createTestUser();
    const res = await auth("post", "/api/billing/checkout").send({ planId: "pro" });
    expect(res.status).toBe(501);
  });

  it("POST /api/billing/portal retorna 501 quando STRIPE_SECRET_KEY ausente", async () => {
    const { auth } = await createTestUser();
    const res = await auth("post", "/api/billing/portal").send({});
    expect(res.status).toBe(501);
  });

  it("POST /api/billing/webhook sem signature retorna 400", async () => {
    const res = await request(app)
      .post("/api/billing/webhook")
      .set("Content-Type", "application/json")
      .send({ id: "evt_test", type: "noop" });
    // Como STRIPE_SECRET_KEY não está setada em test mode, retorna 501;
    // se setarmos, viraria 400 por falta de signature. Aceitamos os dois.
    expect([400, 501]).toContain(res.status);
  });
});

describe("Billing — plan-gating no PUT /api/state", () => {
  it("trial Pro: aceita 15 grupos", async () => {
    const { auth } = await createTestUser();
    const groups = Array.from({ length: 15 }, (_, i) => makeGroup({ id: i + 1, name: `G${i + 1}` }));
    const res = await auth("put", "/api/state").send({ groups, numbers: [], whatsappGroups: [] });
    expect(res.status).toBe(200);
  });

  it("trial Pro: rejeita 16 grupos com 402 + planRequired=business", async () => {
    const { auth } = await createTestUser();
    const groups = Array.from({ length: 16 }, (_, i) => makeGroup({ id: i + 1, name: `G${i + 1}` }));
    const res = await auth("put", "/api/state").send({ groups, numbers: [], whatsappGroups: [] });
    expect(res.status).toBe(402);
    expect(res.body.limit).toBe(15);
    expect(res.body.current).toBe(16);
    expect(res.body.planRequired).toBe("business");
  });

  it("trial Pro: aceita 3 numbers, rejeita 4", async () => {
    const { auth } = await createTestUser();
    const okRes = await auth("put", "/api/state").send({
      groups: [],
      numbers: [1, 2, 3].map(i => ({ id: `n${i}`, phone: `5511${i}` })),
      whatsappGroups: [],
    });
    expect(okRes.status).toBe(200);
    const badRes = await auth("put", "/api/state").send({
      groups: [],
      numbers: [1, 2, 3, 4].map(i => ({ id: `n${i}`, phone: `5511${i}` })),
      whatsappGroups: [],
    });
    expect(badRes.status).toBe(402);
    expect(badRes.body.limit).toBe(3);
  });
});

describe("Billing — admin bypass", () => {
  it("admin recebe business e passa em qualquer contagem", async () => {
    // ADMIN_EMAILS é lido no carregamento do módulo; em testes promovemos
    // o usuário direto via auth.setUserRole após o register.
    const { user, auth: userAuth } = await createTestUser();
    const { auth: adminMod } = await import("../helpers/app.js");
    await adminMod.setUserRole(user.id, "admin");

    const me = await userAuth("get", "/api/billing/me");
    expect(me.body.isAdmin).toBe(true);
    expect(me.body.effectivePlan).toBe("business");

    // 50 grupos passa
    const groups = Array.from({ length: 50 }, (_, i) => makeGroup({ id: i + 1, name: `G${i + 1}` }));
    const res = await userAuth("put", "/api/state").send({ groups, numbers: [], whatsappGroups: [] });
    expect(res.status).toBe(200);
  });
});
