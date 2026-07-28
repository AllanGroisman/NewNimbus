// Preços dos planos vindos do Stripe, com cache stale-while-revalidate.
// Fonte de exibição: o unit_amount real dos prices STRIPE_PRICE_* — assim
// mudar o preço no dashboard reflete no site sem deploy. limits.js continua
// como fallback quando o Stripe está desabilitado ou fora do ar.

const stripe = require("./stripe");
const limits = require("./limits");
const logger = require("../infra/logger");

const TTL_MS = Number(process.env.STRIPE_PRICE_CACHE_TTL_MS) || 60 * 60 * 1000;
// Em outage do Stripe, segura novas tentativas por 60s pra não adicionar
// latência/carga a cada request de /api/billing/me.
const ERROR_TTL_MS = 60 * 1000;

let cache = null; // { basic: 69.9, ... } | null
let fetchedAt = 0;
let failedAt = 0;
let inflight = null;

function refresh() {
  if (!inflight) {
    inflight = (async () => {
      try {
        const prices = await stripe.fetchPlanPrices();
        cache = prices;
        fetchedAt = Date.now();
        for (const [id, value] of Object.entries(prices)) {
          const local = limits.PLANS[id]?.priceBRL;
          if (local != null && value !== local) {
            logger.warn({ planId: id, stripe: value, local }, "[billing] preço do Stripe diverge de limits.js");
          }
        }
      } catch (err) {
        failedAt = Date.now();
        logger.warn({ err: err.message }, "[billing] falha ao buscar preços no Stripe — usando fallback local");
      } finally {
        inflight = null;
      }
    })();
  }
  return inflight;
}

// Preços ao vivo ou null (Stripe desabilitado / erro sem cache) — nunca lança.
// Cache stale é devolvido na hora enquanto um refresh roda em background.
async function getPublicPrices() {
  if (!stripe.enabled()) return null;
  if (cache) {
    if (Date.now() - fetchedAt >= TTL_MS) refresh();
    return cache;
  }
  if (Date.now() - failedAt < ERROR_TTL_MS) return null;
  await refresh();
  return cache;
}

// Cache é singleton do módulo — testes de integração precisam limpar entre casos.
function __resetForTests() {
  cache = null;
  fetchedAt = 0;
  failedAt = 0;
  inflight = null;
}

module.exports = { getPublicPrices, __resetForTests };
