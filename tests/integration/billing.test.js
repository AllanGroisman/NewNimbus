// Cobre billing end-to-end:
//   - Trial automático no register (planId=pro, status=trialing, ~7d)
//   - /api/billing/me — status + limits + admin bypass
//   - /api/billing/checkout — fluxo feliz + erros (plano inválido, etc)
//   - /api/billing/portal — exige customer Stripe existente
//   - /api/billing/webhook — todos os tipos relevantes + idempotência + signature inválida
//   - Plan-gating no PUT /api/state (groups/numbers)
//
// O módulo Stripe é mockado via tests/helpers/stripe-mock.js — `enabled()` retorna true
// e `constructEvent` apenas JSON.parse-eia o body (HMAC ignorado).

import { describe, it, expect } from "vitest";
import {
  app, request, createTestUser,
  auth as authMod, billing,
  stripeCalls, setStripeMock,
} from "../helpers/app.js";
import { makeGroup } from "../helpers/fixtures.js";

// Helper: postar evento bruto pro webhook. O mock ignora a signature.
// IMPORTANTE: supertest serializa Buffer pra { type:"Buffer", data:[...] } quando
// content-type=json. Mandamos a string JSON pra o express.raw receber os bytes certos.
function postEvent(event, opts = {}) {
  return request(app)
    .post("/api/billing/webhook")
    .set("stripe-signature", opts.signature || "t=1,v1=fake")
    .set("Content-Type", "application/json")
    .send(JSON.stringify(event));
}

describe("Billing — trial automático no register", () => {
  it("usuário recém-criado cai em trialing/pro por ~7 dias", async () => {
    const { auth } = await createTestUser();
    const res = await auth("get", "/api/billing/me");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("trialing");
    expect(res.body.planId).toBe("pro");
    expect(res.body.effectivePlan).toBe("pro");
    expect(res.body.daysLeftInTrial).toBeGreaterThan(5);
    expect(res.body.daysLeftInTrial).toBeLessThanOrEqual(7);
    expect(res.body.limits.groups).toBe(5);           // pro = 5 campanhas
    expect(res.body.limits.whatsappGroupsPerCampaign).toBe(15); // pro = 15 grupos WA por campanha
    expect(res.body.limits.autoScraping).toBe(true);
  });

  it("idempotente — múltiplas chamadas de /billing/me não mudam o fim do trial", async () => {
    const { auth } = await createTestUser();
    const a = await auth("get", "/api/billing/me");
    const b = await auth("get", "/api/billing/me");
    expect(a.body.currentPeriodEnd).toBe(b.body.currentPeriodEnd);
  });

  it("/billing/me retorna stripeEnabled=true com mock", async () => {
    const { auth } = await createTestUser();
    const res = await auth("get", "/api/billing/me");
    expect(res.body.stripeEnabled).toBe(true);
  });
});

describe("Billing — checkout", () => {
  it("cria sessão e devolve url Stripe pra plano pro", async () => {
    const { auth } = await createTestUser();
    const res = await auth("post", "/api/billing/checkout").send({ planId: "pro" });
    expect(res.status).toBe(200);
    expect(res.body.url).toMatch(/^https:\/\/checkout\.stripe\.test\/c\/pro/);
    expect(stripeCalls.createCheckoutSession).toHaveLength(1);
    expect(stripeCalls.createCheckoutSession[0].planId).toBe("pro");
  });

  it("liga stripeCustomerId no usuário após primeiro checkout", async () => {
    const { user, auth } = await createTestUser();
    await auth("post", "/api/billing/checkout").send({ planId: "basic" });
    const sub = await billing.getByUserId(user.id);
    expect(sub.stripeCustomerId).toMatch(/^cus_test_/);
  });

  it("reusa stripeCustomerId quando user fizer 2º checkout", async () => {
    const { auth } = await createTestUser();
    await auth("post", "/api/billing/checkout").send({ planId: "basic" });
    await auth("post", "/api/billing/checkout").send({ planId: "pro" });
    expect(stripeCalls.getOrCreateCustomer.length).toBe(2);
    // 2ª chamada deve incluir existingCustomerId
    expect(stripeCalls.getOrCreateCustomer[1].existingCustomerId).toMatch(/^cus_test_/);
  });

  it("rejeita planId desconhecido com 400", async () => {
    const { auth } = await createTestUser();
    const res = await auth("post", "/api/billing/checkout").send({ planId: "enterprise" });
    expect(res.status).toBe(400);
  });

  it("rejeita sem planId", async () => {
    const { auth } = await createTestUser();
    const res = await auth("post", "/api/billing/checkout").send({});
    expect(res.status).toBe(400);
  });

  it("retorna 501 quando Stripe desabilitado", async () => {
    setStripeMock({ enabled: false });
    const { auth } = await createTestUser();
    const res = await auth("post", "/api/billing/checkout").send({ planId: "pro" });
    expect(res.status).toBe(501);
  });
});

describe("Billing — portal", () => {
  it("rejeita sem stripeCustomerId (user ainda não fez checkout)", async () => {
    const { auth } = await createTestUser();
    const res = await auth("post", "/api/billing/portal").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/customer/i);
  });

  it("retorna url após user ter customer linkado", async () => {
    const { user, auth } = await createTestUser();
    await billing.update(user.id, { stripeCustomerId: "cus_test_xyz" });
    const res = await auth("post", "/api/billing/portal").send({});
    expect(res.status).toBe(200);
    expect(res.body.url).toMatch(/^https:\/\/billing\.stripe\.test\//);
  });

  it("retorna 501 quando Stripe desabilitado", async () => {
    setStripeMock({ enabled: false });
    const { auth } = await createTestUser();
    const res = await auth("post", "/api/billing/portal").send({});
    expect(res.status).toBe(501);
  });
});

describe("Billing — webhook handler", () => {
  it("sem signature retorna 400", async () => {
    const res = await request(app)
      .post("/api/billing/webhook")
      .set("Content-Type", "application/json")
      .send("{}");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/signature/i);
  });

  it("signature inválida retorna 400", async () => {
    setStripeMock({ shouldFailConstructEvent: true });
    const res = await postEvent({ id: "evt_x", type: "noop" });
    expect(res.status).toBe(400);
  });

  it("Stripe desabilitado retorna 501", async () => {
    setStripeMock({ enabled: false });
    const res = await postEvent({ id: "evt_x", type: "noop" });
    expect(res.status).toBe(501);
  });

  it("evento desconhecido retorna 200 e ignora", async () => {
    const res = await postEvent({ id: "evt_unknown_1", type: "customer.created", data: { object: {} } });
    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
  });

  it("checkout.session.completed liga stripeCustomerId ao userId", async () => {
    const { user } = await createTestUser();
    const res = await postEvent({
      id: "evt_checkout_1",
      type: "checkout.session.completed",
      data: { object: { client_reference_id: user.id, customer: "cus_paid_123" } },
    });
    expect(res.status).toBe(200);
    const sub = await billing.getByUserId(user.id);
    expect(sub.stripeCustomerId).toBe("cus_paid_123");
  });

  it("customer.subscription.created cria sub completa", async () => {
    const { user } = await createTestUser();
    // Pré-liga customer (como aconteceria após checkout.session.completed)
    await billing.update(user.id, { stripeCustomerId: "cus_x1" });

    const res = await postEvent({
      id: "evt_sub_created_1",
      type: "customer.subscription.created",
      data: {
        object: {
          id: "sub_xyz",
          customer: "cus_x1",
          status: "active",
          current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
          cancel_at_period_end: false,
          items: { data: [{ price: { id: "price_test_pro" } }] },
        },
      },
    });
    expect(res.status).toBe(200);
    const sub = await billing.getByUserId(user.id);
    expect(sub.stripeSubscriptionId).toBe("sub_xyz");
    expect(sub.planId).toBe("pro");
    expect(sub.status).toBe("active");
  });

  it("customer.subscription.updated muda planId (basic→business)", async () => {
    const { user } = await createTestUser();
    await billing.update(user.id, { stripeCustomerId: "cus_y1", stripeSubscriptionId: "sub_y", planId: "basic", status: "active" });

    await postEvent({
      id: "evt_sub_up_1",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_y",
          customer: "cus_y1",
          status: "active",
          current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
          cancel_at_period_end: false,
          items: { data: [{ price: { id: "price_test_business" } }] },
        },
      },
    });
    const sub = await billing.getByUserId(user.id);
    expect(sub.planId).toBe("business");
  });

  it("customer.subscription.deleted derruba pra free/canceled", async () => {
    const { user } = await createTestUser();
    await billing.update(user.id, { stripeCustomerId: "cus_d1", stripeSubscriptionId: "sub_d", planId: "pro", status: "active" });

    await postEvent({
      id: "evt_sub_del_1",
      type: "customer.subscription.deleted",
      data: { object: { id: "sub_d", customer: "cus_d1" } },
    });
    const sub = await billing.getByUserId(user.id);
    expect(sub.planId).toBe("free");
    expect(sub.status).toBe("canceled");
    expect(sub.stripeSubscriptionId).toBeNull();
  });

  it("invoice.payment_failed é aceito mas só loga (não muda sub)", async () => {
    const { user } = await createTestUser();
    await billing.update(user.id, { stripeCustomerId: "cus_inv", planId: "pro", status: "active" });

    const res = await postEvent({
      id: "evt_inv_fail_1",
      type: "invoice.payment_failed",
      data: { object: { id: "in_x", customer: "cus_inv" } },
    });
    expect(res.status).toBe(200);
    // Status inalterado — quem muda pra past_due é o customer.subscription.updated
    const sub = await billing.getByUserId(user.id);
    expect(sub.status).toBe("active");
  });

  it("idempotência — mesmo event.id processado 2x não duplica efeito", async () => {
    const { user } = await createTestUser();
    const eventId = "evt_idemp_unique";
    await postEvent({
      id: eventId,
      type: "checkout.session.completed",
      data: { object: { client_reference_id: user.id, customer: "cus_idemp" } },
    });
    // Re-envia mesmo event — deve responder 200 mas não disparar handleStripeEvent de novo
    const replay = await postEvent({
      id: eventId,
      type: "checkout.session.completed",
      data: { object: { client_reference_id: user.id, customer: "cus_OUTRA" } },
    });
    expect(replay.status).toBe(200);
    const sub = await billing.getByUserId(user.id);
    expect(sub.stripeCustomerId).toBe("cus_idemp"); // valor da 1ª, não da 2ª
  });

  it("subscription event sem userId resolvível é ignorado sem erro", async () => {
    const res = await postEvent({
      id: "evt_orphan",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_orfa",
          customer: "cus_nao_existe",
          status: "active",
          current_period_end: 0,
          items: { data: [{ price: { id: "price_test_pro" } }] },
        },
      },
    });
    expect(res.status).toBe(200);
  });
});

describe("Billing — plan-gating no PUT /api/state", () => {
  it("trial Pro: aceita 5 grupos (campanhas)", async () => {
    const { auth } = await createTestUser();
    const groups = Array.from({ length: 5 }, (_, i) => makeGroup({ id: i + 1, name: `G${i + 1}` }));
    const res = await auth("put", "/api/state").send({ groups, numbers: [], whatsappGroups: [] });
    expect(res.status).toBe(200);
  });

  it("trial Pro: rejeita 6 grupos com 402 + planRequired=business", async () => {
    const { auth } = await createTestUser();
    const groups = Array.from({ length: 6 }, (_, i) => makeGroup({ id: i + 1, name: `G${i + 1}` }));
    const res = await auth("put", "/api/state").send({ groups, numbers: [], whatsappGroups: [] });
    expect(res.status).toBe(402);
    expect(res.body.limit).toBe(5);
    expect(res.body.current).toBe(6);
    expect(res.body.planRequired).toBe("business");
  });

  it("trial Pro: aceita 3 numbers, rejeita 4", async () => {
    const { auth } = await createTestUser();
    const okRes = await auth("put", "/api/state").send({
      groups: [], numbers: [1, 2, 3].map(i => ({ id: `n${i}`, phone: `5511${i}` })), whatsappGroups: [],
    });
    expect(okRes.status).toBe(200);
    const badRes = await auth("put", "/api/state").send({
      groups: [], numbers: [1, 2, 3, 4].map(i => ({ id: `n${i}`, phone: `5511${i}` })), whatsappGroups: [],
    });
    expect(badRes.status).toBe(402);
    expect(badRes.body.limit).toBe(3);
  });

  it("user free (canceled) é bloqueado em 1 grupo (groups limit)", async () => {
    const { user, auth } = await createTestUser();
    await billing.update(user.id, { planId: "free", status: "canceled" });
    // auto:false pra não disparar o gating de autoScraping (que retornaria planRequired=pro);
    // categoria única pra não disparar gating de categoriesPerGroup. Aqui testamos só `groups`.
    const g = makeGroup({ id: 1, auto: false, categories: [] });
    const res = await auth("put", "/api/state").send({ groups: [g], numbers: [], whatsappGroups: [] });
    expect(res.status).toBe(402);
    expect(res.body.planRequired).toBe("basic");
  });
});

describe("Billing — admin bypass", () => {
  it("admin recebe business permanente e passa em qualquer contagem", async () => {
    const { user, auth } = await createTestUser();
    await authMod.setUserRole(user.id, "admin");

    const me = await auth("get", "/api/billing/me");
    expect(me.body.isAdmin).toBe(true);
    expect(me.body.effectivePlan).toBe("business");

    const groups = Array.from({ length: 50 }, (_, i) => makeGroup({ id: i + 1, name: `G${i + 1}` }));
    const res = await auth("put", "/api/state").send({ groups, numbers: [], whatsappGroups: [] });
    expect(res.status).toBe(200);
  });
});
