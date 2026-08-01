// E-mails de cobrança disparados pelo webhook do Stripe.
//
// O cenário que justifica tudo isto: o cartão do cliente falha, o Stripe põe a
// assinatura em past_due e o Nimbus dá 3 dias de carência antes de pausar as
// campanhas. Esses 3 dias só servem pra alguma coisa se alguém avisar a pessoa.
//
// O módulo notifications/email é mockado (helpers/email-mock.js) — aqui o que
// importa é QUE o aviso saiu, uma vez só, para quem devia.

import { describe, it, expect } from "vitest";
import {
  app, request, createTestUser, billing, emailByKind, auth,
} from "../helpers/app.js";

// Mesmo helper de billing.test.js: o mock ignora a signature, e mandamos a
// string JSON pro express.raw receber os bytes certos.
function postEvent(event) {
  return request(app)
    .post("/api/billing/webhook")
    .set("stripe-signature", "t=1,v1=fake")
    .set("Content-Type", "application/json")
    .send(JSON.stringify(event));
}

const emUmMes = () => Math.floor(Date.now() / 1000) + 30 * 86400;

// Evento de subscription pronto — só o que muda entre os casos vai por argumento.
function subEvent({ id, customer, subId, status, plan = "pro", cancelAtPeriodEnd = false }) {
  return {
    id,
    type: "customer.subscription.updated",
    data: {
      object: {
        id: subId,
        customer,
        status,
        current_period_end: emUmMes(),
        cancel_at_period_end: cancelAtPeriodEnd,
        items: { data: [{ price: { id: `price_test_${plan}` } }] },
      },
    },
  };
}

describe("E-mails de cobrança — falha de pagamento", () => {
  it("avisa na transição para past_due e não repete na reentrega", async () => {
    const { user } = await createTestUser();
    await billing.update(user.id, {
      stripeCustomerId: "cus_pf", stripeSubscriptionId: "sub_pf", planId: "pro", status: "active",
    });

    await postEvent(subEvent({ id: "evt_pf_1", customer: "cus_pf", subId: "sub_pf", status: "past_due" }));

    const avisos = emailByKind("payment_failed");
    expect(avisos).toHaveLength(1);
    expect(avisos[0].payload.to).toBe(user.email);
    // A data limite da carência tem que ir no e-mail — é a informação útil.
    expect(avisos[0].payload.deadline).toBeInstanceOf(Date);

    // Stripe reentrega o mesmo estado com outro event.id: continua 1 aviso.
    await postEvent(subEvent({ id: "evt_pf_2", customer: "cus_pf", subId: "sub_pf", status: "past_due" }));
    expect(emailByKind("payment_failed")).toHaveLength(1);
  });

  it("avisa quando o pagamento é recuperado", async () => {
    const { user } = await createTestUser();
    await billing.update(user.id, {
      stripeCustomerId: "cus_pr", stripeSubscriptionId: "sub_pr", planId: "pro", status: "active",
    });

    await postEvent(subEvent({ id: "evt_pr_1", customer: "cus_pr", subId: "sub_pr", status: "past_due" }));
    await postEvent(subEvent({ id: "evt_pr_2", customer: "cus_pr", subId: "sub_pr", status: "active" }));

    expect(emailByKind("payment_failed")).toHaveLength(1);
    const recuperado = emailByKind("payment_recovered");
    expect(recuperado).toHaveLength(1);
    expect(recuperado[0].payload.to).toBe(user.email);
  });
});

describe("E-mails de cobrança — plano e cancelamento", () => {
  it("troca de plano avisa com os dois rótulos", async () => {
    const { user } = await createTestUser();
    await billing.update(user.id, {
      stripeCustomerId: "cus_pc", stripeSubscriptionId: "sub_pc", planId: "basic", status: "active",
    });

    await postEvent(subEvent({
      id: "evt_pc_1", customer: "cus_pc", subId: "sub_pc", status: "active", plan: "business",
    }));

    const avisos = emailByKind("plan_changed");
    expect(avisos).toHaveLength(1);
    expect(avisos[0].payload.fromPlanLabel).toBe("Básico");
    expect(avisos[0].payload.toPlanLabel).toBe("Business");
  });

  it("renovação sem mudança nenhuma não gera e-mail", async () => {
    const { user } = await createTestUser();
    await billing.update(user.id, {
      stripeCustomerId: "cus_nn", stripeSubscriptionId: "sub_nn", planId: "pro", status: "active",
    });

    await postEvent(subEvent({ id: "evt_nn_1", customer: "cus_nn", subId: "sub_nn", status: "active" }));
    await postEvent(subEvent({ id: "evt_nn_2", customer: "cus_nn", subId: "sub_nn", status: "active" }));

    expect(emailByKind("payment_failed")).toHaveLength(0);
    expect(emailByKind("plan_changed")).toHaveLength(0);
    expect(emailByKind("cancel_scheduled")).toHaveLength(0);
  });

  it("cancelamento agendado pelo portal avisa uma vez", async () => {
    const { user } = await createTestUser();
    await billing.update(user.id, {
      stripeCustomerId: "cus_cs", stripeSubscriptionId: "sub_cs", planId: "pro", status: "active",
    });

    await postEvent(subEvent({
      id: "evt_cs_1", customer: "cus_cs", subId: "sub_cs", status: "active", cancelAtPeriodEnd: true,
    }));

    const avisos = emailByKind("cancel_scheduled");
    expect(avisos).toHaveLength(1);
    expect(avisos[0].payload.to).toBe(user.email);
  });

  it("assinatura encerrada avisa que nada foi apagado", async () => {
    const { user } = await createTestUser();
    await billing.update(user.id, {
      stripeCustomerId: "cus_del", stripeSubscriptionId: "sub_del", planId: "pro", status: "active",
    });

    await postEvent({
      id: "evt_del_1",
      type: "customer.subscription.deleted",
      data: { object: { id: "sub_del", customer: "cus_del" } },
    });

    const avisos = emailByKind("subscription_canceled");
    expect(avisos).toHaveLength(1);
    expect(avisos[0].payload.to).toBe(user.email);
    expect(avisos[0].opts.dedupeKey).toContain("sub_del");
  });
});

describe("E-mails de cobrança — quem não recebe", () => {
  it("admin não recebe aviso de cobrança", async () => {
    const { user } = await createTestUser();
    await auth.setUserRole(user.id, "admin");
    await billing.update(user.id, {
      stripeCustomerId: "cus_adm", stripeSubscriptionId: "sub_adm", planId: "pro", status: "active",
    });

    await postEvent(subEvent({ id: "evt_adm_1", customer: "cus_adm", subId: "sub_adm", status: "past_due" }));

    expect(emailByKind("payment_failed")).toHaveLength(0);
  });
});
