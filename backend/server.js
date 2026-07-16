// CRÍTICO: carregar .env ANTES de qualquer require que dependa de env na hora do
// module-load. O facade whatsapp/index.js decide local-vs-proxy lendo QUEUE_BACKEND
// no require; sem o dotenv aqui, ele resolvia pra "local" (sem sessões) no backend,
// quebrando envios e abrindo uma conexão Baileys duplicada (conflito com o worker).
require("./config/loadEnv"); // carrega .env + override por modo (prod | ngrok)

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { CATEGORIES, STORES, scrapeSingleProduct } = require("./scraping/scraper");
const wa = require("./whatsapp");
const auth = require("./auth");
const storage = require("./storage");
const scheduler = require("./scheduler");
const affiliate = require("./scraping/affiliate");
const catalog = require("./catalog");
const adminScraper = require("./scraping/admin");
const appConfig = require("./config");
const queueMod = require("./infra/queue");
const logger = require("./infra/logger");
const metrics = require("./infra/metrics");
const sentry = require("./infra/sentry");
const billing = require("./billing");
const stripeMod = require("./billing/stripe");
const backupApi = require("./backup/api");
const adminNotifier = require("./notifications/admin-notifier");
const whatsnimbus = require("./notifications/whatsnimbus");

// Sentry init (Fase 4) — no-op se SENTRY_DSN não estiver definido
sentry.init({ context: "server" });

// Process-level error handlers — captura tudo que escapa de async/promises.
process.on("unhandledRejection", (reason, promise) => {
  logger.error({ err: reason, type: "unhandledRejection" }, "Promise rejeitada sem catch");
  sentry.captureException(reason instanceof Error ? reason : new Error(String(reason)), {
    tags: { type: "unhandledRejection" },
  });
});
process.on("uncaughtException", (err) => {
  logger.fatal({ err, type: "uncaughtException" }, "Exceção não tratada — process vai sair");
  sentry.captureException(err, { tags: { type: "uncaughtException" } });
  // Não chama process.exit imediatamente — deixa pino e Sentry fazer flush
  Promise.allSettled([sentry.flush(2000)]).then(() => setTimeout(() => process.exit(1), 500));
});

const app = express();
const PORT = process.env.PORT || 3001;

// ────────────────────────────────────────────────────────────────────────
// Hardening (Fase 0)
// ────────────────────────────────────────────────────────────────────────

// Helmet — headers de segurança HTTP padrão.
app.use(helmet({
  // Frontend (Vite) e fetch da própria SPA precisam abrir cross-origin pra
  // imagens dos produtos (Amazon/ML thumbnails). Mantemos COEP/CORP relaxados.
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" },
}));

// CORS allowlist via env. Default em dev: aceita tudo (mantém comportamento legado).
// Em produção: defina NIMBUS_CORS_ORIGINS=https://app.x.com,https://admin.x.com
// Patterns suportados: domínio exato OU "*.dominio.com" (wildcard de subdomínio).
const { corsOrigins: CORS_ORIGINS } = require("./config/publicUrl");

function originAllowed(origin) {
  if (!CORS_ORIGINS.length) return true; // dev mode (sem env definida)
  if (!origin) return true; // requests same-origin / curl
  for (const pat of CORS_ORIGINS) {
    if (pat === origin) return true;
    if (pat.startsWith("*.")) {
      const suffix = pat.slice(1); // ".dominio.com"
      if (origin.endsWith(suffix)) return true;
    }
  }
  return false;
}

app.use(cors({
  origin: (origin, cb) => {
    if (originAllowed(origin)) return cb(null, true);
    cb(new Error(`Origin não permitido: ${origin}`));
  },
  credentials: true,
}));

// ────────────────────────────────────────────────────────────────────────
// Stripe webhook — DEVE vir antes do express.json() global porque
// stripe.webhooks.constructEvent precisa do raw body (Buffer) pra validar
// a assinatura HMAC. Se passar pelo json parser primeiro, perdemos os bytes.
// ────────────────────────────────────────────────────────────────────────
app.post(
  "/api/billing/webhook",
  express.raw({ type: "application/json", limit: "1mb" }),
  async (req, res) => {
    if (!stripeMod.enabled()) return res.status(501).json({ error: "Stripe não configurado" });
    const signature = req.headers["stripe-signature"];
    if (!signature) return res.status(400).json({ error: "Missing stripe-signature" });

    let event;
    try {
      event = stripeMod.constructEvent(req.body, signature);
    } catch (err) {
      logger.warn({ err: err.message }, "[billing] webhook signature inválida");
      return res.status(400).json({ error: `Webhook signature: ${err.message}` });
    }

    // Idempotência — Stripe reentrega eventos. Marca antes de processar.
    const fresh = await billing.markWebhookProcessed(event.id, event.type);
    if (!fresh) {
      return res.json({ received: true, deduped: true });
    }

    try {
      await handleStripeEvent(event);
      metrics.recordWebhook?.(event.type, "ok");
      res.json({ received: true });
    } catch (err) {
      logger.error({ err: err.message, eventId: event.id, type: event.type }, "[billing] handler falhou");
      sentry.captureException(err, { tags: { stripeEvent: event.type } });
      metrics.recordWebhook?.(event.type, "error");
      // 500 faz o Stripe reentregar — mas como já marcamos como processed,
      // não vai re-processar. Aceitamos a perda em troca de não loopar.
      res.status(500).json({ error: err.message });
    }
  }
);

// Despacha cada tipo de evento Stripe pra atualização correspondente do storage.
async function handleStripeEvent(event) {
  const obj = event.data?.object;
  switch (event.type) {
    case "checkout.session.completed": {
      // Primeiro pareamento customer ↔ user. A subscription em si vem em
      // subscription.created/updated logo depois — aqui só garantimos o link.
      const userId = obj.client_reference_id;
      const customerId = typeof obj.customer === "string" ? obj.customer : obj.customer?.id;
      if (userId && customerId) {
        await billing.update(userId, { stripeCustomerId: customerId });
      }
      return;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const norm = stripeMod.normalizeSubscription(obj);
      // Resolve userId: 1) metadata.nimbusUserId, 2) customer já linkado.
      let userId = obj.metadata?.nimbusUserId;
      if (!userId && norm.stripeCustomerId) {
        const existing = await billing.getByCustomerId(norm.stripeCustomerId);
        userId = existing?.userId;
      }
      if (!userId) {
        logger.warn({ subId: obj.id }, "[billing] subscription sem userId — ignorando");
        return;
      }
      await billing.update(userId, norm);
      return;
    }
    case "customer.subscription.deleted": {
      // Stripe envia quando assinatura é cancelada definitivamente (fim do período).
      const customerId = typeof obj.customer === "string" ? obj.customer : obj.customer?.id;
      const existing = customerId ? await billing.getByCustomerId(customerId) : null;
      if (existing) {
        await billing.update(existing.userId, {
          planId: "free",
          status: "canceled",
          cancelAtPeriodEnd: false,
          stripeSubscriptionId: null,
        });
      }
      return;
    }
    case "invoice.payment_succeeded":
    case "invoice.payment_failed":
      // Status do subscription já reflete em customer.subscription.updated;
      // só logamos pra observabilidade.
      logger.info({ type: event.type, invoice: obj.id }, "[billing] invoice event");
      return;
    default:
      // Ignora silenciosamente — Stripe manda muitos tipos.
      return;
  }
}

app.use(express.json({ limit: "2mb" }));

// Métricas Prometheus (Fase 4) — instrumenta TODOS os requests.
app.use(metrics.httpMiddleware);

// /metrics — texto plano formato Prometheus. Sem auth (é interno; em prod
// ficar atrás de allowlist no nginx/LB).
app.get("/metrics", metrics.handler);

// Rate limiters — protege endpoints sensíveis. Janelas em minutos.
// Confiamos em X-Forwarded-For atrás do nginx (trust proxy = 1 hop).
app.set("trust proxy", 1);

// Em testes (NODE_ENV=test) os limiters viram no-op pra não estourar registrando users.
const skipLimitInTests = () => process.env.NODE_ENV === "test";
const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipLimitInTests,
  message: { error: "Muitas tentativas de login. Aguarde 1 minuto." },
});
const registerLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipLimitInTests,
  message: { error: "Muitas tentativas de cadastro. Aguarde 1 minuto." },
});
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300, // generoso pra polling do frontend (state/ops a cada 30s × várias abas)
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipLimitInTests,
  message: { error: "Limite de requisições atingido. Aguarde 1 minuto." },
});
app.use("/api/", apiLimiter);

// ────────────────────────────────────────────────────────────────────────
// Health check — endpoint público pra load balancers / monitoring
// ────────────────────────────────────────────────────────────────────────

app.get("/healthz", async (req, res) => {
  const checks = {};
  let healthy = true;

  // Storage: tenta uma operação leve
  try {
    await storage.listAllUserIds();
    checks.storage = { ok: true, backend: "pg" };
  } catch (err) {
    healthy = false;
    checks.storage = { ok: false, backend: "pg", error: err.message };
  }

  // Scheduler: ticou recentemente?
  const sched = scheduler.status();
  checks.scheduler = sched;
  if (!sched.healthy && sched.running) healthy = false;

  // WhatsApp: contagem de sessões (não falha health se 0 — válido em deploy novo).
  // Em redis mode, lê do cache de session-status; em memory, lê direto da memória.
  try { checks.whatsapp = await wa.status(); } catch (err) { checks.whatsapp = { error: err.message }; }

  // Queue (Fase 2): backend + contagens. Falha health se redis configurado mas down.
  try {
    checks.queue = await queueMod.status();
    if (checks.queue && checks.queue.ok === false) healthy = false;
    // Atualiza gauges Prometheus (cardinalidade controlada)
    if (checks.queue?.send?.counts) {
      for (const [state, n] of Object.entries(checks.queue.send.counts)) {
        metrics.queueDepth.set({ queue: "send", state }, n);
      }
    }
    if (checks.queue?.control?.counts) {
      for (const [state, n] of Object.entries(checks.queue.control.counts)) {
        metrics.queueDepth.set({ queue: "control", state }, n);
      }
    }
  } catch (err) {
    healthy = false;
    checks.queue = { backend: queueMod.backendName(), ok: false, error: err.message };
  }

  // Worker heartbeat (Fase 4) — em redis mode, server lê do Redis
  if (queueMod.isRedis()) {
    try {
      const heartbeat = require("./infra/worker-heartbeat");
      const age = await heartbeat.ageSeconds();
      checks.worker = age == null ? { alive: false, ageSeconds: null } : { alive: age < 30, ageSeconds: age };
      metrics.workerHeartbeatAge.set(age ?? NaN);
      if (!checks.worker.alive) healthy = false;
    } catch (err) {
      checks.worker = { alive: false, error: err.message };
    }
  }

  // Admin scraper: status (informativo, não afeta health)
  checks.adminScraper = {
    running: adminScraper.status().running,
    lastRun: adminScraper.status().lastRun,
    lastError: adminScraper.status().lastError,
  };

  res.status(healthy ? 200 : 503).json({
    status: healthy ? "ok" : "degraded",
    uptime: Math.round(process.uptime()),
    checks,
  });
});

// ────────────────────────────────────────────────────────────────────────
// Auth
// ────────────────────────────────────────────────────────────────────────

app.post("/api/auth/register", registerLimiter, async (req, res) => {
  try {
    const { name, email, password } = req.body || {};
    const user = await auth.register({ name, email, password });
    // Trial automático de 7 dias do plano Pro — sem cartão. Idempotente.
    // Inicia já: quando o usuário verificar o email, o trial vai estar correndo.
    try { await billing.startTrialFor(user.id); }
    catch (err) { logger.warn({ err: err.message, userId: user.id }, "[billing] trial start falhou"); }
    // Sem token: usuário precisa verificar email antes de logar.
    res.json({ user, requiresVerification: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/auth/login", loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const result = await auth.login({ email, password });
    res.json(result);
  } catch (err) {
    // Distingue "email não verificado" (403 + code) de credencial errada (401).
    if (err.code === "email_not_verified") {
      return res.status(403).json({ error: err.message, code: "email_not_verified" });
    }
    res.status(401).json({ error: err.message });
  }
});

// Confirma email a partir do token enviado por email. Devolve token JWT
// pra auto-login na sequência.
app.post("/api/auth/verify-email", loginLimiter, async (req, res) => {
  try {
    const { token } = req.body || {};
    const result = await auth.verifyEmail({ token });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Reenvia email de verificação. Sempre devolve ok (não revela se conta existe).
// Exceção: resend_cooldown (429) revela que a conta existe, mas o usuário já sabe disso.
app.post("/api/auth/resend-verification", registerLimiter, async (req, res) => {
  try {
    const { email } = req.body || {};
    const result = await auth.resendVerification({ email });
    res.json(result);
  } catch (err) {
    if (err.code === "resend_cooldown") {
      return res.status(429).json({ error: err.message, code: "resend_cooldown", retryAfterSeconds: err.retryAfterSeconds });
    }
    res.status(400).json({ error: err.message });
  }
});

// Solicita reset de senha. Sempre devolve ok (não revela se conta existe).
app.post("/api/auth/forgot-password", registerLimiter, async (req, res) => {
  try {
    const { email } = req.body || {};
    const result = await auth.requestPasswordReset({ email });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Aplica nova senha a partir de token de reset. Auto-login.
app.post("/api/auth/reset-password", loginLimiter, async (req, res) => {
  try {
    const { token, newPassword } = req.body || {};
    const result = await auth.resetPassword({ token, newPassword });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Login via Google Identity Services. Frontend recebe um ID token do GIS
// e POSTa aqui. Backend valida com Google e cria/loga o usuário.
// Se for criação nova, inicia trial automático de 7 dias (mesmo fluxo do register).
app.post("/api/auth/google", loginLimiter, async (req, res) => {
  try {
    const { idToken, credential } = req.body || {};
    const result = await auth.loginWithGoogle({ idToken: idToken || credential });
    if (result.created) {
      try { await billing.startTrialFor(result.user.id); }
      catch (err) { logger.warn({ err: err.message, userId: result.user.id }, "[billing] trial start falhou"); }
    }
    res.json({ token: result.token, user: result.user });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

app.get("/api/auth/me", auth.requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// Renova o token de sessão (sliding session por inatividade). O frontend chama
// isso enquanto há atividade do usuário — com throttle — para deslizar a janela.
// Se o usuário ficar ocioso, para de renovar e o token vence sozinho.
app.post("/api/auth/refresh", auth.requireAuth, (req, res) => {
  res.json({ token: auth.reissueToken(req.user) });
});

app.patch("/api/auth/me", auth.requireAuth, async (req, res) => {
  try {
    const user = await auth.updateProfile(req.user.id, req.body || {});
    res.json({ user });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/auth/password", auth.requireAuth, async (req, res) => {
  try {
    await auth.changePassword(req.user.id, req.body || {});
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────────────────────
// Persistência de estado da app por usuário
// ────────────────────────────────────────────────────────────────────────

app.get("/api/state", auth.requireAuth, async (req, res) => {
  try {
    res.json(await storage.loadState(req.user.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/state", auth.requireAuth, async (req, res) => {
  try {
    // Plan-gating — bloqueia se contagens excedem limites do plano efetivo.
    // Admin passa direto. Mensagens explícitas pra UI sugerir upgrade.
    const incoming = req.body || {};
    if (req.user.role !== "admin") {
      const sub = await billing.getByUserId(req.user.id);
      const planLimits = billing.limits.getLimits(sub, req.user.role);

      const incomingGroups = Array.isArray(incoming.groups) ? incoming.groups : [];
      const incomingNumbers = Array.isArray(incoming.numbers) ? incoming.numbers : [];

      const checks = [
        billing.limits.checkLimit(sub, "groups", incomingGroups.length, req.user.role),
        billing.limits.checkLimit(sub, "numbers", incomingNumbers.length, req.user.role),
      ];
      // categoriesPerGroup — qualquer grupo que exceda é bloqueio.
      const worstCats = incomingGroups.reduce((max, g) => {
        const n = Array.isArray(g.categories) ? g.categories.length : 0;
        return n > max ? n : max;
      }, 0);
      if (worstCats > 0) {
        checks.push(billing.limits.checkLimit(sub, "categoriesPerGroup", worstCats, req.user.role));
      }
      // whatsappGroupsPerCampaign — qualquer campanha com mais grupos do WA que o limite bloqueia.
      const worstWaGroups = incomingGroups.reduce((max, g) => {
        const n = Array.isArray(g.whatsappGroupIds) ? g.whatsappGroupIds.length : 0;
        return n > max ? n : max;
      }, 0);
      if (worstWaGroups > 0) {
        checks.push(billing.limits.checkLimit(sub, "whatsappGroupsPerCampaign", worstWaGroups, req.user.role));
      }
      // autoScraping — bloqueia se algum grupo tem scraping.auto=true e plano não permite.
      if (!planLimits.autoScraping) {
        const usesAuto = incomingGroups.some(g => g?.scraping?.auto === true);
        if (usesAuto) {
          return res.status(402).json({
            error: "Scraping automático não disponível no plano atual",
            planRequired: "pro",
          });
        }
      }

      const failed = checks.find(c => !c.ok);
      if (failed) return res.status(402).json(failed);
    }

    const saved = await storage.saveState(req.user.id, incoming);
    res.json({ ok: true, updatedAt: saved.updatedAt });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/state/ops", auth.requireAuth, async (req, res) => {
  try {
    res.json(await storage.loadOps(req.user.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────────────────────
// Billing (Stripe)
// ────────────────────────────────────────────────────────────────────────

// Status atual da assinatura do usuário — usado pelo frontend pra renderizar
// plano ativo, limites, dias restantes do trial e badges past_due.
app.get("/api/billing/me", auth.requireAuth, async (req, res) => {
  try {
    const status = await billing.getStatus(req.user.id, req.user.role);
    res.json({ ...status, stripeEnabled: stripeMod.enabled() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cria Checkout Session pra um plano. Body: { planId }.
// Responde { url } — frontend faz window.location.assign(url).
app.post("/api/billing/checkout", auth.requireAuth, async (req, res) => {
  try {
    if (!stripeMod.enabled()) return res.status(501).json({ error: "Stripe não configurado" });
    const planId = String(req.body?.planId || "").trim();
    if (!["basic", "pro", "business"].includes(planId)) {
      return res.status(400).json({ error: "planId inválido" });
    }
    if (!stripeMod.priceFor(planId)) {
      return res.status(500).json({ error: `Price ID do plano "${planId}" não configurado no servidor` });
    }

    // Garante sub existente; pega customer se já tem.
    const sub = await billing.ensureForUser(req.user.id, { planId: "free", status: "inactive" });
    const customer = await stripeMod.getOrCreateCustomer({
      userId: req.user.id,
      email: req.user.email,
      name: req.user.name,
      existingCustomerId: sub.stripeCustomerId,
    });

    // Persiste customerId se ainda não estava linkado.
    if (!sub.stripeCustomerId) {
      await billing.update(req.user.id, { stripeCustomerId: customer.id });
    }

    const session = await stripeMod.createCheckoutSession({
      planId,
      customer,
      userId: req.user.id,
    });
    metrics.recordCheckout?.(planId, "ok");
    res.json({ url: session.url });
  } catch (err) {
    metrics.recordCheckout?.(String(req.body?.planId || "unknown"), "error");
    logger.error({ err: err.message }, "[billing] checkout falhou");
    res.status(500).json({ error: err.message });
  }
});

// Customer Portal — alterar cartão / cancelar / ver faturas. Precisa customer
// existente, então user só consegue acessar depois do primeiro checkout.
app.post("/api/billing/portal", auth.requireAuth, async (req, res) => {
  try {
    if (!stripeMod.enabled()) return res.status(501).json({ error: "Stripe não configurado" });
    const sub = await billing.getByUserId(req.user.id);
    if (!sub?.stripeCustomerId) {
      return res.status(400).json({ error: "Sem customer Stripe — assine um plano primeiro" });
    }
    const session = await stripeMod.createPortalSession({ customer: { id: sub.stripeCustomerId } });
    res.json({ url: session.url });
  } catch (err) {
    logger.error({ err: err.message }, "[billing] portal falhou");
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────────────────────
// Afiliados ML
// ────────────────────────────────────────────────────────────────────────

app.get("/api/affiliate", auth.requireAuth, (req, res) => {
  res.json(affiliate.status(req.user.id));
});

app.put("/api/affiliate", auth.requireAuth, (req, res) => {
  try {
    const { tag, cookie } = req.body || {};
    affiliate.writeConfig(req.user.id, { tag, cookie });
    res.json(affiliate.status(req.user.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/affiliate", auth.requireAuth, (req, res) => {
  try {
    affiliate.clearConfig(req.user.id);
    res.json(affiliate.status(req.user.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/affiliate/test", auth.requireAuth, async (req, res) => {
  try {
    const url = req.body?.url;
    if (!url || typeof url !== "string" || !url.trim()) {
      return res.status(400).json({ error: "Forneça uma URL de produto do Mercado Livre pra testar." });
    }
    const short = await affiliate.gerarLinkAfiliadoML(req.user.id, url.trim());
    if (!short) {
      const s = affiliate.status(req.user.id);
      const reason = s.lastFailureReason || "Falha ao gerar link";
      return res.status(400).json({ error: reason, cookieHealthy: !!s.healthy });
    }
    res.json({ ok: true, shortUrl: short });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Afiliado Amazon ───────────────────────────────────────────────────

app.put("/api/affiliate/amazon", auth.requireAuth, (req, res) => {
  try {
    const { tag } = req.body || {};
    affiliate.writeAmazonConfig(req.user.id, { tag });
    res.json(affiliate.status(req.user.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/affiliate/amazon", auth.requireAuth, (req, res) => {
  try {
    affiliate.clearAmazonConfig(req.user.id);
    res.json(affiliate.status(req.user.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/affiliate/amazon/test", auth.requireAuth, (req, res) => {
  try {
    const url = req.body?.url;
    if (!url || typeof url !== "string" || !url.trim()) {
      return res.status(400).json({ error: "Forneça uma URL de produto da Amazon pra testar." });
    }
    const short = affiliate.gerarLinkAfiliadoAmazon(req.user.id, url.trim());
    if (!short) {
      const s = affiliate.status(req.user.id);
      const reason = s.amazon.lastFailureReason
        || (!s.amazon.configured ? "Configure a tag de afiliado da Amazon primeiro." : "Falha ao gerar link");
      return res.status(400).json({ error: reason });
    }
    res.json({ ok: true, shortUrl: short });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Afiliado Shopee ───────────────────────────────────────────────────

app.put("/api/affiliate/shopee", auth.requireAuth, (req, res) => {
  try {
    const { appId, appSecret } = req.body || {};
    affiliate.writeShopeeConfig(req.user.id, { appId, appSecret });
    res.json(affiliate.status(req.user.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/affiliate/shopee", auth.requireAuth, (req, res) => {
  try {
    affiliate.clearShopeeConfig(req.user.id);
    res.json(affiliate.status(req.user.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/affiliate/shopee/test", auth.requireAuth, async (req, res) => {
  try {
    const url = req.body?.url;
    if (!url || typeof url !== "string" || !url.trim()) {
      return res.status(400).json({ error: "Forneça uma URL de produto da Shopee pra testar." });
    }
    const short = await affiliate.gerarLinkAfiliadoShopee(req.user.id, url.trim());
    if (!short) {
      const s = affiliate.status(req.user.id);
      const reason = s.shopee.lastFailureReason
        || (!s.shopee.configured ? "Configure App ID e App Secret da Shopee primeiro." : "Falha ao gerar link");
      return res.status(400).json({ error: reason });
    }
    res.json({ ok: true, shortUrl: short });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Dispara envio do próximo item da fila imediatamente
app.post("/api/state/groups/:gid/send-now", auth.requireAuth, async (req, res) => {
  try {
    const groupId = isNaN(Number(req.params.gid)) ? req.params.gid : Number(req.params.gid);
    const r = await scheduler.sendNextNow(req.user.id, groupId);
    res.json({ ok: true, ...r });
  } catch (err) {
    console.error("[send-now]", err.message);
    res.status(400).json({ error: err.message });
  }
});

// Aprovar item pendente: move de pending pra queue (final).
app.post("/api/state/groups/:gid/pending/:pid/approve", auth.requireAuth, async (req, res) => {
  try {
    const groupId = isNaN(Number(req.params.gid)) ? req.params.gid : Number(req.params.gid);
    const pid = req.params.pid;
    const state = await storage.loadState(req.user.id);
    const group = (state.groups || []).find(g => g.id === groupId);
    if (!group) return res.status(404).json({ error: "Campanha não encontrada" });
    const idx = (group.pending || []).findIndex(p => String(p.id ?? p.key) === String(pid));
    if (idx < 0) return res.status(404).json({ error: "Item pendente não encontrado" });
    const item = group.pending[idx];
    const newPending = group.pending.filter((_, i) => i !== idx);
    const newQueue = [...(group.queue || []), item];
    await storage.updateGroupOps(req.user.id, groupId, { pending: newPending, queue: newQueue });
    res.json({ ok: true, queueSize: newQueue.length, pendingSize: newPending.length });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Rejeitar item pendente: remove de pending.
app.delete("/api/state/groups/:gid/pending/:pid", auth.requireAuth, async (req, res) => {
  try {
    const groupId = isNaN(Number(req.params.gid)) ? req.params.gid : Number(req.params.gid);
    const pid = req.params.pid;
    const state = await storage.loadState(req.user.id);
    const group = (state.groups || []).find(g => g.id === groupId);
    if (!group) return res.status(404).json({ error: "Campanha não encontrada" });
    const newPending = (group.pending || []).filter(p => String(p.id ?? p.key) !== String(pid));
    if (newPending.length === (group.pending || []).length) {
      return res.status(404).json({ error: "Item pendente não encontrado" });
    }
    await storage.updateGroupOps(req.user.id, groupId, { pending: newPending });
    res.json({ ok: true, pendingSize: newPending.length });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Aprovar TODOS os pendentes de uma vez: move tudo pra queue numa única escrita.
// Evita o race de disparar N aprovações em paralelo (cada uma fazia replace-all
// do pending/queue, colidindo no unique [groupId, productKey]).
app.post("/api/state/groups/:gid/pending/approve-all", auth.requireAuth, async (req, res) => {
  try {
    const groupId = isNaN(Number(req.params.gid)) ? req.params.gid : Number(req.params.gid);
    const state = await storage.loadState(req.user.id);
    const group = (state.groups || []).find(g => g.id === groupId);
    if (!group) return res.status(404).json({ error: "Campanha não encontrada" });
    const newQueue = [...(group.queue || []), ...(group.pending || [])];
    await storage.updateGroupOps(req.user.id, groupId, { pending: [], queue: newQueue });
    res.json({ ok: true, queueSize: newQueue.length, pendingSize: 0 });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Rejeitar TODOS os pendentes de uma vez: limpa o pending numa única escrita.
app.delete("/api/state/groups/:gid/pending", auth.requireAuth, async (req, res) => {
  try {
    const groupId = isNaN(Number(req.params.gid)) ? req.params.gid : Number(req.params.gid);
    const updated = await storage.updateGroupOps(req.user.id, groupId, { pending: [] });
    if (!updated) return res.status(404).json({ error: "Campanha não encontrada" });
    res.json({ ok: true, pendingSize: 0 });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Persiste a fila reordenada/editada pela UI (drag-and-drop, remoção de item).
// A ordem e a composição da fila vivem na tabela de ops (groupQueueItem.position),
// que o PUT /api/state (saveState) NÃO grava — sem esta rota o poll de ops
// (GET /api/state/ops, ordenado por position asc) reverteria qualquer mudança
// local em segundos. updateGroupOps faz replace-all regravando as posições na
// ordem do array recebido.
app.put("/api/state/groups/:gid/queue", auth.requireAuth, async (req, res) => {
  try {
    const groupId = isNaN(Number(req.params.gid)) ? req.params.gid : Number(req.params.gid);
    const queue = Array.isArray(req.body?.queue) ? req.body.queue : null;
    if (!queue) return res.status(400).json({ error: "queue deve ser uma lista" });
    const updated = await storage.updateGroupOps(req.user.id, groupId, { queue });
    if (!updated) return res.status(404).json({ error: "Campanha não encontrada" });
    res.json({ ok: true, queue: updated.queue });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Limpa a fila de envios da campanha
app.delete("/api/state/groups/:gid/queue", auth.requireAuth, async (req, res) => {
  try {
    const groupId = isNaN(Number(req.params.gid)) ? req.params.gid : Number(req.params.gid);
    const updated = await storage.updateGroupOps(req.user.id, groupId, { queue: [] });
    if (!updated) return res.status(404).json({ error: "Campanha não encontrada" });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/state/groups/:gid/history", auth.requireAuth, async (req, res) => {
  try {
    const groupId = isNaN(Number(req.params.gid)) ? req.params.gid : Number(req.params.gid);
    const updated = await storage.updateGroupOps(req.user.id, groupId, {
      history: [],
      sentToday: 0,
      sentWeek: 0,
      weekData: [0, 0, 0, 0, 0, 0, 0],
      lastSend: "—",
    });
    if (!updated) return res.status(404).json({ error: "Campanha não encontrada" });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Busca metadados de uma URL única (Puppeteer) — usado pelo "Adicionar link".
// Não bloqueia em erro: devolve campos null pra UI deixar editar manualmente.
app.post("/api/scraper/fetch-url", auth.requireAuth, async (req, res) => {
  try {
    const url = req.body?.url;
    if (!url || typeof url !== "string" || !url.trim()) {
      return res.status(400).json({ error: "URL obrigatória" });
    }
    const data = await scrapeSingleProduct(url.trim(), { userId: req.user.id });
    res.json(data);
  } catch (err) {
    console.error("[fetch-url]", err.message);
    res.status(400).json({ error: err.message });
  }
});

// Adiciona um produto manualmente à fila/pending da campanha.
// Body: { url, overrides: { name, price, originalPrice, discount, img, store, category }, force? }
// Resposta:
//  - { ok: true, target, item, ... } quando adicionado
//  - { inCooldown: true, lastSentAt, cooldownMinutes, cooldownLabel } pedindo confirmação (UI manda force=true depois)
//  - 400 com error em duplicata na fila/pending ou validação
app.post("/api/state/groups/:gid/manual-add", auth.requireAuth, async (req, res) => {
  try {
    const groupId = isNaN(Number(req.params.gid)) ? req.params.gid : Number(req.params.gid);
    const r = await scheduler.manualAdd(req.user.id, groupId, req.body || {});
    res.json(r);
  } catch (err) {
    const status = err.code === "duplicate_queue" || err.code === "duplicate_pending" ? 409 : 400;
    res.status(status).json({ error: err.message, code: err.code || null });
  }
});

// Força refill da fila a partir do catálogo (aplica filtros da campanha).
// Aceita body opcional { filters, sources, categories } com overrides ainda não persistidos.
app.post("/api/state/groups/:gid/refill", auth.requireAuth, async (req, res) => {
  try {
    const groupId = isNaN(Number(req.params.gid)) ? req.params.gid : Number(req.params.gid);
    const r = await scheduler.refillNow(req.user.id, groupId, req.body || {});
    res.json({ ok: true, ...r });
  } catch (err) {
    console.error("[refill]", err.message);
    res.status(400).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────────────────────
// Ofertas — agora lê do CATÁLOGO global (preenchido pelo admin-scraper)
// ────────────────────────────────────────────────────────────────────────

app.get("/api/ofertas", auth.requireAuth, async (req, res) => {
  try {
    const category = req.query.category || null;
    const minDiscount = parseInt(req.query.minDiscount) || 0;
    const minPrice = parseFloat(req.query.minPrice) || 0;
    const maxPrice = parseFloat(req.query.maxPrice) || Infinity;
    const limit = parseInt(req.query.limit) || 50;
    const sources = req.query.sources
      ? String(req.query.sources).split(",").map(s => s.trim()).filter(Boolean)
      : null;

    const [products, catalogStats] = await Promise.all([
      catalog.query({
        categories: category ? [category] : null,
        sources,
        filters: { minDiscount, minPrice, maxPrice },
        limit,
        sortBy: "discount_desc",
      }),
      catalog.getStats(),
    ]);

    res.json({
      total: products.length,
      category,
      sources,
      products,
      catalogStats,
    });
  } catch (err) {
    console.error("[ofertas] Erro:", err.message);
    res.status(500).json({ error: "Falha ao buscar ofertas", details: err.message });
  }
});

app.get("/api/categories", (req, res) => {
  const cats = Object.entries(CATEGORIES).map(([id, info]) => ({ id, label: info.label }));
  res.json(cats);
});

app.get("/api/status", async (req, res) => {
  try {
    const s = await catalog.getStats();
    res.json({
      status: "ok",
      categories: Object.keys(CATEGORIES),
      catalog: s,
      adminScraper: adminScraper.status(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────────────────────
// Admin — gerenciamento de usuários
// ────────────────────────────────────────────────────────────────────────

app.get("/api/admin/users", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    res.json({ users: await auth.listUsers() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/admin/users/:id", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    if (req.params.id === req.user.id) {
      return res.status(400).json({ error: "Você não pode excluir a si mesmo" });
    }
    await auth.deleteUser(req.params.id);
    await storage.clearState(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch("/api/admin/users/:id/password", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const { newPassword } = req.body || {};
    await auth.adminSetPassword(req.params.id, newPassword);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch("/api/admin/users/:id/role", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const { role } = req.body || {};
    if (req.params.id === req.user.id && role !== "admin") {
      return res.status(400).json({ error: "Você não pode rebaixar a si mesmo" });
    }
    const user = await auth.setUserRole(req.params.id, role);
    res.json({ user });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch("/api/admin/users/:id/verify-email", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const user = await auth.adminVerifyEmail(req.params.id);
    res.json({ user });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch("/api/admin/users/:id/suspend", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    if (req.params.id === req.user.id) {
      return res.status(400).json({ error: "Você não pode suspender a si mesmo" });
    }
    const { suspended } = req.body || {};
    const user = await auth.adminSetSuspended(req.params.id, !!suspended);
    res.json({ user });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/admin/users/:id/resend-verification", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const result = await auth.adminResendVerification(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────────────────────
// Admin — Backups
// ────────────────────────────────────────────────────────────────────────

app.get("/api/admin/backups/local", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const items = await backupApi.listLocal();
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/admin/backups/remote", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const result = await backupApi.listRemote();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cria novo dump local (pode demorar ~10-30s)
app.post("/api/admin/backups/local", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const info = await backupApi.createLocalDump();
    res.json({ ok: true, backup: { name: info.name, size: info.size } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Envia backup local para o Backblaze
app.post("/api/admin/backups/push", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const { filename } = req.body || {};
    if (!filename) return res.status(400).json({ error: "filename obrigatório" });
    await backupApi.uploadToRemote(filename);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Restaura banco a partir de backup local ou remoto (operação bloqueante ~10-60s)
app.post("/api/admin/backups/restore", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  const { source, filename } = req.body || {};
  if (!source || !filename) return res.status(400).json({ error: "source e filename obrigatórios" });
  if (source !== "local" && source !== "remote") return res.status(400).json({ error: "source inválido" });
  try {
    const { disconnect } = require("./db");
    await disconnect(); // libera conexões Prisma antes de dropar o banco
    if (source === "local") await backupApi.restoreLocal(filename);
    else await backupApi.restoreRemote(filename);

    res.json({ ok: true, message: "Banco restaurado. Backend reiniciando..." });

    // Reinicia o processo via PM2 após enviar a resposta
    setTimeout(() => {
      try { require("child_process").execSync("pm2 restart nimbus-backend nimbus-worker", { stdio: "ignore" }); }
      catch {}
    }, 1500);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/admin/backups/local/:filename", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    await backupApi.deleteLocal(req.params.filename);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/admin/backups/remote/:filename", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    await backupApi.deleteRemote(req.params.filename);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────────────────────
// Admin — scraper global e catálogo
// ────────────────────────────────────────────────────────────────────────

app.get("/api/admin/scraper/config", auth.requireAuth, auth.requireAdmin, (req, res) => {
  res.json({
    config: adminScraper.readConfig(),
    available: {
      categories: Object.entries(CATEGORIES).map(([id, info]) => ({ id, label: info.label })),
      sources: Object.entries(STORES).map(([id, info]) => ({ id, label: info.label })),
    },
  });
});

app.put("/api/admin/scraper/config", auth.requireAuth, auth.requireAdmin, (req, res) => {
  try {
    const cfg = adminScraper.writeConfig(req.body || {});
    res.json({ config: cfg });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/admin/scraper/run", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    if (adminScraper.status().running) {
      return res.status(409).json({ error: "Scraping já em execução" });
    }
    // Não bloqueia a resposta — roda em background
    adminScraper.runOnce().catch(err => console.error("[admin-scraper.run]", err.message));
    res.json({ ok: true, message: "Scraping iniciado em background" });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/admin/scraper/cancel", auth.requireAuth, auth.requireAdmin, (req, res) => {
  const r = adminScraper.cancel();
  if (!r.ok) return res.status(409).json({ error: r.message });
  res.json(r);
});

app.get("/api/admin/scraper/status", auth.requireAuth, auth.requireAdmin, (req, res) => {
  res.json(adminScraper.status());
});

// Credenciais Shopee globais (usadas pelo admin-scraper).
// Override per-user fica intacto; isso aqui sobrescreve só o fallback do scraper.
app.get("/api/admin/scraper/shopee", auth.requireAuth, auth.requireAdmin, (req, res) => {
  const admin = affiliate.readScraperShopeeAdminCreds();
  const active = affiliate.getScraperShopeeCreds();
  res.json({
    admin: {
      configured: !!(admin.appId && admin.appSecret),
      appId: admin.appId,
      appSecretPreview: admin.appSecret ? admin.appSecret.slice(0, 6) + "…" : null,
      updatedAt: admin.updatedAt,
    },
    active: active ? {
      appId: active.appId,
      appSecretPreview: active.appSecret ? active.appSecret.slice(0, 6) + "…" : null,
      source: active.source, // "env" | "admin" | "user-fallback"
    } : null,
  });
});

app.put("/api/admin/scraper/shopee", auth.requireAuth, auth.requireAdmin, (req, res) => {
  try {
    const { appId, appSecret } = req.body || {};
    const saved = affiliate.writeScraperShopeeAdminCreds({ appId, appSecret });
    res.json({
      ok: true,
      admin: {
        configured: !!(saved.appId && saved.appSecret),
        appId: saved.appId,
        appSecretPreview: saved.appSecret ? saved.appSecret.slice(0, 6) + "…" : null,
        updatedAt: saved.updatedAt,
      },
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/admin/scraper/shopee", auth.requireAuth, auth.requireAdmin, (req, res) => {
  affiliate.clearScraperShopeeAdminCreds();
  res.json({ ok: true });
});

// Filtros de qualidade aplicados pelo scraper Shopee (rating min, vendas min, etc).
app.get("/api/admin/scraper/shopee/filters", auth.requireAuth, auth.requireAdmin, (req, res) => {
  res.json({ filters: affiliate.readShopeeScraperFilters(), defaults: affiliate.SHOPEE_FILTERS_DEFAULTS });
});

app.put("/api/admin/scraper/shopee/filters", auth.requireAuth, auth.requireAdmin, (req, res) => {
  try {
    const saved = affiliate.writeShopeeScraperFilters(req.body || {});
    res.json({ ok: true, filters: saved });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Filtros de qualidade do Mercado Livre (admin-only)
app.get("/api/admin/scraper/ml/filters", auth.requireAuth, auth.requireAdmin, (req, res) => {
  res.json({ filters: affiliate.readMLScraperFilters(), defaults: affiliate.ML_FILTERS_DEFAULTS });
});

app.put("/api/admin/scraper/ml/filters", auth.requireAuth, auth.requireAdmin, (req, res) => {
  try {
    const saved = affiliate.writeMLScraperFilters(req.body || {});
    res.json({ ok: true, filters: saved });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Filtros de qualidade da Amazon (admin-only)
app.get("/api/admin/scraper/amazon/filters", auth.requireAuth, auth.requireAdmin, (req, res) => {
  res.json({ filters: affiliate.readAmazonScraperFilters(), defaults: affiliate.AMAZON_FILTERS_DEFAULTS });
});

app.put("/api/admin/scraper/amazon/filters", auth.requireAuth, auth.requireAdmin, (req, res) => {
  try {
    const saved = affiliate.writeAmazonScraperFilters(req.body || {});
    res.json({ ok: true, filters: saved });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Testa as credenciais admin gerando um shortlink — mesma rota de teste do affiliate,
// mas usando explicitamente as creds do admin (sem cair em env nem user fallback).
app.post("/api/admin/scraper/shopee/test", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const url = String(req.body?.url || "").trim();
    if (!url) return res.status(400).json({ error: "Cole uma URL de produto da Shopee." });
    if (!/shopee\.com\.br|s\.shopee\./i.test(url)) {
      return res.status(400).json({ error: "URL inválida — precisa ser de shopee.com.br." });
    }
    const admin = affiliate.readScraperShopeeAdminCreds();
    if (!admin.appId || !admin.appSecret) {
      return res.status(400).json({ error: "Configure App ID e App Secret antes de testar." });
    }
    // Usa o fetcher de oferta com creds explícitas, ou gera um shortlink direto.
    // Reaproveita gerarLinkAfiliadoShopee criando um userId-token de teste isolado.
    // Mas o caminho mais direto é montar a chamada aqui — porém isso duplicaria.
    // Truque: monkey-patch temporário via env (não — feio). Melhor: chamar direto
    // via os helpers internos. Vou usar uma rota auxiliar exposta.
    const { signShopeeRequest, buildShopeeShortLinkPayload } = affiliate;
    const timestamp = Math.floor(Date.now() / 1000);
    const payload = buildShopeeShortLinkPayload(url);
    const authHeader = signShopeeRequest({
      appId: admin.appId, appSecret: admin.appSecret, timestamp, payload,
    });
    const r = await fetch("https://open-api.affiliate.shopee.com.br/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": authHeader },
      body: payload,
    });
    if (!r.ok) return res.status(502).json({ error: `Shopee HTTP ${r.status} — confira App ID/Secret` });
    const data = await r.json();
    if (data?.errors?.length) {
      return res.status(502).json({ error: `Shopee API: ${data.errors[0]?.message || "erro"}` });
    }
    const short = data?.data?.generateShortLink?.shortLink || null;
    if (!short) return res.status(502).json({ error: "Sem shortLink na resposta — URL pode não ser de produto válido." });
    res.json({ ok: true, shortUrl: short });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Lista paginada do catálogo, com filtros opcionais — visualização do admin
app.get("/api/admin/catalog", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(10, parseInt(req.query.pageSize) || 50));
    const category = req.query.category || null;
    const source = req.query.source || null;
    const search = (req.query.q || "").toString().trim().toLowerCase();
    const sortBy = req.query.sortBy || "lastSeen_desc";

    let items = await catalog.query({
      categories: category ? [category] : null,
      sources: source ? [source] : null,
      limit: 0,
      sortBy,
    });
    if (search) items = items.filter(p => (p.name || "").toLowerCase().includes(search));

    const total = items.length;
    const start = (page - 1) * pageSize;
    const slice = items.slice(start, start + pageSize);
    res.json({
      page,
      pageSize,
      total,
      items: slice,
      stats: await catalog.getStats(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Apaga TODOS os produtos do catálogo de uma vez (botão "Apagar todos").
app.delete("/api/admin/catalog", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const r = await catalog.clearAll();
    res.json({ ok: true, removed: r.removed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────────────────────
// Admin — fila DLQ (envios que falharam definitivamente)
// ────────────────────────────────────────────────────────────────────────

app.get("/api/admin/queue/failed", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    if (!queueMod.isRedis()) return res.json({ items: [], note: "queue=memory; sem DLQ" });
    const queue = req.query.queue === "control" ? "control" : "send";
    const start = Math.max(0, parseInt(req.query.start) || 0);
    const end = Math.min(start + 199, parseInt(req.query.end) || (start + 49));
    const items = await queueMod.listFailed({ queue, start, end });
    res.json({ queue, start, end, items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/admin/queue/failed/:id/retry", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const queue = req.body?.queue === "control" ? "control" : "send";
    const r = await queueMod.retryFailed(req.params.id, { queue });
    res.json(r);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/admin/queue/failed/:id", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const queue = req.query.queue === "control" ? "control" : "send";
    const r = await queueMod.removeFailed(req.params.id, { queue });
    res.json(r);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────────────────────
// Admin — Notificações WhatsApp
// ────────────────────────────────────────────────────────────────────────

app.get("/api/admin/notifications/config", auth.requireAuth, auth.requireAdmin, (req, res) => {
  res.json(adminNotifier.readConfig());
});

app.put("/api/admin/notifications/config", auth.requireAuth, auth.requireAdmin, (req, res) => {
  try {
    const body = req.body || {};
    // userId é sempre sobrescrito pelo usuário logado — garante que a sessão WA pertence ao admin
    const saved = adminNotifier.writeConfig({ ...body, userId: req.user.id });
    res.json({ ok: true, config: saved });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/admin/notifications/test", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    await adminNotifier.sendTest();
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});


// ────────────────────────────────────────────────────────────────────────
// Admin — WhatsNimbus (o WhatsApp dedicado do sistema, remetente das
// notificações pros usuários). Sessão sob userId sintético (whatsnimbus.js).
// ────────────────────────────────────────────────────────────────────────

async function whatsNimbusSnapshot() {
  const cfg = whatsnimbus.readConfig();
  let session = null;
  if (cfg.numberId) {
    try { session = await wa.getSession(whatsnimbus.WHATSNIMBUS_USER_ID, cfg.numberId); } catch { /* ignore */ }
  }
  return {
    numberId: cfg.numberId,
    phone: cfg.phone,
    name: cfg.name,
    connectedAt: cfg.connectedAt,
    status: session?.status || (cfg.numberId ? "disconnected" : "idle"),
    qr: session?.qrDataUrl || null,
    info: session?.info || null,
    lastError: session?.lastError || null,
  };
}

app.get("/api/admin/whatsnimbus", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    res.json(await whatsNimbusSnapshot());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Inicia (ou retoma) a sessão do WhatsNimbus. Cria um numberId provisório na
// primeira conexão; após o scan o frontend chama /finalize com o telefone.
app.post("/api/admin/whatsnimbus/connect", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    let cfg = whatsnimbus.readConfig();
    if (!cfg.numberId) {
      cfg = whatsnimbus.writeConfig({ numberId: `wn-${Date.now()}`, phone: null, name: null, connectedAt: null });
    }
    await wa.startSession(whatsnimbus.WHATSNIMBUS_USER_ID, cfg.numberId);
    res.json(await whatsNimbusSnapshot());
  } catch (err) {
    console.error("[whatsnimbus] connect:", err);
    res.status(500).json({ error: err.message });
  }
});

// Chamado pelo frontend quando a sessão conecta: fixa o numberId canônico
// (= telefone), pra config apontar pra mesma sessão que o local.js canonicaliza.
app.post("/api/admin/whatsnimbus/finalize", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const { phone, name } = req.body || {};
    if (!phone) return res.status(400).json({ error: "phone obrigatório" });
    const canonical = wa.normalizePhone(phone);
    whatsnimbus.writeConfig({ numberId: canonical, phone: canonical, name: name || null, connectedAt: new Date().toISOString() });
    res.json(await whatsNimbusSnapshot());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/admin/whatsnimbus/disconnect", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const cfg = whatsnimbus.readConfig();
    if (cfg.numberId) {
      try { await wa.deleteSession(whatsnimbus.WHATSNIMBUS_USER_ID, cfg.numberId); } catch { /* ignore */ }
    }
    whatsnimbus.clearConfig();
    res.json(await whatsNimbusSnapshot());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ────────────────────────────────────────────────────────────────────────
// WhatsApp (Baileys)
// ────────────────────────────────────────────────────────────────────────

app.get("/api/whatsapp/sessions", auth.requireAuth, async (req, res) => {
  try {
    res.json(await wa.listSessions(req.user.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/whatsapp/sessions/:id", auth.requireAuth, async (req, res) => {
  try {
    // Plan-gating — número novo conta contra limite `numbers`. Sessão já existente
    // (reconect) passa direto pq não estoura contagem.
    if (req.user.role !== "admin") {
      const existing = await wa.listSessions?.(req.user.id);
      const isNew = !(existing || []).some(s => s.numberId === req.params.id || s.id === req.params.id);
      if (isNew) {
        const sub = await billing.getByUserId(req.user.id);
        const count = (existing || []).length + 1;
        const check = billing.limits.checkLimit(sub, "numbers", count, req.user.role);
        if (!check.ok) return res.status(402).json(check);
      }
    }
    await wa.startSession(req.user.id, req.params.id);
    const s = await wa.getSession(req.user.id, req.params.id);
    res.json({ ok: true, id: req.params.id, status: s?.status });
  } catch (err) {
    console.error("[whatsapp] startSession:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/whatsapp/sessions/:id", auth.requireAuth, async (req, res) => {
  try {
    const s = await wa.getSession(req.user.id, req.params.id);
    if (!s) return res.status(404).json({ error: "Sessão não encontrada" });
    res.json({
      id: s.numberId,
      status: s.status,
      qr: s.qrDataUrl || null,
      info: s.info || null,
      lastError: s.lastError || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/whatsapp/sessions/:id", auth.requireAuth, async (req, res) => {
  try {
    await wa.deleteSession(req.user.id, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/whatsapp/sessions/:id/groups", auth.requireAuth, async (req, res) => {
  try {
    const groups = await wa.listGroups(req.user.id, req.params.id);
    res.json(groups);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Disponibilidade do WhatsNimbus pra o fluxo de criação de grupo (não-admin):
// permite usar o número do sistema como o participante extra que o WhatsApp exige.
app.get("/api/whatsnimbus/available", auth.requireAuth, async (req, res) => {
  try {
    const cfg = whatsnimbus.readConfig();
    let connected = false, phone = null;
    if (cfg.numberId) {
      const s = await wa.getSession(whatsnimbus.WHATSNIMBUS_USER_ID, cfg.numberId);
      connected = s?.status === "connected";
      if (connected) phone = cfg.phone || s?.info?.phone || null;
    }
    res.json({ connected, phone });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/whatsapp/sessions/:id/groups", auth.requireAuth, async (req, res) => {
  try {
    const { name, participants = [], includeNimbus = false } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: "name obrigatório" });

    let parts = Array.isArray(participants) ? participants.slice() : [];

    // Opção "usar o WhatsNimbus": anexa o telefone do número do sistema como
    // participante. Resolvido no servidor (fonte da verdade) — o cliente só pede.
    if (includeNimbus) {
      const cfg = whatsnimbus.readConfig();
      const s = cfg.numberId ? await wa.getSession(whatsnimbus.WHATSNIMBUS_USER_ID, cfg.numberId) : null;
      if (!cfg.numberId || s?.status !== "connected") {
        return res.status(400).json({ error: "O WhatsNimbus não está conectado. Conecte-o na aba admin ou informe um participante." });
      }
      const wnPhone = cfg.phone || s?.info?.phone;
      if (wnPhone) parts.push(wnPhone);
    }

    parts = [...new Set(parts.map(p => String(p).trim()).filter(Boolean))];
    if (parts.length === 0) {
      return res.status(400).json({ error: "informe ao menos um participante (telefone) ou use o WhatsNimbus" });
    }
    const group = await wa.createGroup(req.user.id, req.params.id, String(name).trim(), parts);
    res.json(group);
  } catch (err) {
    console.error("[whatsapp] createGroup:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/whatsapp/sessions/:id/groups/:jid/invite", auth.requireAuth, async (req, res) => {
  try {
    const inviteLink = await wa.getInviteLink(req.user.id, req.params.id, req.params.jid);
    res.json({ inviteLink });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/whatsapp/sessions/:id/groups/:jid/invite/revoke", auth.requireAuth, async (req, res) => {
  try {
    const inviteLink = await wa.revokeInvite(req.user.id, req.params.id, req.params.jid);
    res.json({ inviteLink });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/whatsapp/sessions/:id/groups/:jid", auth.requireAuth, async (req, res) => {
  try {
    await wa.leaveGroup(req.user.id, req.params.id, req.params.jid);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/whatsapp/sessions/:id/send", auth.requireAuth, async (req, res) => {
  try {
    const { jid, text, imageUrl } = req.body || {};
    if (!jid) return res.status(400).json({ error: "jid obrigatório" });
    if (!text && !imageUrl) return res.status(400).json({ error: "text ou imageUrl obrigatório" });
    if (imageUrl) {
      await wa.sendImage(req.user.id, req.params.id, jid, imageUrl, text);
    } else {
      await wa.sendText(req.user.id, req.params.id, jid, text);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("[whatsapp] send:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/whatsapp/sessions/:id/broadcast", auth.requireAuth, async (req, res) => {
  try {
    const { jids = [], text, imageUrl, intervalMs = 4000 } = req.body || {};
    if (!Array.isArray(jids) || jids.length === 0) return res.status(400).json({ error: "jids obrigatório (array)" });
    if (!text && !imageUrl) return res.status(400).json({ error: "text ou imageUrl obrigatório" });

    const results = [];
    for (let i = 0; i < jids.length; i++) {
      const jid = jids[i];
      try {
        if (imageUrl) {
          await wa.sendImage(req.user.id, req.params.id, jid, imageUrl, text);
        } else {
          await wa.sendText(req.user.id, req.params.id, jid, text);
        }
        results.push({ jid, ok: true });
      } catch (err) {
        results.push({ jid, ok: false, error: err.message });
      }
      if (i < jids.length - 1 && intervalMs > 0) {
        await new Promise(r => setTimeout(r, intervalMs));
      }
    }
    res.json({ ok: true, results });
  } catch (err) {
    console.error("[whatsapp] broadcast:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────────────────────

async function boot() {
  // Pré-aquece JWT secret (Postgres / env) + cache de config (scraper-config +
  // afiliado per-user) — necessário pra auth e pra affiliate.status() /
  // adminScraper.readConfig() funcionarem sync.
  await auth.warmup();
  await auth.bootSeed();
  await appConfig.warmup();
  await affiliate.warmup();

  // Inicializa fila de envios (Fase 2). Server é só PRODUCER — quem registra
  // workers é o backend/worker.js (em redis mode). Em memory é no-op.
  await queueMod.init({ producer: true, consumer: false });

  const server = app.listen(PORT, () => {
    console.log(`Nimbus Backend rodando em http://localhost:${PORT} [queue=${queueMod.backendName()}]`);
    console.log(`  GET  /api/ofertas?category=gamer&minDiscount=20&limit=10`);
    console.log(`  GET  /api/status`);
    console.log(`  GET  /api/admin/scraper/config (admin)`);
    console.log(`  POST /api/admin/scraper/run    (admin)`);
    console.log(`  POST /api/admin/scraper/cancel (admin)`);
    console.log(`  GET  /api/admin/users          (admin)`);

    if (queueMod.isRedis()) {
      // Redis mode: worker.js owna Baileys + processa filas. Server é proxy.
      console.log(`[server] modo redis: rode 'node worker.js' em paralelo (Baileys + workers)`);
    } else {
      // Memory mode (legado): single process owna tudo.
      wa.restoreSessions().catch(err => console.error("[server] restoreSessions:", err.message));
    }
    scheduler.start();
    adminScraper.start();
    // Fire-and-forget — falha silenciosa se sessão WA ainda não estiver conectada
    setTimeout(() => {
      adminNotifier.notifySystemOnline().catch(err =>
        console.error("[server] notifySystemOnline:", err.message)
      );
    }, 5000);
  });

  // Shutdown limpo — drena worker (jobs em-vôo terminam) antes de derrubar HTTP
  const shutdown = async (signal) => {
    console.log(`[server] ${signal} recebido, encerrando...`);
    scheduler.stop();
    server.close(() => console.log("[server] HTTP fechado"));
    try { await queueMod.close(); console.log("[server] queue fechada"); } catch {}
    setTimeout(() => process.exit(0), 2000);
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

// Em testes (NODE_ENV=test) o app é exportado sem rodar boot() — quem importa
// é responsável por chamar appConfig.warmup() e queueMod.init() (ou não, se
// não precisar). Sem isso o supertest fica esperando o listener.
if (require.main === module) {
  boot().catch(err => {
    console.error("[boot] falha fatal:", err);
    process.exit(1);
  });
}

module.exports = { app, boot };
