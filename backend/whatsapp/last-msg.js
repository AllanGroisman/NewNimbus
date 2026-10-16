// last-msg — a última mensagem que chegou em cada grupo, por número (task 13).
//
// Por que isto existe: o "Limpar conversa" do WhatsApp (chatModify `clear`) manda
// pro celular um intervalo de mensagens a apagar, e o Baileys exige a key da
// última mensagem do chat pra montar esse intervalo — com `participant` quando
// não fomos nós que mandamos (Utils/chat-utils.js getMessageRange). O sistema não
// guarda mensagens recebidas, então guardamos SÓ a key + timestamp da mais nova de
// cada grupo. Sem conteúdo.
//
// Junto vai `clearedTs`: o timestamp da última mensagem já limpa. Se não chegou
// nada depois dele, a limpeza do grupo é pulada — reenviar o mesmo intervalo seria
// só ruído no app state.
//
// Duas camadas, como o msg-store: memória no processo do socket e, em modo redis,
// um hash por número (`nimbus:walast:<numberId>`, campo = jid). Sem o Redis, todo
// restart do worker zerava o registro e a próxima limpeza pulava tudo até chegar
// mensagem nova. A escrita no Redis é agrupada (flush a cada FLUSH_MS): grupo de
// oferta recebe mensagem o tempo todo, um HSET por mensagem seria desperdício.

const USE_REDIS = (process.env.QUEUE_BACKEND || "memory").toLowerCase() === "redis";
const FLUSH_MS = Number(process.env.WA_LAST_MSG_FLUSH_MS) || 30 * 1000;
const TTL_S = 30 * 24 * 60 * 60;
const RKEY = (numberId) => `nimbus:walast:${numberId}`;

// numberId -> Map(jid -> { key, messageTimestamp, clearedTs })
const store = new Map();
// numberId -> Set(jid) com mudança ainda não gravada no Redis
const dirty = new Map();
// numberIds já lidos do Redis (a hidratação acontece uma vez por processo)
const hydrated = new Set();

let _redis = null;
function redis() {
  if (_redis) return _redis;
  const IORedis = require("ioredis");
  _redis = new IORedis(process.env.REDIS_URL || "redis://localhost:6379", {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    retryStrategy: (times) => Math.min(times * 200, 3000),
  });
  _redis.on("error", () => { /* já logamos por operação; não derruba o worker */ });
  return _redis;
}

function bucket(numberId) {
  const k = String(numberId);
  let m = store.get(k);
  if (!m) { m = new Map(); store.set(k, m); }
  return m;
}

function markDirty(numberId, jid) {
  if (!USE_REDIS) return;
  const k = String(numberId);
  let s = dirty.get(k);
  if (!s) { s = new Set(); dirty.set(k, s); }
  s.add(jid);
  scheduleFlush();
}

let _flushTimer = null;
function scheduleFlush() {
  if (_flushTimer) return;
  _flushTimer = setTimeout(() => { _flushTimer = null; flush().catch(() => {}); }, FLUSH_MS);
  if (_flushTimer.unref) _flushTimer.unref();
}

async function flush() {
  if (!USE_REDIS) return;
  const pending = [...dirty.entries()];
  dirty.clear();
  for (const [numberId, jids] of pending) {
    const m = store.get(numberId);
    if (!m) continue;
    const fields = [];
    for (const jid of jids) {
      const e = m.get(jid);
      if (e) fields.push(jid, JSON.stringify(e));
    }
    if (!fields.length) continue;
    try {
      await redis().multi().hset(RKEY(numberId), ...fields).expire(RKEY(numberId), TTL_S).exec();
    } catch (err) {
      console.error(`[wa] last-msg: falha ao gravar ${numberId} no Redis: ${err.message}`);
    }
  }
}

async function hydrate(numberId) {
  const k = String(numberId);
  if (!USE_REDIS || hydrated.has(k)) return;
  hydrated.add(k);
  try {
    const all = await redis().hgetall(RKEY(k));
    const m = bucket(k);
    for (const [jid, raw] of Object.entries(all || {})) {
      let e;
      try { e = JSON.parse(raw); } catch { continue; }
      const cur = m.get(jid);
      // O que chegou em memória depois do restart é mais novo que o do Redis.
      if (!cur) m.set(jid, e);
      else if (!cur.clearedTs && e.clearedTs) cur.clearedTs = e.clearedTs;
    }
  } catch (err) {
    hydrated.delete(k);
    console.error(`[wa] last-msg: falha ao ler ${k} do Redis: ${err.message}`);
  }
}

function tsOf(m) {
  const t = m && m.messageTimestamp;
  if (t == null) return 0;
  // Long do protobuf ou número/string.
  const n = typeof t === "object" && typeof t.toNumber === "function" ? t.toNumber() : Number(t);
  return Number.isFinite(n) ? n : 0;
}

// Chamado pelo listener messages.upsert. Nunca lança.
function onUpsert(numberId, messages) {
  if (!numberId || !Array.isArray(messages)) return;
  for (const msg of messages) {
    try {
      const key = msg && msg.key;
      const jid = key && key.remoteJid;
      if (!jid || !jid.endsWith("@g.us") || !key.id) continue;
      const ts = tsOf(msg);
      if (!ts) continue;
      // Mensagem de outro membro sem participant não serve pro intervalo (o
      // Baileys recusa) — melhor ficar com a anterior válida.
      if (!key.fromMe && !key.participant) continue;
      const m = bucket(numberId);
      const cur = m.get(jid);
      if (cur && cur.messageTimestamp >= ts) continue;
      m.set(jid, {
        key: { remoteJid: jid, id: key.id, fromMe: !!key.fromMe, ...(key.participant ? { participant: key.participant } : {}) },
        messageTimestamp: ts,
        clearedTs: cur ? cur.clearedTs || 0 : 0,
      });
      markDirty(numberId, jid);
    } catch { /* ignore */ }
  }
}

async function get(numberId, jid) {
  await hydrate(numberId);
  const e = bucket(numberId).get(jid);
  return e ? { ...e, key: { ...e.key } } : null;
}

function markCleared(numberId, jid, ts) {
  const m = bucket(numberId);
  const e = m.get(jid);
  if (!e) return;
  e.clearedTs = Math.max(e.clearedTs || 0, ts);
  markDirty(numberId, jid);
}

module.exports = {
  onUpsert,
  get,
  markCleared,
  flush,
  // Só pra teste.
  __clear: () => { store.clear(); dirty.clear(); hydrated.clear(); },
};
