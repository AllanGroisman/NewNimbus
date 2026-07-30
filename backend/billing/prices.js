// Catálogo dos planos vindo do Stripe (preço + nome do produto), com cache
// stale-while-revalidate POR MODO (test/live).
// Fonte de exibição: o unit_amount e o product.name reais dos prices
// STRIPE_PRICE_* — assim mudar preço ou nome no dashboard reflete no site sem
// deploy. limits.js continua como fallback quando o Stripe está desabilitado ou
// fora do ar.

const stripe = require("./stripe");
const limits = require("./limits");
const logger = require("../infra/logger");

const TTL_MS = Number(process.env.STRIPE_PRICE_CACHE_TTL_MS) || 60 * 60 * 1000;
// Em outage do Stripe, segura novas tentativas por 60s pra não adicionar
// latência/carga a cada request de /api/billing/me.
const ERROR_TTL_MS = 60 * 1000;

// modo -> { data: { basic: { priceBRL, name, priceId }, … }, fetchedAt, failedAt, inflight }
const byMode = new Map();

function slot(mode) {
  if (!byMode.has(mode)) byMode.set(mode, { data: null, fetchedAt: 0, failedAt: 0, inflight: null });
  return byMode.get(mode);
}

function refresh(mode) {
  const s = slot(mode);
  if (!s.inflight) {
    s.inflight = (async () => {
      try {
        const plans = await stripe.fetchPlanPrices();
        s.data = plans;
        s.fetchedAt = Date.now();
        for (const [id, value] of Object.entries(plans)) {
          const local = limits.PLANS[id]?.priceBRL;
          if (local != null && value.priceBRL !== local) {
            logger.warn({ planId: id, stripe: value.priceBRL, local, mode }, "[billing] preço do Stripe diverge de limits.js");
          }
        }
      } catch (err) {
        s.failedAt = Date.now();
        logger.warn({ err: err.message, mode }, "[billing] falha ao buscar catálogo no Stripe — usando fallback local");
      } finally {
        s.inflight = null;
      }
    })();
  }
  return s.inflight;
}

// Catálogo ao vivo do modo ativo ou null (Stripe desabilitado / erro sem cache)
// — nunca lança. Cache stale é devolvido na hora enquanto um refresh roda em
// background. Trocar de modo no admin lê outro slot, então o catálogo do modo
// anterior nunca vaza pra tela.
async function getPublicPrices() {
  if (!stripe.enabled()) return null;
  const mode = stripe.mode();
  const s = slot(mode);
  if (s.data) {
    if (Date.now() - s.fetchedAt >= TTL_MS) refresh(mode);
    return s.data;
  }
  if (Date.now() - s.failedAt < ERROR_TTL_MS) return null;
  await refresh(mode);
  return s.data;
}

// Descarta o cache — chamado por stripe.setMode() pra não servir dado velho
// logo depois da troca, e usado pelo botão de recarregar catálogo do admin.
function __invalidate() {
  byMode.clear();
}

// Cache é singleton do módulo — testes de integração precisam limpar entre casos.
function __resetForTests() {
  byMode.clear();
}

module.exports = { getPublicPrices, __invalidate, __resetForTests };
