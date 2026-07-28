// Mock do módulo backend/billing/stripe.js — instalado no require.cache
// antes do server.js carregar. Permite testar o webhook handler e endpoints
// /checkout e /portal sem credenciais reais da Stripe.
//
// O mock simula:
//   - enabled() retorna true (configurável)
//   - constructEvent(rawBody) → JSON.parse(rawBody) — sem validar HMAC
//   - getOrCreateCustomer → retorna { id: "cus_test_<userId>" }
//   - createCheckoutSession → { id, url }
//   - createPortalSession → { url }
//
// Os testes podem definir handlers customizados via `setMock(opts)` ou inspecionar
// chamadas em `calls`.

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

const calls = {
  enabled: 0,
  constructEvent: [],
  getOrCreateCustomer: [],
  createCheckoutSession: [],
  createPortalSession: [],
  getActiveSubscriptionForCustomer: [],
  getUpcomingInvoice: [],
  listInvoices: [],
  getDefaultPaymentMethod: [],
  fetchPlanPrices: [],
  reactivateSubscription: [],
};

let state = {
  enabled: true,
  // Permite forçar uma exception em constructEvent (testa 400 de signature inválida)
  shouldFailConstructEvent: false,
  // Assinatura ao vivo devolvida por getActiveSubscriptionForCustomer (sync endpoint).
  // null = customer sem assinatura no Stripe.
  activeSubscription: null,
  // Dados do endpoint /api/billing/details
  upcomingInvoice: null,   // { amountBRL, currency, nextPaymentAttempt } | null
  invoices: [],            // [{ id, date, amountBRL, status, hostedUrl, pdfUrl }]
  paymentMethod: null,     // { brand, last4, expMonth, expYear } | null
  // Catálogo devolvido por fetchPlanPrices. Default espelha limits.js pra não
  // quebrar testes que fixam 69.90 no /api/billing/me.
  planPrices: { basic: 69.90, pro: 99.90, business: 149.90 },
  shouldFailFetchPrices: false,
};

const PRICE_IDS = {
  basic: "price_test_basic",
  pro: "price_test_pro",
  business: "price_test_business",
};
const PRICE_TO_PLAN = {
  price_test_basic: "basic",
  price_test_pro: "pro",
  price_test_business: "business",
};

function reset() {
  for (const k of Object.keys(calls)) {
    if (Array.isArray(calls[k])) calls[k].length = 0;
    else calls[k] = 0;
  }
  state = {
    enabled: true,
    shouldFailConstructEvent: false,
    activeSubscription: null,
    upcomingInvoice: null,
    invoices: [],
    paymentMethod: null,
    planPrices: { basic: 69.90, pro: 99.90, business: 149.90 },
    shouldFailFetchPrices: false,
  };
}

function setMock(opts = {}) {
  Object.assign(state, opts);
}

const mock = {
  __calls: calls,
  __reset: reset,
  __setMock: setMock,

  client() { return null; },
  enabled() { calls.enabled += 1; return state.enabled; },
  priceFor(planId) { return PRICE_IDS[planId] || ""; },
  planFromPrice(priceId) { return PRICE_TO_PLAN[priceId] || null; },

  async getOrCreateCustomer({ userId, email, name, existingCustomerId }) {
    calls.getOrCreateCustomer.push({ userId, email, name, existingCustomerId });
    return { id: existingCustomerId || `cus_test_${userId}`, email, name };
  },

  async createCheckoutSession({ planId, customer, userId, withTrial = false }) {
    calls.createCheckoutSession.push({ planId, customerId: customer.id, userId, withTrial });
    return {
      id: `cs_test_${userId}_${planId}`,
      url: `https://checkout.stripe.test/c/${planId}${withTrial ? "?trial=1" : ""}`,
    };
  },

  async createPortalSession({ customer }) {
    calls.createPortalSession.push({ customerId: customer.id });
    return { url: `https://billing.stripe.test/p/${customer.id}` };
  },

  // constructEvent: sem HMAC. Em rawBody chega Buffer (express.raw), em testes
  // podemos mandar string/Buffer indiferente — apenas JSON.parse.
  constructEvent(rawBody, signature) {
    calls.constructEvent.push({ signature });
    if (state.shouldFailConstructEvent) {
      throw new Error("signature inválida (mock)");
    }
    const str = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody);
    return JSON.parse(str);
  },

  // Idêntico ao real — prefere metadata.planId, fallback pro mapa de preços.
  normalizeSubscription(sub) {
    const item = sub.items?.data?.[0];
    const priceId = item?.price?.id || null;
    const metaPlan = sub.metadata?.planId;
    const validMeta = ["basic", "pro", "business"].includes(metaPlan) ? metaPlan : null;
    const planId = validMeta || (priceId ? PRICE_TO_PLAN[priceId] : null);
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
      trialEnd: sub.trial_end ? new Date(sub.trial_end * 1000) : null,
    };
  },

  // Reconciliação ativa (sync endpoint). Devolve state.activeSubscription já
  // normalizada, ou null se o customer não tem assinatura no Stripe.
  async getActiveSubscriptionForCustomer(customerId) {
    calls.getActiveSubscriptionForCustomer.push({ customerId });
    if (!customerId || !state.activeSubscription) return null;
    return this.normalizeSubscription(state.activeSubscription);
  },

  async getUpcomingInvoice(customerId) {
    calls.getUpcomingInvoice.push({ customerId });
    return state.upcomingInvoice;
  },

  async listInvoices(customerId, limit = 10) {
    calls.listInvoices.push({ customerId, limit });
    return state.invoices;
  },

  async getDefaultPaymentMethod(customerId, subscriptionId) {
    calls.getDefaultPaymentMethod.push({ customerId, subscriptionId });
    return state.paymentMethod;
  },

  async fetchPlanPrices() {
    calls.fetchPlanPrices.push({});
    if (state.shouldFailFetchPrices) throw new Error("stripe indisponível (mock)");
    return { ...state.planPrices };
  },

  // Desfaz cancelamento agendado na assinatura do state (se houver).
  async reactivateSubscription(subscriptionId) {
    calls.reactivateSubscription.push({ subscriptionId });
    if (state.activeSubscription) state.activeSubscription.cancel_at_period_end = false;
    if (state.activeSubscription) return this.normalizeSubscription(state.activeSubscription);
    // Sem state — devolve patch mínimo (sem stripeCustomerId pra não sobrescrever o banco).
    return {
      stripeSubscriptionId: subscriptionId,
      status: "active",
      cancelAtPeriodEnd: false,
      trialEnd: null,
    };
  },
};

function installMock() {
  const target = path.resolve(__dirname, "..", "..", "backend", "billing", "stripe.js");
  require.cache[target] = {
    id: target,
    filename: target,
    loaded: true,
    children: [],
    paths: [],
    exports: mock,
  };
  return mock;
}

export { installMock, mock, calls, reset, setMock };
