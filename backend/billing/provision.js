// Provisionamento a partir de um pagamento — o caminho landing → Stripe → sistema.
//
// Quem vem da landing paga ANTES de ter conta: o Checkout coleta o e-mail e a
// conta nasce do pagamento aprovado. Duas coisas disparam isso, e a corrida
// entre elas é normal:
//   - o webhook `checkout.session.completed` (server.js), e
//   - o resgate em POST /api/public/claim, quando a pessoa volta do Stripe.
// Por isso `provisionFromCheckout` é idempotente: a primeira chamada cria, a
// segunda só devolve o que já existe. O trilho da idempotência é o UNIQUE em
// Subscription.checkoutSessionId.

const store = require("./pg");
const stripe = require("./stripe");
const limits = require("./limits");
const auth = require("../auth");
const mailer = require("../auth/mailer");
const logger = require("../infra/logger");
const { normalizeCpf, isValidCpf, maskEmail } = require("../utils/cpf");

// E-mail do pagador. customer_details é o que a pessoa digitou no Checkout;
// customer_email é o prefill que mandamos. Um dos dois sempre vem.
function emailFromSession(session) {
  return String(
    session?.customer_details?.email || session?.customer_email || ""
  ).trim().toLowerCase();
}

function customerIdFromSession(session) {
  const c = session?.customer;
  return typeof c === "string" ? c : c?.id || null;
}

function subscriptionIdFromSession(session) {
  const s = session?.subscription;
  return typeof s === "string" ? s : s?.id || null;
}

function planFromSession(session) {
  const meta = session?.metadata?.planId;
  return ["basic", "pro", "business"].includes(meta) ? meta : null;
}

// Provisiona (ou recupera) a conta dona de uma Checkout Session paga.
// Retorna { userId, user, created, subscription, alreadyProvisioned }.
//
// Sessão com client_reference_id veio de um usuário logado — nada a criar, o
// fluxo normal do webhook já cuida dela; devolvemos só o vínculo.
async function provisionFromCheckout(session) {
  const sessionId = session?.id;
  if (!sessionId) throw new Error("Checkout Session sem id");

  // Já processada: devolve o estado atual, sem tocar em nada.
  const existingBySession = await store.getByCheckoutSessionId(sessionId);
  if (existingBySession) {
    const user = await auth.findById(existingBySession.userId);
    return {
      userId: existingBySession.userId,
      user,
      created: false,
      subscription: existingBySession,
      alreadyProvisioned: true,
    };
  }

  const customerId = customerIdFromSession(session);
  const subscriptionId = subscriptionIdFromSession(session);
  const planId = planFromSession(session);

  // Caminho do app: usuário já logado assinou por dentro do sistema.
  const knownUserId = session?.client_reference_id
    || session?.metadata?.nimbusUserId
    || null;

  let user = null;
  let created = false;
  let setPasswordToken = null;

  if (knownUserId) {
    user = await auth.findById(knownUserId);
  }

  if (!user) {
    const email = emailFromSession(session);
    if (!email) {
      // Sem e-mail não há como criar nem achar a conta. Não é erro fatal do
      // webhook: os eventos de subscription seguintes ainda podem resolver
      // pelo customer, então só registramos.
      logger.error({ sessionId }, "[provision] Checkout Session sem e-mail — conta não provisionada");
      return { userId: null, user: null, created: false, subscription: null, alreadyProvisioned: false };
    }
    const res = await auth.createPaidUser({
      email,
      name: session?.customer_details?.name,
      // Coletado no popup da landing, antes de abrir o Stripe.
      cpf: session?.metadata?.pendingCpf,
    });
    user = res.user;
    created = res.created;
    setPasswordToken = res.setPasswordToken;
  }

  if (!user) throw new Error("Não foi possível provisionar a conta do pagamento");

  // Assinou por dentro do app estando sem CPF (conta anterior à regra): o
  // documento informado no checkout preenche a lacuna. Falhar aqui não derruba
  // o provisionamento — o painel volta a pedir na próxima entrada.
  if (knownUserId && !user.cpf && session?.metadata?.pendingCpf) {
    try {
      await auth.setCpf(user.id, session.metadata.pendingCpf);
      user = await auth.findById(user.id);
    } catch (err) {
      logger.warn({ err: err.message, userId: user.id }, "[provision] CPF do checkout não gravado");
    }
  }

  // Vincula os objetos do Stripe à conta. O status/plano definitivos vêm do
  // evento customer.subscription.created/updated — aqui gravamos o que já dá
  // pra saber, pra pessoa não cair num painel "sem plano" logo após pagar.
  await store.ensureForUser(user.id, { planId: "free", status: "inactive" });
  await store.update(user.id, {
    ...(customerId ? { stripeCustomerId: customerId } : {}),
    ...(subscriptionId ? { stripeSubscriptionId: subscriptionId } : {}),
    ...(planId ? { planId } : {}),
    checkoutSessionId: sessionId,
    signupSource: knownUserId ? "app" : "landing",
    stripeMode: session?.livemode === true ? "live"
      : session?.livemode === false ? "test"
      : stripe.mode(),
  }).catch(err => {
    // Corrida com o outro caminho (webhook × claim) gravando a mesma sessão.
    if (err.code !== "P2002") throw err;
  });

  // Metadata no Stripe: é o que faz os eventos SEGUINTES (subscription.updated,
  // faturas) acharem o usuário sem depender do e-mail.
  if (!knownUserId) {
    await tagStripeObjects({ customerId, subscriptionId, userId: user.id, planId, cpf: user.cpf });
  }

  if (created && setPasswordToken) {
    const planLabel = planId ? limits.getPlan(planId).label : null;
    // userId: o mailer registra o envio em email_log, e é esse registro que
    // segura o "assinatura confirmada" do webhook (billing/notify.js) — senão
    // quem vem da landing recebe dois e-mails dizendo a mesma coisa.
    mailer.sendWelcomeSetPasswordEmail({
      to: user.email, name: user.name, token: setPasswordToken, planLabel, userId: user.id,
    }).catch(err => logger.error({ err: err.message }, "[provision] e-mail de boas-vindas falhou"));
  }

  const subscription = await store.getByCheckoutSessionId(sessionId);
  logger.info(
    { userId: user.id, sessionId, planId, created, source: knownUserId ? "app" : "landing" },
    "[provision] conta vinculada ao pagamento",
  );
  return { userId: user.id, user, created, subscription, alreadyProvisioned: false };
}

// Carimba nimbusUserId no Customer e na Subscription. Falha aqui não pode
// derrubar o provisionamento — a conta já existe e o reconcile por customerId
// continua funcionando.
async function tagStripeObjects({ customerId, subscriptionId, userId, planId, cpf }) {
  const client = stripe.client();
  if (!client) return;
  try {
    if (customerId) {
      // O CPF fica no Customer pra conferência e pra nota fiscal futura.
      await client.customers.update(customerId, {
        metadata: { nimbusUserId: userId, ...(cpf ? { cpf } : {}) },
      });
      // Rede de segurança do documento fiscal: o checkout já grava o br_cpf,
      // mas pagamentos que nasceram sem passar por lá (ou Customers antigos)
      // são acertados aqui. A função é idempotente.
      if (cpf) await stripe.ensureCustomerTaxId(customerId, cpf);
    }
    if (subscriptionId) {
      await client.subscriptions.update(subscriptionId, {
        metadata: { nimbusUserId: userId, ...(planId ? { planId } : {}) },
      });
    }
  } catch (err) {
    logger.warn({ err: err.message, customerId, subscriptionId }, "[provision] tag de metadata no Stripe falhou");
  }
}

// ────────────────────────────────────────────────────────────────────────
// Decisão do checkout público
// ────────────────────────────────────────────────────────────────────────
//
// O botão da landing não sabe quem está clicando, então antes de mandar pro
// Stripe olhamos o e-mail e o CPF. Saídas:
//   "checkout"                  — pode pagar (sem conta, ou conta sem plano ativo)
//   "invalid_cpf"               — documento não confere (rota devolve 400)
//   "cpf_taken"                 — o CPF já é de OUTRA conta; uma conta por CPF
//   "blocked"                   — já tem plano igual ou melhor; cobrar de novo
//                                 criaria uma segunda assinatura pro mesmo dono
//   "upgrade_requires_login"    — quer plano melhor: o caminho certo é o upgrade
//                                 dentro do sistema, que cobra só a diferença
//
// Não revela se o e-mail tem conta: e-mail sem cadastro e e-mail cadastrado sem
// plano dão a MESMA resposta ("checkout"). O que vaza — e é intencional — é que
// aquele e-mail tem assinatura ativa, sem o que não dá pra explicar o bloqueio.
// O mesmo vale pro CPF, e por isso o e-mail da conta dona vem mascarado: dá pra
// reconhecer a própria conta, não pra descobrir a de terceiros.
async function decideForSignup({ planId, email, cpf }) {
  const normalized = String(email || "").trim().toLowerCase();
  const digits = normalizeCpf(cpf);

  if (!isValidCpf(digits)) {
    return {
      decision: "invalid_cpf", user: null, sub: null, currentPlan: null, trialEligible: false,
      message: "CPF inválido. Confira os números e tente de novo.",
    };
  }

  const user = normalized ? await auth.findByEmail(normalized) : null;
  const byCpf = await auth.findByCpf(digits);

  // Uma conta por CPF, mesmo que a conta antiga esteja cancelada: o documento
  // é o que impede a mesma pessoa de repetir o teste de R$ 1,00 trocando de
  // e-mail.
  if (byCpf && byCpf.id !== user?.id) {
    return {
      decision: "cpf_taken", user: null, sub: null, currentPlan: null, trialEligible: false,
      message: `Já existe uma conta com este CPF (e-mail ${maskEmail(byCpf.email)}). `
        + "Entre nela para assinar ou mudar de plano.",
    };
  }

  if (!user) {
    return { decision: "checkout", user: null, sub: null, currentPlan: null, cpf: digits, trialEligible: true };
  }

  // E-mail de uma conta que já tem OUTRO CPF: ou a pessoa errou o documento,
  // ou está usando o e-mail de outra pessoa. Nos dois casos o caminho é entrar
  // na conta, não abrir uma assinatura nova.
  if (user.cpf && user.cpf !== digits) {
    return {
      decision: "cpf_mismatch", user: null, sub: null, currentPlan: null, trialEligible: false,
      message: "O CPF não confere com o cadastrado para este e-mail. "
        + "Confira os números ou entre na sua conta para assinar.",
    };
  }

  const sub = await store.getByUserId(user.id);
  // Admin tem Business por bypass (limits.effectivePlanId) — não faz sentido
  // deixar comprar plano nenhum pela landing.
  const role = auth.isAdminEmail(user.email) ? "admin" : user.role;
  // `paidPlanId`, e não `effectivePlanId`: a pergunta aqui é "já é cliente?".
  // Uma cortesia do admin não é assinatura — tratá-la como uma bloquearia
  // justamente quem a gente quer que assine no fim do período de teste.
  const currentPlan = limits.paidPlanId(sub, role);
  const trialEligible = !sub?.trialUsedAt && !sub?.stripeSubscriptionId;

  if (currentPlan === "free") {
    return { decision: "checkout", user, sub, currentPlan, cpf: digits, trialEligible };
  }

  if (limits.isUpgrade(currentPlan, planId)) {
    return {
      decision: "upgrade_requires_login",
      user, sub, currentPlan, trialEligible: false,
      message: `Este e-mail já assina o plano ${limits.getPlan(currentPlan).label}. `
        + `Entre na sua conta para mudar para o ${limits.getPlan(planId).label} — `
        + "você paga só a diferença, sem começar uma assinatura nova.",
    };
  }

  return {
    decision: "blocked",
    user, sub, currentPlan, trialEligible: false,
    message: currentPlan === planId
      ? `Este e-mail já tem o plano ${limits.getPlan(currentPlan).label} ativo. É só entrar na sua conta.`
      : `Este e-mail já assina o plano ${limits.getPlan(currentPlan).label}, que é superior ao `
        + `${limits.getPlan(planId).label}. Entre na sua conta para mudar de plano.`,
  };
}

module.exports = {
  provisionFromCheckout,
  decideForSignup,
  emailFromSession,
};
