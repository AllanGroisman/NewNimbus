// Filas BullMQ — facade memory/redis (Fase 2 + 2.1).
//
// Modos:
//   QUEUE_BACKEND=memory (default) — chama o handler inline. Sem persistência,
//                                    sem retry. Comportamento legado.
//   QUEUE_BACKEND=redis             — BullMQ no Redis. Duas filas:
//                                    - send-message: envios agendados (retry exponencial)
//                                    - control:      RPC server↔worker (await result)
//
// Em redis mode, o **worker** (backend/worker.js) registra os handlers e roda
// os Workers BullMQ; o **server** é só producer (enfileira + aguarda resposta
// da control queue). Isso permite restart do server sem perder sessões Baileys
// e abre caminho pra sharding por número.

require("dotenv").config();

const log = require("./logger").child({ module: "queue" });

const BACKEND = (process.env.QUEUE_BACKEND || "memory").toLowerCase();
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const SEND_QUEUE = "nimbus.send-message";
const CONTROL_QUEUE = "nimbus.control";

let _connection = null;

let _sendQueue = null;
let _sendWorker = null;
let _sendEvents = null;
let _sendHandler = null;

let _controlQueue = null;
let _controlWorker = null;
let _controlEvents = null;
let _controlHandler = null;

function isRedis() { return BACKEND === "redis"; }
function backendName() { return BACKEND; }

function makeConnection() {
  const IORedis = require("ioredis");
  return new IORedis(REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    retryStrategy: (times) => Math.min(times * 200, 3000),
  });
}

// Inicializa as filas. `producer` cria Queue + QueueEvents (necessários pra
// enfileirar e pra `callControl` aguardar resposta). `consumer` é só uma flag
// informativa — Workers só são criados quando setSendHandler/setControlHandler
// são chamados (em backend/worker.js).
async function init({ producer = true, consumer = false } = {}) {
  if (!isRedis()) {
    console.log("[queue] backend=memory (sem persistência, sem retry)");
    return;
  }
  const { Queue, QueueEvents } = require("bullmq");
  _connection = makeConnection();
  // maxRetriesPerRequest: null faz o ioredis segurar o comando pra sempre
  // enquanto reconecta — então este ping nunca rejeitava. Com o Redis fora, o
  // boot ficava pendurado aqui: o processo subia, o app.listen nunca acontecia,
  // e o nginx respondia 502 eternamente sem o PM2 perceber nada de errado.
  //
  // Não degradamos pra memory: em redis mode quem é dono das sessões Baileys é
  // o worker, e um server em memory começaria a abrir sessão por conta própria
  // (foi o que derrubou os números uma vez). Melhor falhar rápido e deixar o
  // PM2 reiniciar até o Redis voltar.
  const PING_TIMEOUT_MS = 5000;
  let pingTimer = null;
  try {
    await Promise.race([
      _connection.ping(),
      new Promise((_, reject) => {
        pingTimer = setTimeout(
          () => reject(new Error(`Redis não respondeu em ${PING_TIMEOUT_MS}ms (${REDIS_URL.replace(/:\/\/.*@/, "://***@")})`)),
          PING_TIMEOUT_MS
        );
      }),
    ]);
  } catch (err) {
    log.error({ err: err.message }, "[queue] Redis indisponível no boot");
    try { _connection.disconnect(); } catch {}
    _connection = null;
    throw err;
  } finally {
    clearTimeout(pingTimer);
  }

  if (producer) {
    _sendQueue = new Queue(SEND_QUEUE, { connection: _connection });
    _controlQueue = new Queue(CONTROL_QUEUE, { connection: _connection });
    _sendEvents = new QueueEvents(SEND_QUEUE, { connection: makeConnection() });
    _controlEvents = new QueueEvents(CONTROL_QUEUE, { connection: makeConnection() });

    _sendEvents.on("failed", ({ jobId, failedReason }) => {
      log.error({ queue: "send", jobId, reason: failedReason }, "job falhou (final)");
      // DLQ: jobs ficam disponíveis pra inspeção via listFailed/retryFailed.
      // Sentry capture pra alertar — failure terminal indica algo digno de atenção.
      try {
        const sentry = require("./sentry");
        sentry.captureMessage(`Send job ${jobId} falhou definitivamente`, "error", {
          tags: { queue: "send", jobId: String(jobId) },
          extra: { reason: failedReason },
        });
      } catch {}
    });
  }
  console.log(`[queue] backend=redis @ ${REDIS_URL} (producer=${producer} consumer=${consumer})`);
}

// Registra o handler de envios agendados. Cria o Worker BullMQ se em redis.
// concurrency=1 + limiter mantém ritmo conservador (Baileys-friendly).
function setSendHandler(fn) {
  if (typeof fn !== "function") throw new Error("[queue] handler deve ser função");
  _sendHandler = fn;
  if (isRedis() && !_sendWorker) {
    const { Worker } = require("bullmq");
    _sendWorker = new Worker(SEND_QUEUE, async (job) => fn(job), {
      connection: makeConnection(),
      concurrency: 1,
      limiter: { max: 1, duration: 1000 },
    });
    _sendWorker.on("error", (err) => log.error({ err, queue: "send" }, "worker error"));
    _sendWorker.on("failed", (job, err) => {
      log.warn({ err, queue: "send", jobId: job?.id, attempt: job?.attemptsMade, max: job?.opts?.attempts }, "tentativa falhou");
    });
    console.log(`[queue/send] worker iniciado`);
  }
}

// Registra o handler de control ops (RPC). concurrency maior porque ops são
// leves (status, list groups) e independentes.
function setControlHandler(fn) {
  if (typeof fn !== "function") throw new Error("[queue] handler deve ser função");
  _controlHandler = fn;
  if (isRedis() && !_controlWorker) {
    const { Worker } = require("bullmq");
    _controlWorker = new Worker(CONTROL_QUEUE, async (job) => fn(job), {
      connection: makeConnection(),
      concurrency: 4,
      // O default (30s) é MENOR que ops legítimas (listGroups/createGroup usam
      // timeout de 60s no proxy). Com ele, uma op lenta era declarada "stalled" e
      // REPROCESSADA — no caso do startSession isso abria um segundo socket pro
      // mesmo número, que o WhatsApp trata como conflito e derruba o device.
      lockDuration: 60_000,
      stalledInterval: 60_000,
      maxStalledCount: 1,
    });
    _controlWorker.on("error", (err) => log.error({ err, queue: "control" }, "worker error"));
    _controlWorker.on("failed", (job, err) => {
      log.warn({ err, queue: "control", jobId: job?.id, op: job?.data?.op }, "control job falhou");
    });
    console.log(`[queue/control] worker iniciado`);
  }
}

// Enfileira um envio agendado. Em memory: chama handler inline.
async function enqueueSend(jobData) {
  if (!isRedis()) {
    if (!_sendHandler) throw new Error("[queue] handler de envio não registrado");
    return _sendHandler({ data: jobData, id: "memory-" + Date.now(), attemptsMade: 0 });
  }
  if (!_sendQueue) throw new Error("[queue] producer não inicializado");
  return _sendQueue.add("send-message", jobData, {
    attempts: 5,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 500 },
  });
}

// Margem sobre o timeout do chamador, pra tolerar latência e clock skew.
const CONTROL_JOB_GRACE_MS = 5000;

// Puro/testável (sem Redis): o job já passou da validade? Com o worker fora, o
// server segue enfileirando (cada POST de QR, cada envio) e TUDO executava de uma
// vez quando ele voltava — startSession de sessão que ninguém olha mais e sendText
// cujo HTTP expirou há minutos. Job sem carimbo (enfileirado por uma versão
// anterior) nunca é descartado.
function isControlJobExpired(enqueuedAt, now, timeoutMs = 30000, graceMs = CONTROL_JOB_GRACE_MS) {
  if (!enqueuedAt) return false;
  return (now - enqueuedAt) > (timeoutMs + graceMs);
}

// RPC: enfileira uma op de controle e AGUARDA o resultado do worker.
// Lança erro se: queue não inicializada, timeout, ou handler retornou erro.
// Em memory mode: lança — chame o módulo local diretamente.
async function callControl(op, args, { timeoutMs = 30000 } = {}) {
  if (!isRedis()) {
    throw new Error("[queue] callControl só em redis mode (use whatsapp-local direto em memory)");
  }
  if (!_controlQueue || !_controlEvents) throw new Error("[queue] producer não inicializado");
  const job = await _controlQueue.add(op, { op, args, enqueuedAt: Date.now(), timeoutMs }, {
    attempts: 1,
    removeOnComplete: { count: 50 },
    removeOnFail: { count: 100 },
  });
  return job.waitUntilFinished(_controlEvents, timeoutMs);
}

async function status() {
  if (!isRedis()) return { backend: "memory", ok: true };
  const out = { backend: "redis", ok: true };
  try {
    if (_sendQueue) {
      out.send = {
        queue: SEND_QUEUE,
        counts: await _sendQueue.getJobCounts("waiting", "active", "delayed", "failed", "completed"),
      };
    }
    if (_controlQueue) {
      out.control = {
        queue: CONTROL_QUEUE,
        counts: await _controlQueue.getJobCounts("waiting", "active", "delayed", "failed", "completed"),
      };
    }
  } catch (err) {
    out.ok = false;
    out.error = err.message;
  }
  return out;
}

// ── DLQ helpers ──────────────────────────────────────────────────────
// BullMQ não tem "dead-letter queue" separada — jobs falhos ficam in-place
// (até `removeOnFail.count`). Estes helpers permitem inspecionar e retentar.

async function listFailed({ queue = "send", start = 0, end = 99 } = {}) {
  if (!isRedis()) return [];
  const q = queue === "control" ? _controlQueue : _sendQueue;
  if (!q) throw new Error("[queue] producer não inicializado");
  const jobs = await q.getJobs(["failed"], start, end, false);
  return jobs.map(j => ({
    id: j.id,
    name: j.name,
    data: j.data,
    failedReason: j.failedReason,
    attemptsMade: j.attemptsMade,
    timestamp: j.timestamp,
    finishedOn: j.finishedOn,
    stacktrace: Array.isArray(j.stacktrace) ? j.stacktrace.slice(0, 2) : null,
  }));
}

async function retryFailed(jobId, { queue = "send" } = {}) {
  if (!isRedis()) throw new Error("[queue] retryFailed só em redis mode");
  const q = queue === "control" ? _controlQueue : _sendQueue;
  if (!q) throw new Error("[queue] producer não inicializado");
  const job = await q.getJob(jobId);
  if (!job) throw new Error(`job ${jobId} não encontrado`);
  await job.retry();
  return { id: job.id, retried: true };
}

async function removeFailed(jobId, { queue = "send" } = {}) {
  if (!isRedis()) throw new Error("[queue] removeFailed só em redis mode");
  const q = queue === "control" ? _controlQueue : _sendQueue;
  if (!q) throw new Error("[queue] producer não inicializado");
  const job = await q.getJob(jobId);
  if (!job) return { removed: false };
  await job.remove();
  return { id: jobId, removed: true };
}

async function close() {
  const ops = [];
  if (_sendWorker) ops.push(_sendWorker.close());
  if (_controlWorker) ops.push(_controlWorker.close());
  if (_sendEvents) ops.push(_sendEvents.close());
  if (_controlEvents) ops.push(_controlEvents.close());
  if (_sendQueue) ops.push(_sendQueue.close());
  if (_controlQueue) ops.push(_controlQueue.close());
  if (_connection) ops.push(_connection.quit().catch(() => {}));
  await Promise.allSettled(ops);
  _sendWorker = _controlWorker = null;
  _sendEvents = _controlEvents = null;
  _sendQueue = _controlQueue = null;
  _connection = null;
}

module.exports = {
  init, isRedis, backendName,
  setSendHandler, setControlHandler,
  enqueueSend, callControl, isControlJobExpired,
  listFailed, retryFailed, removeFailed,
  status, close,
};
