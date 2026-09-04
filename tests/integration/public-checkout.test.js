// Cobre o caminho landing page → Stripe → sistema (checkout público):
//   - /api/public/plans     — catálogo sem login
//   - /api/public/plan-check — as 4 decisões (livre, sem plano, bloqueado, upgrade)
//   - /api/public/checkout   — sessão pra quem não tem conta + bloqueios
//   - /api/public/claim      — troca a sessão paga por login, uso único
//   - webhook sem client_reference_id — conta criada pelo pagamento
//   - /api/billing/change-plan — upgrade com proration, downgrade recusado
//
// Stripe e mailer são mockados (tests/helpers/*-mock.js).

import { describe, it, expect, afterEach } from "vitest";
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";
import {
  app, request, createTestUser, uniqueEmail, randomCpf,
  billing, stripeCalls, setStripeMock, mailerCalls,
} from "../helpers/app.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const requireCjs = createRequire(import.meta.url);
const backendDir = path.resolve(__dirname, "..", "..", "backend");
const { prisma } = requireCjs(path.join(backendDir, "db.js"));
const appConfig = requireCjs(path.join(backendDir, "config"));

// Checkout Session paga, como o Stripe devolve no retorno/webhook.
function paidSession({ id = "cs_test_public_1", email, cpf = randomCpf(), planId = "pro", customer = "cus_test_public", subscription = "sub_test_public", clientRef = null } = {}) {
  return {
    id,
    object: "checkout.session",
    status: "complete",
    payment_status: "paid",
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    customer,
    subscription,
    client_reference_id: clientRef,
    customer_details: { email, name: "Cliente Landing" },
    customer_email: email,
    metadata: { planId, source: "landing", pendingEmail: email, pendingCpf: cpf },
  };
}

// Dá assinatura Stripe "viva" a um usuário — seedSubscription não preenche o
// stripeSubscriptionId, que é o que change-plan e o plan-check exigem.
async function seedLiveSub(userId, planId, status = "active") {
  return prisma().subscription.upsert({
    where: { userId },
    create: {
      userId, planId, status,
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 3600 * 1000),
      stripeCustomerId: `cus_live_${userId}`,
      stripeSubscriptionId: `sub_live_${userId}`,
    },
    update: {
      planId, status,
      stripeCustomerId: `cus_live_${userId}`,
      stripeSubscriptionId: `sub_live_${userId}`,
    },
  });
}

describe("Checkout público — catálogo", () => {
  it("GET /api/public/plans devolve os 3 planos sem exigir login", async () => {
    const res = await request(app).get("/api/public/plans");
    expect(res.status).toBe(200);
    expect(res.body.plans.map(p => p.id)).toEqual(["basic", "pro", "business"]);
    expect(res.body.plans[0].priceBRL).toBe(69.90);
  });
});

describe("Checkout público — decisão por e-mail", () => {
  it("e-mail sem conta pode seguir pro pagamento", async () => {
    const res = await request(app).post("/api/public/plan-check")
      .send({ planId: "pro", email: uniqueEmail("novo"), cpf: randomCpf() });
    expect(res.status).toBe(200);
    expect(res.body.decision).toBe("checkout");
    expect(res.body.currentPlan).toBeNull();
  });

  it("conta existente SEM plano ativo pode seguir pro pagamento", async () => {
    const { email, cpf } = await createTestUser();
    const res = await request(app).post("/api/public/plan-check").send({ planId: "pro", email, cpf });
    expect(res.status).toBe(200);
    expect(res.body.decision).toBe("checkout");
  });

  it("mesmo plano já ativo é bloqueado", async () => {
    const { user, email, cpf } = await createTestUser();
    await seedLiveSub(user.id, "pro");
    const res = await request(app).post("/api/public/plan-check").send({ planId: "pro", email, cpf });
    expect(res.body.decision).toBe("blocked");
    expect(res.body.currentPlan).toBe("pro");
    expect(res.body.message).toMatch(/já tem o plano/i);
  });

  it("plano inferior ao ativo é bloqueado", async () => {
    const { user, email, cpf } = await createTestUser();
    await seedLiveSub(user.id, "business");
    const res = await request(app).post("/api/public/plan-check").send({ planId: "basic", email, cpf });
    expect(res.body.decision).toBe("blocked");
    expect(res.body.message).toMatch(/superior/i);
  });

  it("plano melhor que o ativo pede login pra fazer upgrade", async () => {
    const { user, email, cpf } = await createTestUser();
    await seedLiveSub(user.id, "basic");
    const res = await request(app).post("/api/public/plan-check").send({ planId: "business", email, cpf });
    expect(res.body.decision).toBe("upgrade_requires_login");
    expect(res.body.message).toMatch(/diferença/i);
  });

  it("assinatura em trial conta como ativa", async () => {
    const { user, email, cpf } = await createTestUser();
    await seedLiveSub(user.id, "basic", "trialing");
    const res = await request(app).post("/api/public/plan-check").send({ planId: "basic", email, cpf });
    expect(res.body.decision).toBe("blocked");
  });

  it("cortesia do admin NÃO bloqueia a compra — não é assinatura", async () => {
    // A regressão que isto trava: `effectivePlanId` inclui a cortesia, e usá-lo
    // aqui fazia o site responder "você já tem o plano Pro ativo" pra quem só
    // estava testando de graça — impedindo justamente a conversão.
    const { user, email, cpf } = await createTestUser();
    await billing.grantManualTrial(user.id, { planId: "pro", days: 20 });

    const res = await request(app).post("/api/public/plan-check").send({ planId: "pro", email, cpf });
    expect(res.body.decision).toBe("checkout");
  });

  it("comprar durante a cortesia adia a primeira cobrança", async () => {
    const { user, email, cpf } = await createTestUser();
    await billing.grantManualTrial(user.id, { planId: "pro", days: 20 });

    const res = await request(app).post("/api/public/checkout").send({ planId: "pro", email, cpf });
    expect(res.status).toBe(200);
    const sub = await billing.getByUserId(user.id);
    expect(stripeCalls.createCheckoutSession.at(-1).trialEndsAt).toEqual(sub.manualTrialEndsAt);
  });

  it("planId inválido é recusado", async () => {
    const res = await request(app).post("/api/public/plan-check")
      .send({ planId: "enterprise", email: uniqueEmail(), cpf: randomCpf() });
    expect(res.status).toBe(400);
  });
});

// Bloqueio não pode ser beco sem saída: quem já assina precisa enxergar, na
// própria tela, como subir de plano (tasks 52 e 53).
describe("Checkout público — saídas oferecidas no bloqueio", () => {
  it("quem tentou um plano maior recebe ele como alvo e os demais upgrades", async () => {
    const { user, email, cpf } = await createTestUser();
    await seedLiveSub(user.id, "basic");
    const res = await request(app).post("/api/public/plan-check").send({ planId: "pro", email, cpf });
    expect(res.body.decision).toBe("upgrade_requires_login");
    expect(res.body.currentPlanLabel).toBe("Básico");
    expect(res.body.targetPlan).toMatchObject({ id: "pro", priceBRL: 99.90 });
    expect(res.body.targetPlan.url).toMatch(/\/assinatura\?plano=pro$/);
    // O Business também é maior que o Básico, então entra como opção.
    expect(res.body.upgrades.map(p => p.id)).toEqual(["pro", "business"]);
  });

  it("plano menor que o ativo: sem alvo, mas com os planos maiores", async () => {
    const { user, email, cpf } = await createTestUser();
    await seedLiveSub(user.id, "pro");
    const res = await request(app).post("/api/public/plan-check").send({ planId: "basic", email, cpf });
    expect(res.body.decision).toBe("blocked");
    expect(res.body.targetPlan).toBeNull();
    expect(res.body.upgrades.map(p => p.id)).toEqual(["business"]);
  });

  it("quem já está no maior plano só recebe a informação", async () => {
    const { user, email, cpf } = await createTestUser();
    await seedLiveSub(user.id, "business");
    const res = await request(app).post("/api/public/plan-check").send({ planId: "pro", email, cpf });
    expect(res.body.decision).toBe("blocked");
    expect(res.body.upgrades).toEqual([]);
    expect(res.body.targetPlan).toBeNull();
    expect(res.body.loginUrl).toBeTruthy();
  });

  it("CPF de outra conta não expõe plano nenhum", async () => {
    const { cpf } = await createTestUser();
    const res = await request(app).post("/api/public/plan-check")
      .send({ planId: "pro", email: uniqueEmail("terceiro"), cpf });
    expect(res.body.decision).toBe("cpf_taken");
    expect(res.body.currentPlan).toBeNull();
    expect(res.body.upgrades).toEqual([]);
  });

  it("o 409 do checkout traz as mesmas opções do plan-check", async () => {
    const { user, email, cpf } = await createTestUser();
    await seedLiveSub(user.id, "basic");
    const res = await request(app).post("/api/public/checkout").send({ planId: "business", email, cpf });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("upgrade_requires_login");
    expect(res.body.targetPlan.id).toBe("business");
    expect(res.body.upgrades.map(p => p.id)).toEqual(["pro", "business"]);
  });

  it("e-mail liberado não recebe opções de upgrade", async () => {
    const res = await request(app).post("/api/public/plan-check")
      .send({ planId: "pro", email: uniqueEmail("livre"), cpf: randomCpf() });
    expect(res.body.decision).toBe("checkout");
    expect(res.body.upgrades).toBeUndefined();
  });
});

describe("Checkout público — criação da sessão", () => {
  it("e-mail novo gera sessão sem userId, com customer já criado e retorno em /bem-vindo", async () => {
    const email = uniqueEmail("landing");
    const res = await request(app).post("/api/public/checkout").send({ planId: "pro", email, cpf: randomCpf() });
    expect(res.status).toBe(200);
    expect(res.body.url).toMatch(/^https:\/\/checkout\.stripe\.test\/c\/pro/);
    const call = stripeCalls.createCheckoutSession.at(-1);
    expect(call.userId).toBeUndefined();
    // O Customer é criado antes do Checkout pra o CPF já ser documento fiscal
    // na primeira fatura — por isso não vai mais customerEmail.
    expect(call.customerId).toMatch(/^cus_test_/);
    expect(call.customerEmail).toBeNull();
    expect(call.successUrl).toMatch(/\/bem-vindo\?session_id=/);
    expect(call.metadataExtra.source).toBe("landing");
  });

  it("reaproveita o customer do Stripe quando o e-mail já tem um", async () => {
    setStripeMock({ customerByEmail: { id: "cus_existente_landing" } });
    const res = await request(app).post("/api/public/checkout")
      .send({ planId: "pro", email: uniqueEmail("recorrente"), cpf: randomCpf() });
    expect(res.status).toBe(200);
    expect(stripeCalls.createCheckoutSession.at(-1).customerId).toBe("cus_existente_landing");
  });

  it("conta existente sem plano reaproveita o customer e vai com userId", async () => {
    const { user, email, cpf } = await createTestUser();
    const res = await request(app).post("/api/public/checkout").send({ planId: "basic", email, cpf });
    expect(res.status).toBe(200);
    const call = stripeCalls.createCheckoutSession.at(-1);
    expect(call.userId).toBe(user.id);
    expect(call.customerId).toMatch(/^cus_test_/);
  });

  it("quem já assina recebe 409 com o motivo", async () => {
    const { user, email, cpf } = await createTestUser();
    await seedLiveSub(user.id, "pro");
    const res = await request(app).post("/api/public/checkout").send({ planId: "pro", email, cpf });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("blocked");
    expect(res.body.currentPlan).toBe("pro");
  });

  it("e-mail inválido é recusado antes de falar com o Stripe", async () => {
    const antes = stripeCalls.createCheckoutSession.length;
    const res = await request(app).post("/api/public/checkout").send({ planId: "pro", email: "nao-e-email", cpf: randomCpf() });
    expect(res.status).toBe(400);
    expect(stripeCalls.createCheckoutSession).toHaveLength(antes);
  });

  it("teste de R$1 só vale no Básico", async () => {
    const res = await request(app).post("/api/public/checkout")
      .send({ planId: "pro", email: uniqueEmail(), cpf: randomCpf(), trial: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Básico/);
  });

  it("teste de R$1 no Básico chega no Stripe como trial", async () => {
    const res = await request(app).post("/api/public/checkout")
      .send({ planId: "basic", email: uniqueEmail(), cpf: randomCpf(), trial: true });
    expect(res.status).toBe(200);
    expect(stripeCalls.createCheckoutSession.at(-1).withTrial).toBe(true);
  });

  it("quem já usou o trial segue pro checkout pagando o valor cheio", async () => {
    const { user, email, cpf } = await createTestUser();
    await prisma().subscription.create({
      data: { userId: user.id, planId: "free", status: "canceled", trialUsedAt: new Date() },
    });
    const res = await request(app).post("/api/public/checkout")
      .send({ planId: "basic", email, cpf, trial: true });
    expect(res.status).toBe(200);
    expect(stripeCalls.createCheckoutSession.at(-1).withTrial).toBe(false);
  });
});

describe("Checkout público — uma conta = um CPF", () => {
  it("CPF inválido é recusado antes de falar com o Stripe", async () => {
    const antes = stripeCalls.createCheckoutSession.length;
    const res = await request(app).post("/api/public/checkout")
      .send({ planId: "pro", email: uniqueEmail(), cpf: "111.111.111-11" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_cpf");
    expect(stripeCalls.createCheckoutSession).toHaveLength(antes);
  });

  it("CPF ausente é recusado", async () => {
    const res = await request(app).post("/api/public/checkout")
      .send({ planId: "pro", email: uniqueEmail() });
    expect(res.status).toBe(400);
  });

  it("CPF de outra conta bloqueia, mesmo com e-mail novo", async () => {
    const { cpf } = await createTestUser();
    const res = await request(app).post("/api/public/checkout")
      .send({ planId: "pro", email: uniqueEmail("outro"), cpf });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("cpf_taken");
    // A mensagem identifica a conta sem entregar o e-mail inteiro.
    expect(res.body.error).toMatch(/\*+@/);
  });

  it("bloqueia mesmo se a conta dona do CPF estiver cancelada", async () => {
    const { user, cpf } = await createTestUser();
    await prisma().subscription.create({
      data: { userId: user.id, planId: "free", status: "canceled" },
    });
    const res = await request(app).post("/api/public/checkout")
      .send({ planId: "basic", email: uniqueEmail("recomeco"), cpf, trial: true });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("cpf_taken");
  });

  it("CPF que não confere com o e-mail informado é bloqueado", async () => {
    const { email } = await createTestUser();
    const res = await request(app).post("/api/public/checkout")
      .send({ planId: "pro", email, cpf: randomCpf() });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("cpf_mismatch");
  });

  it("o CPF viaja na metadata da sessão do Stripe", async () => {
    const cpf = randomCpf();
    await request(app).post("/api/public/checkout")
      .send({ planId: "pro", email: uniqueEmail("meta"), cpf });
    expect(stripeCalls.createCheckoutSession.at(-1).metadataExtra.pendingCpf).toBe(cpf);
  });

  it("o CPF vai pro Customer do Stripe, pra virar documento fiscal", async () => {
    const cpf = randomCpf();
    await request(app).post("/api/public/checkout")
      .send({ planId: "pro", email: uniqueEmail("fiscal"), cpf });
    expect(stripeCalls.getOrCreateCustomer.at(-1).cpf).toBe(cpf);
  });

  it("conta existente também leva o CPF pro Customer", async () => {
    const { email, cpf } = await createTestUser();
    await request(app).post("/api/public/checkout").send({ planId: "basic", email, cpf });
    expect(stripeCalls.getOrCreateCustomer.at(-1).cpf).toBe(cpf);
  });

  it("conta criada pelo pagamento nasce com o CPF gravado", async () => {
    const email = uniqueEmail("comcpf");
    const cpf = randomCpf();
    setStripeMock({ checkoutSession: paidSession({ id: "cs_cpf_1", email, cpf }) });
    const res = await request(app).post("/api/public/claim").send({ sessionId: "cs_cpf_1" });
    expect(res.status).toBe(200);

    const row = await prisma().user.findUnique({ where: { email } });
    expect(row.cpf).toBe(cpf);
    // E não volta inteiro pro cliente.
    expect(res.body.user.cpf).toBe(`${cpf.slice(0, 3)}.***.***-${cpf.slice(9)}`);
    expect(res.body.user.cpfRequired).toBe(false);
  });
});

describe("CPF de contas antigas (POST /api/account/cpf)", () => {
  it("conta sem CPF é sinalizada em /api/auth/me", async () => {
    const { auth } = await createTestUser({ cpf: null });
    const me = await auth("get", "/api/auth/me");
    expect(me.body.user.cpfRequired).toBe(true);
    expect(me.body.user.cpf).toBeNull();
  });

  it("grava o CPF e desliga o aviso", async () => {
    const { auth } = await createTestUser({ cpf: null });
    const cpf = randomCpf();
    const res = await auth("post", "/api/account/cpf").send({ cpf });
    expect(res.status).toBe(200);
    expect(res.body.user.cpfRequired).toBe(false);

    const me = await auth("get", "/api/auth/me");
    expect(me.body.user.cpfRequired).toBe(false);
  });

  it("recusa CPF inválido", async () => {
    const { auth } = await createTestUser({ cpf: null });
    const res = await auth("post", "/api/account/cpf").send({ cpf: "123" });
    expect(res.status).toBe(400);
  });

  it("recusa CPF que já é de outra conta", async () => {
    const { cpf } = await createTestUser();
    const { auth } = await createTestUser({ cpf: null });
    const res = await auth("post", "/api/account/cpf").send({ cpf });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("cpf_taken");
  });

  it("não deixa trocar o CPF já cadastrado", async () => {
    const { auth } = await createTestUser();
    const res = await auth("post", "/api/account/cpf").send({ cpf: randomCpf() });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("cpf_locked");
  });

  it("assinar por dentro do sistema sem CPF é recusado até informar", async () => {
    const { auth } = await createTestUser({ cpf: null });
    const semCpf = await auth("post", "/api/billing/checkout").send({ planId: "pro" });
    expect(semCpf.status).toBe(400);
    expect(semCpf.body.code).toBe("cpf_required");

    const comCpf = await auth("post", "/api/billing/checkout").send({ planId: "pro", cpf: randomCpf() });
    expect(comCpf.status).toBe(200);
  });

  it("exige login", async () => {
    const res = await request(app).post("/api/account/cpf").send({ cpf: randomCpf() });
    expect(res.status).toBe(401);
  });
});

describe("Checkout público — resgate (/claim)", () => {
  it("sessão paga cria a conta, devolve token e pede senha", async () => {
    const email = uniqueEmail("pagou");
    setStripeMock({ checkoutSession: paidSession({ email }) });

    const res = await request(app).post("/api/public/claim").send({ sessionId: "cs_test_public_1" });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.user.email).toBe(email);
    expect(res.body.needsPassword).toBe(true);

    // Conta criada já verificada (o pagamento prova a posse do e-mail).
    const row = await prisma().user.findUnique({ where: { email } });
    expect(row.emailVerified).toBe(true);
    // E o e-mail de boas-vindas com link de senha saiu.
    expect(mailerCalls.sendWelcomeSetPasswordEmail.at(-1).to).toBe(email);

    // Token devolvido serve pra usar o sistema.
    const me = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${res.body.token}`);
    expect(me.status).toBe(200);
  });

  it("liga a assinatura ao usuário criado", async () => {
    const email = uniqueEmail("pagou2");
    setStripeMock({ checkoutSession: paidSession({ id: "cs_test_public_2", email, planId: "business" }) });
    await request(app).post("/api/public/claim").send({ sessionId: "cs_test_public_2" });

    const user = await prisma().user.findUnique({ where: { email } });
    const sub = await billing.getByUserId(user.id);
    expect(sub.planId).toBe("business");
    expect(sub.stripeCustomerId).toBe("cus_test_public");
    expect(sub.signupSource).toBe("landing");
  });

  it("é de uso único — a segunda tentativa devolve 410", async () => {
    const email = uniqueEmail("umavez");
    setStripeMock({ checkoutSession: paidSession({ id: "cs_test_public_3", email }) });
    const first = await request(app).post("/api/public/claim").send({ sessionId: "cs_test_public_3" });
    expect(first.status).toBe(200);

    const second = await request(app).post("/api/public/claim").send({ sessionId: "cs_test_public_3" });
    expect(second.status).toBe(410);
    expect(second.body.code).toBe("already_claimed");
  });

  it("não abre sessão numa conta que já tem senha própria", async () => {
    const { email } = await createTestUser();
    setStripeMock({ checkoutSession: paidSession({ id: "cs_test_existente", email }) });
    const res = await request(app).post("/api/public/claim").send({ sessionId: "cs_test_existente" });
    expect(res.status).toBe(200);
    expect(res.body.requiresLogin).toBe(true);
    expect(res.body.token).toBeUndefined();
    expect(res.body.message).toMatch(/entre com seu e-mail e senha/i);
  });

  it("sessão não paga é recusada", async () => {
    setStripeMock({
      checkoutSession: { ...paidSession({ email: uniqueEmail() }), status: "open", payment_status: "unpaid" },
    });
    const res = await request(app).post("/api/public/claim").send({ sessionId: "cs_test_public_4" });
    expect(res.status).toBe(402);
  });

  it("sessão antiga demais expira o resgate", async () => {
    const s = paidSession({ id: "cs_test_old", email: uniqueEmail() });
    s.created = Math.floor(Date.now() / 1000) - 6 * 3600;
    setStripeMock({ checkoutSession: s });
    const res = await request(app).post("/api/public/claim").send({ sessionId: "cs_test_old" });
    expect(res.status).toBe(410);
    expect(res.body.code).toBe("claim_expired");
  });

  it("id que não é de checkout é recusado sem chamar o Stripe", async () => {
    const antes = stripeCalls.getCheckoutSession.length;
    const res = await request(app).post("/api/public/claim").send({ sessionId: "sub_123" });
    expect(res.status).toBe(400);
    expect(stripeCalls.getCheckoutSession).toHaveLength(antes);
  });
});

describe("Checkout público — provisionamento pelo webhook", () => {
  function postEvent(event) {
    return request(app)
      .post("/api/billing/webhook")
      .set("stripe-signature", "t=1,v1=fake")
      .set("Content-Type", "application/json")
      .send(JSON.stringify(event));
  }

  it("checkout.session.completed sem client_reference_id cria a conta", async () => {
    const email = uniqueEmail("webhook");
    const res = await postEvent({
      id: "evt_public_1", type: "checkout.session.completed", livemode: false,
      data: { object: paidSession({ id: "cs_wh_1", email, planId: "basic" }) },
    });
    expect(res.status).toBe(200);
    const user = await prisma().user.findUnique({ where: { email } });
    expect(user).toBeTruthy();
    const sub = await billing.getByUserId(user.id);
    expect(sub.planId).toBe("basic");
  });

  it("webhook e claim da mesma sessão produzem UMA conta só", async () => {
    const email = uniqueEmail("corrida");
    const session = paidSession({ id: "cs_wh_2", email });
    setStripeMock({ checkoutSession: session });

    await postEvent({
      id: "evt_public_2", type: "checkout.session.completed", livemode: false,
      data: { object: session },
    });
    const claim = await request(app).post("/api/public/claim").send({ sessionId: "cs_wh_2" });
    expect(claim.status).toBe(200);

    const users = await prisma().user.findMany({ where: { email } });
    expect(users).toHaveLength(1);
    // E o e-mail de boas-vindas não foi mandado duas vezes.
    expect(mailerCalls.sendWelcomeSetPasswordEmail.filter(c => c.to === email)).toHaveLength(1);
  });

  it("pagamento de quem JÁ tem conta não cria conta nova", async () => {
    const { user, email } = await createTestUser();
    await postEvent({
      id: "evt_public_3", type: "checkout.session.completed", livemode: false,
      data: { object: paidSession({ id: "cs_wh_3", email, planId: "pro" }) },
    });
    const users = await prisma().user.findMany({ where: { email } });
    expect(users).toHaveLength(1);
    const sub = await billing.getByUserId(user.id);
    expect(sub.stripeCustomerId).toBe("cus_test_public");
  });
});

describe("Checkout público — beta fechado", () => {
  // A flag vive no cache em memória do appConfig, que o truncate das tabelas
  // não desfaz — sem o afterEach ela vazaria pros testes seguintes.
  afterEach(() => { appConfig.set("registration-blocked", { blocked: false }); });

  it("cadastro comum é barrado, mas quem paga entra", async () => {
    appConfig.set("registration-blocked", { blocked: true });

    const barrado = await request(app).post("/api/auth/register")
      .send({ name: "Barrado", email: uniqueEmail("barrado"), password: "Senha123" });
    expect(barrado.status).toBe(400);

    const email = uniqueEmail("pagante");
    setStripeMock({ checkoutSession: paidSession({ id: "cs_beta_1", email }) });
    const res = await request(app).post("/api/public/claim").send({ sessionId: "cs_beta_1" });
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(email);
  });
});

describe("Primeira senha", () => {
  it("quem entrou pelo checkout define a senha sem informar a atual", async () => {
    const email = uniqueEmail("senha");
    setStripeMock({ checkoutSession: paidSession({ id: "cs_senha_1", email }) });
    const claim = await request(app).post("/api/public/claim").send({ sessionId: "cs_senha_1" });
    const token = claim.body.token;

    const res = await request(app).post("/api/auth/set-initial-password")
      .set("Authorization", `Bearer ${token}`)
      .send({ password: "NovaSenha123" });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();

    // Agora a senha vale no login normal.
    const login = await request(app).post("/api/auth/login").send({ email, password: "NovaSenha123" });
    expect(login.status).toBe(200);
  });

  it("conta que já tem senha não pode usar este caminho", async () => {
    const { token } = await createTestUser();
    const res = await request(app).post("/api/auth/set-initial-password")
      .set("Authorization", `Bearer ${token}`)
      .send({ password: "OutraSenha123" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/já tem senha/i);
  });

  it("senha fraca é recusada", async () => {
    const email = uniqueEmail("fraca");
    setStripeMock({ checkoutSession: paidSession({ id: "cs_fraca_1", email }) });
    const claim = await request(app).post("/api/public/claim").send({ sessionId: "cs_fraca_1" });
    const res = await request(app).post("/api/auth/set-initial-password")
      .set("Authorization", `Bearer ${claim.body.token}`)
      .send({ password: "abc" });
    expect(res.status).toBe(400);
  });
});

describe("Upgrade de plano (change-plan)", () => {
  it("sobe de plano na assinatura existente, sem abrir checkout novo", async () => {
    const { user, auth } = await createTestUser();
    await seedLiveSub(user.id, "basic");
    const antes = stripeCalls.createCheckoutSession.length;

    const res = await auth("post", "/api/billing/change-plan").send({ planId: "pro" });
    expect(res.status).toBe(200);
    expect(res.body.planId).toBe("pro");
    expect(stripeCalls.changeSubscriptionPlan.at(-1)).toMatchObject({ planId: "pro" });
    expect(stripeCalls.createCheckoutSession).toHaveLength(antes);

    const sub = await billing.getByUserId(user.id);
    expect(sub.planId).toBe("pro");
  });

  it("descer de plano é recusado com orientação pro portal", async () => {
    const { user, auth } = await createTestUser();
    await seedLiveSub(user.id, "business");
    const res = await auth("post", "/api/billing/change-plan").send({ planId: "basic" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("downgrade_via_portal");
  });

  it("sem assinatura ativa não há o que trocar", async () => {
    const { auth } = await createTestUser();
    const res = await auth("post", "/api/billing/change-plan").send({ planId: "pro" });
    expect(res.status).toBe(400);
  });

  it("exige login", async () => {
    const res = await request(app).post("/api/billing/change-plan").send({ planId: "pro" });
    expect(res.status).toBe(401);
  });
});
