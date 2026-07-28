// Cobre billing end-to-end:
//   - Conta nova sem trial (planId=free, status=inactive)
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

describe("Billing — conta nova sem trial", () => {
  it("usuário recém-criado cai em free/inactive — sem acesso até assinar", async () => {
    const { auth } = await createTestUser();
    const res = await auth("get", "/api/billing/me");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("inactive");
    expect(res.body.planId).toBe("free");
    expect(res.body.effectivePlan).toBe("free");
    expect(res.body.daysLeftInTrial).toBeNull();
    expect(res.body.limits.groups).toBe(0);           // free = 0 campanhas
    expect(res.body.limits.numbers).toBe(0);
  });

  it("/billing/me não cria row nem trial em leituras repetidas", async () => {
    const { user, auth } = await createTestUser();
    await auth("get", "/api/billing/me");
    await auth("get", "/api/billing/me");
    // Nenhum row de subscription foi criado só por ler o status.
    const sub = await billing.getByUserId(user.id);
    expect(sub).toBeNull();
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

  it("metadata.planId tem prioridade sobre o price (blinda price_id trocado)", async () => {
    const { user } = await createTestUser();
    await billing.update(user.id, { stripeCustomerId: "cus_meta", stripeSubscriptionId: "sub_meta", planId: "pro", status: "active" });

    // price mapeia pra pro, mas metadata diz business — deve prevalecer business.
    await postEvent({
      id: "evt_meta_1",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_meta",
          customer: "cus_meta",
          status: "active",
          current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
          metadata: { planId: "business" },
          items: { data: [{ price: { id: "price_test_pro" } }] },
        },
      },
    });
    const sub = await billing.getByUserId(user.id);
    expect(sub.planId).toBe("business");
  });
});

describe("Billing — sync (reconciliação ativa)", () => {
  it("corrige o plano local a partir da assinatura ao vivo no Stripe", async () => {
    const { user, auth } = await createTestUser();
    // Simula: checkout ligou o customer, mas o webhook do plano não chegou.
    await billing.update(user.id, { stripeCustomerId: "cus_sync_1", planId: "pro", status: "trialing" });
    setStripeMock({
      activeSubscription: {
        id: "sub_sync_1",
        customer: "cus_sync_1",
        status: "active",
        current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
        metadata: { planId: "business" },
        items: { data: [{ price: { id: "price_test_business" } }] },
      },
    });
    const res = await auth("post", "/api/billing/sync").send({});
    expect(res.status).toBe(200);
    expect(res.body.synced).toBe(true);
    expect(res.body.planId).toBe("business");
    expect(res.body.status).toBe("active");
    const sub = await billing.getByUserId(user.id);
    expect(sub.planId).toBe("business");
  });

  it("sem stripeCustomerId responde synced=false e status free", async () => {
    const { auth } = await createTestUser();
    const res = await auth("post", "/api/billing/sync").send({});
    expect(res.status).toBe(200);
    expect(res.body.synced).toBe(false);
    expect(res.body.planId).toBe("free");
  });

  it("retorna 501 quando Stripe desabilitado", async () => {
    setStripeMock({ enabled: false });
    const { auth } = await createTestUser();
    const res = await auth("post", "/api/billing/sync").send({});
    expect(res.status).toBe(501);
  });
});

describe("Billing — plan-gating no PUT /api/state", () => {
  // Helper: cria user já com assinatura Pro ativa (o trial não existe mais).
  async function createProUser() {
    const ctx = await createTestUser();
    await billing.update(ctx.user.id, { planId: "pro", status: "active" });
    return ctx;
  }

  it("Pro: aceita 5 grupos (campanhas)", async () => {
    const { auth } = await createProUser();
    const groups = Array.from({ length: 5 }, (_, i) => makeGroup({ id: i + 1, name: `G${i + 1}` }));
    const res = await auth("put", "/api/state").send({ groups, numbers: [], whatsappGroups: [] });
    expect(res.status).toBe(200);
  });

  it("Pro: rejeita 6 grupos com 402 + planRequired=business", async () => {
    const { auth } = await createProUser();
    const groups = Array.from({ length: 6 }, (_, i) => makeGroup({ id: i + 1, name: `G${i + 1}` }));
    const res = await auth("put", "/api/state").send({ groups, numbers: [], whatsappGroups: [] });
    expect(res.status).toBe(402);
    expect(res.body.limit).toBe(5);
    expect(res.body.current).toBe(6);
    expect(res.body.planRequired).toBe("business");
  });

  it("Pro: aceita 3 numbers, rejeita 4", async () => {
    const { auth } = await createProUser();
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
    // Categoria única pra não disparar gating de categoriesPerGroup. Aqui testamos só `groups`.
    const g = makeGroup({ id: 1, categories: [] });
    const res = await auth("put", "/api/state").send({ groups: [g], numbers: [], whatsappGroups: [] });
    expect(res.status).toBe(402);
    expect(res.body.planRequired).toBe("basic");
  });
});

describe("Billing — trial de R$1 (15 dias, só Básico, 1x por conta)", () => {
  it("checkout com trial no basic passa withTrial=true pro Stripe", async () => {
    const { auth } = await createTestUser();
    const res = await auth("post", "/api/billing/checkout").send({ planId: "basic", trial: true });
    expect(res.status).toBe(200);
    expect(stripeCalls.createCheckoutSession).toHaveLength(1);
    expect(stripeCalls.createCheckoutSession[0].withTrial).toBe(true);
  });

  it("checkout sem trial não passa withTrial", async () => {
    const { auth } = await createTestUser();
    await auth("post", "/api/billing/checkout").send({ planId: "basic" });
    expect(stripeCalls.createCheckoutSession[0].withTrial).toBe(false);
  });

  it("trial em plano != basic → 400", async () => {
    const { auth } = await createTestUser();
    const res = await auth("post", "/api/billing/checkout").send({ planId: "pro", trial: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Básico/);
  });

  it("trial já usado (trialUsedAt) → 400", async () => {
    const { user, auth } = await createTestUser();
    await billing.update(user.id, { trialUsedAt: new Date() });
    const res = await auth("post", "/api/billing/checkout").send({ planId: "basic", trial: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/já utilizado/i);
  });

  it("ex-assinante (stripeSubscriptionId) não é elegível → 400", async () => {
    const { user, auth } = await createTestUser();
    await billing.update(user.id, { stripeSubscriptionId: "sub_old", planId: "free", status: "canceled" });
    const res = await auth("post", "/api/billing/checkout").send({ planId: "basic", trial: true });
    expect(res.status).toBe(400);
  });

  it("/billing/me expõe trialEligible=true pra conta nova e false após trial", async () => {
    const { user, auth } = await createTestUser();
    const before = await auth("get", "/api/billing/me");
    expect(before.body.trialEligible).toBe(true);
    await billing.update(user.id, { trialUsedAt: new Date() });
    const after = await auth("get", "/api/billing/me");
    expect(after.body.trialEligible).toBe(false);
  });

  it("webhook com trial_end grava trialUsedAt", async () => {
    const { user } = await createTestUser();
    await billing.update(user.id, { stripeCustomerId: "cus_trial_1" });
    await postEvent({
      id: "evt_trial_1",
      type: "customer.subscription.created",
      data: {
        object: {
          id: "sub_trial_1",
          customer: "cus_trial_1",
          status: "trialing",
          trial_end: Math.floor(Date.now() / 1000) + 15 * 86400,
          current_period_end: Math.floor(Date.now() / 1000) + 15 * 86400,
          items: { data: [{ price: { id: "price_test_basic" } }] },
        },
      },
    });
    const sub = await billing.getByUserId(user.id);
    expect(sub.status).toBe("trialing");
    expect(sub.trialUsedAt).not.toBeNull();
  });
});

describe("Billing — /me com fresh, usage e plans", () => {
  it("?fresh=1 reconcilia com o Stripe e é throttled na repetição imediata", async () => {
    const { user, auth } = await createTestUser();
    await billing.update(user.id, { stripeCustomerId: "cus_fresh_1", planId: "basic", status: "active" });
    setStripeMock({
      activeSubscription: {
        id: "sub_fresh_1",
        customer: "cus_fresh_1",
        status: "active",
        current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
        items: { data: [{ price: { id: "price_test_pro" } }] },
      },
    });
    const res = await auth("get", "/api/billing/me?fresh=1");
    expect(res.status).toBe(200);
    expect(res.body.planId).toBe("pro"); // corrigido pelo Stripe ao vivo
    expect(stripeCalls.getActiveSubscriptionForCustomer).toHaveLength(1);
    // Repetição imediata cai no throttle — não chama o Stripe de novo.
    await auth("get", "/api/billing/me?fresh=1");
    expect(stripeCalls.getActiveSubscriptionForCustomer).toHaveLength(1);
  });

  it("sem fresh não chama o Stripe", async () => {
    const { user, auth } = await createTestUser();
    await billing.update(user.id, { stripeCustomerId: "cus_nofresh", planId: "basic", status: "active" });
    await auth("get", "/api/billing/me");
    expect(stripeCalls.getActiveSubscriptionForCustomer).toHaveLength(0);
  });

  it("inclui usage com contagens do state e plans com preços", async () => {
    const { user, auth } = await createTestUser();
    await billing.update(user.id, { planId: "pro", status: "active" });
    const groups = [
      makeGroup({ id: 1, name: "G1" }),
      makeGroup({ id: 2, name: "G2" }),
    ];
    await auth("put", "/api/state").send({
      groups,
      numbers: [{ id: "n1", phone: "551199" }],
      whatsappGroups: [],
    });
    const res = await auth("get", "/api/billing/me");
    expect(res.body.usage.groups).toBe(2);
    expect(res.body.usage.numbers).toBe(1);
    expect(res.body.plans).toHaveLength(3);
    const basic = res.body.plans.find(p => p.id === "basic");
    expect(basic.priceBRL).toBe(69.90);
    expect(basic.limits.groups).toBe(1);
  });
});

describe("Billing — /details", () => {
  it("sem customer retorna struct vazia sem chamar o Stripe", async () => {
    const { auth } = await createTestUser();
    const res = await auth("get", "/api/billing/details");
    expect(res.status).toBe(200);
    expect(res.body.hasStripeCustomer).toBe(false);
    expect(res.body.upcomingInvoice).toBeNull();
    expect(res.body.invoices).toEqual([]);
    expect(stripeCalls.getUpcomingInvoice).toHaveLength(0);
  });

  it("com customer retorna próxima fatura, cartão e histórico", async () => {
    const { user, auth } = await createTestUser();
    await billing.update(user.id, { stripeCustomerId: "cus_det_1", stripeSubscriptionId: "sub_det_1", planId: "basic", status: "active" });
    setStripeMock({
      upcomingInvoice: { amountBRL: 69.9, currency: "brl", nextPaymentAttempt: new Date() },
      paymentMethod: { brand: "visa", last4: "4242", expMonth: 12, expYear: 2027 },
      invoices: [{ id: "in_1", date: new Date(), amountBRL: 1, status: "paid", hostedUrl: "https://x/1", pdfUrl: "https://x/1.pdf" }],
    });
    const res = await auth("get", "/api/billing/details");
    expect(res.status).toBe(200);
    expect(res.body.upcomingInvoice.amountBRL).toBe(69.9);
    expect(res.body.paymentMethod.last4).toBe("4242");
    expect(res.body.invoices).toHaveLength(1);
    expect(res.body.invoices[0].status).toBe("paid");
  });

  it("Stripe desabilitado retorna 200 com struct vazia", async () => {
    setStripeMock({ enabled: false });
    const { auth } = await createTestUser();
    const res = await auth("get", "/api/billing/details");
    expect(res.status).toBe(200);
    expect(res.body.stripeEnabled).toBe(false);
  });
});

describe("Billing — reactivate", () => {
  it("desfaz cancelamento agendado e persiste no banco", async () => {
    const { user, auth } = await createTestUser();
    await billing.update(user.id, {
      stripeCustomerId: "cus_re_1", stripeSubscriptionId: "sub_re_1",
      planId: "pro", status: "active", cancelAtPeriodEnd: true,
    });
    setStripeMock({
      activeSubscription: {
        id: "sub_re_1",
        customer: "cus_re_1",
        status: "active",
        cancel_at_period_end: true,
        current_period_end: Math.floor(Date.now() / 1000) + 10 * 86400,
        items: { data: [{ price: { id: "price_test_pro" } }] },
      },
    });
    const res = await auth("post", "/api/billing/reactivate").send({});
    expect(res.status).toBe(200);
    expect(res.body.cancelAtPeriodEnd).toBe(false);
    expect(stripeCalls.reactivateSubscription).toHaveLength(1);
    const sub = await billing.getByUserId(user.id);
    expect(sub.cancelAtPeriodEnd).toBe(false);
  });

  it("sem assinatura → 400", async () => {
    const { auth } = await createTestUser();
    const res = await auth("post", "/api/billing/reactivate").send({});
    expect(res.status).toBe(400);
  });

  it("sem cancelamento agendado → 400", async () => {
    const { user, auth } = await createTestUser();
    await billing.update(user.id, { stripeSubscriptionId: "sub_ok", planId: "pro", status: "active", cancelAtPeriodEnd: false });
    const res = await auth("post", "/api/billing/reactivate").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/não está agendado/i);
  });

  it("Stripe desabilitado → 501", async () => {
    setStripeMock({ enabled: false });
    const { auth } = await createTestUser();
    const res = await auth("post", "/api/billing/reactivate").send({});
    expect(res.status).toBe(501);
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
