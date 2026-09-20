// CRÍTICO: carregar .env ANTES de qualquer require que dependa de env na hora do
// module-load. O facade whatsapp/index.js decide local-vs-proxy lendo QUEUE_BACKEND
// no require; sem o dotenv aqui, ele resolvia pra "local" (sem sessões) no backend,
// quebrando envios e abrindo uma conexão Baileys duplicada (conflito com o worker).
require("./config/loadEnv"); // carrega .env + override por modo (prod | ngrok)

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");
const { CATEGORIES, STORES, normalizeSource, scrapeSingleProduct } = require("./scraping/scraper");
const wa = require("./whatsapp");
const auth = require("./auth");
const storage = require("./storage");
const scheduler = require("./scheduler");
const affiliate = require("./scraping/affiliate");
const catalog = require("./catalog");
const adminScraper = require("./scraping/admin");
const storeLocks = require("./scraping/store-locks");
const mlHub = require("./scraping/ml-hub");
const scrapTester = require("./scraping/tester");
const mlCoupon = require("./scraping/ml-coupon");
const mlCupons = require("./coupons/sync");
const couponsStore = require("./coupons");
const tutorials = require("./tutorials");
const appConfig = require("./config");
const cpfUtil = require("./utils/cpf");
const phoneUtil = require("./utils/phone");
const repasseLeaders = require("./repasse/leaders");
const couponWords = require("./repasse/coupon-words");
const couponAutotestConfig = require("./repasse/coupon-autotest-config");
const queueMod = require("./infra/queue");
const logger = require("./infra/logger");
const metrics = require("./infra/metrics");
const sentry = require("./infra/sentry");
const httpErrors = require("./infra/httpErrors");
const billing = require("./billing");
const stripeMod = require("./billing/stripe");
const backupApi = require("./backup/api");
const diskInfo = require("./infra/disk");
const backupMonitor = require("./backup/monitor");
const billingReminders = require("./billing/reminders");
// O log direto, e não notifications/email: a rota só lê o histórico, e assim
// continua lendo o banco de verdade mesmo com o módulo de envio mockado.
const emailLog = require("./notifications/email/log");
// Modelos de e-mail (Admin › E-mails): catálogo, render e o transporte SMTP —
// o envio de teste vai direto pelo transporte, sem passar pelo email_log.
const emailCatalog = require("./notifications/email/catalog");
const emailRender = require("./notifications/email/render");
const emailTransport = require("./notifications/email/transport");
const adminNotifier = require("./notifications/admin-notifier");
const whatsnimbus = require("./notifications/whatsnimbus");
const userNotifier = require("./notifications/user-notifier");

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
// Interface onde a API escuta. Default 127.0.0.1 — quem fala com o mundo é o
// nginx. BIND_HOST=0.0.0.0 só se algum dia o backend rodar em host separado.
const BIND_HOST = process.env.BIND_HOST || "127.0.0.1";

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
const publicUrl = require("./config/publicUrl");
const { corsOrigins: CORS_ORIGINS } = publicUrl;

// Em produção a allowlist não pode ficar vazia: combinada com credentials:true,
// "aceita qualquer origem" deixa qualquer site ler respostas autenticadas da API.
// Falhar no boot é melhor do que subir aberto sem ninguém perceber.
if (process.env.NODE_ENV === "production" && !CORS_ORIGINS.length) {
  console.error("[cors] NODE_ENV=production sem allowlist de origem. Defina PUBLIC_BASE_URL ou NIMBUS_CORS_ORIGINS no .env.");
  process.exit(1);
}

function originAllowed(origin) {
  if (!origin) return true; // requests same-origin / curl
  if (!CORS_ORIGINS.length) return true; // dev sem env definida
  for (const pat of CORS_ORIGINS) {
    if (pat === origin) return true;
    if (pat.startsWith("*.")) {
      // Compara o host parseado, não a string toda: "https://evil.com/#.dominio.com"
      // termina com ".dominio.com" mas não é subdomínio dele. E exige https, senão
      // "http://sub.dominio.com" (texto claro) passaria pelo mesmo teste.
      let u;
      try { u = new URL(origin); } catch { return false; }
      if (u.protocol !== "https:") continue;
      const suffix = pat.slice(1); // ".dominio.com"
      if (u.host.endsWith(suffix)) return true;
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
      httpErrors.serverError(res, err, { req, ctx: "POST /api/billing/webhook" });
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
      // Sem client_reference_id = checkout público (veio da landing, pagou
      // antes de ter conta). A conta nasce aqui, do pagamento aprovado.
      // Idempotente e disputado com POST /api/public/claim — quem chegar
      // primeiro cria, o outro só encontra.
      if (!userId) {
        await billing.provision.provisionFromCheckout(obj);
        return;
      }
      if (userId && customerId) {
        // event.livemode diz de qual modo veio (o webhook aceita os dois), e é
        // mais confiável que o modo ativo no momento em que o evento chegou.
        await billing.update(userId, {
          stripeCustomerId: customerId,
          stripeMode: event.livemode ? "live" : "test",
        });
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
      // Marca trialUsedAt na primeira vez que vemos uma sub com trial — queima
      // a elegibilidade do trial de R$1 (set-if-null = idempotente).
      // `trialFromManual` é o trial que existe só pra adiar a primeira cobrança
      // até o fim de uma cortesia: esse não é o teste de R$1 e não queima nada.
      if (norm.trialEnd && !norm.trialFromManual) {
        const existing = await billing.getByUserId(userId);
        if (!existing?.trialUsedAt) norm.trialUsedAt = new Date();
      }
      // Snapshots crus antes/depois: é a diferença entre os dois que decide se
      // o cliente recebe e-mail (cartão falhou, plano mudou, cancelou). Sem
      // isso, cada reentrega do Stripe viraria um aviso repetido.
      const before = await billing.getRawByUserId(userId);
      await billing.update(userId, norm);
      // "Cancelar o trial e começar agora": a pessoa pediu no checkout pra
      // encerrar a cortesia junto com a primeira cobrança. Roda ANTES do
      // applyPlanLimits pra os limites serem recalculados uma vez só, já sem ela.
      if (norm.manualTrialCancel) {
        const atual = await billing.getByUserId(userId);
        if (billing.limits.manualTrialActive(atual)) {
          await billing.revokeManualTrial(userId).catch(err => {
            logger.warn({ err: err.message, userId }, "[billing] encerrar cortesia no checkout falhou");
          });
        }
      }
      const after = await billing.getRawByUserId(userId);
      // Plano mudou → recalcula o que fica ativo/pausado (downgrade pausa o
      // excedente, upgrade despausa). Nunca derruba o webhook se falhar.
      const enforced = await applyPlanLimits(userId);
      // Awaited, mas nunca lança: o notify engole os próprios erros e o envio
      // do e-mail em si é fire-and-forget lá dentro. Assim o webhook não vira
      // 500 (que geraria reentrega) por causa de um aviso.
      await billing.notify.onSubscriptionChanged({
        userId, before, after, livemode: event.livemode, planPaused: enforced?.planPaused,
      });
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
        // Sem plano = tudo pausado (nada é apagado; volta ao reassinar).
        await applyPlanLimits(existing.userId);
        // `existing` é o estado ANTES do downgrade pra free — é dele que sai o
        // nome do plano encerrado no e-mail.
        await billing.notify.onSubscriptionDeleted({
          userId: existing.userId, before: existing, livemode: event.livemode,
        });
      }
      return;
    }
    case "invoice.payment_succeeded":
    case "invoice.payment_failed":
      // Status do subscription já reflete em customer.subscription.updated;
      // o log continua aqui pra observabilidade.
      logger.info({ type: event.type, invoice: obj.id }, "[billing] invoice event");
      // Cobrança recorrente aprovada = recibo pro cliente. O notify decide se
      // aquela fatura merece e-mail (a primeira da assinatura, não) e engole os
      // próprios erros — recibo não pode derrubar o webhook.
      if (event.type === "invoice.payment_succeeded") {
        await billing.notify.onInvoicePaid({ invoice: obj, livemode: event.livemode });
      }
      return;
    case "charge.refunded":
      // Estorno total ou parcial, normalmente feito à mão no dashboard. O aviso
      // sai primeiro pra que o cliente saiba do dinheiro mesmo se o
      // cancelamento abaixo falhar.
      await billing.notify.onChargeRefunded({ charge: obj, livemode: event.livemode });
      await cancelarPorEstorno({ charge: obj, livemode: event.livemode });
      return;
    default:
      // Ignora silenciosamente — Stripe manda muitos tipos.
      return;
  }
}

// Devolver dinheiro encerra a conta. O Stripe não faz isso sozinho — refund
// numa cobrança só devolve o valor, a assinatura segue ativa e cobra de novo no
// próximo ciclo. Vale pro estorno parcial também (decisão de produto).
//
// O caminho normal é cancelar no Stripe e deixar o customer.subscription.deleted
// fazer o downgrade — assim existe um jeito só de derrubar plano. O downgrade
// local é rede de segurança pra quando não há assinatura no Stripe pra cancelar.
async function cancelarPorEstorno({ charge, livemode }) {
  try {
    // Mesmo critério do notify: evento de um modo Stripe que não é o ativo não
    // pode ser cancelado com o cliente do modo errado.
    if (livemode !== undefined && livemode !== null && livemode !== (stripeMod.mode() === "live")) return;
    if (!(Number(charge?.amount_refunded) > 0)) return;

    const customerId = typeof charge?.customer === "string" ? charge.customer : charge?.customer?.id;
    const sub = customerId ? await billing.getByCustomerId(customerId) : null;
    if (!sub) {
      logger.warn({ charge: charge?.id, customerId }, "[billing] estorno de customer desconhecido");
      return;
    }
    if (sub.status === "canceled" && sub.planId === "free") return;

    if (sub.stripeSubscriptionId) {
      try {
        await stripeMod.cancelSubscription(sub.stripeSubscriptionId);
        logger.info({ userId: sub.userId, subId: sub.stripeSubscriptionId }, "[billing] assinatura cancelada por estorno");
        return; // subscription.deleted chega em seguida e faz o downgrade
      } catch (err) {
        logger.warn({ err: err.message, subId: sub.stripeSubscriptionId }, "[billing] cancelamento no Stripe falhou — derrubando plano localmente");
      }
    }

    await billing.update(sub.userId, {
      planId: "free",
      status: "canceled",
      cancelAtPeriodEnd: false,
      stripeSubscriptionId: null,
    });
    await applyPlanLimits(sub.userId);
    logger.info({ userId: sub.userId }, "[billing] plano derrubado localmente por estorno");
  } catch (err) {
    // Nunca derruba o webhook: o evento já foi marcado como processado, então
    // um 500 aqui só perderia o evento sem reentrega.
    logger.error({ err: err.message, charge: charge?.id }, "[billing] cancelamento por estorno falhou");
    sentry.captureException(err, { tags: { stripeEvent: "charge.refunded" } });
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
// Chave por usuário autenticado (sub do JWT) quando houver token válido —
// senão o polling de várias abas de um mesmo usuário (ops 3s + sessão 8s +
// afiliado 30s ≈ 30 req/min/aba) soma no MESMO balde de outros usuários atrás
// do mesmo IP/NAT, e um 429 aí é engolido em silêncio pelo polling do
// frontend (App.jsx) — a tela para de atualizar sem nenhum aviso, dando a
// falsa impressão de que só o F5 resolve. Cai pra IP só em rotas sem token.
function apiLimiterKey(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  const payload = token ? auth.verifyToken(token) : null;
  return payload?.sub ? `user:${payload.sub}` : ipKeyGenerator(req.ip);
}
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  // ~30 req/min/aba de polling (ops 3s + sessão 8s + afiliado 30s) — dá margem
  // pra várias abas do mesmo usuário sem esbarrar no limite.
  max: 180,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipLimitInTests,
  keyGenerator: apiLimiterKey,
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
  // Os .status() abaixo são síncronos, mas se um deles estourar o handler
  // inteiro cairia no error handler global e viraria um 500 genérico — e quem
  // monitora precisa do 503 com diagnóstico. Por isso cada um é isolado.
  try {
    const sched = scheduler.status();
    checks.scheduler = sched;
    if (!sched.healthy && sched.running) healthy = false;
  } catch (err) {
    healthy = false;
    checks.scheduler = { ok: false, error: err.message };
  }

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

  // Backup: idade do último dump local/remoto (informativo, não afeta health —
  // o alerta ativo é do backup/monitor.js via WhatsApp de admin)
  try { checks.backup = backupMonitor.status(); } catch (err) { checks.backup = { ok: false, error: err.message }; }

  // Lembretes de cobrança: última varredura (informativo). Se lastRunAt ficar
  // velho, os avisos de "teste acabando"/"acesso vai cair" pararam de sair.
  try { checks.billingReminders = billingReminders.status(); } catch (err) { checks.billingReminders = { ok: false, error: err.message }; }

  // Admin scraper: status (informativo, não afeta health)
  try {
    const st = adminScraper.status();
    checks.adminScraper = { running: st.running, lastRun: st.lastRun, lastError: st.lastError };
  } catch (err) {
    checks.adminScraper = { ok: false, error: err.message };
  }

  // /healthz é público (o monitoramento externo precisa alcançar). O detalhe dos
  // checks fica só pra quem chama de dentro: as mensagens de erro do Postgres e
  // do Redis costumam trazer host, porta e usuário do banco, e o resto entrega
  // contagem de sessões e profundidade de fila pra qualquer um.
  const fromLocalhost = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.ip);
  const body = fromLocalhost
    ? { status: healthy ? "ok" : "degraded", uptime: Math.round(process.uptime()), checks }
    : { status: healthy ? "ok" : "degraded" };

  res.status(healthy ? 200 : 503).json(body);
});

// ────────────────────────────────────────────────────────────────────────
// Auth
// ────────────────────────────────────────────────────────────────────────

app.post("/api/auth/register", registerLimiter, async (req, res) => {
  try {
    const { name, email, password, phone } = req.body || {};
    const user = await auth.register({ name, email, password, phone });
    // Sem trial: novas contas nascem free/inactive — acesso só após checkout.
    // Sem token: usuário precisa verificar email antes de logar.
    res.json({ user, requiresVerification: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Público: a tela de login usa pra esconder o cadastro no beta fechado.
app.get("/api/auth/registration-status", (req, res) => {
  res.json({ blocked: auth.isRegistrationBlocked() });
});

// ────────────────────────────────────────────────────────────────────────
// Checkout público — landing page → Stripe → sistema
// ────────────────────────────────────────────────────────────────────────
//
// Quem chega da landing ainda não tem conta, então nada aqui exige login. A
// conta nasce do pagamento aprovado (billing/provision.js), e o retorno do
// Stripe cai em /bem-vindo?session_id=…, que troca a sessão paga por um JWT.
//
// O e-mail é pedido ANTES de abrir o Stripe porque é a única forma de barrar
// quem já assina (o Checkout só coleta o e-mail depois, com a cobrança feita).

const publicCheckoutLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipLimitInTests,
  message: { error: "Muitas tentativas. Aguarde 1 minuto." },
});

const SUBSCRIBABLE_PLANS = ["basic", "pro", "business"];

// Quando a pessoa está numa cortesia do admin, assinar não pode cobrar hoje: ela
// já tem o acesso até certa data, e pagar agora seria pagar duas vezes pelo mesmo
// período. A primeira cobrança é empurrada pro fim da cortesia (trial_end do
// Stripe), com o cartão coletado no ato.
//
// O piso de 48h é regra do Stripe pro trial_end no Checkout: cortesia acabando
// antes disso não dá pra adiar, então a cobrança entra normal — o que também é o
// certo, porque o intervalo é irrisório.
const DEFER_MIN_MS = 48 * 60 * 60 * 1000;

function deferralFor(sub) {
  if (!billing.limits.manualTrialActive(sub)) return null;
  const fim = new Date(sub.manualTrialEndsAt);
  return fim.getTime() - Date.now() >= DEFER_MIN_MS ? fim : null;
}

// Bloqueio nunca é beco sem saída: quem já assina recebe, junto da mensagem, o
// caminho para os planos MAIORES que o dele. Todos apontam para
// /assinatura?plano=…, onde a troca cobra só a diferença — abrir um checkout
// novo criaria uma segunda assinatura pro mesmo CPF.
//
// Vive aqui, e não em provision.js, porque é a camada que conhece URL pública.
// Usado pelos DOIS endpoints (plan-check e o 409 do checkout) pra eles nunca
// divergirem: o popup da landing chama um, a tela /assinar chama o outro.
async function buildBlockedPayload(decision, planId) {
  const base = {
    currentPlan: decision.currentPlan || null,
    currentPlanLabel: null,
    upgrades: [],
    targetPlan: null,
    loginUrl: publicUrl.loginUrl,
  };
  // cpf_taken / cpf_mismatch: a conta dona é de outra pessoa (ou o documento
  // não confere), então não há plano a comparar nem upgrade a oferecer.
  if (!decision.currentPlan) return base;

  const catalog = await billing.publicPlans().catch(() => []);
  const asOption = (id) => {
    const p = catalog.find(x => x.id === id);
    return {
      id,
      label: p?.label || billing.limits.getPlan(id).label,
      priceBRL: p?.priceBRL ?? billing.limits.getPlan(id).priceBRL ?? null,
      url: publicUrl.upgradeUrl(id),
    };
  };

  const upgrades = SUBSCRIBABLE_PLANS.filter(id => billing.limits.isUpgrade(decision.currentPlan, id));
  return {
    ...base,
    currentPlanLabel: billing.limits.getPlan(decision.currentPlan).label,
    // Vazio quando a pessoa já está no maior plano — aí a tela só informa.
    upgrades: upgrades.map(asOption),
    // O plano que ela tentou assinar, quando é de fato um upgrade: é o botão
    // "quero assinar mesmo assim".
    targetPlan: upgrades.includes(planId) ? asOption(planId) : null,
  };
}

// Catálogo pra landing e pra tela /assinar montarem nome e preço sem login.
app.get("/api/public/plans", async (req, res) => {
  try {
    res.json({ plans: await billing.publicPlans(), stripeEnabled: stripeMod.enabled() });
  } catch (err) {
    logger.error({ err: err.message }, "[public] plans falhou");
    httpErrors.serverError(res, err, { req, ctx: "GET /api/public/plans" });
  }
});

// Diz se aquele e-mail e CPF podem seguir pro pagamento — usado pelo popup da
// landing e pela tela /assinar pra avisar antes de mandar pro Stripe. Mesma
// decisão do checkout.
app.post("/api/public/plan-check", publicCheckoutLimiter, async (req, res) => {
  try {
    const planId = String(req.body?.planId || "").trim();
    if (!SUBSCRIBABLE_PLANS.includes(planId)) {
      return res.status(400).json({ error: "planId inválido" });
    }
    const d = await billing.provision.decideForSignup({
      planId, email: req.body?.email, cpf: req.body?.cpf,
    });
    if (d.decision === "checkout") {
      return res.json({
        decision: d.decision, message: null, currentPlan: null, trialEligible: d.trialEligible,
      });
    }
    res.json({
      decision: d.decision,
      message: d.message || null,
      trialEligible: d.trialEligible,
      ...(await buildBlockedPayload(d, planId)),
    });
  } catch (err) {
    logger.error({ err: err.message }, "[public] plan-check falhou");
    httpErrors.serverError(res, err, { req, ctx: "POST /api/public/plan-check" });
  }
});

// Cria a Checkout Session de quem veio da landing. Body: { planId, email, cpf, phone, trial }.
app.post("/api/public/checkout", publicCheckoutLimiter, async (req, res) => {
  try {
    if (!stripeMod.enabled()) return res.status(501).json({ error: "Stripe não configurado" });
    const planId = String(req.body?.planId || "").trim();
    const email = String(req.body?.email || "").trim().toLowerCase();
    const cpf = cpfUtil.normalizeCpf(req.body?.cpf);
    const phone = phoneUtil.toStoredPhone(req.body?.phone);
    const withTrial = !!req.body?.trial;

    if (!SUBSCRIBABLE_PLANS.includes(planId)) {
      return res.status(400).json({ error: "planId inválido" });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "Informe um e-mail válido" });
    }
    // CPF conferido antes de qualquer chamada ao Stripe: uma conta = um CPF.
    if (!cpfUtil.isValidCpf(cpf)) {
      return res.status(400).json({ error: "Informe um CPF válido", code: "invalid_cpf" });
    }
    // Telefone junto: a conta nasce do pagamento, então é aqui ou nunca — o
    // painel só voltaria a pedir depois que a pessoa já pagou.
    if (!phone) {
      return res.status(400).json({ error: "Informe um telefone válido (DDD + celular)", code: "invalid_phone" });
    }
    if (!stripeMod.priceFor(planId)) {
      return res.status(500).json({ error: `Price ID do plano "${planId}" não configurado no servidor` });
    }
    if (withTrial && planId !== "basic") {
      return res.status(400).json({ error: "O teste de 7 dias está disponível apenas no plano Básico" });
    }

    const d = await billing.provision.decideForSignup({ planId, email, cpf });
    if (d.decision === "invalid_cpf") {
      return res.status(400).json({ error: d.message, code: d.decision });
    }
    if (d.decision !== "checkout") {
      return res.status(409).json({
        error: d.message,
        code: d.decision,
        ...(await buildBlockedPayload(d, planId)),
      });
    }
    // Trial é 1x por conta — e-mail que já usou paga o valor cheio em vez de
    // receber um erro (a intenção dele é assinar, não brigar com a regra).
    const trial = withTrial && d.trialEligible;

    // Conta existente sem plano ativo: o checkout é dela, com o customer que
    // ela já tiver — cai exatamente no fluxo autenticado de sempre.
    let customer = null;
    let adiarAte = null;
    if (d.user) {
      const sub = await billing.ensureForUser(d.user.id, { planId: "free", status: "inactive" });
      adiarAte = deferralFor(sub);
      customer = await stripeMod.getOrCreateCustomer({
        userId: d.user.id,
        email: d.user.email,
        name: d.user.name,
        cpf,
        existingCustomerId: sub.stripeCustomerId,
      });
      if (!sub.stripeCustomerId) {
        await billing.update(d.user.id, { stripeCustomerId: customer.id });
      }
    } else {
      // Sem conta ainda: o Customer é criado AQUI, e não pelo Stripe no fim do
      // pagamento, porque é a única forma de o CPF já ser documento fiscal na
      // primeira fatura. A busca por e-mail evita um Customer novo a cada
      // tentativa abandonada.
      const existing = await stripeMod.findCustomerByEmail(email);
      customer = await stripeMod.getOrCreateCustomer({
        email,
        cpf,
        existingCustomerId: existing?.id,
      });
    }

    const session = await stripeMod.createCheckoutSession({
      planId,
      customer,
      customerEmail: customer ? undefined : email,
      userId: d.user?.id,
      withTrial: trial && !adiarAte,
      trialEndsAt: adiarAte,
      successUrl: publicUrl.stripeWelcomeUrl,
      cancelUrl: publicUrl.subscribeUrl(planId),
      metadataExtra: { source: "landing", pendingEmail: email, pendingCpf: cpf, pendingPhone: phone },
    });
    metrics.recordCheckout?.(planId, "ok");
    res.json({ url: session.url });
  } catch (err) {
    metrics.recordCheckout?.(String(req.body?.planId || "unknown"), "error");
    logger.error({ err: err.message }, "[public] checkout falhou");
    httpErrors.serverError(res, err, { req, ctx: "POST /api/public/checkout" });
  }
});

// Resgate do retorno do Stripe: troca o id da Checkout Session paga por uma
// sessão logada. Uso único (o id anda na URL) e só vale enquanto a sessão do
// Checkout é recente — depois disso o caminho é o e-mail de boas-vindas.
const CLAIM_WINDOW_MS = 2 * 60 * 60 * 1000; // 2h desde a criação do checkout

app.post("/api/public/claim", publicCheckoutLimiter, async (req, res) => {
  try {
    if (!stripeMod.enabled()) return res.status(501).json({ error: "Stripe não configurado" });
    const sessionId = String(req.body?.sessionId || "").trim();
    if (!sessionId.startsWith("cs_")) return res.status(400).json({ error: "Sessão inválida" });

    let session;
    try {
      session = await stripeMod.getCheckoutSession(sessionId);
    } catch {
      return res.status(404).json({ error: "Pagamento não encontrado" });
    }

    const paid = session.payment_status === "paid"
      || session.payment_status === "no_payment_required" // trial sem cobrança hoje
      || session.status === "complete";
    if (!paid) return res.status(402).json({ error: "Pagamento ainda não confirmado" });

    if (session.created && Date.now() - session.created * 1000 > CLAIM_WINDOW_MS) {
      return res.status(410).json({
        error: "Este link expirou. Verifique seu e-mail para criar a senha e entrar.",
        code: "claim_expired",
      });
    }

    const { user } = await billing.provision.provisionFromCheckout(session);
    if (!user) return res.status(500).json({ error: "Não foi possível localizar sua conta" });

    // Conta que JÁ tinha senha não abre sessão por aqui. O pagamento prova
    // intenção de assinar, não posse da conta — senão bastaria saber o e-mail
    // de alguém e pagar uma mensalidade pra entrar no lugar dela. Só quem nasceu
    // deste pagamento (senha aleatória, token de definição pendente) entra
    // direto; o resto assina normalmente e faz login com a própria senha.
    if (!user.passwordResetToken) {
      await billing.markClaimed(user.id);
      return res.json({
        requiresLogin: true,
        email: user.email,
        message: "Pagamento confirmado! Sua assinatura já está ativa — entre com seu e-mail e senha.",
      });
    }

    // Uso único: se já foi resgatado, a pessoa entra pelo login normal.
    const first = await billing.markClaimed(user.id);
    if (!first) {
      return res.status(410).json({
        error: "Este link já foi usado. Entre com seu e-mail e senha.",
        code: "already_claimed",
      });
    }

    // Reconcilia antes de responder pro painel já abrir com o plano certo,
    // mesmo se o webhook de subscription.created ainda não chegou.
    try { await reconcileWithStripe(user.id); }
    catch (err) { logger.warn({ err: err.message }, "[public] reconcile pós-claim falhou"); }

    // needsPassword: conta criada pelo pagamento nasce com senha aleatória e um
    // token de "defina sua senha" pendente — é o que faz /bem-vindo abrir o
    // formulário de senha em vez de mandar direto pro painel.
    const issued = await auth.issueSession(user);
    res.json({ ...issued, needsPassword: !!user.passwordResetToken });
  } catch (err) {
    logger.error({ err: err.message }, "[public] claim falhou");
    httpErrors.serverError(res, err, { req, ctx: "POST /api/public/claim" });
  }
});

// ────────────────────────────────────────────────────────────────────────
// Layout — paleta de cores, valendo pro sistema inteiro
// ────────────────────────────────────────────────────────────────────────

// Ids aceitos. Precisam bater com os blocos data-palette do frontend
// (index.css) e com PALETTES em src/data/constants.js.
const PALETTE_IDS = ["nimbus", "laranja", "classica"];
const PALETTE_KEY = "layout-palette";
const DEFAULT_PALETTE = "nimbus";

function readPalette() {
  const v = appConfig.get(PALETTE_KEY);
  return PALETTE_IDS.includes(v) ? v : DEFAULT_PALETTE;
}

// Público de propósito: a tela de login precisa da paleta antes de existir
// sessão, senão o usuário veria as cores trocando depois de entrar.
app.get("/api/layout", (req, res) => {
  res.json({ palette: readPalette() });
});

app.put("/api/admin/layout", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  const palette = (req.body || {}).palette;
  if (!PALETTE_IDS.includes(palette)) {
    return res.status(400).json({ error: `Paleta inválida. Use uma de: ${PALETTE_IDS.join(", ")}.` });
  }
  appConfig.set(PALETTE_KEY, palette);
  if (!await confirmConfigSaved(res)) return;
  res.json({ ok: true, palette });
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
// Contas novas nascem free/inactive — sem trial; acesso só após checkout.
app.post("/api/auth/google", loginLimiter, async (req, res) => {
  try {
    const { idToken, credential } = req.body || {};
    const result = await auth.loginWithGoogle({ idToken: idToken || credential });
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
    // Trocar a senha invalida os tokens antigos (inclusive o desta aba), então
    // devolvemos um token novo pra sessão atual seguir sem precisar relogar.
    const { token } = await auth.changePassword(req.user.id, req.body || {});
    res.json({ ok: true, token });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// CPF de quem já tinha conta antes da regra "uma conta = um CPF". O painel
// pede isso na primeira entrada (user.cpfRequired). Grava uma vez só: trocar o
// documento é trocar de dono, e isso passa pelo admin.
app.post("/api/account/cpf", auth.requireAuth, async (req, res) => {
  try {
    const user = await auth.setCpf(req.user.id, req.body?.cpf);
    res.json({ ok: true, user });
  } catch (err) {
    const status = err.code === "cpf_taken" ? 409 : 400;
    res.status(status).json({ error: err.message, code: err.code || null });
  }
});

// Telefone de quem entrou sem informar um (conta anterior à regra, conta do
// Google, conta provisionada por pagamento sem o número). O painel pede na
// entrada e deixa pular; esta rota é o que grava quando a pessoa informa.
app.post("/api/account/phone", auth.requireAuth, async (req, res) => {
  try {
    const user = await auth.setPhone(req.user.id, req.body?.phone);
    res.json({ ok: true, user });
  } catch (err) {
    res.status(400).json({ error: err.message, code: err.code || null });
  }
});

// Troca de email em dois tempos. Aqui só pede: a senha atual autoriza e o
// endereço novo recebe o link. Nada muda na conta até o clique.
app.post("/api/account/email", auth.requireAuth, registerLimiter, async (req, res) => {
  try {
    const r = await auth.requestEmailChange(req.user.id, {
      password: req.body?.password,
      newEmail: req.body?.newEmail,
    });
    res.json(r);
  } catch (err) {
    const status = err.code === "email_taken" ? 409 : 400;
    res.status(status).json({ error: err.message, code: err.code || null });
  }
});

// Confirmação vinda do link. Sem requireAuth de propósito: a pessoa pode abrir
// o email em outro navegador, e o token já é a prova de posse do endereço.
app.post("/api/account/email/confirm", loginLimiter, async (req, res) => {
  try {
    const r = await auth.confirmEmailChange(req.body?.token);
    // Recibo e aviso de cobrança precisam seguir o email novo. Best-effort:
    // syncCustomerEmail nunca lança, então uma falha no Stripe não desfaz nem
    // reprova uma troca de email que já está gravada.
    await billing.syncCustomerEmail(r.user.id, r.user.email);
    res.json(r);
  } catch (err) {
    const status = err.code === "email_taken" ? 409 : 400;
    res.status(status).json({ error: err.message, code: err.code || null });
  }
});

// Primeira senha de quem entrou pelo checkout público — a conta foi criada pelo
// pagamento e não tem senha atual pra informar. auth.setInitialPassword recusa
// se a conta já tiver uma senha escolhida.
app.post("/api/auth/set-initial-password", auth.requireAuth, async (req, res) => {
  try {
    const { token, user } = await auth.setInitialPassword(req.user.id, req.body?.password);
    res.json({ ok: true, token, user });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────────────────────
// Persistência de estado da app por usuário
// ────────────────────────────────────────────────────────────────────────

app.get("/api/state", auth.requireAuth, async (req, res) => {
  try {
    // Abertura da página: reavalia a pausa por plano com o estado em mãos.
    // Cobre o caso sem evento nenhum (carência que venceu) — o poll de ops
    // depois só reflete o que já está gravado.
    const state = await storage.loadState(req.user.id);
    const applied = await applyPlanLimits(req.user.id, { role: req.user.role, state });
    if (applied.changed && applied.planPaused) {
      const pausedGroups = new Set(applied.planPaused.groups.map(Number));
      const pausedNumbers = new Set(applied.planPaused.numbers.map(String));
      for (const g of state.groups || []) g.planPaused = pausedGroups.has(Number(g.id));
      for (const n of state.numbers || []) n.planPaused = pausedNumbers.has(String(n.id));
      state.planPaused = applied.planPaused;
    }
    res.json(state);
  } catch (err) {
    httpErrors.serverError(res, err, { req, ctx: "GET /api/state" });
  }
});

app.put("/api/state", auth.requireAuth, async (req, res) => {
  try {
    // Plan-gating — o limite vale sobre os itens ATIVOS. O que está pausado
    // pelo plano (cancelamento/downgrade) não conta e não é checado: assim
    // quem está acima do limite ainda consegue apagar, editar e reorganizar —
    // só não consegue criar item ativo novo. Admin passa direto.
    const incoming = req.body || {};
    if (req.user.role !== "admin") {
      const sub = await billing.getByUserId(req.user.id);
      // Reavalia ANTES de checar: se o plano encolheu sem ninguém ter
      // recalculado (fim da carência, downgrade sem webhook), o excedente é
      // pausado agora. Sem isso o cliente tomaria 402 até pra apagar campanha.
      const applied = await applyPlanLimits(req.user.id, { role: req.user.role, sub });
      const planPaused = applied.planPaused || await storage.loadPlanPaused(req.user.id);

      const incomingGroups = Array.isArray(incoming.groups) ? incoming.groups : [];
      const incomingNumbers = Array.isArray(incoming.numbers) ? incoming.numbers : [];
      const activeGroups = incomingGroups.filter(g => !billing.enforce.isGroupPlanPaused(planPaused, g.id));
      const activeNumbers = incomingNumbers.filter(n => !billing.enforce.isNumberPlanPaused(planPaused, n.id));

      const checks = [
        billing.limits.checkLimit(sub, "groups", activeGroups.length, req.user.role),
        billing.limits.checkLimit(sub, "numbers", activeNumbers.length, req.user.role),
      ];
      // categoriesPerGroup — qualquer campanha ATIVA que exceda é bloqueio.
      const worstCats = activeGroups.reduce((max, g) => {
        const n = Array.isArray(g.categories) ? g.categories.length : 0;
        return n > max ? n : max;
      }, 0);
      if (worstCats > 0) {
        checks.push(billing.limits.checkLimit(sub, "categoriesPerGroup", worstCats, req.user.role));
      }
      // whatsappGroupsPerCampaign — idem, só entre as campanhas ativas.
      const worstWaGroups = activeGroups.reduce((max, g) => {
        const n = Array.isArray(g.whatsappGroupIds) ? g.whatsappGroupIds.length : 0;
        return n > max ? n : max;
      }, 0);
      if (worstWaGroups > 0) {
        checks.push(billing.limits.checkLimit(sub, "whatsappGroupsPerCampaign", worstWaGroups, req.user.role));
      }
      // leadersPerCampaign — grupos líderes de uma campanha de repasse.
      const worstLeaders = activeGroups.reduce((max, g) => {
        const n = repasseLeaders.leadersOf(g.scraping).length;
        return n > max ? n : max;
      }, 0);
      if (worstLeaders > 0) {
        checks.push(billing.limits.checkLimit(sub, "leadersPerCampaign", worstLeaders, req.user.role));
      }
      const failed = checks.find(c => !c.ok);
      if (failed) return res.status(402).json(failed);
    }

    const saved = await storage.saveState(req.user.id, incoming);
    // Contagens mudaram (apagou/criou/editou) — reavalia a pausa por plano:
    // apagar campanha acima do limite libera vaga pras que estavam pausadas.
    await applyPlanLimits(req.user.id, { state: saved, role: req.user.role });
    res.json({ ok: true, updatedAt: saved.updatedAt });
  } catch (err) {
    if (err.code === "STALE_STATE") {
      return res.status(409).json({ error: err.message, code: "STALE_STATE" });
    }
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/state/ops", auth.requireAuth, async (req, res) => {
  try {
    res.json(await storage.loadOps(req.user.id));
  } catch (err) {
    httpErrors.serverError(res, err, { req, ctx: "GET /api/state/ops" });
  }
});

// ────────────────────────────────────────────────────────────────────────
// Billing (Stripe)
// ────────────────────────────────────────────────────────────────────────

// Gate de assinatura para as rotas que DISPARAM envio na hora. O loop automático
// já checava isso (scheduler.js), mas as rotas manuais não — quem cancelava
// seguia enviando por elas, à mão, indefinidamente. Admin passa sempre.
async function requireActiveSubscription(req, res, next) {
  try {
    const sub = await billing.getByUserId(req.user.id);
    if (!billing.isActive(sub, req.user.role)) {
      return res.status(402).json({
        error: "Sua assinatura não está ativa. Reative o plano para voltar a enviar.",
        code: "subscription_inactive",
      });
    }
    next();
  } catch (err) {
    console.error("[billing] gate:", err.message);
    res.status(500).json({ error: "Erro ao verificar a assinatura" });
  }
}

// Gate por número — whitelist: só envia por número que está CADASTRADO no
// estado e não pausado pelo plano.
//
// O cadastro importa porque a pausa por plano só consegue marcar ids que
// existem em `state.numbers` (enforce.js descarta id desconhecido). Um número
// removido do estado com a sessão ainda de pé ficava impausável por construção
// — quem caía de Pro pra Básico apagava os números pausados da lista e seguia
// enviando pelos três. Sem cadastro, não envia.
//
// Número pausado continua conectado (não perde o pareamento), mas não envia
// nada até o cliente ativá-lo de volta.
async function requireUsableNumber(req, res, next) {
  try {
    if (req.user.role === "admin") return next();
    const state = await storage.loadState(req.user.id);
    const known = (state.numbers || []).some(n => String(n.id) === String(req.params.id));
    if (!known) {
      return res.status(402).json({
        error: "Este número não está cadastrado no seu plano. Adicione-o na página WhatsApp para poder enviar por ele.",
        code: "number_not_registered",
      });
    }
    if (billing.enforce.isNumberPlanPaused(state.planPaused, req.params.id)) {
      return res.status(402).json({
        error: "Este número está pausado pelo seu plano. Ative-o na página WhatsApp (trocando com outro) ou assine um plano maior.",
        code: "number_plan_paused",
      });
    }
    next();
  } catch (err) {
    logger.error({ err: err.message }, "[billing] gate de número");
    res.status(500).json({ error: "Erro ao verificar o plano" });
  }
}

// Recalcula quais campanhas/números ficam ativos dentro do plano atual.
// Chamada depois de qualquer mudança de assinatura ou de estado. Nunca lança —
// falhar aqui não pode derrubar webhook, save ou página de assinatura.
async function applyPlanLimits(userId, opts = {}) {
  try {
    let role = opts.role;
    if (!role) {
      const user = await auth.findById(userId);
      role = user?.role;
    }
    const sub = opts.sub || await billing.getByUserId(userId);
    return await billing.enforce.reconcileLimits(userId, sub, role, { state: opts.state });
  } catch (err) {
    logger.warn({ err: err.message, userId }, "[billing] applyPlanLimits falhou");
    return { planPaused: null, changed: false };
  }
}

// Reconciliação com o Stripe: busca a assinatura ao vivo e atualiza o banco.
// Usada pelo POST /sync e pelo GET /me?fresh=1. Também marca trialUsedAt
// na primeira vez que uma sub com trial aparece (set-if-null = idempotente).
async function reconcileWithStripe(userId) {
  const sub = await billing.getByUserId(userId);
  if (!sub?.stripeCustomerId) return false;
  const norm = await stripeMod.getActiveSubscriptionForCustomer(sub.stripeCustomerId);
  if (!norm) return false;
  // Mesma ressalva do webhook: trial que só adia a cobrança até o fim de uma
  // cortesia não é o teste de R$1 e não queima a elegibilidade da conta.
  if (norm.trialEnd && !norm.trialFromManual && !sub.trialUsedAt) norm.trialUsedAt = new Date();
  await billing.update(userId, norm);
  // Plano pode ter mudado no Stripe sem webhook chegar — aplica os limites.
  await applyPlanLimits(userId);
  return true;
}

// Throttle do fresh sync — memória do processo (backend roda em processo único
// no pm2). Evita que o poll de 20s da página martele o Stripe.
const FRESH_SYNC_TTL_MS = 60 * 1000;
const freshSyncAt = new Map(); // userId → timestamp do último sync

// Contagens de uso do plano (campanhas, números, etc.) pra página de assinatura.
// Espelha as chaves de limits.js pro frontend parear limite × uso.
async function computeUsage(userId) {
  const state = await storage.loadState(userId);
  const groups = Array.isArray(state?.groups) ? state.groups : [];
  const numbers = Array.isArray(state?.numbers) ? state.numbers : [];
  const planPaused = state?.planPaused || { groups: [], numbers: [] };
  return {
    // `groups`/`numbers` = total; `active*` = o que conta contra o limite
    // (o resto está pausado pelo plano e não envia).
    groups: groups.length,
    numbers: numbers.length,
    activeGroups: groups.filter(g => !g.planPaused).length,
    activeNumbers: numbers.filter(n => !n.planPaused).length,
    pausedGroups: (planPaused.groups || []).length,
    pausedNumbers: (planPaused.numbers || []).length,
    maxWhatsappGroupsPerCampaign: groups.reduce((max, g) => {
      const n = Array.isArray(g?.whatsappGroupIds) ? g.whatsappGroupIds.length : 0;
      return n > max ? n : max;
    }, 0),
    maxLeadersPerCampaign: groups.reduce((max, g) => {
      const n = repasseLeaders.leadersOf(g?.scraping).length;
      return n > max ? n : max;
    }, 0),
    maxCategoriesPerGroup: groups.reduce((max, g) => {
      const n = Array.isArray(g?.categories) ? g.categories.length : 0;
      return n > max ? n : max;
    }, 0),
  };
}

// Status atual da assinatura do usuário — usado pelo frontend pra renderizar
// plano ativo, limites, dias restantes do trial e badges past_due.
// ?fresh=1 reconcilia com o Stripe antes (throttled) — usado no mount da página;
// o poll periódico chama sem fresh e lê só o banco.
app.get("/api/billing/me", auth.requireAuth, async (req, res) => {
  try {
    if (req.query.fresh && stripeMod.enabled()) {
      const last = freshSyncAt.get(req.user.id) || 0;
      if (Date.now() - last > FRESH_SYNC_TTL_MS) {
        freshSyncAt.set(req.user.id, Date.now());
        try {
          await reconcileWithStripe(req.user.id);
        } catch (err) {
          // Nunca quebra a página por falha do Stripe — cai pro dado do banco.
          logger.warn({ err: err.message }, "[billing] fresh sync falhou — usando banco");
        }
      }
    }
    const status = await billing.getStatus(req.user.id, req.user.role);
    let usage = null;
    try {
      usage = await computeUsage(req.user.id);
    } catch (err) {
      logger.warn({ err: err.message }, "[billing] computeUsage falhou");
    }
    res.json({ ...status, usage, stripeEnabled: stripeMod.enabled() });
  } catch (err) {
    httpErrors.serverError(res, err, { req, ctx: "GET /api/billing/me" });
  }
});

// Escolha do cliente de quais campanhas/números ficam ATIVOS dentro do plano.
// Body: { groups: [id, …], numbers: ["id", …] } — o que NÃO vier fica pausado
// pelo plano (não envia, não conta no limite, não é apagado). Usada tanto pelo
// "escolher quais campanhas ficam ativas" quanto pela troca de número.
app.put("/api/billing/active-selection", auth.requireAuth, async (req, res) => {
  try {
    const sub = await billing.getByUserId(req.user.id);
    const result = await billing.enforce.setActiveSelection(
      req.user.id, sub, req.user.role, req.body || {},
    );
    if (!result.ok) {
      const { ok, status, ...payload } = result;
      return res.status(status || 400).json(payload);
    }
    let usage = null;
    try {
      usage = await computeUsage(req.user.id);
    } catch { /* usage é informativo — não derruba a resposta */ }
    res.json({ ok: true, planPaused: result.planPaused, usage });
  } catch (err) {
    logger.error({ err: err.message }, "[billing] active-selection falhou");
    httpErrors.serverError(res, err, { req, ctx: "PUT /api/billing/active-selection" });
  }
});

// Detalhes de cobrança pro mount da página (nunca polled): próxima fatura,
// cartão cadastrado e histórico de faturas. Falha parcial → campo null/[].
app.get("/api/billing/details", auth.requireAuth, async (req, res) => {
  try {
    const empty = { upcomingInvoice: null, paymentMethod: null, invoices: [] };
    if (!stripeMod.enabled()) {
      return res.json({ stripeEnabled: false, hasStripeCustomer: false, ...empty });
    }
    const sub = await billing.getByUserId(req.user.id);
    if (!sub?.stripeCustomerId) {
      return res.json({ stripeEnabled: true, hasStripeCustomer: false, ...empty });
    }
    const [upcoming, pm, invoices] = await Promise.allSettled([
      stripeMod.getUpcomingInvoice(sub.stripeCustomerId),
      stripeMod.getDefaultPaymentMethod(sub.stripeCustomerId, sub.stripeSubscriptionId),
      stripeMod.listInvoices(sub.stripeCustomerId),
    ]);
    res.json({
      stripeEnabled: true,
      hasStripeCustomer: true,
      upcomingInvoice: upcoming.status === "fulfilled" ? upcoming.value : null,
      paymentMethod: pm.status === "fulfilled" ? pm.value : null,
      invoices: invoices.status === "fulfilled" ? invoices.value : [],
    });
  } catch (err) {
    logger.error({ err: err.message }, "[billing] details falhou");
    httpErrors.serverError(res, err, { req, ctx: "GET /api/billing/details" });
  }
});

// Cria Checkout Session pra um plano. Body: { planId, trial? }.
// trial=true → "7 dias por R$1" (só plano Básico, 1x por usuário).
// Responde { url } — frontend faz window.location.assign(url).
app.post("/api/billing/checkout", auth.requireAuth, async (req, res) => {
  try {
    if (!stripeMod.enabled()) return res.status(501).json({ error: "Stripe não configurado" });
    const planId = String(req.body?.planId || "").trim();
    const withTrial = !!req.body?.trial;
    if (!["basic", "pro", "business"].includes(planId)) {
      return res.status(400).json({ error: "planId inválido" });
    }
    if (!stripeMod.priceFor(planId)) {
      return res.status(500).json({ error: `Price ID do plano "${planId}" não configurado no servidor` });
    }
    if (withTrial && planId !== "basic") {
      return res.status(400).json({ error: "Trial disponível apenas no plano Básico" });
    }

    // Uma conta = um CPF. Quem tem conta anterior à regra informa o documento
    // aqui mesmo, antes de a assinatura existir.
    if (req.user.cpfRequired) {
      const cpf = cpfUtil.normalizeCpf(req.body?.cpf);
      if (!cpfUtil.isValidCpf(cpf)) {
        return res.status(400).json({ error: "Informe seu CPF para assinar", code: "cpf_required" });
      }
      try {
        await auth.setCpf(req.user.id, cpf);
      } catch (err) {
        return res.status(err.code === "cpf_taken" ? 409 : 400).json({ error: err.message, code: err.code });
      }
    }

    // Telefone obrigatório. Na entrada do painel a tela deixa pular; aqui não:
    // este é o momento em que a conta vira cliente pagante e o número é o canal
    // de suporte. Quem pulou informa no bloco que a página de Assinatura mostra.
    if (req.user.phoneRequired) {
      return res.status(400).json({ error: "Informe seu telefone para assinar", code: "phone_required" });
    }

    // Garante sub existente; pega customer se já tem.
    const sub = await billing.ensureForUser(req.user.id, { planId: "free", status: "inactive" });
    if (withTrial && (sub.trialUsedAt || sub.stripeSubscriptionId)) {
      return res.status(400).json({ error: "Trial já utilizado nesta conta" });
    }
    // req.user.cpf vem mascarado (publicUser) — o documento fiscal precisa do
    // número inteiro, então vem do banco.
    const fullUser = await auth.findById(req.user.id);
    const customer = await stripeMod.getOrCreateCustomer({
      userId: req.user.id,
      email: req.user.email,
      name: req.user.name,
      cpf: fullUser?.cpf,
      existingCustomerId: sub.stripeCustomerId,
    });

    // Persiste customerId se ainda não estava linkado.
    if (!sub.stripeCustomerId) {
      await billing.update(req.user.id, { stripeCustomerId: customer.id });
    }

    // Cortesia correndo: quem decide é a pessoa, no modal da página de
    // Assinatura. `keepManualTrial` false = "cancelar o trial e começar agora".
    // O default é MANTER porque é o único que não cobra por dias que ela já tem
    // — um cliente antigo que não mande o campo nunca é cobrado por engano.
    //
    // Em qualquer um dos dois casos o teste de R$1 não entra: o acesso já está
    // liberado. A elegibilidade fica intacta pra depois; quem a queima é o
    // webhook, e ele sabe distinguir adiamento de teste pago.
    const manterCortesia = req.body?.keepManualTrial !== false;
    const emCortesia = billing.limits.manualTrialActive(sub);
    const adiarAte = manterCortesia ? deferralFor(sub) : null;
    const session = await stripeMod.createCheckoutSession({
      planId,
      customer,
      userId: req.user.id,
      withTrial: withTrial && !emCortesia,
      trialEndsAt: adiarAte,
      // Encerrar a cortesia aqui faria um checkout abandonado custar os dias
      // dela. Quem encerra é o webhook, quando a assinatura de fato existe.
      ...(emCortesia && !manterCortesia ? { metadataExtra: { manualTrialCancel: "1" } } : {}),
    });
    metrics.recordCheckout?.(planId, "ok");
    res.json({ url: session.url });
  } catch (err) {
    metrics.recordCheckout?.(String(req.body?.planId || "unknown"), "error");
    logger.error({ err: err.message }, "[billing] checkout falhou");
    httpErrors.serverError(res, err, { req, ctx: "POST /api/billing/checkout" });
  }
});

// Upgrade de plano numa assinatura que já existe. Body: { planId }.
// Troca o item da assinatura no Stripe e cobra a diferença proporcional na hora
// (proration), em vez de abrir um checkout novo — que criaria uma SEGUNDA
// assinatura pro mesmo cliente. Descer de plano continua indo pelo Portal, que
// agenda a troca pro fim do período já pago.
app.post("/api/billing/change-plan", auth.requireAuth, async (req, res) => {
  try {
    if (!stripeMod.enabled()) return res.status(501).json({ error: "Stripe não configurado" });
    const planId = String(req.body?.planId || "").trim();
    if (!["basic", "pro", "business"].includes(planId)) {
      return res.status(400).json({ error: "planId inválido" });
    }
    const sub = await billing.getByUserId(req.user.id);
    if (!sub?.stripeSubscriptionId) {
      return res.status(400).json({ error: "Sem assinatura ativa — assine um plano primeiro" });
    }
    if (!billing.limits.isUpgrade(sub.planId, planId)) {
      return res.status(400).json({
        error: "Para mudar para um plano menor, use o portal de cobrança — a troca vale a partir da próxima renovação.",
        code: "downgrade_via_portal",
      });
    }
    const norm = await stripeMod.changeSubscriptionPlan(sub.stripeSubscriptionId, planId);
    await billing.update(req.user.id, norm);
    // Upgrade libera limites — despausa o que estava travado pelo plano antigo.
    await applyPlanLimits(req.user.id);
    const status = await billing.getStatus(req.user.id, req.user.role);
    res.json({ ...status, stripeEnabled: true });
  } catch (err) {
    logger.error({ err: err.message }, "[billing] change-plan falhou");
    httpErrors.serverError(res, err, { req, ctx: "POST /api/billing/change-plan" });
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
    httpErrors.serverError(res, err, { req, ctx: "POST /api/billing/portal" });
  }
});

// Reconciliação ativa — busca a assinatura ao vivo no Stripe e atualiza o plano local.
// Chamado pelo frontend ao voltar do checkout (?checkout=success), então o plano é
// corrigido na hora mesmo se o webhook customer.subscription.updated não chegar.
app.post("/api/billing/sync", auth.requireAuth, async (req, res) => {
  try {
    if (!stripeMod.enabled()) return res.status(501).json({ error: "Stripe não configurado" });
    const synced = await reconcileWithStripe(req.user.id);
    const status = await billing.getStatus(req.user.id, req.user.role);
    res.json({ ...status, stripeEnabled: true, synced });
  } catch (err) {
    logger.error({ err: err.message }, "[billing] sync falhou");
    httpErrors.serverError(res, err, { req, ctx: "POST /api/billing/sync" });
  }
});

// Reativa assinatura com cancelamento agendado (cancel_at_period_end → false).
// Permite desfazer o cancelamento direto na página, sem passar pelo portal.
app.post("/api/billing/reactivate", auth.requireAuth, async (req, res) => {
  try {
    if (!stripeMod.enabled()) return res.status(501).json({ error: "Stripe não configurado" });
    const sub = await billing.getByUserId(req.user.id);
    if (!sub?.stripeSubscriptionId) {
      return res.status(400).json({ error: "Sem assinatura ativa para reativar" });
    }
    if (!sub.cancelAtPeriodEnd) {
      return res.status(400).json({ error: "Cancelamento não está agendado" });
    }
    const norm = await stripeMod.reactivateSubscription(sub.stripeSubscriptionId);
    await billing.update(req.user.id, norm);
    const status = await billing.getStatus(req.user.id, req.user.role);
    res.json({ ...status, stripeEnabled: true });
  } catch (err) {
    logger.error({ err: err.message }, "[billing] reactivate falhou");
    httpErrors.serverError(res, err, { req, ctx: "POST /api/billing/reactivate" });
  }
});

// ────────────────────────────────────────────────────────────────────────
// Afiliados ML
// ────────────────────────────────────────────────────────────────────────

// Loja trancada pelo admin: bloqueia escrita/teste de credenciais pro usuário
// comum — a UI já esconde a aba, isto fecha o caminho pelo devtools. Admin
// passa direto, senão não daria pra validar a integração antes de destrancar.
function requireStoreUnlocked(storeId) {
  return (req, res, next) => {
    if (req.user?.role === "admin") return next();
    const msg = storeLocks.lockMessage(storeId);
    if (msg) return res.status(403).json({ error: msg, storeLocked: true });
    next();
  };
}

app.get("/api/affiliate", auth.requireAuth, (req, res) => {
  res.json(affiliate.status(req.user.id));
});

app.put("/api/affiliate", auth.requireAuth, requireStoreUnlocked("ml"), (req, res) => {
  try {
    const { tag, cookie } = req.body || {};
    affiliate.writeConfig(req.user.id, { tag, cookie });
    res.json(affiliate.status(req.user.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/affiliate", auth.requireAuth, requireStoreUnlocked("ml"), (req, res) => {
  try {
    affiliate.clearConfig(req.user.id);
    res.json(affiliate.status(req.user.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/affiliate/test", auth.requireAuth, requireStoreUnlocked("ml"), async (req, res) => {
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
    httpErrors.serverError(res, err, { req, ctx: "POST /api/affiliate/test", expose: true });
  }
});

// ─── Afiliado Amazon ───────────────────────────────────────────────────

app.put("/api/affiliate/amazon", auth.requireAuth, requireStoreUnlocked("amazon"), (req, res) => {
  try {
    const { tag } = req.body || {};
    affiliate.writeAmazonConfig(req.user.id, { tag });
    res.json(affiliate.status(req.user.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/affiliate/amazon", auth.requireAuth, requireStoreUnlocked("amazon"), (req, res) => {
  try {
    affiliate.clearAmazonConfig(req.user.id);
    res.json(affiliate.status(req.user.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/affiliate/amazon/test", auth.requireAuth, requireStoreUnlocked("amazon"), (req, res) => {
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
    httpErrors.serverError(res, err, { req, ctx: "POST /api/affiliate/amazon/test", expose: true });
  }
});

// ─── Afiliado Shopee ───────────────────────────────────────────────────

app.put("/api/affiliate/shopee", auth.requireAuth, requireStoreUnlocked("shopee"), (req, res) => {
  try {
    const { appId, appSecret } = req.body || {};
    affiliate.writeShopeeConfig(req.user.id, { appId, appSecret });
    res.json(affiliate.status(req.user.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/affiliate/shopee", auth.requireAuth, requireStoreUnlocked("shopee"), (req, res) => {
  try {
    affiliate.clearShopeeConfig(req.user.id);
    res.json(affiliate.status(req.user.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/affiliate/shopee/test", auth.requireAuth, requireStoreUnlocked("shopee"), async (req, res) => {
  try {
    const url = req.body?.url;
    if (!url || typeof url !== "string" || !url.trim()) {
      return res.status(400).json({ error: "Forneça uma URL de produto da Shopee pra testar." });
    }
    const short = await affiliate.gerarLinkAfiliadoShopee(req.user.id, url.trim());
    if (!short) {
      const s = affiliate.status(req.user.id);
      const reason = s.shopee.lastFailureReason
        || (!s.shopee.configured ? "Configure App ID e senha da Shopee primeiro." : "Falha ao gerar link");
      return res.status(400).json({ error: reason });
    }
    res.json({ ok: true, shortUrl: short });
  } catch (err) {
    httpErrors.serverError(res, err, { req, ctx: "POST /api/affiliate/shopee/test", expose: true });
  }
});

// Dispara envio do próximo item da fila imediatamente
app.post("/api/state/groups/:gid/send-now", auth.requireAuth, requireActiveSubscription, async (req, res) => {
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
app.post("/api/state/groups/:gid/pending/:pid/approve", auth.requireAuth, requireActiveSubscription, async (req, res) => {
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

// Cupom digitado à mão na fila/revisão: normaliza como o extractCoupon do repasse
// (UPPER, sem espaço nas pontas). Vazio vira null e apaga o cupom — renderTemplate
// já some com a linha inteira do {cupom} quando não tem código.
function normalizeCoupon(v) {
  const s = String(v ?? "").trim().toUpperCase();
  return s ? s.slice(0, 40) : null;
}

// Edita SÓ o cupom de um item da fila ou do pending, com read-modify-write no
// servidor. Não reusa o PUT /queue (replace-all mandado pelo cliente) de propósito:
// no repasse a captura escreve nessas listas o tempo todo, e devolver a lista
// inteira apagaria o que entrou entre o carregamento da tela e o clique.
async function patchItemCoupon(req, res, list) {
  try {
    const groupId = isNaN(Number(req.params.gid)) ? req.params.gid : Number(req.params.gid);
    const raw = req.body?.coupon;
    if (raw != null && typeof raw !== "string") {
      return res.status(400).json({ error: "coupon deve ser texto (ou vazio pra apagar)" });
    }
    const coupon = normalizeCoupon(raw);
    const state = await storage.loadState(req.user.id);
    const group = (state.groups || []).find(g => g.id === groupId);
    if (!group) return res.status(404).json({ error: "Campanha não encontrada" });
    const items = group[list] || [];
    const idx = items.findIndex(i => String(i.id ?? i.key) === String(req.params.iid));
    if (idx < 0) return res.status(404).json({ error: "Produto não encontrado" });
    const newItems = items.map((i, n) => (n === idx ? { ...i, coupon } : i));
    await storage.updateGroupOps(req.user.id, groupId, { [list]: newItems });
    res.json({ ok: true, coupon });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

app.patch("/api/state/groups/:gid/queue/:iid/coupon", auth.requireAuth, requireActiveSubscription,
  (req, res) => patchItemCoupon(req, res, "queue"));
app.patch("/api/state/groups/:gid/pending/:iid/coupon", auth.requireAuth, requireActiveSubscription,
  (req, res) => patchItemCoupon(req, res, "pending"));

// Aprovar TODOS os pendentes de uma vez: move tudo pra queue numa única escrita.
// Evita o race de disparar N aprovações em paralelo (cada uma fazia replace-all
// do pending/queue, colidindo no unique [groupId, productKey]).
app.post("/api/state/groups/:gid/pending/approve-all", auth.requireAuth, requireActiveSubscription, async (req, res) => {
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
app.put("/api/state/groups/:gid/queue", auth.requireAuth, requireActiveSubscription, async (req, res) => {
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
app.post("/api/scraper/fetch-url", auth.requireAuth, requireActiveSubscription, async (req, res) => {
  try {
    const url = req.body?.url;
    if (!url || typeof url !== "string" || !url.trim()) {
      return res.status(400).json({ error: "URL obrigatória" });
    }
    const data = await scrapeSingleProduct(url.trim(), { userId: req.user.id });
    res.json(data);
  } catch (err) {
    console.error("[fetch-url]", err.message);
    // `code` é o motivo tipado (login-wall, nao-e-produto, captcha…): cookie
    // vencido pede ação de quem usa e não pode chegar na tela como "espere".
    res.status(400).json({ error: err.message, code: err.kind || null });
  }
});

// Adiciona um produto manualmente à fila/pending da campanha.
// Body: { url, overrides: { name, price, originalPrice, discount, img, store, category }, force? }
// Resposta:
//  - { ok: true, target, item, ... } quando adicionado
//  - { inCooldown: true, lastSentAt, cooldownMinutes, cooldownLabel } pedindo confirmação (UI manda force=true depois)
//  - 400 com error em duplicata na fila/pending ou validação
app.post("/api/state/groups/:gid/manual-add", auth.requireAuth, requireActiveSubscription, async (req, res) => {
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
app.post("/api/state/groups/:gid/refill", auth.requireAuth, requireActiveSubscription, async (req, res) => {
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

const OFERTAS_SORTS = new Set(["discount_desc", "price_asc", "price_desc", "rating_desc", "lastSeen_desc"]);

// Navegação do catálogo pelo usuário comum — mesma superfície de filtros e
// ordenação que o refill da campanha usa, com paginação. A aba "Busca de
// Produtos" consome isso pra mostrar a prévia do que a busca vai trazer.
app.get("/api/ofertas", auth.requireAuth, async (req, res) => {
  try {
    // `categories` (lista) é o formato novo; `category` (single) continua aceito.
    const listParam = (v) => (v ? String(v).split(",").map(s => s.trim()).filter(Boolean) : null);
    const categories = listParam(req.query.categories) || (req.query.category ? [String(req.query.category)] : null);
    const sources = listParam(req.query.sources);

    const minDiscount = parseInt(req.query.minDiscount) || 0;
    const minPrice = parseFloat(req.query.minPrice) || 0;
    const rawMax = parseFloat(req.query.maxPrice);
    const maxPrice = Number.isFinite(rawMax) && rawMax > 0 ? rawMax : null;
    const minRating = parseFloat(req.query.minRating) || 0;
    const minSales = parseInt(req.query.minSales) || 0;
    const keywords = String(req.query.q || req.query.keywords || "").trim();
    // "só produtos com cupom". O catalog/pg.js:buildWhere já sabia filtrar por isso
    // desde que a coluna `couponCampaignId` existe — o que faltava era esta linha,
    // que é o que liga o filtro à tela.
    const hasCoupon = req.query.hasCoupon === "1" || req.query.hasCoupon === "true";
    const filters = { minDiscount, minPrice, maxPrice, minRating, minSales, keywords, hasCoupon };

    const sortBy = OFERTAS_SORTS.has(req.query.sortBy) ? req.query.sortBy : "discount_desc";

    // Modo paginado (page/pageSize) ou modo legado (limit simples).
    const paginated = req.query.page != null || req.query.pageSize != null;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(60, Math.max(1, parseInt(req.query.pageSize) || 24));
    const limit = paginated ? pageSize : Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    const offset = paginated ? (page - 1) * pageSize : 0;

    // Com `groupId`, a lista já sai sem o que a campanha tem na fila e sem o que
    // ela já mandou alguma vez — o mesmo corte que o preenchimento faz. Antes isso
    // era escondido no navegador depois de receber, o que deixava a página pela
    // metade e fazia o `total` contar justamente o que a tela escondia.
    // `hideRecent=0` traz os já enviados de volta (o botão "Adicionar de novo" do
    // card), e aí sim o tempo de espera entra, na confirmação de reenvio.
    let excludeKeys = null;
    const gid = req.query.groupId ? String(req.query.groupId) : null;
    if (gid) {
      // Escopado no grupo e só na coluna productKey: essa rota é chamada a cada
      // busca da aba, não dá pra puxar o estado inteiro do usuário aqui.
      // Grupo de outro dono não acha e volta null — segue sem exclusão.
      excludeKeys = await storage.loadExcludeKeys(req.user.id, gid, {
        queued: req.query.hideQueued !== "0",
        recent: req.query.hideRecent !== "0",
      });
    }

    // getStats() são 5 agregações na tabela inteira — caro demais pra prévia
    // paginada, que refaz a request a cada ajuste de filtro. Só no modo legado.
    // `excludeKeys` vai nos dois: sem ele no count, o número de páginas mentiria.
    const [products, total, catalogStats] = await Promise.all([
      catalog.query({ categories, sources, excludeKeys, filters, limit, offset, sortBy }),
      catalog.count({ categories, sources, excludeKeys, filters }),
      paginated ? null : catalog.getStats(),
    ]);

    // Os cupons de cada produto da PÁGINA — uma consulta indexada sobre no máximo
    // 60 chaves, e não a tabela inteira. Vai com a conta já feita (`precoComCupom`
    // via `detalheDoCupom`): a regra de quando o cupom vale é do backend, e repetir
    // isso em JavaScript de tela é como as duas sairiam de sincronia.
    //
    // A lista inteira, não só o melhor: um produto coberto por dois cupons mostra os
    // dois. O que o envio vai usar é o primeiro COM palavra — a mesma ordem que o
    // `couponsListForKeys` devolve.
    const mapaCupons = await couponsStore.couponsListForKeys(products.map(p => p.key)).catch(() => new Map());
    const itemsComCupons = products.map(p => {
      const lista = mapaCupons.get(p.key) || [];
      if (!lista.length) return p;
      return {
        ...p,
        coupons: lista.map(c => {
          const d = couponsStore.detalheDoCupom(p.price, c);
          return {
            campaignId: c.campaignId, code: c.code, title: c.title,
            kind: c.kind, value: c.value,
            minPurchase: c.minPurchase, maxDiscount: c.maxDiscount,
            expiresAt: c.expiresAt,
            // Nulos quando o cupom não vale para ESTE preço (compra mínima não
            // atingida, por exemplo): a tela mostra o cupom, mas sem prometer valor.
            priceWithCoupon: d ? d.final : null,
            economia: d ? d.economia : null,
            rotulo: d ? d.rotulo : null,
          };
        }),
      };
    });

    res.json({
      // `total` no modo paginado é o total de matches; no legado mantém o
      // comportamento antigo (tamanho da página) pra não quebrar quem já usa.
      total: paginated ? total : products.length,
      page: paginated ? page : 1,
      pageSize: paginated ? pageSize : products.length,
      category: categories && categories.length === 1 ? categories[0] : null,
      categories,
      sources,
      sortBy,
      items: itemsComCupons,
      products: itemsComCupons,   // alias legado
      ...(catalogStats ? { catalogStats } : {}),
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
    httpErrors.serverError(res, err, { req, ctx: "GET /api/status" });
  }
});

// ────────────────────────────────────────────────────────────────────────
// Admin — gerenciamento de usuários
// ────────────────────────────────────────────────────────────────────────

app.get("/api/admin/users", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    res.json({ users: await auth.listUsers() });
  } catch (err) {
    httpErrors.serverError(res, err, { req, ctx: "GET /api/admin/users" });
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

// Trial manual (cortesia): o admin libera um plano por N dias sem passar pelo
// Stripe. Não é o teste de R$1 — não consome `trialUsedAt` e não cobra nada. Uma
// assinatura paga vence a cortesia; ela só assume no vazio.
//
// `applyPlanLimits` depois de gravar é o que despausa as campanhas/números que
// passam a caber no plano da cortesia (e os repausa na revogação) — mesmo
// encadeamento que `reconcileWithStripe` faz depois de sincronizar com o Stripe.
app.post("/api/admin/users/:id/manual-trial", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const { planId, days, note } = req.body || {};
    if (!SUBSCRIBABLE_PLANS.includes(planId)) {
      return res.status(400).json({ error: "Plano inválido para trial manual" });
    }
    const alvo = await auth.findById(req.params.id);
    if (!alvo) return res.status(404).json({ error: "Usuário não encontrado" });
    await billing.grantManualTrial(req.params.id, {
      planId, days, note, grantedBy: req.user.id,
    });
    await applyPlanLimits(req.params.id, { role: alvo.role });
    res.json({ ok: true, manualTrial: billing.manualTrialInfo(await billing.getByUserId(req.params.id)) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/admin/users/:id/manual-trial", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const alvo = await auth.findById(req.params.id);
    if (!alvo) return res.status(404).json({ error: "Usuário não encontrado" });
    await billing.revokeManualTrial(req.params.id);
    await applyPlanLimits(req.params.id, { role: alvo.role });
    res.json({ ok: true });
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

// Histórico de e-mails transacionais de um usuário — responde ao "não recebi o
// e-mail" do suporte sem precisar abrir o banco. Só metadado: assunto e corpo
// não são guardados.
app.get("/api/admin/users/:id/emails", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const items = await emailLog.listByUser(req.params.id, req.query.limit);
    res.json({ items });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Ficha completa de um usuário — o que a aba de usuários mostra ao expandir a
// linha. Responde "essa conta está pagando? está conectada? está enviando?" sem
// precisar abrir o banco, que era a única forma de saber.
//
// Carregada sob demanda (uma vez por usuário expandido), não no polling da
// lista: junta 6 fontes e não vale rodar isso a cada 20s pra todo mundo.
app.get("/api/admin/users/:id/detail", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const { prisma } = require("./db");
    const userId = String(req.params.id);

    const user = await prisma().user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) return res.status(404).json({ error: "Usuário não encontrado" });

    const [sub, stateRow, groupRows, numberRows, waGroups, emailRows, sessions] =
      await Promise.all([
        billing.getRawByUserId(userId),
        prisma().userState.findUnique({ where: { userId }, select: { planPaused: true, updatedAt: true } }),
        prisma().group.findMany({
          where: { userId },
          orderBy: { createdAt: "asc" },
          select: {
            id: true, name: true, paused: true, scraping: true, whatsappGroupIds: true,
            categories: true, sentToday: true, sentWeek: true, lastSend: true,
            avgDiscount: true, createdAt: true,
            _count: { select: { queue: true, pending: true } },
          },
        }),
        prisma().whatsappNumber.findMany({ where: { userId }, select: { id: true, label: true, phone: true } }),
        prisma().whatsappGroup.count({ where: { userId } }),
        emailLog.listByUser(userId, 20),
        // O status ao vivo é acessório: se o WhatsApp estiver fora, a ficha ainda
        // precisa abrir com o resto dos dados.
        Promise.resolve(wa.listSessions(userId)).catch(() => []),
      ]);

    const planPaused = stateRow?.planPaused || { groups: [], numbers: [] };
    const byNumberId = new Map((sessions || []).map(s => [String(s.numberId), s]));

    const groups = groupRows.map(g => {
      const planPausedHere = billing.enforce.isGroupPlanPaused(planPaused, g.id);
      return {
        id: String(g.id),
        name: g.name,
        kind: g.scraping?.kind === "repasse" ? "repasse" : "scraping",
        paused: g.paused,
        planPaused: planPausedHere,
        active: !g.paused && !planPausedHere,
        whatsappGroups: Array.isArray(g.whatsappGroupIds) ? g.whatsappGroupIds.length : 0,
        categories: Array.isArray(g.categories) ? g.categories.length : 0,
        leaders: repasseLeaders.leadersOf(g.scraping).length,
        sentToday: g.sentToday,
        sentWeek: g.sentWeek,
        lastSend: g.lastSend,
        avgDiscount: g.avgDiscount,
        queue: g._count.queue,
        pending: g._count.pending,
        createdAt: g.createdAt,
      };
    });

    const numbers = numberRows.map(n => {
      const live = byNumberId.get(String(n.id));
      return {
        id: n.id,
        label: n.label,
        phone: n.phone,
        planPaused: billing.enforce.isNumberPlanPaused(planPaused, n.id),
        status: live?.status || "offline",
        stuck: live?.stuck || false,
        lastError: live?.lastError || null,
        info: live?.info || null,
      };
    });

    const aff = affiliate.status(userId);
    const affStatus = {
      ml:     { configured: !!aff.ml.configured,     healthy: !!aff.ml.healthy,     lastFailureReason: aff.ml.lastFailureReason || null },
      amazon: { configured: !!aff.amazon.configured, lastFailureReason: aff.amazon.lastFailureReason || null },
      shopee: { configured: !!aff.shopee.configured, healthy: !!aff.shopee.healthy, lastFailureReason: aff.shopee.lastFailureReason || null },
    };

    // Só vale montar o resumo de repasse pra quem tem campanha de repasse —
    // zeros numa conta que nunca usou repasse parecem falha, não ausência.
    let repasse = null;
    if (groups.some(g => g.kind === "repasse")) {
      const repasseSummary = require("./repasse/summary");
      repasse = await repasseSummary.buildSummary(prisma, { hours: 168, where: { userId } });
    }

    res.json({
      subscription: sub ? {
        ...sub,
        effectivePlanId: billing.limits.effectivePlanId(sub, "user"),
        graceEndsAt: billing.limits.graceEndsAt(sub),
        crossMode: sub.stripeMode && sub.stripeMode !== stripeMod.mode() ? sub.stripeMode : null,
      } : null,
      groups,
      numbers,
      whatsappGroups: waGroups,
      repasse,
      emails: emailRows,
      lastStateUpdate: stateRow?.updatedAt || null,
      // Reusa affiliate.status, mas só o veredito: tag, cookie do ML e appSecret
      // da Shopee são credenciais do usuário e não têm por que trafegar numa
      // tela de admin, nem mesmo como "preview".
      affiliate: affStatus,
    });
  } catch (err) {
    httpErrors.serverError(res, err, { req, ctx: "GET /api/admin/users/:id/detail" });
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
    httpErrors.serverError(res, err, { req, ctx: "GET /api/admin/backups/local", expose: true });
  }
});

app.get("/api/admin/backups/remote", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const result = await backupApi.listRemote();
    res.json(result);
  } catch (err) {
    httpErrors.serverError(res, err, { req, ctx: "GET /api/admin/backups/remote", expose: true });
  }
});

// Cria novo dump local (pode demorar ~10-30s)
app.post("/api/admin/backups/local", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const info = await backupApi.createLocalDump();
    res.json({ ok: true, backup: { name: info.name, size: info.size } });
  } catch (err) {
    httpErrors.serverError(res, err, { req, ctx: "POST /api/admin/backups/local", expose: true });
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
    httpErrors.serverError(res, err, { req, ctx: "POST /api/admin/backups/push", expose: true });
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
    httpErrors.serverError(res, err, { req, ctx: "POST /api/admin/backups/restore", expose: true });
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

// Espaço livre no disco da máquina, com quanto os backups e o banco ocupam.
app.get("/api/admin/system/disk", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    res.json(await diskInfo.report());
  } catch (err) {
    httpErrors.serverError(res, err, { req, ctx: "GET /api/admin/system/disk", expose: true });
  }
});

// ────────────────────────────────────────────────────────────────────────
// Admin — scraper global e catálogo
// ────────────────────────────────────────────────────────────────────────

// appConfig.set() é síncrono e grava no Postgres em background. Nas rotas de
// admin esperamos a confirmação antes de responder: sem isso o painel mostrava
// "salvo" mesmo com o banco fora, e a config sumia no próximo restart.
// Retorna false (e já respondeu 500) quando alguma gravação falhou.
async function confirmConfigSaved(res) {
  const { ok, errors } = await appConfig.flush();
  if (!ok) {
    res.status(500).json({ error: `Falha ao gravar no banco: ${errors[0].message}` });
    return false;
  }
  return true;
}

app.get("/api/admin/scraper/config", auth.requireAuth, auth.requireAdmin, (req, res) => {
  res.json({
    config: adminScraper.readConfig(),
    available: {
      categories: Object.entries(CATEGORIES).map(([id, info]) => ({ id, label: info.label })),
      sources: Object.entries(STORES).map(([id, info]) => ({ id, label: info.label })),
    },
  });
});

app.put("/api/admin/scraper/config", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const cfg = adminScraper.writeConfig(req.body || {});
    if (!await confirmConfigSaved(res)) return;
    res.json({ config: cfg });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Bloqueio de cadastro (beta fechado) — toggle global via AppConfig.
app.get("/api/admin/registration", auth.requireAuth, auth.requireAdmin, (req, res) => {
  res.json({ blocked: auth.isRegistrationBlocked() });
});

app.put("/api/admin/registration", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  const blocked = !!(req.body && req.body.blocked);
  appConfig.set("registration-blocked", { blocked });
  if (!await confirmConfigSaved(res)) return;
  res.json({ blocked });
});

// ── Stripe: modo teste ↔ produção ────────────────────────────────────────
// As credenciais dos dois modos vivem no .env; aqui só se escolhe qual está
// valendo (app_config "stripe-mode"), sem reiniciar o sistema. O catálogo vem
// junto pro admin conferir que os produtos do modo ativo são os certos.
async function stripeAdminPayload() {
  const info = stripeMod.modeInfo();
  if (!stripeMod.enabled()) {
    return { ...info, catalog: [], catalogError: "Modo sem chave secreta configurada no .env" };
  }
  try {
    return { ...info, catalog: await billing.publicPlans(), catalogError: null };
  } catch (err) {
    // Stripe fora do ar não pode derrubar a tela — o admin ainda precisa poder
    // ver a configuração e voltar de modo.
    return { ...info, catalog: [], catalogError: err.message };
  }
}

app.get("/api/admin/stripe", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  res.json(await stripeAdminPayload());
});

app.put("/api/admin/stripe", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const mode = String(req.body?.mode || "").trim();
    const info = stripeMod.modeInfo();
    if (!info.modes[mode]) {
      return res.status(400).json({ error: 'Modo inválido — use "test" ou "live"' });
    }
    const missing = info.modes[mode].missing;
    if (missing.length) {
      return res.status(400).json({
        error: `Modo "${mode}" incompleto — falta no .env do servidor: ${missing.join(", ")}`,
      });
    }
    stripeMod.setMode(mode);
    if (!await confirmConfigSaved(res)) return;
    res.json(await stripeAdminPayload());
  } catch (err) {
    logger.error({ err: err.message }, "[billing] troca de modo falhou");
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

// ────────────────────────────────────────────────────────────────────────
// Admin — ScrapTester (monitor de saúde do scraping)
// ────────────────────────────────────────────────────────────────────────

app.get("/api/admin/scrap-tester/config", auth.requireAuth, auth.requireAdmin, (req, res) => {
  res.json({
    config: scrapTester.readConfig(),
    fieldSpecs: scrapTester.FIELD_SPECS,
    available: {
      categories: scrapTester.AVAILABLE_CATEGORIES,
      sources: scrapTester.AVAILABLE_SOURCES,
    },
  });
});

app.put("/api/admin/scrap-tester/config", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const config = scrapTester.writeConfig(req.body || {});
    if (!await confirmConfigSaved(res)) return;
    res.json({ config });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/admin/scrap-tester/status", auth.requireAuth, auth.requireAdmin, (req, res) => {
  res.json(scrapTester.status());
});

app.post("/api/admin/scrap-tester/run", auth.requireAuth, auth.requireAdmin, (req, res) => {
  try {
    if (scrapTester.status().running) {
      return res.status(409).json({ error: "Teste já em execução" });
    }
    // Não bloqueia a resposta — o scrape real leva minutos.
    scrapTester.runOnce().catch(err => console.error("[scrap-tester.run]", err.message));
    res.json({ ok: true, message: "Teste iniciado em background" });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/admin/scrap-tester/cancel", auth.requireAuth, auth.requireAdmin, (req, res) => {
  const r = scrapTester.cancel();
  if (!r.ok) return res.status(409).json({ error: r.message });
  res.json(r);
});

// Teste avulso de UM link: raspa a página do produto na hora e devolve campo a
// campo o que veio, mais a medição da foto. Não mexe no teste de amostra nem no
// catálogo. Body: { url }.
app.post("/api/admin/scrap-tester/link", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const result = await scrapTester.testLink(req.body?.url, { userId: req.user.id });
    res.json({ result });
  } catch (err) {
    console.error("[scrap-tester.link]", err.message);
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/admin/scrap-tester/history", auth.requireAuth, auth.requireAdmin, (req, res) => {
  res.json({ history: scrapTester.readHistory() });
});

// ── Teste de cupom do Mercado Livre (Admin › Cupom) ────────────────────────
//
// Três modos, do mais barato pro mais caro. Body: { url, code, mode }.
//
//   "rapido"   — responde pelo que o sistema já sabe (a palavra na aba /cupons +
//                a vitrine do cupom no banco). Segundos, sem checkout.
//   "checkout" — tenta o rápido primeiro e só leva o item à tela de pagamento
//                quando ele não conclui. Aí sim demora ~40-90s.
//   "leitura"  — só a página do produto, pra ver o cupom que a loja oferece ali.
//
// Diagnóstico: não grava nada na fila, não envia nada e NUNCA finaliza compra.
app.post("/api/admin/ml-coupon/test", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const result = await mlCoupon.testCoupon({
      url: req.body?.url,
      code: req.body?.code,
      mode: req.body?.mode,
    });
    res.json({ result });
  } catch (err) {
    console.error("[ml-coupon.test]", err.message);
    res.status(400).json({ error: err.message });
  }
});

// O mesmo teste, no Chrome do admin (a extensão). Em dois tempos:
//
//   /local/start   — valida a entrada e roda o caminho RÁPIDO, que responde pelo
//                    que o sistema já sabe, sem abrir nada. Só quando ele não
//                    conclui é que a extensão precisa caminhar pelo checkout.
//   /local/result  — o material cru que a aba trouxe vira veredito, com as mesmas
//                    funções puras do caminho antigo (classifyCouponResult,
//                    extractCheckoutTotal, parseProductCoupons).
app.post("/api/admin/ml-coupon/local/start", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    // A conta do ML é a mesma da rodada de cupons. Duas coisas nela ao mesmo tempo
    // dobram a chance de CAPTCHA — e o CAPTCHA vale pra conta, não pra aba.
    if (mlCupons.status().running) {
      return res.status(409).json({ error: "Tem uma rodada de cupons rodando — espere ela terminar para testar um cupom." });
    }
    res.json(await mlCoupon.prepararTesteLocal({ url: req.body?.url, code: req.body?.code, mode: req.body?.mode }));
  } catch (err) {
    console.error("[ml-coupon.local-start]", err.message);
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/admin/ml-coupon/local/result", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    res.json({ result: await mlCoupon.resultadoTesteLocal({ url: b.url, code: b.code, mode: b.mode, material: b.material, quick: b.quick || null }) });
  } catch (err) {
    console.error("[ml-coupon.local-result]", err.message);
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/admin/ml-coupon/history", auth.requireAuth, auth.requireAdmin, (req, res) => {
  res.json({ history: mlCoupon.readHistory(), running: mlCoupon.isRunning() });
});

// ── Cupons do Mercado Livre (Admin › Cupom › Cupons do ML) ─────────────────
//
// Puxa a lista de cupons da conta do sistema (mercadolivre.com.br/cupons) e,
// para cada cupom, os produtos da vitrine dele — é o que permite dizer "este
// produto tem cupom de 20%" na fila do repasse.
//
// A rodada demora minutos (uma página por cupom), então ela roda SOLTA: esta
// rota dispara e responde na hora; a tela acompanha pelo /status.

app.get("/api/admin/ml-cupons/status", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    res.json({ ...mlCupons.status(), stats: await couponsStore.stats() });
  } catch (err) {
    httpErrors.serverError(res, err, { req, ctx: "GET /api/admin/ml-cupons/status" });
  }
});

app.put("/api/admin/ml-cupons/config", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const config = mlCupons.writeConfig(req.body || {});
    if (!await confirmConfigSaved(res)) return;
    res.json({ config });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// A fila da ETAPA 2: quem ainda não tem vitrine raspada. Separa quem só precisa
// ser lido de quem precisa do "Eu quero" antes — a tela mostra os dois números
// antes de o admin apertar o botão, porque o segundo grupo custa ESCRITA na conta.
app.get("/api/admin/ml-cupons/alvos-produtos", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    res.json(await mlCupons.alvosDeProdutos({
      limit: Number(req.query.limit) || 500,
      campaignIds: req.query.campaignId ? [String(req.query.campaignId)] : null,
    }));
  } catch (err) {
    httpErrors.serverError(res, err, { req, ctx: "GET /api/admin/ml-cupons/alvos-produtos" });
  }
});

// ── A mesma rodada, tocada pelo Chrome do admin (a extensão) ──────────────
//
// O laço vive na TELA: ela abre a página que estas rotas mandam, a extensão lê o
// modelo cru e devolve por aqui. Do lado do servidor não muda nada do que importa —
// o parse é o mesmo `parseFilterProps`, a escolha de quem ativar é o mesmo
// `aAtivar`, a gravação é o mesmo `persistRun`. O que sai do caminho é o Puppeteer,
// que é justamente o que o ML barra com CAPTCHA.

app.post("/api/admin/ml-cupons/local/start", auth.requireAuth, auth.requireAdmin, (req, res) => {
  try {
    res.json(mlCupons.startLocalRun(req.body || {}));
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

// Quem ativar na página que a extensão acabou de ler. Devolve só os rótulos que o
// `aAtivar` aprovou — a extensão não escolhe nada, ela clica no que vier.
app.post("/api/admin/ml-cupons/local/ativar", auth.requireAuth, auth.requireAdmin, (req, res) => {
  try {
    res.json(mlCupons.ativacoesLocais(req.body || {}));
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

// Uma página lida. Devolve a próxima URL a abrir — ou, quando a lista acabou, os
// cupons já gravados e as vitrines que valem a pena colher.
app.post("/api/admin/ml-cupons/local/pagina", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    res.json(await mlCupons.paginaLocal(req.body || {}));
  } catch (err) {
    console.error("[ml-cupons.local-pagina]", err.message);
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/admin/ml-cupons/local/fim", auth.requireAuth, auth.requireAdmin, (req, res) => {
  res.json(mlCupons.fimLocalRun(req.body || {}));
});

// A palavra testada na aba do próprio admin. Chega o material cru — os corpos das
// respostas que a página do ML buscou depois do "Aplicar" — e a leitura é a MESMA
// do caminho do servidor (`lerRespostaDeCodigo`), senão a mesma palavra teria dois
// vereditos dependendo de quem abriu a página.
app.post("/api/admin/ml-cupons/local/palavra", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const source = req.body?.source === "repasse" ? "repasse" : "admin";
    res.json({ result: await mlCupons.checkWordLocal({ ...(req.body || {}), source }) });
  } catch (err) {
    console.error("[ml-cupons.local-palavra]", err.message);
    res.status(400).json({ error: err.message });
  }
});

// Apaga TODOS os cupons guardados (botão "Apagar todos" da aba): a lista, os
// vínculos com produto e o carimbo no catálogo. As PALAVRAS testadas ficam — cada
// uma custou um Chrome aberto com a conta do sistema, e elas voltam a carimbar o
// cupom na próxima rodada.
app.delete("/api/admin/ml-cupons", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  // Apagar no meio de uma rodada é apagar o que ela está gravando: ela ainda tem
  // os cupons em memória e segue escrevendo vínculo em cima do vazio.
  if (mlCupons.status().running) {
    return res.status(409).json({ error: "Tem uma rodada de cupons rodando — cancele e espere ela terminar." });
  }
  try {
    res.json({ ok: true, ...await couponsStore.clearAll() });
  } catch (err) {
    httpErrors.serverError(res, err, { req, ctx: "DELETE /api/admin/ml-cupons" });
  }
});

// Apaga UM cupom (o 🗑 da linha da tabela). Mesma recusa do "apagar todos": mexer
// na lista no meio de uma varredura é apagar o que ela está gravando.
app.delete("/api/admin/ml-cupons/:campaignId", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  if (mlCupons.status().running) {
    return res.status(409).json({ error: "Tem uma rodada de cupons rodando — espere ela terminar." });
  }
  try {
    res.json({ ok: true, ...await couponsStore.deleteCoupon(String(req.params.campaignId)) });
  } catch (err) {
    httpErrors.serverError(res, err, { req, ctx: "DELETE /api/admin/ml-cupons/:campaignId" });
  }
});

app.get("/api/admin/ml-cupons", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const out = await couponsStore.listCoupons({
      page: Number(req.query.page) || 1,
      pageSize: Number(req.query.pageSize) || 50,
      q: req.query.q || "",
      scope: req.query.scope || null,
      grouping: req.query.grouping || null,
      onlyActive: req.query.onlyActive === "true",
      onlyValid: req.query.onlyValid === "true",
      withCode: req.query.withCode === "true",
      sortBy: req.query.sortBy || "lastSeen_desc",
    });
    res.json(out);
  } catch (err) {
    httpErrors.serverError(res, err, { req, ctx: "GET /api/admin/ml-cupons" });
  }
});

app.get("/api/admin/ml-cupons/codes", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    res.json({ codes: await couponsStore.listCodeChecks({ limit: Number(req.query.limit) || 50 }) });
  } catch (err) {
    httpErrors.serverError(res, err, { req, ctx: "GET /api/admin/ml-cupons/codes" });
  }
});

app.get("/api/admin/ml-cupons/:campaignId/produtos", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    res.json(await couponsStore.couponProducts(String(req.params.campaignId), {
      page: Number(req.query.page) || 1,
      pageSize: Number(req.query.pageSize) || 50,
    }));
  } catch (err) {
    httpErrors.serverError(res, err, { req, ctx: "GET /api/admin/ml-cupons/:id/produtos" });
  }
});

// O último passo do diagnóstico da aba Config Test: gerar um link de afiliado do
// SISTEMA para uma URL de produto qualquer.
//
// É o único jeito de provar cookie E tag juntos contra o ML de verdade. Os dois
// aparecem "configurados" na tela sem que nenhum funcione, e é exatamente esse par
// que a landing de afiliado usa pra ler a vitrine de um cupom
// (scraping/ml-vitrine-landing.js) — sem ele a rodada cai no caminho caro, o
// navegador, que o ML barra com CAPTCHA.
//
// Não grava nada: `kind` sai como veio, porque cada valor de ML_LINK_KIND já é um
// diagnóstico diferente (falta config, cookie venceu, URL recusada, erro).
app.post("/api/admin/ml-cupons/diagnostico/link", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  const url = String(req.body?.url || "").trim();
  if (!url) return res.status(400).json({ error: "Informe a URL de um produto do Mercado Livre." });
  try {
    const r = await affiliate.criarLinkAfiliadoMLSistema(url);
    res.json({ ok: !!r.shortUrl, shortUrl: r.shortUrl || null, kind: r.kind, reason: r.reason || null });
  } catch (err) {
    console.error("[ml-cupons.diagnostico-link]", err.message);
    res.status(502).json({ error: err.message });
  }
});

app.post("/api/admin/ml-cupons/:campaignId/sync-produtos", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    res.json(await mlCupons.syncOneCoupon(String(req.params.campaignId)));
  } catch (err) {
    console.error("[ml-cupons.sync-produtos]", err.message);
    res.status(400).json({ error: err.message });
  }
});

// A vitrine colhida pela EXTENSÃO do Chrome do admin (`extension/`, na raiz).
//
// Existe porque a vitrine do cupom não abre para navegador automatizado — nem na
// VPS nem na máquina do admin (sonda de 27/08, prints em `debug-cupom/`). Quem
// percorre é uma aba do Chrome dele, com a sessão dele; a extensão colhe os cards
// e a tela do admin manda pra cá com o login que já está aberto.
//
// `parcial: true` quando a coleta parou no meio (muro, teto de páginas). O que
// entra sem `parcial` vira LISTA FECHADA no banco, e é isso que autoriza o
// sistema a responder "fora da vitrine" — por isso a validação vive no
// coupons/sync.js e não aqui.
app.post("/api/admin/ml-cupons/:campaignId/vitrine-local", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const r = await mlCupons.gravarVitrineLocal(String(req.params.campaignId), body.products, {
      parcial: body.parcial === true || body.parcial === "true",
    });
    res.json(r);
  } catch (err) {
    console.error("[ml-cupons.vitrine-local]", err.message);
    res.status(400).json({ error: err.message });
  }
});

// Trazer UMA campanha que o teste de palavra apontou e o sistema não tem. É o
// passo seguinte ao POST /code: aquele descobre o id da campanha, este vai buscá-la
// na lista da conta e gravar — sem precisar rodar a coleta inteira.
//
// Dispara e devolve, como o /run: a varredura da lista do ML passa dos 90s do
// proxy_read_timeout do nginx. A primeira versão esperava pela busca e morria no
// proxy com "não foi possível conectar", com o Chrome ainda trabalhando do outro lado.
app.post("/api/admin/ml-cupons/:campaignId/importar", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const r = await mlCupons.startImport(String(req.params.campaignId), {
      withProducts: req.body?.withProducts !== false,
    });
    // A campanha já estava aqui: desfecho na hora, sem nada pra acompanhar.
    res.status(r.already ? 200 : 202).json(r);
  } catch (err) {
    console.error("[ml-cupons.importar]", err.message);
    res.status(400).json({ error: err.message });
  }
});

// Onde está a busca de campanha que foi disparada acima.
app.get("/api/admin/ml-cupons/importar/status", auth.requireAuth, auth.requireAdmin, (req, res) => {
  res.json(mlCupons.importStatus());
});

// Testar uma PALAVRA (tipo BRINQUEDOS) no campo "Inserir código do cupom" do ML.
// É a única forma de descobrir a que campanha uma palavra pertence — a página não
// lista as palavras em lugar nenhum.
app.post("/api/admin/ml-cupons/code", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    // Lista fechada: a origem vem do cliente e vira coluna (`ml_coupon_codes.source`).
    // A aba Repasse manda "repasse" — é o que separa a palavra que veio de um grupo
    // líder da que o admin digitou à mão.
    const source = req.body?.source === "repasse" ? "repasse" : "admin";
    res.json({ result: await mlCupons.checkWord(req.body?.word, { source, force: !!req.body?.force }) });
  } catch (err) {
    console.error("[ml-cupons.code]", err.message);
    res.status(400).json({ error: err.message });
  }
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

app.put("/api/admin/scraper/shopee", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const { appId, appSecret } = req.body || {};
    const saved = affiliate.writeScraperShopeeAdminCreds({ appId, appSecret });
    if (!await confirmConfigSaved(res)) return;
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

app.delete("/api/admin/scraper/shopee", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  affiliate.clearScraperShopeeAdminCreds();
  if (!await confirmConfigSaved(res)) return;
  res.json({ ok: true });
});

// Filtros de qualidade aplicados pelo scraper Shopee (rating min, vendas min, etc).
app.get("/api/admin/scraper/shopee/filters", auth.requireAuth, auth.requireAdmin, (req, res) => {
  res.json({ filters: affiliate.readShopeeScraperFilters(), defaults: affiliate.SHOPEE_FILTERS_DEFAULTS });
});

app.put("/api/admin/scraper/shopee/filters", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const saved = affiliate.writeShopeeScraperFilters(req.body || {});
    if (!await confirmConfigSaved(res)) return;
    res.json({ ok: true, filters: saved });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Sessão do Mercado Livre DA CONTA DO SISTEMA — abre páginas que só existem
// logado (Hub de Afiliados). Nada a ver com o cookie que cada usuário cola na
// aba dele: aquele continua servindo só pra gerar link de afiliado com a TAG dele.
// O cookie nunca sai daqui inteiro — só tamanho e prévia.
function mlSessionPayload() {
  const admin = affiliate.readScraperMLAdminSession();
  const active = affiliate.getScraperMLSession();
  return {
    configured: !!(active && active.cookie),
    source: active ? active.source : null,
    cookieLength: active?.cookie ? active.cookie.length : 0,
    cookiePreview: active?.cookie ? active.cookie.slice(0, 30) : null,
    // A tag NÃO é segredo (ela vai no link que o cliente recebe), então vai
    // inteira — ao contrário do cookie, que só sai como tamanho e prévia.
    tag: active?.tag || null,
    updatedAt: admin.updatedAt,
    lastCheckAt: admin.lastCheckAt,
    lastCheckOk: admin.lastCheckOk,
    lastCheckReason: admin.lastCheckReason,
  };
}

app.get("/api/admin/scraper/ml/session", auth.requireAuth, auth.requireAdmin, (req, res) => {
  res.json(mlSessionPayload());
});

app.put("/api/admin/scraper/ml/session", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    // Campo ausente = não mexer nele. É o que permite salvar só a tag sem ter que
    // recolar o cookie inteiro, e vice-versa.
    const patch = {};
    if (body.cookie !== undefined) patch.cookie = body.cookie;
    if (body.tag !== undefined) patch.tag = body.tag;
    affiliate.writeScraperMLAdminSession(patch);
    if (!await confirmConfigSaved(res)) return;
    res.json({ ok: true, ...mlSessionPayload() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/admin/scraper/ml/session", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  affiliate.clearScraperMLAdminSession();
  if (!await confirmConfigSaved(res)) return;
  res.json({ ok: true, ...mlSessionPayload() });
});

// Abre o Hub num navegador de verdade e diz se a sessão entrou. Demora (~30s).
app.post("/api/admin/scraper/ml/session/test", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  const session = affiliate.getScraperMLSession();
  if (!session) return res.status(400).json({ error: "Nenhuma sessão salva — cole o cookie da conta do sistema primeiro." });
  try {
    const r = await mlHub.checkHubAccess(session.cookie);
    // manual: quem clicou já está olhando a tela — testar um cookie que ainda não
    // vale não pode virar aviso de bloqueio no grupo do admin.
    affiliate.recordMLHubCheck({ ok: r.ok, reason: r.reason, manual: true });
    if (!await confirmConfigSaved(res)) return;
    res.json({ ...r, session: mlSessionPayload() });
  } catch (err) {
    affiliate.recordMLHubCheck({ ok: false, reason: err.message, manual: true });
    res.status(502).json({ error: err.message });
  }
});

// De onde o robô tira as ofertas do ML: vitrine pública, Hub de Afiliados, ou as
// duas — e qual delas enche a cota primeiro. `hubAvailable` diz se existe sessão
// do sistema; sem ela o Hub não abre, por mais que esteja marcado.
function mlSourcesPayload() {
  return {
    sources: affiliate.readMLScraperSources(),
    hubAvailable: !!affiliate.getScraperMLSession(),
    defaults: affiliate.ML_SOURCES_DEFAULTS,
  };
}

app.get("/api/admin/scraper/ml/sources", auth.requireAuth, auth.requireAdmin, (req, res) => {
  res.json(mlSourcesPayload());
});

app.put("/api/admin/scraper/ml/sources", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    affiliate.writeMLScraperSources(req.body || {});
    if (!await confirmConfigSaved(res)) return;
    res.json({ ok: true, ...mlSourcesPayload() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Filtros de qualidade do Mercado Livre (admin-only)
app.get("/api/admin/scraper/ml/filters", auth.requireAuth, auth.requireAdmin, (req, res) => {
  res.json({ filters: affiliate.readMLScraperFilters(), defaults: affiliate.ML_FILTERS_DEFAULTS });
});

app.put("/api/admin/scraper/ml/filters", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const saved = affiliate.writeMLScraperFilters(req.body || {});
    if (!await confirmConfigSaved(res)) return;
    res.json({ ok: true, filters: saved });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Filtros de qualidade da Amazon (admin-only)
app.get("/api/admin/scraper/amazon/filters", auth.requireAuth, auth.requireAdmin, (req, res) => {
  res.json({ filters: affiliate.readAmazonScraperFilters(), defaults: affiliate.AMAZON_FILTERS_DEFAULTS });
});

app.put("/api/admin/scraper/amazon/filters", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const saved = affiliate.writeAmazonScraperFilters(req.body || {});
    if (!await confirmConfigSaved(res)) return;
    res.json({ ok: true, filters: saved });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────────────────────
// Trava de loja — admin tranca uma loja e os usuários veem só a mensagem.
// ────────────────────────────────────────────────────────────────────────

// Estado das travas + quantas campanhas usam cada loja (pro admin medir o
// impacto antes de trancar). Contagem varre todas as campanhas — rota é
// admin-only e chamada só ao abrir a aba, então o custo é aceitável.
app.get("/api/admin/stores/locks", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const locks = storeLocks.readStoreLocks();
    const { prisma } = require("./db");
    const rows = await prisma().group.findMany({ select: { scraping: true } });
    const usage = {};
    for (const id of Object.keys(STORES)) usage[id] = 0;
    for (const r of rows) {
      const sources = Array.isArray(r.scraping?.sources) ? r.scraping.sources : [];
      const ids = new Set(sources.map(normalizeSource).filter(Boolean));
      for (const id of ids) if (usage[id] !== undefined) usage[id] += 1;
    }
    res.json({ locks, usage });
  } catch (err) {
    httpErrors.serverError(res, err, { req, ctx: "GET /api/admin/stores/locks" });
  }
});

app.put("/api/admin/stores/:store/lock", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const { locked, message } = req.body || {};
    const saved = storeLocks.writeStoreLock(req.params.store, { locked, message });
    if (!await confirmConfigSaved(res)) return;
    res.json({ ok: true, store: storeLocks.resolveStoreId(req.params.store), lock: saved });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Versão pro usuário comum: só locked + message, sem contagem de uso.
app.get("/api/stores/locks", auth.requireAuth, (req, res) => {
  const all = storeLocks.readStoreLocks();
  const out = {};
  for (const [id, lock] of Object.entries(all)) {
    out[id] = { locked: lock.locked, message: lock.locked ? lock.message : null };
  }
  res.json({ locks: out });
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
      return res.status(400).json({ error: "Configure App ID e senha antes de testar." });
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
    if (!r.ok) return res.status(502).json({ error: `Shopee HTTP ${r.status} — confira App ID/senha` });
    const data = await r.json();
    if (data?.errors?.length) {
      return res.status(502).json({ error: `Shopee API: ${data.errors[0]?.message || "erro"}` });
    }
    const short = data?.data?.generateShortLink?.shortLink || null;
    if (!short) return res.status(502).json({ error: "Sem shortLink na resposta — URL pode não ser de produto válido." });
    res.json({ ok: true, shortUrl: short });
  } catch (err) {
    httpErrors.serverError(res, err, { req, ctx: "POST /api/admin/scraper/shopee/test", expose: true });
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
    httpErrors.serverError(res, err, { req, ctx: "GET /api/admin/catalog" });
  }
});

// ── Detecção de cupom na legenda do grupo líder ──────────────────────────
// As palavras-gatilho ("cupom", "código", "voucher"…) e o tamanho do código
// eram fixos no capture.js; agora vivem em app_config e o admin edita aqui.
// A captura roda no WORKER, que recarrega o app_config a cada 30s — por isso a
// mudança vale em até meio minuto, sem restart.
app.get("/api/admin/repasse/coupon-config", auth.requireAuth, auth.requireAdmin, (req, res) => {
  res.json({ config: couponWords.readConfig(), defaults: couponWords.DEFAULTS });
});

app.put("/api/admin/repasse/coupon-config", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const config = couponWords.writeConfig(req.body || {});
    if (!await confirmConfigSaved(res)) return;
    res.json({ config });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Testador da tela: roda a detecção com a config que ainda está no formulário,
// não com a salva. Serve pra conferir uma palavra nova ANTES de gravar — sem
// isso o único jeito de testar seria postar num grupo líder de verdade.
app.post("/api/admin/repasse/coupon-config/test", auth.requireAuth, auth.requireAdmin, (req, res) => {
  try {
    const text = String((req.body || {}).text || "").slice(0, 4000);
    const config = couponWords.sanitize((req.body || {}).config);
    // Require aqui dentro (e não no topo) como as outras rotas de repasse: o
    // capture.js arrasta scraper/scheduler e a rota é usada de vez em quando.
    const capture = require("./repasse/capture");
    res.json({ coupon: capture.extractCoupon(text, config), config });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Teste automático dos cupons do repasse ───────────────────────────────
// O robô que testa no ML a palavra que a captura pescou e traz a campanha pro
// sistema (backend/repasse/coupon-autotest.js). Até aqui isso era o botão da linha
// na aba, e o filtro padrão dela era "nunca testados" porque era o estado de quase
// todas as linhas.
//
// A config é o freio: cada teste abre um Chrome com a conta do ML, e o número certo
// de palavras por rodada só se descobre olhando o ML reagir.
app.get("/api/admin/repasse/coupon-autotest", auth.requireAuth, auth.requireAdmin, (req, res) => {
  const autotest = require("./repasse/coupon-autotest");
  res.json({
    config: couponAutotestConfig.readConfig(),
    defaults: couponAutotestConfig.DEFAULTS,
    status: autotest.status(),
  });
});

app.put("/api/admin/repasse/coupon-autotest", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const config = couponAutotestConfig.writeConfig(req.body || {});
    if (!await confirmConfigSaved(res)) return;
    // O intervalo virou outro: reagenda, senão o número novo só valeria no próximo
    // restart e a tela mostraria uma cadência que não é a que está rodando.
    const autotest = require("./repasse/coupon-autotest");
    autotest.stop();
    autotest.start();
    res.json({ config, status: autotest.status() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// "Rodar agora": dispara SOLTA e responde na hora. A rodada abre um Chrome por
// palavra e passa dos 90s do proxy_read_timeout do nginx — segurar a conexão é o
// caminho mais curto pro timeout. A tela acompanha pelo status e pelo log.
app.post("/api/admin/repasse/coupon-autotest/run", auth.requireAuth, auth.requireAdmin, (req, res) => {
  const autotest = require("./repasse/coupon-autotest");
  // `manual` passa por cima do `enabled: false` — é um pedido explícito de quem
  // está olhando a tela, e serve justamente pra testar a config antes de ligar.
  autotest.runOnce({ manual: true }).catch(err =>
    console.error("[repasse.coupon-autotest] rodada manual:", err.message));
  res.status(202).json({ started: true, status: autotest.status() });
});

// O diário: uma linha por tentativa do robô. `code` filtra o histórico de um cupom.
app.get("/api/admin/repasse/coupon-autotest/log", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const { listAutotestLog } = require("./repasse/coupon-autotest-log");
    res.json(await listAutotestLog({
      page: req.query.page,
      pageSize: req.query.pageSize,
      code: req.query.code,
    }));
  } catch (err) {
    httpErrors.serverError(res, err, { req, ctx: "GET /api/admin/repasse/coupon-autotest/log" });
  }
});

// ── Varredura dos cupons pela landing (task 12) ──────────────────────────
// Traz para o catálogo os produtos de cada cupom, sem navegador, e as amostras dos
// cards (backend/coupons/landing-sweep.js). É o que faz o produto do sistema
// aparecer com o cupom que vale nele — antes disso eram 4.035 produtos e UM com cupom.
app.get("/api/admin/ml-cupons/landing-sweep", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const sweep = require("./coupons/landing-sweep");
    const sweepConfig = require("./coupons/landing-sweep-config");
    res.json({
      config: sweepConfig.readConfig(),
      defaults: sweepConfig.DEFAULTS,
      status: sweep.status(),
      cobertura: await couponsStore.coberturaStats(),
    });
  } catch (err) {
    httpErrors.serverError(res, err, { req, ctx: "GET /api/admin/ml-cupons/landing-sweep" });
  }
});

app.put("/api/admin/ml-cupons/landing-sweep", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const sweepConfig = require("./coupons/landing-sweep-config");
    const config = sweepConfig.writeConfig(req.body || {});
    if (!await confirmConfigSaved(res)) return;
    // Intervalo novo só vale reagendando — senão a tela mostraria uma cadência que
    // não é a que está rodando.
    const sweep = require("./coupons/landing-sweep");
    sweep.stop();
    sweep.start();
    res.json({ config, status: sweep.status() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// "Rodar agora": SOLTA, responde na hora. 60 cupons a ~2 s mais as pausas passam
// dos 90 s do nginx; a tela acompanha pelo status.
app.post("/api/admin/ml-cupons/landing-sweep/run", auth.requireAuth, auth.requireAdmin, (req, res) => {
  const sweep = require("./coupons/landing-sweep");
  sweep.runOnce({ manual: true }).catch(err =>
    console.error("[cupons.landing-sweep] rodada manual:", err.message));
  res.status(202).json({ started: true, status: sweep.status() });
});

// "Quais cupons valem neste produto?" — pelo link (ou pela chave do catálogo).
// Só o que o sistema já sabe, sem rede: cada cupom vem com a ORIGEM do vínculo,
// porque "está na prévia" e "está na vitrine completa" não são a mesma garantia.
app.get("/api/admin/produtos/cupons", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const { paraProduto } = require("./coupons/product-coupons");
    res.json(await paraProduto({ url: req.query.url ? String(req.query.url) : null, key: req.query.key ? String(req.query.key) : null }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// A sonda do checkout (extensão, comando "cupons-checkout"): guarda em
// backend/logs/ml-checkout-cupons/ o que a tela de cupons mostrou. Não interpreta
// nada — o parser só é escrito depois de alguém olhar isto.
app.post("/api/admin/ml-cupons/sonda-checkout", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const { gravarSonda } = require("./coupons/product-coupons");
    const r = await gravarSonda({ url: req.body?.url ? String(req.body.url) : null, material: req.body?.material });
    res.json({ pasta: require("path").relative(__dirname, r.pasta), resumo: r.resumo });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Os cupons que o repasse pescou, um por linha (Admin › Cupom › Repasse).
// Agrega o log de captura por código e cruza com o dicionário palavra → campanha
// da aba "Descobrir palavra", pra dizer de cada um se já foi testado, de que
// campanha é e se os produtos dela estão no sistema.
app.get("/api/admin/repasse/coupons", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const repasseCoupons = require("./repasse/coupons");
    res.json(await repasseCoupons.listCapturedCoupons({
      page: req.query.page,
      pageSize: req.query.pageSize,
      days: req.query.days,
      status: req.query.status || "todos",
      q: req.query.q || "",
    }));
  } catch (err) {
    httpErrors.serverError(res, err, { req, ctx: "GET /api/admin/repasse/coupons" });
  }
});

// Faxina da aba: "excluir" é ESQUECER o código, não apagar a captura. A coluna
// `coupon` vai a null e o resto da linha (grupo, link, produto, desfecho) fica
// no log de Admin › Repasse — o extractCoupon é heurística sobre texto humano e
// a lista junta lixo ("AQUI", "PROMO"), que enterrava os cupons de verdade.
//
// A rota sem :code limpa o que o FILTRO mostra (mesmos days/status/q do GET),
// pra dar pra varrer só uma situação de cada vez.
app.delete("/api/admin/repasse/coupons", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const repasseCoupons = require("./repasse/coupons");
    res.json({
      ok: true,
      ...await repasseCoupons.forgetFiltered({
        days: req.query.days,
        status: req.query.status || "todos",
        q: req.query.q || "",
      }),
    });
  } catch (err) {
    httpErrors.serverError(res, err, { req, ctx: "DELETE /api/admin/repasse/coupons" });
  }
});

app.delete("/api/admin/repasse/coupons/:code", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const repasseCoupons = require("./repasse/coupons");
    const code = String(req.params.code || "").trim().toUpperCase();
    res.json({ ok: true, code, ...await repasseCoupons.forgetCoupons([code]) });
  } catch (err) {
    httpErrors.serverError(res, err, { req, ctx: "DELETE /api/admin/repasse/coupons/:code" });
  }
});

// Resumo do log de repasse: total por resultado, por motivo, e taxa de sucesso
// por loja numa janela de tempo. É o que faz um bloqueio sistêmico aparecer — na
// lista item a item, 10 falhas do mesmo tipo eram só 10 linhas parecidas.
app.get("/api/admin/repasse/summary", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const { prisma } = require("./db");
    const repasseSummary = require("./repasse/summary");
    // Mesmos filtros da lista, pra o resumo poder ser lido "dentro" de um filtro.
    const where = {};
    if (req.query.userId) where.userId = String(req.query.userId);
    if (req.query.groupId) where.groupId = BigInt(req.query.groupId);
    if (req.query.store) where.store = String(req.query.store);
    res.json(await repasseSummary.buildSummary(prisma, { hours: req.query.hours, where }));
  } catch (err) {
    httpErrors.serverError(res, err, { req, ctx: "GET /api/admin/repasse/summary" });
  }
});

// Log de captura de campanhas de repasse — visibilidade do admin sobre cada
// link visto num grupo líder e o que aconteceu com ele (fila/pendente/descarte).
app.get("/api/admin/repasse/logs", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const { prisma } = require("./db");
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(10, parseInt(req.query.pageSize) || 50));
    const where = {};
    if (req.query.userId) where.userId = String(req.query.userId);
    if (req.query.groupId) where.groupId = BigInt(req.query.groupId);
    if (req.query.store) where.store = String(req.query.store);
    if (req.query.outcome) where.outcome = String(req.query.outcome);
    // Um cupom só. É o que a aba Admin › Cupom › Repasse pede ao expandir uma
    // linha — as capturas individuais daquele código, sem rota nova.
    if (req.query.coupon) where.coupon = String(req.query.coupon).trim().toUpperCase();
    // "none" isola os descartes que NÃO são erro (a fonte não habilitada na
    // campanha) — sem isso não haveria como separá-los dos que precisam de ação.
    if (req.query.errorKind === "none") where.errorKind = null;
    else if (req.query.errorKind) where.errorKind = String(req.query.errorKind);
    if (req.query.stage) where.stage = String(req.query.stage);

    const [total, rows] = await Promise.all([
      prisma().repasseCaptureLog.count({ where }),
      prisma().repasseCaptureLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    const groupIds = [...new Set(rows.map(r => r.groupId))];
    const userIds = [...new Set(rows.map(r => r.userId))];
    // O veredito do cupom de cada linha. Uma consulta pra página inteira, no mesmo
    // molde do nome do grupo e do e-mail: o card já mostra "cupom: JBL20" e sem
    // isso não haveria como dizer ao lado se aquele código foi validado — que é a
    // única pergunta que importa quando o cupom sai na mensagem do cliente.
    const codes = [...new Set(rows.map(r => r.coupon).filter(Boolean))];
    const [groups, users, checks] = await Promise.all([
      groupIds.length ? prisma().group.findMany({ where: { id: { in: groupIds } }, select: { id: true, name: true } }) : [],
      userIds.length ? prisma().user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true, name: true } }) : [],
      codes.length ? prisma().mlCouponCode.findMany({
        where: { code: { in: codes } },
        select: { code: true, verdict: true, checkedAt: true, source: true },
      }) : [],
    ]);
    const groupById = new Map(groups.map(g => [g.id.toString(), g.name]));
    const userById = new Map(users.map(u => [u.id, u]));
    const checkByCode = new Map(checks.map(c => [c.code, c]));

    const items = rows.map(r => ({
      id: r.id.toString(),
      groupId: r.groupId.toString(),
      groupName: groupById.get(r.groupId.toString()) || null,
      userId: r.userId,
      userEmail: userById.get(r.userId)?.email || null,
      waJid: r.waJid,
      rawUrl: r.rawUrl,
      resolvedUrl: r.resolvedUrl,
      store: r.store,
      sourceAllowed: r.sourceAllowed,
      affiliateConfigured: r.affiliateConfigured,
      scrapeOk: r.scrapeOk,
      productName: r.productName,
      productImg: r.productImg,
      price: r.price,
      originalPrice: r.originalPrice,
      discount: r.discount,
      sold: r.sold,
      coupon: r.coupon,
      // null = a palavra nunca foi ao ML. É diferente de "invalid" (o ML não
      // reconheceu), e a tela não pode passar um pelo outro.
      couponVerdict: r.coupon ? (checkByCode.get(r.coupon)?.verdict ?? null) : null,
      couponCheckedAt: r.coupon ? (checkByCode.get(r.coupon)?.checkedAt ?? null) : null,
      couponSource: r.coupon ? (checkByCode.get(r.coupon)?.source ?? null) : null,
      outcome: r.outcome,
      errorKind: r.errorKind,
      stage: r.stage,
      reason: r.reason,
      createdAt: r.createdAt,
    }));

    res.json({ page, pageSize, total, items });
  } catch (err) {
    httpErrors.serverError(res, err, { req, ctx: "GET /api/admin/repasse/logs" });
  }
});

// Apaga TODOS os produtos do catálogo de uma vez (botão "Apagar todos").
app.delete("/api/admin/catalog", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const r = await catalog.clearAll();
    res.json({ ok: true, removed: r.removed });
  } catch (err) {
    httpErrors.serverError(res, err, { req, ctx: "DELETE /api/admin/catalog" });
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
    httpErrors.serverError(res, err, { req, ctx: "GET /api/admin/queue/failed" });
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

app.put("/api/admin/notifications/config", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const saved = adminNotifier.writeConfig(body);
    if (!await confirmConfigSaved(res)) return;
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

// Modelos editáveis das notificações ("Modelos Notificações" no Admin)
app.get("/api/admin/notifications/templates", auth.requireAuth, auth.requireAdmin, (req, res) => {
  res.json(adminNotifier.getTemplates());
});

app.put("/api/admin/notifications/templates", auth.requireAuth, auth.requireAdmin, (req, res) => {
  try {
    res.json(adminNotifier.saveTemplates(req.body || {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/admin/notifications/templates/preview", auth.requireAuth, auth.requireAdmin, (req, res) => {
  try {
    const { key, text } = req.body || {};
    res.json({ text: adminNotifier.renderPreview(key, text) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});


// ────────────────────────────────────────────────────────────────────────
// Tutoriais (tela "Tutoriais" + Admin › Editar Tutoriais)
//
// Antes as seções e tutoriais eram constantes no JSX do front. Agora vêm daqui,
// e o admin edita pela tela sem precisar de deploy.
// ────────────────────────────────────────────────────────────────────────

// Leitura: qualquer usuário logado, INCLUSIVE sem assinatura ativa. Tutorial é
// material de ajuda — quem está travado na assinatura é justamente quem precisa.
app.get("/api/tutoriais", auth.requireAuth, async (req, res) => {
  try {
    res.json(await tutorials.getTree());
  } catch (err) {
    httpErrors.serverError(res, err, { req, ctx: "GET /api/tutoriais" });
  }
});

// Escrita: a árvore inteira de uma vez (a ordem do array vira o `sort`).
// Erro de validação vem com `status: 400` de tutorials/pg.js e a mensagem já
// está em português, pronta pra tela.
app.put("/api/admin/tutoriais", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    res.json(await tutorials.saveTree(req.body || {}));
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    httpErrors.serverError(res, err, { req, ctx: "PUT /api/admin/tutoriais" });
  }
});


// ────────────────────────────────────────────────────────────────────────
// Admin — Modelos de e-mail (tela Admin › E-mails)
//
// O texto dos 17 e-mails do sistema. O override fica em app_config, então a
// gravação passa por confirmConfigSaved: "salvo" na tela só aparece quando o
// Postgres confirmou.
// ────────────────────────────────────────────────────────────────────────

app.get("/api/admin/emails/templates", auth.requireAuth, auth.requireAdmin, (req, res) => {
  res.json(emailRender.getTemplates());
});

app.put("/api/admin/emails/templates", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  let saved;
  try {
    saved = emailRender.saveTemplates(req.body || {});
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  if (!await confirmConfigSaved(res)) return;
  res.json(saved);
});

app.post("/api/admin/emails/preview", auth.requireAuth, auth.requireAdmin, (req, res) => {
  try {
    const { key, block } = req.body || {};
    res.json(emailRender.renderPreview(key, block));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Envia o e-mail de verdade pro admin logado, com os valores de exemplo. Não
// passa por notifications/email de propósito: não deve virar linha no email_log
// nem esbarrar em dedupe/throttle, e o assunto vai marcado como teste.
app.post("/api/admin/emails/test", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const { key } = req.body || {};
    const spec = emailCatalog.get(key);
    if (!spec) return res.status(400).json({ error: `E-mail desconhecido: ${key}` });
    if (!req.user.email) return res.status(400).json({ error: "Sua conta de admin não tem e-mail." });

    const { subject, html, text } = emailRender.renderPreview(key, (req.body || {}).block);
    const r = await emailTransport.sendMail({
      to: req.user.email,
      subject: `[TESTE] ${subject}`,
      html,
      text,
    });
    if (!r.delivered) {
      return res.status(503).json({ error: "SMTP não configurado neste ambiente — nada foi enviado." });
    }
    res.json({ ok: true, to: req.user.email });
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
    httpErrors.serverError(res, err, { req, ctx: "GET /api/admin/whatsnimbus" });
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
    httpErrors.serverError(res, err, { req, ctx: "POST /api/admin/whatsnimbus/connect" });
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
    httpErrors.serverError(res, err, { req, ctx: "POST /api/admin/whatsnimbus/finalize" });
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
    httpErrors.serverError(res, err, { req, ctx: "POST /api/admin/whatsnimbus/disconnect" });
  }
});

app.get("/api/admin/whatsnimbus/groups", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const cfg = whatsnimbus.readConfig();
    if (!cfg.numberId) return res.status(400).json({ error: "WhatsNimbus não está conectado." });
    const groups = await wa.listGroups(whatsnimbus.WHATSNIMBUS_USER_ID, cfg.numberId);
    res.json(groups);
  } catch (err) {
    httpErrors.serverError(res, err, { req, ctx: "GET /api/admin/whatsnimbus/groups" });
  }
});

// Envio manual pelo admin: escolhe um grupo do WhatsNimbus e manda um texto.
app.post("/api/admin/whatsnimbus/send", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const { jid, text } = req.body || {};
    if (!jid) return res.status(400).json({ error: "jid obrigatório" });
    if (!text || !String(text).trim()) return res.status(400).json({ error: "text obrigatório" });
    const cfg = whatsnimbus.readConfig();
    if (!cfg.numberId) return res.status(400).json({ error: "WhatsNimbus não está conectado." });
    await wa.sendText(whatsnimbus.WHATSNIMBUS_USER_ID, cfg.numberId, jid, String(text).trim());
    res.json({ ok: true });
  } catch (err) {
    console.error("[whatsnimbus] send:", err.message);
    httpErrors.serverError(res, err, { req, ctx: "POST /api/admin/whatsnimbus/send" });
  }
});


// ────────────────────────────────────────────────────────────────────────
// WhatsApp (Baileys)
// ────────────────────────────────────────────────────────────────────────

app.get("/api/whatsapp/sessions", auth.requireAuth, async (req, res) => {
  try {
    res.json(await wa.listSessions(req.user.id));
  } catch (err) {
    httpErrors.serverError(res, err, { req, ctx: "GET /api/whatsapp/sessions" });
  }
});

// Plan-gating — número novo conta contra limite `numbers`. Sessão já existente
// (reconect) passa direto pq não estoura contagem. Números pausados pelo plano
// continuam conectados, mas não contam aqui — o que vale é quantos estão ativos.
//
// Devolve o objeto de recusa (pra virar 402) ou null quando pode seguir. Vale pras
// DUAS portas de entrada de sessão (QR e código de pareamento): as duas chamam
// startSession por dentro, e sem a checagem nas duas um curl com ids novos criava
// sessão sem limite pela porta que ficasse de fora.
async function checkNumberSlot(req) {
  if (req.user.role === "admin") return null;
  const existing = await wa.listSessions?.(req.user.id);
  const isNew = !(existing || []).some(s => s.numberId === req.params.id || s.id === req.params.id);
  if (!isNew) return null;
  const sub = await billing.getByUserId(req.user.id);
  const planPaused = await storage.loadPlanPaused(req.user.id);
  const activeExisting = (existing || []).filter(
    s => !billing.enforce.isNumberPlanPaused(planPaused, s.numberId || s.id),
  );
  const count = activeExisting.length + 1;
  const check = billing.limits.checkLimit(sub, "numbers", count, req.user.role);
  return check.ok ? null : check;
}

app.post("/api/whatsapp/sessions/:id", auth.requireAuth, async (req, res) => {
  try {
    const denied = await checkNumberSlot(req);
    if (denied) return res.status(402).json(denied);
    await wa.startSession(req.user.id, req.params.id);
    const s = await wa.getSession(req.user.id, req.params.id);
    res.json({ ok: true, id: req.params.id, status: s?.status });
  } catch (err) {
    console.error("[whatsapp] startSession:", err);
    httpErrors.serverError(res, err, { req, ctx: "POST /api/whatsapp/sessions/:id" });
  }
});

// Código de pareamento: alternativa ao QR (o usuário digita o telefone no site e
// o código de 8 caracteres no celular). O código sai SÓ aqui, na resposta — nunca
// no snapshot do Redis: ele só é resgatável contra o socket exato que o emitiu, e
// um código sobrevivendo ao socket seria pior que nenhum (o WhatsApp diria
// "inválido" e a culpa pareceria nossa).
//
// Recusa esperada volta do wa como { ok: false, reason } — o RPC do BullMQ não
// carrega `err.code`, então erro previsto trafega como valor.
const PAIRING_HTTP_STATUS = {
  BAD_PHONE: 400,
  ALREADY_CONNECTED: 409,
  ALREADY_PAIRED: 409,
  SOCKET_GONE: 503,
  PAIRING_TIMEOUT: 503,
};

app.post("/api/whatsapp/sessions/:id/pairing-code", auth.requireAuth, async (req, res) => {
  try {
    // toWhatsappPhone, NÃO toStoredPhone: aqui o número tem que bater com a conta
    // que o WhatsApp conhece, e há contas antigas de 8 dígitos. Forçar o nono
    // dígito gerava um código válido pra um número inexistente (foi o que
    // aconteceu no primeiro teste, com um número de 8 dígitos).
    const phone = phoneUtil.toWhatsappPhone(req.body?.phone);
    if (!phone) return res.status(400).json({ error: "Informe um celular válido com DDD." });

    const denied = await checkNumberSlot(req);
    if (denied) return res.status(402).json(denied);

    const result = await wa.requestPairingCode(req.user.id, req.params.id, phone);
    if (!result?.ok) {
      const status = PAIRING_HTTP_STATUS[result?.reason] || 503;
      return res.status(status).json({ error: result?.message || "Não foi possível gerar o código.", code: result?.reason });
    }
    res.json(result);
  } catch (err) {
    console.error("[whatsapp] requestPairingCode:", err);
    httpErrors.serverError(res, err, { req, ctx: "POST /api/whatsapp/sessions/:id/pairing-code" });
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
    httpErrors.serverError(res, err, { req, ctx: "GET /api/whatsapp/sessions/:id" });
  }
});

app.delete("/api/whatsapp/sessions/:id", auth.requireAuth, async (req, res) => {
  try {
    await wa.deleteSession(req.user.id, req.params.id);
    // Apagar número libera vaga — despausa na hora quem estava travado pelo
    // plano, em vez de esperar o próximo GET/PUT /api/state.
    await applyPlanLimits(req.user.id, { role: req.user.role });
    res.json({ ok: true });
  } catch (err) {
    httpErrors.serverError(res, err, { req, ctx: "DELETE /api/whatsapp/sessions/:id" });
  }
});

app.get("/api/whatsapp/sessions/:id/groups", auth.requireAuth, async (req, res) => {
  try {
    const groups = await wa.listGroups(req.user.id, req.params.id);
    res.json(groups);
  } catch (err) {
    httpErrors.serverError(res, err, { req, ctx: "GET /api/whatsapp/sessions/:id/groups" });
  }
});

app.post("/api/whatsapp/sessions/:id/groups", auth.requireAuth, async (req, res) => {
  try {
    const { name, participants = [] } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: "name obrigatório" });

    // Teto global de grupos de WhatsApp derivado do plano: nenhuma conta precisa
    // de mais que "campanhas × grupos por campanha". Sem isto, criar grupo real
    // no WhatsApp não passava por gating nenhum — o limite por campanha só é
    // cobrado quando a campanha é salva (PUT /api/state), e quem chamasse a API
    // direto criava quantos quisesse.
    if (req.user.role !== "admin") {
      const sub = await billing.getByUserId(req.user.id);
      const planLimits = billing.limits.getLimits(sub, req.user.role);
      const max = planLimits.groups * planLimits.whatsappGroupsPerCampaign;
      const state = await storage.loadState(req.user.id);
      const current = (state.whatsappGroups || []).length;
      if (current + 1 > max) {
        return res.status(402).json({
          code: "plan_limit",
          key: "whatsappGroupsPerCampaign",
          error: `Seu plano comporta no máximo ${max} grupos de WhatsApp e você já tem ${current}. Apague um grupo ou assine um plano maior.`,
          limit: max,
          current: current + 1,
        });
      }
    }

    let parts = Array.isArray(participants) ? participants.slice() : [];
    parts = [...new Set(parts.map(p => String(p).trim()).filter(Boolean))];

    const s = await wa.getSession(req.user.id, req.params.id);
    if (parts.length === 0) {
      // Sem participantes informados: o WhatsApp exige ao menos 1 além do criador.
      // Usa o próprio número do criador — na prática o grupo fica só com ele mesmo.
      if (!s?.info?.phone) return res.status(400).json({ error: "Sessão não encontrada ou sem número associado." });
      parts = [s.info.phone];
    }
    const group = await wa.createGroup(req.user.id, req.params.id, String(name).trim(), parts);
    res.json(group);
  } catch (err) {
    console.error("[whatsapp] createGroup:", err);
    httpErrors.serverError(res, err, { req, ctx: "POST /api/whatsapp/sessions/:id/groups" });
  }
});

app.get("/api/whatsapp/sessions/:id/groups/:jid/invite", auth.requireAuth, async (req, res) => {
  try {
    const inviteLink = await wa.getInviteLink(req.user.id, req.params.id, req.params.jid);
    res.json({ inviteLink });
  } catch (err) {
    httpErrors.serverError(res, err, { req, ctx: "GET /api/whatsapp/sessions/:id/groups/:jid/invite" });
  }
});

app.post("/api/whatsapp/sessions/:id/groups/:jid/invite/revoke", auth.requireAuth, async (req, res) => {
  try {
    const inviteLink = await wa.revokeInvite(req.user.id, req.params.id, req.params.jid);
    res.json({ inviteLink });
  } catch (err) {
    httpErrors.serverError(res, err, { req, ctx: "POST /api/whatsapp/sessions/:id/groups/:jid/invite/revoke" });
  }
});

app.delete("/api/whatsapp/sessions/:id/groups/:jid", auth.requireAuth, async (req, res) => {
  try {
    await wa.leaveGroup(req.user.id, req.params.id, req.params.jid);
    res.json({ ok: true });
  } catch (err) {
    httpErrors.serverError(res, err, { req, ctx: "DELETE /api/whatsapp/sessions/:id/groups/:jid" });
  }
});

// Teste de conexão do número (botão "Testar" no card). Duas pernas, porque cada
// uma prova uma coisa diferente:
//   1. auto-DM pelo PRÓPRIO número — único jeito de provar que aquela sessão
//      Baileys está enviando. O status "connected" da tela não prova: o snapshot
//      do Redis pode estar velho (ver infra/session-status.js:decaySnapshot) ou o
//      socket ter sido trocado por conflito.
//   2. DM do WhatsNimbus pro número — prova que o remetente das notificações do
//      sistema está de pé. WhatsNimbus desconectado NÃO reprova o teste: vira
//      `skipped`, é informativo.
// As pernas são independentes: a 2 roda mesmo se a 1 falhou — é justamente o
// caso em que o usuário quer saber se ao menos a DM do sistema chega.
const TEST_COOLDOWN_MS = 60 * 1000;
// Janela de espera antes de perguntar se o aparelho pediu reenvio. O retry receipt
// vem em segundos (retryRequestDelayMs do Baileys é 350ms + ida e volta), e 6s cabe
// folgado dentro do cooldown de 60s. Zero em teste pra não arrastar a suíte.
const TEST_RETRY_WAIT_MS = process.env.NODE_ENV === "test" ? 0 : 6000;
const testCooldown = new Map(); // `${userId}::${numberId}` -> timestamp do último teste

app.post("/api/whatsapp/sessions/:id/test", auth.requireAuth, requireActiveSubscription, requireUsableNumber, async (req, res) => {
  try {
    const numberId = String(req.params.id);
    const cooldownKey = `${req.user.id}::${numberId}`;

    // Cada clique dispara DUAS mensagens reais de WhatsApp; martelar o botão é
    // vetor de ban. Map em memória basta: só esta rota lê/escreve e perder o
    // estado num restart é inofensivo.
    if (process.env.NODE_ENV !== "test") {
      const last = testCooldown.get(cooldownKey) || 0;
      const elapsed = Date.now() - last;
      if (elapsed < TEST_COOLDOWN_MS) {
        const retryAfterSeconds = Math.ceil((TEST_COOLDOWN_MS - elapsed) / 1000);
        return res.status(429).json({
          error: `Aguarde ${retryAfterSeconds}s antes de testar este número de novo.`,
          code: "test_cooldown",
          retryAfterSeconds,
        });
      }
      testCooldown.set(cooldownKey, Date.now());
    }

    // Telefone resolvido no servidor — nunca do cliente. A sessão viva é a fonte
    // mais fiel (local.js grava info.phone só dígitos); depois o estado salvo
    // (vem como "+55…", mas jidFromPhone limpa); por último o próprio numberId,
    // que APÓS a canonicalização É o telefone.
    let phone = null;
    try { phone = (await wa.getSession(req.user.id, numberId))?.info?.phone || null; } catch { /* ignore */ }
    if (!phone) {
      try {
        const state = await storage.loadState(req.user.id);
        phone = (state.numbers || []).find(n => String(n.id) === numberId)?.phone || null;
      } catch { /* ignore */ }
    }
    if (!phone && /^\d{8,}$/.test(numberId)) phone = numberId;
    if (!phone) {
      return res.status(400).json({ error: "Não foi possível descobrir o telefone deste número. Reconecte-o e tente de novo." });
    }

    const self = { ok: false };
    let selfMsgId = null;
    try {
      const sent = await wa.sendText(req.user.id, numberId, wa.jidFromPhone(phone), userNotifier.selfTestText());
      selfMsgId = sent?.key?.id || null;
      self.ok = true;
    } catch (err) {
      self.error = err.message;
    }

    const whatsNimbusLeg = { ok: false };
    try {
      await userNotifier.sendConnectionTest(phone);
      whatsNimbusLeg.ok = true;
    } catch (err) {
      whatsNimbusLeg.error = err.message;
      // Não conectado é ausência de configuração, não falha do teste.
      if (/WhatsNimbus não está conectado/.test(err.message)) whatsNimbusLeg.skipped = true;
    }

    // O envio ter saído do servidor NÃO prova que o aparelho conseguiu ler: quando a
    // sessão Signal está dessincronizada, o celular mostra "Aguardando mensagem" e
    // manda um retry receipt pedindo o reenvio. O único sinal disso do nosso lado é o
    // Baileys vir buscar a mensagem no msg-store — que conta os pedidos. Esperamos a
    // janela do retry (segundos) e perguntamos ao worker, dono do store.
    if (self.ok && selfMsgId) {
      if (TEST_RETRY_WAIT_MS) await new Promise(r => setTimeout(r, TEST_RETRY_WAIT_MS));
      try {
        const stats = await wa.msgStats(selfMsgId);
        self.retried = !!(stats && stats.retries > 0);
        self.retries = (stats && stats.retries) || 0;
        // Sem o id no store (worker reiniciado, teto/TTL) não dá pra afirmar nada.
        self.deliveryKnown = !!(stats && stats.known);
      } catch (err) {
        self.deliveryKnown = false;
      }
    }

    // Resultado parcial ainda é um diagnóstico bem-sucedido: 200 e o veredito vai
    // nos campos. `ok` segue a perna que prova o número do usuário.
    res.json({ ok: self.ok, self, whatsnimbus: whatsNimbusLeg });
  } catch (err) {
    console.error("[whatsapp] test:", err.message);
    httpErrors.serverError(res, err, { req, ctx: "POST /api/whatsapp/sessions/:id/test" });
  }
});

app.post("/api/whatsapp/sessions/:id/send", auth.requireAuth, requireActiveSubscription, requireUsableNumber, async (req, res) => {
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
    httpErrors.serverError(res, err, { req, ctx: "POST /api/whatsapp/sessions/:id/send" });
  }
});

app.post("/api/whatsapp/sessions/:id/broadcast", auth.requireAuth, requireActiveSubscription, requireUsableNumber, async (req, res) => {
  try {
    const { jids = [], text, imageUrl, intervalMs = 4000 } = req.body || {};
    if (!Array.isArray(jids) || jids.length === 0) return res.status(400).json({ error: "jids obrigatório (array)" });
    if (!text && !imageUrl) return res.status(400).json({ error: "text ou imageUrl obrigatório" });

    // Sem isto o broadcast era um caminho paralelo sem plano nenhum: aceitava
    // qualquer lista de jids, de qualquer tamanho, sem relação com os grupos
    // vinculados às campanhas — furava `whatsappGroupsPerCampaign` inteiro.
    // Agora só dispara pra grupo REGISTRADO neste número e respeita o teto.
    if (req.user.role !== "admin") {
      const state = await storage.loadState(req.user.id);
      const allowed = new Set();
      for (const w of (state.whatsappGroups || [])) {
        if (String(w.numberId) !== String(req.params.id)) continue;
        allowed.add(String(w.jid || w.id));
        allowed.add(String(w.id));
      }
      const unknown = jids.find(j => !allowed.has(String(j)));
      if (unknown !== undefined) {
        return res.status(400).json({
          error: "Só é possível disparar para grupos de WhatsApp cadastrados neste número.",
          code: "unknown_jid",
          jid: String(unknown),
        });
      }
      const sub = await billing.getByUserId(req.user.id);
      const check = billing.limits.checkLimit(sub, "whatsappGroupsPerCampaign", jids.length, req.user.role);
      if (!check.ok) return res.status(402).json(check);
    }

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
    httpErrors.serverError(res, err, { req, ctx: "POST /api/whatsapp/sessions/:id/broadcast" });
  }
});

// ────────────────────────────────────────────────────────────────────────
// 404 e tratador de erro global. Precisam vir DEPOIS de todas as rotas.
// Sem eles, uma rota async que rejeitasse fora de try/catch caía no handler
// default do Express, que responde HTML — e o frontend, esperando JSON,
// mostrava "Bad Gateway"/stack trace pro usuário.
httpErrors.install(app);

// ────────────────────────────────────────────────────────────────────────

async function boot() {
  // Postgres do compose pode ainda estar subindo quando o PM2 nos inicia; sem
  // esperar, o warmup abaixo estoura e o processo entra em crash-loop.
  const { waitForReady } = require("./db");
  await waitForReady();
  // Pré-aquece JWT secret (Postgres / env) + cache de config (scraper-config +
  // afiliado per-user) — necessário pra auth e pra affiliate.status() /
  // adminScraper.readConfig() funcionarem sync.
  await auth.warmup();
  await auth.bootSeed();
  await appConfig.warmup();
  // Recarrega config do Postgres periodicamente: em modo redis o worker é outro
  // processo com outro cache, e sem isso ele só via mudanças do admin (ex: trava
  // de loja) depois de reiniciar.
  appConfig.startAutoRefresh();
  await affiliate.warmup();

  // Inicializa fila de envios (Fase 2). Server é só PRODUCER — quem registra
  // workers é o backend/worker.js (em redis mode). Em memory é no-op.
  await queueMod.init({ producer: true, consumer: false });

  // Bind em 127.0.0.1: só o nginx (que roda na mesma máquina) alcança a API.
  // Sem o host, o Express escuta em 0.0.0.0 e responde direto pela porta 3001,
  // contornando o nginx e portanto o HTTPS — senhas e tokens em texto claro.
  const server = app.listen(PORT, BIND_HOST, () => {
    console.log(`Nimbus Backend rodando em http://localhost:${PORT} [queue=${queueMod.backendName()}]`);
    console.log(`  GET  /api/ofertas?category=gamer&minDiscount=20&limit=10`);
    console.log(`  GET  /api/status`);
    console.log(`  GET  /api/admin/scraper/config (admin)`);
    console.log(`  POST /api/admin/scraper/run    (admin)`);
    console.log(`  POST /api/admin/scraper/cancel (admin)`);
    console.log(`  GET  /api/admin/users          (admin)`);
    console.log(`  GET  /api/admin/users/:id/detail (admin)`);

    startWaMetrics();
    if (queueMod.isRedis()) {
      // Redis mode: worker.js owna Baileys + processa filas. Server é proxy.
      console.log(`[server] modo redis: rode 'node worker.js' em paralelo (Baileys + workers)`);
    } else {
      // Memory mode (legado): single process owna tudo.
      wa.restoreSessions().catch(err => console.error("[server] restoreSessions:", err.message));
    }
    scheduler.start();
    adminScraper.start();
    scrapTester.start();
    // A rodada GERAL de cupons do ML continua sendo o botão do admin, mas o
    // resultado da última precisa sobreviver ao reboot — senão a tela abre dizendo
    // que nunca rodou.
    mlCupons.loadPersistedStatus();
    // O que tem agenda é o teste dos cupons que o repasse pesca nas legendas: ele
    // roda aqui, e não no worker onde o cupom nasce, porque os mutex do
    // coupons/sync.js são por processo — no worker o robô abriria um segundo Chrome
    // na conta do ML no meio de uma rodada do admin, sem aparecer em tela nenhuma.
    require("./repasse/coupon-autotest").start();
    // A varredura dos cupons pela landing (sem navegador) — mesmo motivo de morar
    // aqui: respeitar os mutex do coupons/sync.js, que são por processo.
    require("./coupons/landing-sweep").start();
    backupMonitor.start();
    billingReminders.start();
    // Fire-and-forget — falha silenciosa se sessão WA ainda não estiver conectada
    setTimeout(() => {
      adminNotifier.notifySystemOnline().catch(err =>
        console.error("[server] notifySystemOnline:", err.message)
      );
    }, 5000);
  });

  // Gauge nimbus_whatsapp_sessions: existia declarado em infra/metrics.js e nunca
  // era .set(), então /metrics reportava sempre zero. Em redis mode as contagens
  // vêm do cache no Redis JÁ decaído (worker morto não conta como conectado); em
  // memory mode, do Map local.
  let _waMetricsTimer = null;

  function startWaMetrics() {
    if (_waMetricsTimer) return;
    const tick = async () => {
      try {
        let counts;
        if (queueMod.isRedis()) {
          counts = await require("./infra/session-status").countsByStatus();
        } else {
          counts = {};
          for (const list of Object.values(wa.listAllSessions() || {})) {
            for (const sess of list) {
              const st = sess.status || "unknown";
              counts[st] = (counts[st] || 0) + 1;
            }
          }
        }
        metrics.waSessions.reset(); // limpa labels de status que zeraram
        for (const [status, n] of Object.entries(counts)) metrics.waSessions.set({ status }, n);
      } catch { /* métrica é acessória */ }
    };
    tick();
    _waMetricsTimer = setInterval(tick, 30_000);
    _waMetricsTimer.unref?.();
  }

  function stopWaMetrics() {
    if (_waMetricsTimer) { clearInterval(_waMetricsTimer); _waMetricsTimer = null; }
  }

  // Shutdown limpo — drena worker (jobs em-vôo terminam) antes de derrubar HTTP
  const shutdown = async (signal) => {
    console.log(`[server] ${signal} recebido, encerrando...`);
    scheduler.stop();
    scrapTester.stop();
    backupMonitor.stop();
    billingReminders.stop();
    stopWaMetrics();
    appConfig.stopAutoRefresh();
    // Em memory mode o SERVER é dono dos sockets Baileys. Sair sem encerrá-los
    // deixa o WhatsApp achando que o device ainda está conectado, e o boot
    // seguinte cai no conflito 401 que o worker já evita com o mesmo closeAll.
    // Em redis mode o closeAll do proxy é no-op (quem fecha é o worker).
    try { await wa.closeAll(); } catch {}
    server.close(() => console.log("[server] HTTP fechado"));
    try { await appConfig.flush(); } catch {}
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
