// Métricas Prometheus (Fase 4).
//
// Expostas em GET /metrics (texto plano, formato Prometheus).
// Coleta default node (heap, gc, event loop) + métricas customizadas do Nimbus.
//
// Convenções de nome (Prometheus best practice):
//   - prefixo nimbus_
//   - sufixo _total pra counters, _seconds pra durações, sem sufixo pra gauges

const client = require("prom-client");

const register = new client.Registry();
register.setDefaultLabels({ app: "nimbus" });
client.collectDefaultMetrics({ register });

// ── HTTP ──────────────────────────────────────────────────────────────
const httpRequestsTotal = new client.Counter({
  name: "nimbus_http_requests_total",
  help: "Total de requests HTTP recebidos",
  labelNames: ["method", "route", "status"],
  registers: [register],
});
const httpDuration = new client.Histogram({
  name: "nimbus_http_request_duration_seconds",
  help: "Duração de requests HTTP em segundos",
  labelNames: ["method", "route", "status"],
  buckets: [0.01, 0.05, 0.1, 0.3, 1, 3, 10],
  registers: [register],
});

// ── Scheduler ─────────────────────────────────────────────────────────
const schedulerTicksTotal = new client.Counter({
  name: "nimbus_scheduler_ticks_total",
  help: "Total de ticks do scheduler",
  labelNames: ["status"], // "ok" | "error"
  registers: [register],
});
const schedulerTickDuration = new client.Histogram({
  name: "nimbus_scheduler_tick_duration_seconds",
  help: "Duração de cada tick do scheduler",
  buckets: [0.1, 0.5, 1, 3, 10, 30],
  registers: [register],
});
const schedulerEnqueuedTotal = new client.Counter({
  name: "nimbus_scheduler_enqueued_total",
  help: "Total de envios enfileirados pelo producer",
  labelNames: ["target"], // "queue" | "memory"
  registers: [register],
});

// ── Sends (resultado de processSendJob) ───────────────────────────────
const sendsTotal = new client.Counter({
  name: "nimbus_sends_total",
  help: "Total de envios completados (success ou fail terminal)",
  labelNames: ["status", "store"], // status: ok|fail; store: ml|amazon|...
  registers: [register],
});
const sendDuration = new client.Histogram({
  name: "nimbus_send_duration_seconds",
  help: "Duração do envio (do start do job até o callback de envio)",
  buckets: [0.5, 1, 3, 5, 10, 30, 60],
  registers: [register],
});
const sendRetryTotal = new client.Counter({
  name: "nimbus_send_retry_total",
  help: "Tentativas de retry em jobs de envio",
  registers: [register],
});

// ── Queue depth (gauges atualizados sob demanda) ──────────────────────
const queueDepth = new client.Gauge({
  name: "nimbus_queue_depth",
  help: "Profundidade das filas BullMQ",
  labelNames: ["queue", "state"], // state: waiting|active|delayed|failed|completed
  registers: [register],
});

// ── WhatsApp sessions ─────────────────────────────────────────────────
const waSessions = new client.Gauge({
  name: "nimbus_whatsapp_sessions",
  help: "Total de sessões WhatsApp por status",
  labelNames: ["status"], // connected|connecting|awaiting_qr|disconnected|logged_out
  registers: [register],
});

// ── Catalog ───────────────────────────────────────────────────────────
const catalogProducts = new client.Gauge({
  name: "nimbus_catalog_products",
  help: "Total de produtos no catálogo",
  labelNames: ["store"],
  registers: [register],
});
const catalogScrapeRunsTotal = new client.Counter({
  name: "nimbus_catalog_scrape_runs_total",
  help: "Runs do admin-scraper",
  labelNames: ["status"], // ok|fail
  registers: [register],
});

// ── Worker heartbeat (set pelo server lendo do Redis) ─────────────────
const workerHeartbeatAge = new client.Gauge({
  name: "nimbus_worker_heartbeat_age_seconds",
  help: "Idade do último heartbeat do worker (NaN se nunca recebido)",
  registers: [register],
});

// ── Billing (Stripe) ──────────────────────────────────────────────────
const billingWebhookTotal = new client.Counter({
  name: "nimbus_billing_webhook_events_total",
  help: "Eventos de webhook Stripe recebidos",
  labelNames: ["type", "result"], // result: ok|error
  registers: [register],
});
const billingCheckoutTotal = new client.Counter({
  name: "nimbus_billing_checkout_total",
  help: "Tentativas de checkout (criação de Stripe Checkout Session)",
  labelNames: ["plan", "result"], // result: ok|error
  registers: [register],
});
const billingActiveSubs = new client.Gauge({
  name: "nimbus_billing_active_subscriptions",
  help: "Assinaturas ativas (status active+trialing) por plano",
  labelNames: ["plan"],
  registers: [register],
});

function recordWebhook(type, result) {
  try { billingWebhookTotal.inc({ type, result }); } catch {}
}
function recordCheckout(plan, result) {
  try { billingCheckoutTotal.inc({ plan, result }); } catch {}
}

// Express middleware — instrumenta requests HTTP. Aplique APÓS rotas que
// você quer trackear. Usa req.route?.path quando disponível pra evitar
// explosão de cardinalidade com rotas paramétricas.
function httpMiddleware(req, res, next) {
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    const dur = Number(process.hrtime.bigint() - start) / 1e9;
    const route = req.route?.path || req.path || "unknown";
    const labels = { method: req.method, route, status: String(res.statusCode) };
    try {
      httpRequestsTotal.inc(labels);
      httpDuration.observe(labels, dur);
    } catch {}
  });
  next();
}

// Handler do endpoint /metrics
async function handler(req, res) {
  try {
    res.set("Content-Type", register.contentType);
    res.end(await register.metrics());
  } catch (err) {
    res.status(500).end(err.message);
  }
}

module.exports = {
  register,
  httpMiddleware,
  handler,
  // counters/histograms/gauges expostos pra os módulos chamarem
  schedulerTicksTotal,
  schedulerTickDuration,
  schedulerEnqueuedTotal,
  sendsTotal,
  sendDuration,
  sendRetryTotal,
  queueDepth,
  waSessions,
  catalogProducts,
  catalogScrapeRunsTotal,
  workerHeartbeatAge,
  billingWebhookTotal,
  billingCheckoutTotal,
  billingActiveSubs,
  recordWebhook,
  recordCheckout,
};
