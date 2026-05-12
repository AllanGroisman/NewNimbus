// worker.js — processo separado que owna Baileys + consome filas (Fase 2.1).
//
// Roda em paralelo ao server. Responsabilidades:
//   - Restaurar sessões Baileys persistidas (auth_states/)
//   - Publicar status das sessões no Redis (pra server ler via whatsapp-proxy)
//   - Consumir queue "send-message" → processSendJob (envios agendados, com retry)
//   - Consumir queue "control"      → handleControlJob (RPC do server)
//
// Pré-condição: QUEUE_BACKEND=redis. Em memory mode, este script sai com erro —
// o server faz tudo no mesmo processo nesse modo.
//
// Uso:
//   node worker.js
//   pm2 start ecosystem.config.js  (sobe server + worker juntos)

// CRÍTICO: setar antes dos requires pra facade do whatsapp.js resolver pra local
process.env.WORKER_PROCESS = "true";

require("dotenv").config();

const queue = require("./infra/queue");
const wa = require("./whatsapp");          // resolve pra whatsapp/local
const scheduler = require("./scheduler");
const appConfig = require("./config");
const { backendName } = require("./db");
const logger = require("./infra/logger");
const sentry = require("./infra/sentry");
const heartbeat = require("./infra/worker-heartbeat");

sentry.init({ context: "worker" });

// Process-level error handlers
process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason, type: "unhandledRejection" }, "[worker] promise sem catch");
  sentry.captureException(reason instanceof Error ? reason : new Error(String(reason)), {
    tags: { type: "unhandledRejection", component: "worker" },
  });
});
process.on("uncaughtException", (err) => {
  logger.fatal({ err, type: "uncaughtException" }, "[worker] uncaught — saindo");
  sentry.captureException(err, { tags: { type: "uncaughtException", component: "worker" } });
  Promise.allSettled([sentry.flush(2000)]).then(() => setTimeout(() => process.exit(1), 500));
});

// Despacha job da control queue pra função local correspondente em wa.
async function handleControlJob(job) {
  const { op, args = [] } = job.data || {};
  if (typeof op !== "string") throw new Error(`control op inválida: ${op}`);
  const fn = wa[op];
  if (typeof fn !== "function") throw new Error(`whatsapp.${op} não existe`);

  const result = await fn(...args);

  // Pra startSession: o resultado de wa.startSession é o objeto session (com
  // referência a sock — não-serializável). Pegamos o snapshot leve.
  if (op === "startSession") {
    const [userId, numberId] = args;
    const s = wa.getSession(userId, numberId);
    return s ? {
      numberId: s.numberId,
      status: s.status,
      info: s.info || null,
      lastError: s.lastError || null,
    } : null;
  }

  // Pra sends: o retorno do Baileys é um WebMessageInfo grande. Reduzimos.
  if (op === "sendText" || op === "sendImage") {
    return { ok: true, key: result?.key || null };
  }

  // createGroup, listGroups, getInviteLink, etc. — retornam estruturas serializáveis.
  return result === undefined ? { ok: true } : result;
}

async function main() {
  console.log(`[worker] iniciando (storage=${backendName()} queue=${queue.backendName()})`);

  if (!queue.isRedis()) {
    console.error("[worker] erro: QUEUE_BACKEND deve ser 'redis'. Em memory mode o server faz tudo. Saindo.");
    process.exit(1);
  }

  await appConfig.warmup();
  await queue.init({ producer: false, consumer: true });

  // Restaura sessões Baileys persistidas (auth_states/ ou tabela baileys_auth
  // dependendo de STORAGE_BACKEND). Eventos connection.update vão publicar
  // status no Redis automaticamente (ver whatsapp-local.js → publishStatus).
  await wa.restoreSessions();

  queue.setSendHandler(scheduler.processSendJob);
  queue.setControlHandler(handleControlJob);

  // Heartbeat — server lê pra detectar worker morto
  await heartbeat.start({ extras: { storage: backendName(), queue: queue.backendName() } });

  console.log("[worker] pronto. Aguardando jobs...");

  const shutdown = async (signal) => {
    console.log(`[worker] ${signal} recebido, encerrando...`);
    try { await heartbeat.stop(); } catch {}
    try { await queue.close(); console.log("[worker] queue fechada"); } catch {}
    try { await sentry.flush(2000); } catch {}
    setTimeout(() => process.exit(0), 1500);
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

main().catch(err => {
  console.error("[worker] falha fatal no boot:", err);
  process.exit(1);
});
