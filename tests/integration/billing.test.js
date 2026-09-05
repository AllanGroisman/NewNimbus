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

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRequire } from "module";
import {
  app, request, createTestUser,
  auth as authMod, billing,
  stripeCalls, setStripeMock, prisma,
} from "../helpers/app.js";
import { makeGroup } from "../helpers/fixtures.js";

// Cache de preços é singleton do backend — os testes de preço precisam limpá-lo.
const requireCjs = createRequire(import.meta.url);
const pricesCache = requireCjs("../../backend/billing/prices.js");
const limitsMod = requireCjs("../../backend/billing/limits.js");

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

  // Na entrada do painel dá pra adiar o cadastro do telefone; virar cliente
  // pagante, não — é o número por onde o suporte fala com quem paga.
  it("conta sem telefone não abre checkout, e abre depois de informar", async () => {
    const { user, auth } = await createTestUser();
    await prisma().user.update({ where: { id: user.id }, data: { phone: "" } });
    authMod.invalidateUser(user.id);
    const antes = stripeCalls.createCheckoutSession.length;

    const bloqueado = await auth("post", "/api/billing/checkout").send({ planId: "pro" });
    expect(bloqueado.status).toBe(400);
    expect(bloqueado.body.code).toBe("phone_required");
    expect(stripeCalls.createCheckoutSession).toHaveLength(antes);

    const salvo = await auth("post", "/api/account/phone").send({ phone: "(11) 99999-9999" });
    expect(salvo.status).toBe(200);

    const liberado = await auth("post", "/api/billing/checkout").send({ planId: "pro" });
    expect(liberado.status).toBe(200);
    expect(liberado.body.url).toBeTruthy();
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

describe("Billing — estorno cancela a conta", () => {
  function refundEvent({ id, customer, amount = 6990, refunded = 6990, livemode }) {
    return {
      id,
      type: "charge.refunded",
      livemode,
      data: { object: { id: `ch_${id}`, customer, currency: "brl", amount, amount_refunded: refunded } },
    };
  }

  async function assinante(sufixo, extra = {}) {
    const { user } = await createTestUser();
    await billing.update(user.id, {
      stripeCustomerId: `cus_${sufixo}`, stripeSubscriptionId: `sub_${sufixo}`,
      planId: "basic", status: "active", ...extra,
    });
    return user;
  }

  it("estorno integral cancela a assinatura no Stripe", async () => {
    await assinante("ref");

    const res = await postEvent(refundEvent({ id: "evt_ref_1", customer: "cus_ref" }));

    expect(res.status).toBe(200);
    expect(stripeCalls.cancelSubscription).toEqual([{ subscriptionId: "sub_ref" }]);
  });

  it("estorno parcial também cancela", async () => {
    await assinante("par");

    await postEvent(refundEvent({ id: "evt_par_1", customer: "cus_par", refunded: 1000 }));

    expect(stripeCalls.cancelSubscription).toEqual([{ subscriptionId: "sub_par" }]);
  });

  it("o downgrade em si vem do subscription.deleted, não do refund", async () => {
    const user = await assinante("del");

    await postEvent(refundEvent({ id: "evt_del_1", customer: "cus_del" }));
    // Enquanto o deleted não chega, o banco segue como estava — é o Stripe que
    // manda o evento logo depois do cancel.
    expect((await billing.getByUserId(user.id)).status).toBe("active");

    await postEvent({
      id: "evt_del_2",
      type: "customer.subscription.deleted",
      data: { object: { id: "sub_del", customer: "cus_del", status: "canceled" } },
    });

    const sub = await billing.getByUserId(user.id);
    expect(sub.planId).toBe("free");
    expect(sub.status).toBe("canceled");
    expect(sub.stripeSubscriptionId).toBeNull();
  });

  it("cancelamento falhando no Stripe derruba o plano localmente", async () => {
    const user = await assinante("err");
    setStripeMock({ cancelSubscriptionError: true });

    const res = await postEvent(refundEvent({ id: "evt_err_1", customer: "cus_err" }));

    expect(res.status).toBe(200);
    const sub = await billing.getByUserId(user.id);
    expect(sub.planId).toBe("free");
    expect(sub.status).toBe("canceled");
  });

  it("sem assinatura no Stripe, derruba o plano localmente", async () => {
    const user = await assinante("sem", { stripeSubscriptionId: null });

    await postEvent(refundEvent({ id: "evt_sem_1", customer: "cus_sem" }));

    expect(stripeCalls.cancelSubscription).toHaveLength(0);
    expect((await billing.getByUserId(user.id)).status).toBe("canceled");
  });

  it("estorno de R$ 0 e customer desconhecido não cancelam nada", async () => {
    await assinante("zer");

    await postEvent(refundEvent({ id: "evt_zer_r", customer: "cus_zer", refunded: 0 }));
    await postEvent(refundEvent({ id: "evt_nin_r", customer: "cus_inexistente" }));

    expect(stripeCalls.cancelSubscription).toHaveLength(0);
  });

  it("estorno de outro modo Stripe (live com sistema em test) é ignorado", async () => {
    const user = await assinante("mod");

    await postEvent(refundEvent({ id: "evt_mod_1", customer: "cus_mod", livemode: true }));

    expect(stripeCalls.cancelSubscription).toHaveLength(0);
    expect((await billing.getByUserId(user.id)).status).toBe("active");
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

// Task 34: o que acontece quando o cliente cancela ou baixa de plano.
// Nada é apagado — o excedente fica pausado pelo plano, e ele continua
// conseguindo mexer no que tem (o bug antigo era travar até a exclusão).
describe("Billing — cancelamento e downgrade (pausa por plano)", () => {
  const g5 = () => [1, 2, 3, 4, 5].map(i => makeGroup({ id: i, name: `G${i}`, categories: ["gamer"] }));

  async function proUserWith5Campanhas() {
    const ctx = await createTestUser();
    await billing.update(ctx.user.id, { planId: "pro", status: "active" });
    const res = await ctx.auth("put", "/api/state").send({ groups: g5(), numbers: [], whatsappGroups: [] });
    expect(res.status).toBe(200);
    return ctx;
  }

  it("downgrade pra Básico pausa 4 das 5 campanhas, mantendo a mais antiga ativa", async () => {
    const { user, auth } = await proUserWith5Campanhas();
    await billing.update(user.id, { planId: "basic", status: "active" });

    const res = await auth("get", "/api/state");
    expect(res.status).toBe(200);
    expect(res.body.planPaused.groups.sort((a, b) => a - b)).toEqual([2, 3, 4, 5]);
    expect(res.body.groups.find(g => g.id === 1).planPaused).toBe(false);
  });

  it("acima do limite ainda consegue apagar campanhas até caber", async () => {
    const { user, auth } = await proUserWith5Campanhas();
    await billing.update(user.id, { planId: "basic", status: "active" });

    // Apaga uma de cada vez — todos os passos precisam passar (era o bug).
    let groups = g5();
    for (let i = 5; i >= 1; i--) {
      groups = groups.filter(g => g.id !== i);
      const res = await auth("put", "/api/state").send({ groups, numbers: [], whatsappGroups: [] });
      expect(res.status).toBe(200);
    }
  });

  it("cancelou (free): continua conseguindo salvar e apagar, mas não criar", async () => {
    const { user, auth } = await proUserWith5Campanhas();
    await billing.update(user.id, { planId: "free", status: "canceled" });

    // Tudo pausado — salvar o que já existe passa.
    const keep = await auth("put", "/api/state").send({ groups: g5(), numbers: [], whatsappGroups: [] });
    expect(keep.status).toBe(200);

    // Criar campanha nova (ativa) continua bloqueado.
    const nova = [...g5(), makeGroup({ id: 6, name: "Nova", categories: ["gamer"] })];
    const res = await auth("put", "/api/state").send({ groups: nova, numbers: [], whatsappGroups: [] });
    expect(res.status).toBe(402);
    expect(res.body.code).toBe("plan_limit");
  });

  it("volta pro Pro: as campanhas pausadas voltam a ficar ativas sozinhas", async () => {
    const { user, auth } = await proUserWith5Campanhas();
    await billing.update(user.id, { planId: "basic", status: "active" });
    await auth("get", "/api/state");

    await billing.update(user.id, { planId: "pro", status: "active" });
    const res = await auth("get", "/api/state");
    expect(res.body.planPaused.groups).toEqual([]);
  });

  it("carência: cartão que falhou há 1 dia não pausa nada", async () => {
    const { user, auth } = await proUserWith5Campanhas();
    await billing.update(user.id, { status: "past_due" });

    const me = await auth("get", "/api/billing/me");
    expect(me.body.inGrace).toBe(true);
    expect(me.body.effectivePlan).toBe("pro");
    const res = await auth("get", "/api/state");
    expect(res.body.planPaused.groups).toEqual([]);
  });

  it("carência vencida: cai pra free e pausa tudo", async () => {
    const { user, auth } = await proUserWith5Campanhas();
    await billing.update(user.id, { status: "past_due" });
    // Empurra o início do atraso pra 4 dias atrás (carência é de 3).
    await billing.update(user.id, { pastDueSince: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000) });

    const me = await auth("get", "/api/billing/me");
    expect(me.body.inGrace).toBe(false);
    expect(me.body.effectivePlan).toBe("free");
    const res = await auth("get", "/api/state");
    expect(res.body.planPaused.groups.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("Billing — PUT /api/billing/active-selection", () => {
  async function basicUserCom3Campanhas() {
    const ctx = await createTestUser();
    await billing.update(ctx.user.id, { planId: "pro", status: "active" });
    const groups = [1, 2, 3].map(i => makeGroup({ id: i, name: `G${i}`, categories: ["gamer"] }));
    await ctx.auth("put", "/api/state").send({ groups, numbers: [], whatsappGroups: [] });
    await billing.update(ctx.user.id, { planId: "basic", status: "active" });
    await ctx.auth("get", "/api/state"); // aplica a pausa por plano
    return ctx;
  }

  it("troca qual campanha fica ativa", async () => {
    const { auth } = await basicUserCom3Campanhas();
    const res = await auth("put", "/api/billing/active-selection").send({ groups: [3], numbers: [] });
    expect(res.status).toBe(200);
    expect(res.body.planPaused.groups.sort((a, b) => a - b)).toEqual([1, 2]);
    expect(res.body.usage.activeGroups).toBe(1);
  });

  it("recusa seleção acima do limite do plano", async () => {
    const { auth } = await basicUserCom3Campanhas();
    const res = await auth("put", "/api/billing/active-selection").send({ groups: [1, 2], numbers: [] });
    expect(res.status).toBe(402);
    expect(res.body.code).toBe("plan_limit");
    expect(res.body.planRequired).toBe("pro");
  });

  it("recusa campanha que não existe", async () => {
    const { auth } = await basicUserCom3Campanhas();
    const res = await auth("put", "/api/billing/active-selection").send({ groups: [999], numbers: [] });
    expect(res.status).toBe(400);
  });
});

describe("Billing — trial de R$1 (7 dias, só Básico, 1x por conta)", () => {
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
          trial_end: Math.floor(Date.now() / 1000) + 7 * 86400,
          current_period_end: Math.floor(Date.now() / 1000) + 7 * 86400,
          items: { data: [{ price: { id: "price_test_basic" } }] },
        },
      },
    });
    const sub = await billing.getByUserId(user.id);
    expect(sub.status).toBe("trialing");
    expect(sub.trialUsedAt).not.toBeNull();
  });
});

// Cortesia do admin (trial manual): acesso liberado à mão, fora do Stripe. Aqui a
// prova é do lado do CLIENTE — o que /api/billing/me conta pra ele.
describe("Billing — trial manual (cortesia)", () => {
  const DIA = 24 * 60 * 60 * 1000;

  it("/billing/me reflete a cortesia e NÃO consome o teste de R$1", async () => {
    const { user, auth } = await createTestUser();
    await billing.grantManualTrial(user.id, { planId: "pro", days: 12, note: "beta" });

    const res = await auth("get", "/api/billing/me");
    expect(res.status).toBe(200);
    expect(res.body.effectivePlan).toBe("pro");
    expect(res.body.limits.groups).toBe(5);
    expect(res.body.manualTrial).toMatchObject({ planId: "pro", planLabel: "Pro", active: true, dormant: false, daysLeft: 12 });
    // O status do Stripe continua sendo o que é: cortesia não é assinatura.
    expect(res.body.status).toBe("inactive");
    expect(res.body.planId).toBe("free");
    // E o teste de R$1 segue disponível — são coisas diferentes.
    expect(res.body.trialEligible).toBe(true);
  });

  it("assinatura paga vence a cortesia, que fica dormente", async () => {
    const { user, auth } = await createTestUser();
    await billing.grantManualTrial(user.id, { planId: "business", days: 30 });
    await billing.update(user.id, { planId: "basic", status: "active" });

    const res = await auth("get", "/api/billing/me");
    expect(res.body.effectivePlan).toBe("basic");
    expect(res.body.limits.groups).toBe(1);
    expect(res.body.manualTrial).toMatchObject({ active: true, dormant: true });
  });

  it("cortesia vencida some do plano em vigor", async () => {
    const { user, auth } = await createTestUser();
    await billing.grantManualTrial(user.id, { planId: "pro", days: 1 });
    await billing.update(user.id, { manualTrialEndsAt: new Date(Date.now() - DIA) });

    const res = await auth("get", "/api/billing/me");
    expect(res.body.effectivePlan).toBe("free");
    expect(res.body.manualTrial.active).toBe(false);
  });

  it("assinar durante a cortesia adia a primeira cobrança pro fim dela", async () => {
    const { user, auth } = await createTestUser();
    await billing.grantManualTrial(user.id, { planId: "pro", days: 20 });

    const res = await auth("post", "/api/billing/checkout").send({ planId: "pro" });
    expect(res.status).toBe(200);

    const chamada = stripeCalls.createCheckoutSession.at(-1);
    const sub = await billing.getByUserId(user.id);
    expect(chamada.trialEndsAt).toEqual(sub.manualTrialEndsAt);
    expect(chamada.withTrial).toBe(false);
  });

  it("cortesia acabando em menos de 48h cobra normal (piso do Stripe)", async () => {
    const { user, auth } = await createTestUser();
    await billing.grantManualTrial(user.id, { planId: "pro", days: 10 });
    await billing.update(user.id, { manualTrialEndsAt: new Date(Date.now() + 3 * 60 * 60 * 1000) });

    await auth("post", "/api/billing/checkout").send({ planId: "pro" });
    expect(stripeCalls.createCheckoutSession.at(-1).trialEndsAt).toBeNull();
  });

  it("keepManualTrial=false cobra hoje e marca a cortesia pra encerrar", async () => {
    const { user, auth } = await createTestUser();
    await billing.grantManualTrial(user.id, { planId: "basic", days: 20 });

    const res = await auth("post", "/api/billing/checkout").send({ planId: "pro", keepManualTrial: false });
    expect(res.status).toBe(200);

    const chamada = stripeCalls.createCheckoutSession.at(-1);
    expect(chamada.trialEndsAt).toBeNull();      // sem adiamento: cobra agora
    expect(chamada.metadataExtra).toMatchObject({ manualTrialCancel: "1" });
    // A cortesia NÃO morre no clique — um checkout abandonado não pode custá-la.
    expect((await billing.getByUserId(user.id)).manualTrialEndedAt).toBeNull();
  });

  it("o webhook de quem escolheu 'começar agora' encerra a cortesia de vez", async () => {
    const { user } = await createTestUser();
    await billing.grantManualTrial(user.id, { planId: "basic", days: 20 });
    await billing.update(user.id, { stripeCustomerId: "cus_cancel_1" });

    await postEvent({
      id: "evt_cancel_1",
      type: "customer.subscription.created",
      data: {
        object: {
          id: "sub_cancel_1",
          customer: "cus_cancel_1",
          status: "active",
          current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
          metadata: { planId: "pro", manualTrialCancel: "1" },
          items: { data: [{ price: { id: "price_test_pro" } }] },
        },
      },
    });

    const sub = await billing.getByUserId(user.id);
    expect(sub.manualTrialEndedAt).not.toBeNull();
    expect(limitsMod.manualTrialActive(sub)).toBe(false);
    expect(limitsMod.effectivePlanId(sub)).toBe("pro");

    // E não ressuscita quando a assinatura cai: a pessoa gastou a cortesia.
    await billing.update(user.id, { planId: "free", status: "canceled" });
    expect(limitsMod.effectivePlanId(await billing.getByUserId(user.id))).toBe("free");
  });

  it("adiar a cobrança NÃO queima o teste de R$1 da conta", async () => {
    const { user, auth } = await createTestUser();
    await billing.grantManualTrial(user.id, { planId: "pro", days: 20 });
    await billing.update(user.id, { stripeCustomerId: "cus_defer_1" });

    // O webhook do Stripe chega com trial_end (é o adiamento) e a marca que o
    // checkout gravou na metadata da assinatura.
    await postEvent({
      id: "evt_defer_1",
      type: "customer.subscription.created",
      data: {
        object: {
          id: "sub_defer_1",
          customer: "cus_defer_1",
          status: "trialing",
          trial_end: Math.floor(Date.now() / 1000) + 20 * 86400,
          current_period_end: Math.floor(Date.now() / 1000) + 20 * 86400,
          metadata: { planId: "pro", manualTrialDefer: "1" },
          items: { data: [{ price: { id: "price_test_pro" } }] },
        },
      },
    });

    const sub = await billing.getByUserId(user.id);
    expect(sub.status).toBe("trialing");
    expect(sub.trialUsedAt).toBeNull();
    const me = await auth("get", "/api/billing/me");
    expect(me.body.trialEligible).toBe(false); // já tem assinatura, mas não por ter "usado o trial"
    expect(me.body.manualTrial.dormant).toBe(true);
  });

  it("a varredura encerra a cortesia vencida uma vez só", async () => {
    const requireCjs2 = createRequire(import.meta.url);
    const reminders = requireCjs2("../../backend/billing/reminders.js");
    const { user } = await createTestUser();
    await billing.grantManualTrial(user.id, { planId: "pro", days: 1 });
    await billing.update(user.id, { manualTrialEndsAt: new Date(Date.now() - DIA) });

    const primeira = await reminders.expireManualTrials();
    expect(primeira.expired).toBeGreaterThanOrEqual(1);
    expect((await billing.getByUserId(user.id)).manualTrialEndedAt).not.toBeNull();

    // Segunda passada não pega a mesma concessão de novo.
    const antes = (await billing.getByUserId(user.id)).manualTrialEndedAt;
    await reminders.expireManualTrials();
    expect((await billing.getByUserId(user.id)).manualTrialEndedAt).toEqual(antes);
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

describe("Billing — preços e nomes vindos do Stripe", () => {
  beforeEach(() => pricesCache.__resetForTests());
  afterEach(() => pricesCache.__resetForTests());

  it("plans reflete o preço ao vivo do Stripe", async () => {
    setStripeMock({ planPrices: {
      basic: { priceBRL: 79.90, name: "Básico", priceId: "price_test_basic" },
      pro: { priceBRL: 109.90, name: "Pro", priceId: "price_test_pro" },
      business: { priceBRL: 149.90, name: "Business", priceId: "price_test_business" },
    } });
    const { auth } = await createTestUser();
    const res = await auth("get", "/api/billing/me");
    expect(res.status).toBe(200);
    const basic = res.body.plans.find(p => p.id === "basic");
    const pro = res.body.plans.find(p => p.id === "pro");
    expect(basic.priceBRL).toBe(79.90);
    expect(pro.priceBRL).toBe(109.90);
    // Só preço e nome vêm do Stripe — os limites continuam do limits.js.
    expect(basic.limits.groups).toBe(1);
  });

  it("label vem do nome do produto no Stripe", async () => {
    setStripeMock({ planPrices: {
      basic: { priceBRL: 69.90, name: "Nimbus Essencial", priceId: "price_x" },
      pro: { priceBRL: 99.90, name: "Nimbus Avançado", priceId: "price_y" },
      business: { priceBRL: 149.90, name: "Nimbus Empresa", priceId: "price_z" },
    } });
    const { auth } = await createTestUser();
    const res = await auth("get", "/api/billing/me");
    expect(res.status).toBe(200);
    expect(res.body.plans.find(p => p.id === "basic").label).toBe("Nimbus Essencial");
    expect(res.body.plans.find(p => p.id === "business").label).toBe("Nimbus Empresa");
    expect(res.body.plans.find(p => p.id === "pro").priceId).toBe("price_y");
  });

  it("Stripe desabilitado → fallback pros preços e labels do limits.js", async () => {
    setStripeMock({ enabled: false });
    const { auth } = await createTestUser();
    const res = await auth("get", "/api/billing/me");
    expect(res.status).toBe(200);
    const basic = res.body.plans.find(p => p.id === "basic");
    expect(basic.priceBRL).toBe(69.90);
    expect(basic.label).toBe("Básico");
    expect(stripeCalls.fetchPlanPrices).toHaveLength(0);
  });

  it("erro no Stripe → 200 com fallback, nunca 500", async () => {
    setStripeMock({ shouldFailFetchPrices: true });
    const { auth } = await createTestUser();
    const res = await auth("get", "/api/billing/me");
    expect(res.status).toBe(200);
    const basic = res.body.plans.find(p => p.id === "basic");
    expect(basic.priceBRL).toBe(69.90);
    expect(basic.label).toBe("Básico");
  });

  it("cache: leituras seguidas fazem uma busca só no Stripe", async () => {
    const { auth } = await createTestUser();
    await auth("get", "/api/billing/me");
    await auth("get", "/api/billing/me");
    expect(stripeCalls.fetchPlanPrices).toHaveLength(1);
  });
});

describe("Billing — modo teste ↔ produção", () => {
  afterEach(() => setStripeMock({ mode: "test" }));

  it("assinatura de outro modo fica inerte (usuário aparece sem plano)", async () => {
    const { user, auth } = await createTestUser();
    await billing.update(user.id, {
      stripeCustomerId: "cus_live_1",
      stripeSubscriptionId: "sub_live_1",
      planId: "pro",
      status: "active",
      stripeMode: "live",
    });

    // Sistema em modo teste: a assinatura de produção não vale agora.
    const inTest = await auth("get", "/api/billing/me");
    expect(inTest.status).toBe(200);
    expect(inTest.body.effectivePlan).toBe("free");
    expect(inTest.body.status).toBe("inactive");
    expect(inTest.body.hasStripeCustomer).toBe(false);
    expect(inTest.body.stripeMode).toBe("test");

    // Voltando pro modo dela, tudo volta como estava — nada foi apagado.
    setStripeMock({ mode: "live" });
    const inLive = await auth("get", "/api/billing/me");
    expect(inLive.body.effectivePlan).toBe("pro");
    expect(inLive.body.status).toBe("active");
    expect(inLive.body.hasStripeCustomer).toBe(true);
  });

  it("portal recusa quando a assinatura é de outro modo", async () => {
    const { user, auth } = await createTestUser();
    await billing.update(user.id, {
      stripeCustomerId: "cus_live_2",
      planId: "pro",
      status: "active",
      stripeMode: "live",
    });
    const res = await auth("post", "/api/billing/portal").send({});
    expect(res.status).toBe(400);
    expect(stripeCalls.createPortalSession).toHaveLength(0);
  });

  it("webhook carimba o modo pelo livemode do evento", async () => {
    const { user, auth } = await createTestUser();
    const res = await postEvent({
      id: "evt_mode_1",
      type: "customer.subscription.created",
      data: {
        object: {
          id: "sub_mode_1",
          customer: "cus_mode_1",
          livemode: true,
          status: "active",
          current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
          cancel_at_period_end: false,
          metadata: { nimbusUserId: user.id },
          items: { data: [{ price: { id: "price_test_pro" } }] },
        },
      },
    });
    expect(res.status).toBe(200);

    // Evento de produção com o sistema em teste: grava, mas não libera agora.
    const inTest = await auth("get", "/api/billing/me");
    expect(inTest.body.effectivePlan).toBe("free");

    setStripeMock({ mode: "live" });
    const inLive = await auth("get", "/api/billing/me");
    expect(inLive.body.effectivePlan).toBe("pro");
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
