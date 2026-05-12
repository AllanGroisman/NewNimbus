// Cache de status das sessões WhatsApp no Redis (Fase 2.1).
//
// Quem owna a sessão (worker process) PUBLISH em eventos de connection.update.
// Quem precisa ler (server process via whatsapp-proxy) faz READ.
//
// Schema:
//   nimbus:session:<userId>:<numberId>  →  JSON { numberId, status, qr, info, lastError, updatedAt }

require("dotenv").config();

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const TTL_SECONDS = 86400; // 24h. Re-published a cada evento, então não expira em sessão ativa.

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

// Worker → Redis: publica snapshot da sessão. `data` deve conter ao menos status.
async function publish(userId, numberId, data) {
  const payload = {
    userId: String(userId),
    numberId: String(numberId),
    status: data.status || null,
    qr: data.qr || null,                     // data URL pra UI mostrar
    info: data.info || null,                 // { id, name, phone }
    lastError: data.lastError || null,
    updatedAt: new Date().toISOString(),
  };
  await client().setex(KEY(userId, numberId), TTL_SECONDS, JSON.stringify(payload));
}

async function read(userId, numberId) {
  const json = await client().get(KEY(userId, numberId));
  return json ? JSON.parse(json) : null;
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

async function listForUser(userId) {
  const keys = await scanKeys(USER_PATTERN(userId));
  if (!keys.length) return [];
  const values = await client().mget(...keys);
  return values
    .filter(Boolean)
    .map(v => { try { return JSON.parse(v); } catch { return null; } })
    .filter(Boolean);
}

async function clear(userId, numberId) {
  await client().del(KEY(userId, numberId));
}

// Status agregado (todos usuários) — usado pelo /healthz.
async function aggregateStatus() {
  const keys = await scanKeys(ALL_PATTERN);
  let total = 0, connected = 0;
  if (!keys.length) return { totalSessions: 0, connectedSessions: 0 };
  // mget em chunks pra não estourar
  const CHUNK = 200;
  for (let i = 0; i < keys.length; i += CHUNK) {
    const chunk = keys.slice(i, i + CHUNK);
    const values = await client().mget(...chunk);
    for (const v of values) {
      if (!v) continue;
      total++;
      try { if (JSON.parse(v).status === "connected") connected++; } catch {}
    }
  }
  return { totalSessions: total, connectedSessions: connected };
}

async function close() {
  if (_redis) {
    try { await _redis.quit(); } catch {}
    _redis = null;
  }
}

module.exports = { publish, read, listForUser, clear, aggregateStatus, close };
