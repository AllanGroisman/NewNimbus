// worker.js — processo separado que owna Baileys + consome filas (Fase 2.1).
//
// Roda em paralelo ao server. Responsabilidades:
//   - Restaurar sessões Baileys persistidas (tabela baileys_auth)
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

require("./config/loadEnv"); // carrega .env + override por modo (prod | ngrok)

const queue = require("./infra/queue");
const wa = require("./whatsapp");          // resolve pra whatsapp/local
const scheduler = require("./scheduler");
const appConfig = require("./config");
const auth = require("./auth");
const affiliate = require("./scraping/affiliate");
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
  const { op, args = [], enqueuedAt = null, timeoutMs = 30000 } = job.data || {};
  if (typeof op !== "string") throw new Error(`control op inválida: ${op}`);

  // Quem pediu já desistiu faz tempo (o HTTP expirou antes do worker voltar):
  // executar agora só cria sessão que ninguém está olhando e erro no log.
  // `return` em vez de `throw`: não é falha, é descarte — não queremos ruído de
  // DLQ/Sentry por um job que ninguém espera mais.
  if (queue.isControlJobExpired(enqueuedAt, Date.now(), timeoutMs)) {
    logger.warn({ op, jobId: job?.id, ageMs: Date.now() - enqueuedAt },
      "[worker] control job expirado — descartado");
    return { ok: false, skipped: "expired" };
  }

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
  console.log(`[worker] iniciando (queue=${queue.backendName()})`);

  if (!queue.isRedis()) {
    console.error("[worker] erro: QUEUE_BACKEND deve ser 'redis'. Em memory mode o server faz tudo. Saindo.");
    process.exit(1);
  }

  // Mesmo motivo do server.js: esperar o Postgres em vez de morrer e deixar o
  // PM2 reiniciar em loop até o banco aceitar conexão.
  const { waitForReady } = require("./db");
  await waitForReady();

  await appConfig.warmup();
  // Cache de config é por processo: sem esse refresh o worker só veria uma trava
  // de loja (ou filtro) alterada pelo admin depois de ser reiniciado.
  appConfig.startAutoRefresh();
  await auth.warmup();
  // Cache de afiliados (tag/cookie por usuário) — sem isso a captura de repasse
  // vê todo mundo como "não configurado" e descarta os links silenciosamente.
  await affiliate.warmup();
  // Quem grava a config é o server (aba de afiliado): sem o refresh, trocar a
  // TAG ou recolar o cookie só valeria aqui depois de reiniciar o worker.
  affiliate.startAutoRefresh();
  await auth.bootSeed();
  await queue.init({ producer: false, consumer: true });

  // Restaura sessões Baileys persistidas (tabela baileys_auth). Eventos
  // connection.update vão publicar status no Redis automaticamente
  // (ver whatsapp-local.js → publishStatus).
  await wa.restoreSessions();

  queue.setSendHandler(scheduler.processSendJob);
  queue.setControlHandler(handleControlJob);

  // Heartbeat — server lê pra detectar worker morto
  await heartbeat.start({ extras: { queue: queue.backendName() } });

  console.log("[worker] pronto. Aguardando jobs...");

  const shutdown = async (signal) => {
    console.log(`[worker] ${signal} recebido, encerrando...`);
    // Fecha os sockets WhatsApp antes de sair: evita que o WhatsApp veja o device
    // antigo "ainda conectado" quando o próximo worker reconectar (conflito 401).
    try { await wa.closeAll(); console.log("[worker] sessões WhatsApp encerradas"); } catch {}
    try { appConfig.stopAutoRefresh(); await appConfig.flush(); } catch {}
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
