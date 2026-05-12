// Heartbeat do worker no Redis (Fase 4 / 2.2).
//
// Worker escreve um timestamp ISO a cada N segundos. Server lê e calcula a
// idade; se > threshold, considera worker morto.
//
// Schema:
//   nimbus:worker:heartbeat  →  ISO timestamp (TTL 60s — auto-expira se worker morrer)

require("dotenv").config();

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const KEY = "nimbus:worker:heartbeat";
const HEARTBEAT_INTERVAL_MS = 5000;
const TTL_SECONDS = 60;

let _redis = null;
let _interval = null;

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

// Worker chama. Escreve agora + agenda renovação periódica.
async function start({ extras = {} } = {}) {
  if (_interval) return;
  await write(extras);
  _interval = setInterval(() => {
    write(extras).catch(() => {});
  }, HEARTBEAT_INTERVAL_MS);
}

async function write(extras = {}) {
  const payload = JSON.stringify({
    ts: new Date().toISOString(),
    pid: process.pid,
    ...extras,
  });
  await client().setex(KEY, TTL_SECONDS, payload);
}

// Server chama. Retorna idade em segundos (ou null se nunca recebido / expirado).
async function ageSeconds() {
  const v = await client().get(KEY);
  if (!v) return null;
  try {
    const data = JSON.parse(v);
    const t = new Date(data.ts).getTime();
    if (isNaN(t)) return null;
    return Math.round((Date.now() - t) / 1000);
  } catch {
    return null;
  }
}

async function read() {
  const v = await client().get(KEY);
  if (!v) return null;
  try { return JSON.parse(v); } catch { return null; }
}

async function stop() {
  if (_interval) clearInterval(_interval);
  _interval = null;
  if (_redis) {
    try { await _redis.del(KEY); } catch {}
    try { await _redis.quit(); } catch {}
    _redis = null;
  }
}

module.exports = { start, write, read, ageSeconds, stop, KEY, INTERVAL_MS: HEARTBEAT_INTERVAL_MS };
