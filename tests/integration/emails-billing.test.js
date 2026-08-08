// E-mails de cobrança disparados pelo webhook do Stripe.
//
// O cenário que justifica tudo isto: o cartão do cliente falha, o Stripe põe a
// assinatura em past_due e o Nimbus dá 3 dias de carência antes de pausar as
// campanhas. Esses 3 dias só servem pra alguma coisa se alguém avisar a pessoa.
//
// O módulo notifications/email é mockado (helpers/email-mock.js) — aqui o que
// importa é QUE o aviso saiu, uma vez só, para quem devia.

import { describe, it, expect } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import {
  app, request, createTestUser, billing, emailByKind, auth,
} from "../helpers/app.js";

const require = createRequire(import.meta.url);
const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "backend");
// A tabela email_log de verdade — helpers/app.js só mocka o ENVIO. É ela que
// registra o "crie sua senha" da landing e segura o e-mail duplo.
const emailLog = require(path.join(backendDir, "notifications", "email", "log.js"));

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

describe("E-mails de cobrança — primeira assinatura", () => {
  it("assinar pelo app confirma o pagamento e não repete na reentrega", async () => {
    const { user } = await createTestUser();
    // Estado de quem ainda não assinou: customer já vinculado pelo checkout,
    // plano free. É exatamente o caso que ficava sem nenhum e-mail.
    await billing.update(user.id, { stripeCustomerId: "cus_new", planId: "free", status: "inactive" });

    await postEvent(subEvent({ id: "evt_new_1", customer: "cus_new", subId: "sub_new", status: "active" }));

    const avisos = emailByKind("subscription_started");
    expect(avisos).toHaveLength(1);
    expect(avisos[0].payload.to).toBe(user.email);
    expect(avisos[0].payload.planLabel).toBe("Pro");
    expect(avisos[0].payload.amount).toBe(9990);

    await postEvent(subEvent({ id: "evt_new_2", customer: "cus_new", subId: "sub_new", status: "active" }));
    expect(emailByKind("subscription_started")).toHaveLength(1);
  });

  it("teste de R$ 1,00 avisa quanto e quando será a cobrança cheia", async () => {
    const { user } = await createTestUser();
    await billing.update(user.id, { stripeCustomerId: "cus_tri", planId: "free", status: "inactive" });

    await postEvent(subEvent({
      id: "evt_tri_1", customer: "cus_tri", subId: "sub_tri", status: "trialing", plan: "basic",
    }));

    const avisos = emailByKind("subscription_started");
    expect(avisos).toHaveLength(1);
    expect(avisos[0].payload.trial).toBe(true);
    expect(avisos[0].payload.amount).toBe(100);
    expect(avisos[0].payload.planAmount).toBe(6990);
    expect(avisos[0].payload.periodEnd).toBeTruthy();
  });

  it("quem veio da landing não recebe dois e-mails de pagamento confirmado", async () => {
    const { user } = await createTestUser();
    await billing.update(user.id, { stripeCustomerId: "cus_lan", planId: "free", status: "inactive" });
    // O que o provision faz ao criar a conta pelo pagamento: manda o "crie sua
    // senha" (que já abre confirmando o pagamento) e registra o envio.
    const row = await emailLog.claim({
      kind: "welcome_set_password", userId: user.id, to: user.email,
      dedupeKey: `welcome_set_password:${user.id}:tok-lan`,
    });
    await emailLog.finish(row.id, "sent");

    await postEvent(subEvent({ id: "evt_lan_1", customer: "cus_lan", subId: "sub_lan", status: "trialing" }));

    expect(emailByKind("subscription_started")).toHaveLength(0);
  });
});

describe("E-mails de cobrança — recibo e reembolso", () => {
  async function assinante(sufixo) {
    const { user } = await createTestUser();
    await billing.update(user.id, {
      stripeCustomerId: `cus_${sufixo}`, stripeSubscriptionId: `sub_${sufixo}`,
      planId: "pro", status: "active",
    });
    return user;
  }

  function invoiceEvent({ id, customer, invoiceId, reason, amount = 9990 }) {
    return {
      id,
      type: "invoice.payment_succeeded",
      data: {
        object: {
          id: invoiceId,
          customer,
          amount_paid: amount,
          currency: "brl",
          billing_reason: reason,
          hosted_invoice_url: "https://invoice.stripe.com/i/teste",
          status_transitions: { paid_at: Math.floor(Date.now() / 1000) },
        },
      },
    };
  }

  it("renovação mensal manda recibo com valor e link da fatura", async () => {
    const user = await assinante("rec");

    await postEvent(invoiceEvent({
      id: "evt_rec_1", customer: "cus_rec", invoiceId: "in_rec", reason: "subscription_cycle",
    }));

    const recibos = emailByKind("payment_receipt");
    expect(recibos).toHaveLength(1);
    expect(recibos[0].payload.to).toBe(user.email);
    expect(recibos[0].payload.amount).toBe(9990);
    expect(recibos[0].payload.invoiceUrl).toContain("invoice.stripe.com");
    expect(recibos[0].opts.dedupeKey).toContain("in_rec");
  });

  it("primeira fatura da assinatura não vira recibo (já teve a confirmação)", async () => {
    await assinante("cri");

    await postEvent(invoiceEvent({
      id: "evt_cri_1", customer: "cus_cri", invoiceId: "in_cri", reason: "subscription_create", amount: 100,
    }));

    expect(emailByKind("payment_receipt")).toHaveLength(0);
  });

  it("fatura de R$ 0 não vira recibo", async () => {
    await assinante("zer");

    await postEvent(invoiceEvent({
      id: "evt_zer_1", customer: "cus_zer", invoiceId: "in_zer", reason: "subscription_cycle", amount: 0,
    }));

    expect(emailByKind("payment_receipt")).toHaveLength(0);
  });

  it("estorno avisa o cliente e distingue parcial de integral", async () => {
    const user = await assinante("est");

    await postEvent({
      id: "evt_est_1",
      type: "charge.refunded",
      data: {
        object: {
          id: "ch_est", customer: "cus_est", currency: "brl",
          amount: 9990, amount_refunded: 5000,
        },
      },
    });

    const avisos = emailByKind("refund_issued");
    expect(avisos).toHaveLength(1);
    expect(avisos[0].payload.to).toBe(user.email);
    expect(avisos[0].payload.partial).toBe(true);
    expect(avisos[0].payload.amount).toBe(5000);
  });
});

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

describe("E-mails de cobrança — quem recebe", () => {
  it("admin recebe aviso de cobrança como qualquer cliente", async () => {
    const { user } = await createTestUser();
    await auth.setUserRole(user.id, "admin");
    await billing.update(user.id, {
      stripeCustomerId: "cus_adm", stripeSubscriptionId: "sub_adm", planId: "pro", status: "active",
    });

    await postEvent(subEvent({ id: "evt_adm_1", customer: "cus_adm", subId: "sub_adm", status: "past_due" }));

    const avisos = emailByKind("payment_failed");
    expect(avisos).toHaveLength(1);
    expect(avisos[0].payload.to).toBe(user.email);
  });

  it("conta suspensa não recebe (já foi avisada da suspensão)", async () => {
    const { user } = await createTestUser();
    await auth.adminSetSuspended(user.id, true);
    await billing.update(user.id, {
      stripeCustomerId: "cus_sus", stripeSubscriptionId: "sub_sus", planId: "pro", status: "active",
    });

    await postEvent(subEvent({ id: "evt_sus_1", customer: "cus_sus", subId: "sub_sus", status: "past_due" }));

    expect(emailByKind("payment_failed")).toHaveLength(0);
  });
});
