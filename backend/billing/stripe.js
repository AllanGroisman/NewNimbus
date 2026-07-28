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

// Price avulso de R$1 cobrado hoje no checkout com trial ("15 dias por R$1").
const TRIAL_FEE_PRICE = process.env.STRIPE_PRICE_TRIAL_FEE || "";
const TRIAL_DAYS = 15;

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
// withTrial: cobra R$1 hoje (line item avulso) + 15 dias de trial na assinatura.
async function createCheckoutSession({ planId, customer, userId, withTrial = false }) {
  const price = priceFor(planId);
  if (!price) throw new Error(`Price ID não configurado pro plano "${planId}"`);
  if (withTrial && !TRIAL_FEE_PRICE) {
    throw new Error("STRIPE_PRICE_TRIAL_FEE não configurado — trial de R$1 indisponível");
  }

  const lineItems = [{ price, quantity: 1 }];
  if (withTrial) lineItems.push({ price: TRIAL_FEE_PRICE, quantity: 1 });

  const subscriptionData = {
    metadata: { nimbusUserId: userId, planId, ...(withTrial ? { trial: "1" } : {}) },
  };
  if (withTrial) {
    subscriptionData.trial_period_days = TRIAL_DAYS;
    subscriptionData.trial_settings = {
      end_behavior: { missing_payment_method: "cancel" },
    };
  }

  return client().checkout.sessions.create({
    mode: "subscription",
    customer: customer.id,
    client_reference_id: userId,
    line_items: lineItems,
    // Pix recorrente em BRL precisa estar habilitado no dashboard.
    // Se ainda não ativou, deixar só "card" funciona; com Pix ativo, ambos.
    payment_method_types: ["card"],
    // Garante cartão salvo durante o trial pra renovação funcionar.
    ...(withTrial ? { payment_method_collection: "always" } : {}),
    locale: "pt-BR",
    allow_promotion_codes: true,
    success_url: SUCCESS_URL,
    cancel_url: CANCEL_URL,
    metadata: { nimbusUserId: userId, planId },
    subscription_data: subscriptionData,
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
  // Prefere o planId explícito gravado no checkout (subscription_data.metadata.planId).
  // Fallback pro mapa price→plan. Blinda contra price_id defasado/trocado no .env.
  const metaPlan = sub.metadata?.planId;
  const validMeta = ["basic", "pro", "business"].includes(metaPlan) ? metaPlan : null;
  const planId = validMeta || (priceId ? planFromPrice(priceId) : null);
  // API "basil" (2025-03+) moveu current_period_end pro item — fallback defensivo.
  const periodEndUnix = sub.current_period_end ?? item?.current_period_end ?? null;
  const currentPeriodEnd = periodEndUnix ? new Date(periodEndUnix * 1000) : null;
  return {
    stripeSubscriptionId: sub.id,
    stripeCustomerId: typeof sub.customer === "string" ? sub.customer : sub.customer?.id,
    planId: planId || "free",
    status: sub.status,
    currentPeriodEnd,
    cancelAtPeriodEnd: !!sub.cancel_at_period_end,
    // Não é coluna do banco — chamadores usam pra marcar trialUsedAt e removem antes de persistir.
    trialEnd: sub.trial_end ? new Date(sub.trial_end * 1000) : null,
  };
}

// Busca a assinatura ao vivo do customer no Stripe e devolve normalizada.
// Usado pela reconciliação ativa (POST /api/billing/sync) — corrige o plano
// mesmo quando o webhook customer.subscription.updated não chega (ex: ngrok defasado).
async function getActiveSubscriptionForCustomer(customerId) {
  if (!customerId) return null;
  const res = await client().subscriptions.list({
    customer: customerId,
    status: "all",
    limit: 10,
  });
  const subs = res.data || [];
  if (!subs.length) return null;
  const active = subs.find((s) => ["active", "trialing", "past_due"].includes(s.status))
    || subs.slice().sort((a, b) => b.created - a.created)[0];
  return normalizeSubscription(active);
}

// Preview da próxima fatura (valor exato, considera cupons/proração).
// Sem fatura futura (ex: cancelamento agendado) o Stripe lança — retorna null.
async function getUpcomingInvoice(customerId) {
  if (!customerId) return null;
  try {
    const inv = await client().invoices.createPreview({ customer: customerId });
    return {
      amountBRL: (inv.total ?? 0) / 100,
      currency: inv.currency || "brl",
      nextPaymentAttempt: inv.next_payment_attempt
        ? new Date(inv.next_payment_attempt * 1000)
        : null,
    };
  } catch (err) {
    logger.warn({ err: err.message, customerId }, "[stripe] upcoming invoice indisponível");
    return null;
  }
}

// Últimas faturas do customer pro histórico na página (máx. 10).
async function listInvoices(customerId, limit = 10) {
  if (!customerId) return [];
  const res = await client().invoices.list({ customer: customerId, limit });
  return (res.data || []).map((inv) => ({
    id: inv.id,
    date: new Date(inv.created * 1000),
    amountBRL: (inv.total ?? 0) / 100,
    status: inv.status, // draft | open | paid | void | uncollectible
    hostedUrl: inv.hosted_invoice_url || null,
    pdfUrl: inv.invoice_pdf || null,
  }));
}

// Cartão que será cobrado: default da assinatura, senão default do customer.
async function getDefaultPaymentMethod(customerId, subscriptionId) {
  let pm = null;
  if (subscriptionId) {
    try {
      const sub = await client().subscriptions.retrieve(subscriptionId, {
        expand: ["default_payment_method"],
      });
      pm = sub.default_payment_method;
    } catch (err) {
      logger.warn({ err: err.message, subscriptionId }, "[stripe] retrieve subscription falhou");
    }
  }
  if (!pm && customerId) {
    try {
      const cust = await client().customers.retrieve(customerId, {
        expand: ["invoice_settings.default_payment_method"],
      });
      pm = cust.invoice_settings?.default_payment_method;
    } catch (err) {
      logger.warn({ err: err.message, customerId }, "[stripe] retrieve customer falhou");
    }
  }
  if (!pm || typeof pm === "string" || !pm.card) return null;
  return {
    brand: pm.card.brand,
    last4: pm.card.last4,
    expMonth: pm.card.exp_month,
    expYear: pm.card.exp_year,
  };
}

// Busca no Stripe o valor atual dos prices configurados (STRIPE_PRICE_*).
// Retorna { basic: 69.9, ... } só com os planos válidos (BRL, unit_amount
// presente) — plano ausente aqui cai no fallback de limits.js no chamador.
async function fetchPlanPrices() {
  const out = {};
  for (const [planId, priceId] of Object.entries(PRICE_IDS)) {
    if (!priceId) continue;
    const price = await client().prices.retrieve(priceId);
    if (price.currency !== "brl" || price.unit_amount == null) {
      logger.warn({ planId, priceId, currency: price.currency }, "[stripe] price sem unit_amount em BRL — ignorando");
      continue;
    }
    out[planId] = price.unit_amount / 100;
  }
  return out;
}

// Desfaz cancelamento agendado (cancel_at_period_end=true → false).
async function reactivateSubscription(subscriptionId) {
  const updated = await client().subscriptions.update(subscriptionId, {
    cancel_at_period_end: false,
  });
  return normalizeSubscription(updated);
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
  getActiveSubscriptionForCustomer,
  getUpcomingInvoice,
  listInvoices,
  getDefaultPaymentMethod,
  fetchPlanPrices,
  reactivateSubscription,
};
