// Cache de status das sessões WhatsApp no Redis (Fase 2.1).
//
// Quem owna a sessão (worker process) PUBLISH em eventos de connection.update.
// Quem precisa ler (server process via whatsapp-proxy) faz READ.
//
// Schema:
//   nimbus:session:<userId>:<numberId>  →  JSON { numberId, status, qr, info, lastError, updatedAt }
//
// IMPORTANTE — o snapshot pode MENTIR. Se o worker morre sem passar pelo
// closeAll (OOM do max_memory_restart, SIGKILL, uncaughtException), a chave fica
// com "connected" até o TTL. Por isso toda leitura passa por `decaySnapshot`,
// que rebaixa status vivo quando não há worker vivo ou o snapshot está velho.

require("dotenv").config();

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const TTL_SECONDS = 86400; // 24h. Re-published a cada evento + refresh de 60s.
// Logout real: a auth foi apagada, então a sessão não volta no restore. O snapshot
// é a única coisa que faz a tela seguir mostrando "Desconectado (relogar)" em vez
// de um "Desconectado" genérico — por isso vive mais.
const TERMINAL_TTL_SECONDS = 7 * 86400;

let _redis = null;

function client() {
  if (_redis) return _redis;
  const IORedis = require("ioredis");
  _redis = new IORedis(REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    retryStrategy: (times) => Math.min(times * 200, 3000),
  });
  return _redis;
}

const KEY = (userId, numberId) => `nimbus:session:${userId}:${numberId}`;
const USER_PATTERN = (userId) => `nimbus:session:${userId}:*`;
const ALL_PATTERN = `nimbus:session:*`;

// ── Decaimento ──────────────────────────────────────────────────────────────
// Status "vivos" só valem enquanto existe um worker vivo que os escreveu.
const LIVE_STATUSES = new Set(["connected", "connecting", "awaiting_qr"]);
// 3× o refresh periódico do local.js (60s). Mais velho que isso = ninguém é dono.
const STALE_SNAPSHOT_MS = 180_000;
// Mesmo limiar que o /healthz usa pra dizer que o worker está vivo.
const WORKER_DEAD_SECONDS = 30;

// Puro/testável. `workerAgeSeconds`: número = idade do heartbeat; null = worker
// nunca escreveu / expirou; undefined = não foi possível apurar → fail-open
// (não rebaixa, pra uma falha de leitura do Redis não pintar tudo de vermelho).
function decaySnapshot(s, { now = Date.now(), workerAgeSeconds, staleMs = STALE_SNAPSHOT_MS } = {}) {
  if (!s || !LIVE_STATUSES.has(s.status)) return s;
  const workerDead = workerAgeSeconds === null
    || (typeof workerAgeSeconds === "number" && workerAgeSeconds > WORKER_DEAD_SECONDS);
  const ts = s.updatedAt ? Date.parse(s.updatedAt) : NaN;
  const tooOld = !Number.isFinite(ts) || (now - ts) > staleMs;
  if (!workerDead && !tooOld) return s;
  return {
    ...s,
    status: "disconnected",
    qr: null,
    stuck: false,
    stale: true,
    lastError: workerDead
      ? "Serviço de conexão indisponível — reconectando."
      : (s.lastError || null),
  };
}

// Idade do heartbeat do worker, com cache curto: a lista do admin lê dezenas de
// snapshots numa tacada e não pode virar um GET por linha.
let _hbAge, _hbAt = 0;
async function workerAge() {
  if (Date.now() - _hbAt < 2000) return _hbAge;
  try { _hbAge = await require("./worker-heartbeat").ageSeconds(); }
  catch { _hbAge = undefined; } // falha de leitura → fail-open
  _hbAt = Date.now();
  return _hbAge;
}

// Worker → Redis: publica snapshot da sessão. `data` deve conter ao menos status.
async function publish(userId, numberId, data) {
  const terminal = !!data.terminal;
  const payload = {
    userId: String(userId),
    numberId: String(numberId),
    status: data.status || null,
    qr: data.qr || null,                     // data URL pra UI mostrar
    info: data.info || null,                 // { id, name, phone }
    lastError: data.lastError || null,
    stuck: data.stuck || false,              // reconexão presa há muito tempo
    terminal,                                // logout real confirmado
    updatedAt: new Date().toISOString(),
  };
  const ttl = terminal ? TERMINAL_TTL_SECONDS : TTL_SECONDS;
  await client().setex(KEY(userId, numberId), ttl, JSON.stringify(payload));
}

async function read(userId, numberId) {
  const json = await client().get(KEY(userId, numberId));
  if (!json) return null;
  const parsed = JSON.parse(json);
  return decaySnapshot(parsed, { workerAgeSeconds: await workerAge() });
}

// SCAN ao invés de KEYS (não bloqueia Redis em datasets grandes)
async function scanKeys(pattern) {
  const stream = client().scanStream({ match: pattern, count: 200 });
  const keys = [];
  for await (const batch of stream) {
    for (const k of batch) keys.push(k);
  }
  return keys;
}

// mget em chunks pra não estourar o comando.
async function readAll(pattern) {
  const keys = await scanKeys(pattern);
  const out = [];
  if (!keys.length) return out;
  const CHUNK = 200;
  for (let i = 0; i < keys.length; i += CHUNK) {
    const values = await client().mget(...keys.slice(i, i + CHUNK));
    for (const v of values) {
      if (!v) continue;
      try { out.push(JSON.parse(v)); } catch { /* linha corrompida: ignora */ }
    }
  }
  return out;
}

// Snapshots CRUS, sem decaimento — usado pela reconciliação de boot do worker,
// que precisa enxergar o "connected" mentiroso pra poder rebaixá-lo.
async function listAllRaw() {
  return readAll(ALL_PATTERN);
}

async function listForUser(userId) {
  const age = await workerAge();
  const rows = await readAll(USER_PATTERN(userId));
  return rows.map(s => decaySnapshot(s, { workerAgeSeconds: age }));
}

// Tudo agrupado por usuário. Uma varredura serve a lista inteira do admin.
async function listAllByUser() {
  const age = await workerAge();
  const out = {};
  for (const raw of await readAll(ALL_PATTERN)) {
    if (!raw?.userId) continue;
    const s = decaySnapshot(raw, { workerAgeSeconds: age });
    (out[s.userId] ||= []).push({
      numberId: s.numberId,
      status: s.status,
      info: s.info || null,
      lastError: s.lastError || null,
      stuck: s.stuck || false,
    });
  }
  return out;
}

async function clear(userId, numberId) {
  await client().del(KEY(userId, numberId));
}

// Status agregado (todos usuários) — usado pelo /healthz.
async function aggregateStatus() {
  const age = await workerAge();
  const rows = await readAll(ALL_PATTERN);
  let total = 0, connected = 0;
  for (const raw of rows) {
    total++;
    if (decaySnapshot(raw, { workerAgeSeconds: age }).status === "connected") connected++;
  }
  return { totalSessions: total, connectedSessions: connected };
}

// Contagem por status (depois do decaimento) — alimenta o gauge Prometheus.
async function countsByStatus() {
  const age = await workerAge();
  const out = {};
  for (const raw of await readAll(ALL_PATTERN)) {
    const st = decaySnapshot(raw, { workerAgeSeconds: age }).status || "unknown";
    out[st] = (out[st] || 0) + 1;
  }
  return out;
}

async function close() {
  if (_redis) {
    try { await _redis.quit(); } catch {}
    _redis = null;
  }
}

module.exports = {
  publish, read, listForUser, listAllByUser, listAllRaw,
  clear, aggregateStatus, countsByStatus, close,
  decaySnapshot, STALE_SNAPSHOT_MS, WORKER_DEAD_SECONDS,
};
