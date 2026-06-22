// Wrapper do Stripe SDK — centraliza configuração e mapeamento de price→plan.
// Sem STRIPE_SECRET_KEY, todas as ops viram no-op com `enabled=false` — útil pra
// rodar dev/test sem credenciais ou desativar billing em deploys específicos.

const logger = require("../infra/logger");

const SECRET = process.env.STRIPE_SECRET_KEY || "";
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";

const PRICE_IDS = {
  basic: process.env.STRIPE_PRICE_BASIC || "",
  pro: process.env.STRIPE_PRICE_PRO || "",
  business: process.env.STRIPE_PRICE_BUSINESS || "",
};

// Mapa reverso pra resolver planId a partir de price.id no webhook.
const PRICE_TO_PLAN = Object.fromEntries(
  Object.entries(PRICE_IDS).filter(([, v]) => v).map(([k, v]) => [v, k])
);

const { stripeSuccessUrl: SUCCESS_URL, stripeCancelUrl: CANCEL_URL } = require("../config/publicUrl");

let _client = null;
function client() {
  if (!SECRET) return null;
  if (!_client) {
    const Stripe = require("stripe");
    _client = new Stripe(SECRET, {
      // Sem apiVersion fixa — usa a versão default da chave (configurada no dashboard).
      // Fixar aqui ajuda em prod (estabilidade), mas em dev/test deixar livre é mais simples.
      typescript: false,
    });
  }
  return _client;
}

function enabled() {
  return !!SECRET;
}

function priceFor(planId) {
  return PRICE_IDS[planId] || "";
}

function planFromPrice(priceId) {
  return PRICE_TO_PLAN[priceId] || null;
}

// Cria (ou recupera) o Stripe Customer pra um user do Nimbus.
// userId vai como metadata pra rastrear no dashboard.
async function getOrCreateCustomer({ userId, email, name, existingCustomerId }) {
  if (existingCustomerId) {
    try { return await client().customers.retrieve(existingCustomerId); }
    catch (err) {
      logger.warn({ err: err.message, existingCustomerId }, "[stripe] customer retrieve falhou — criando novo");
    }
  }
  return client().customers.create({
    email,
    name,
    metadata: { nimbusUserId: userId },
  });
}

// Cria sessão de Checkout em modo subscription.
// payment_method_types: cartão sempre; Pix só se planId não for trial-only.
async function createCheckoutSession({ planId, customer, userId }) {
  const price = priceFor(planId);
  if (!price) throw new Error(`Price ID não configurado pro plano "${planId}"`);

  return client().checkout.sessions.create({
    mode: "subscription",
    customer: customer.id,
    client_reference_id: userId,
    line_items: [{ price, quantity: 1 }],
    // Pix recorrente em BRL precisa estar habilitado no dashboard.
    // Se ainda não ativou, deixar só "card" funciona; com Pix ativo, ambos.
    payment_method_types: ["card"],
    locale: "pt-BR",
    allow_promotion_codes: true,
    success_url: SUCCESS_URL,
    cancel_url: CANCEL_URL,
    metadata: { nimbusUserId: userId, planId },
    subscription_data: {
      metadata: { nimbusUserId: userId, planId },
    },
  });
}

// Customer Portal — Stripe-hosted UI pra trocar cartão / cancelar / ver faturas.
async function createPortalSession({ customer }) {
  return client().billingPortal.sessions.create({
    customer: customer.id,
    return_url: SUCCESS_URL.replace(/\?.*$/, "") || "http://localhost:5173/",
  });
}

// Verifica assinatura do webhook. Lança em falha — express handler responde 400.
function constructEvent(rawBody, signature) {
  if (!WEBHOOK_SECRET) throw new Error("STRIPE_WEBHOOK_SECRET não configurado");
  return client().webhooks.constructEvent(rawBody, signature, WEBHOOK_SECRET);
}

// Extrai os campos relevantes de um Stripe Subscription pra persistir.
// Status string vai direto. Plano é resolvido por price.id do primeiro item.
function normalizeSubscription(sub) {
  const item = sub.items?.data?.[0];
  const priceId = item?.price?.id || null;
  const planId = priceId ? planFromPrice(priceId) : null;
  const currentPeriodEnd = sub.current_period_end
    ? new Date(sub.current_period_end * 1000)
    : null;
  return {
    stripeSubscriptionId: sub.id,
    stripeCustomerId: typeof sub.customer === "string" ? sub.customer : sub.customer?.id,
    planId: planId || "free",
    status: sub.status,
    currentPeriodEnd,
    cancelAtPeriodEnd: !!sub.cancel_at_period_end,
  };
}

module.exports = {
  client,
  enabled,
  priceFor,
  planFromPrice,
  getOrCreateCustomer,
  createCheckoutSession,
  createPortalSession,
  constructEvent,
  normalizeSubscription,
};
