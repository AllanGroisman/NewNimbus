const path = require("path");
const fs = require("fs");

// Em modo redis + worker process, publica snapshot da sessão no Redis pra que
// o server (whatsapp-proxy) consiga ler status/QR sem RPC. Lazy-required pra não
// criar conexão Redis em modo memory.
const PUBLISH_STATUS = (process.env.QUEUE_BACKEND || "memory").toLowerCase() === "redis"
  && process.env.WORKER_PROCESS === "true";
let _sessionStatus = null;
function sessionStatus() {
  if (!_sessionStatus) _sessionStatus = require("./session-status");
  return _sessionStatus;
}
function publishStatus(session) {
  if (!PUBLISH_STATUS) return;
  // Fire-and-forget. Erros de Redis não devem derrubar Baileys.
  sessionStatus().publish(session.userId, session.numberId, {
    status: session.status,
    qr: session.qrDataUrl || null,
    info: session.info || null,
    lastError: session.lastError || null,
  }).catch(err => console.error(`[whatsapp-local] publishStatus falhou: ${err.message}`));
}

let baileys, QRCode, pino;
try {
  baileys = require("@whiskeysockets/baileys");
  QRCode = require("qrcode");
  pino = require("pino");
} catch (e) {
  console.error("[whatsapp] dependências de WhatsApp não instaladas:", e.message);
  console.error("[whatsapp] rode: cd backend && npm install");
  module.exports = makeStub();
  return;
}

const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = baileys;

const AUTH_DIR = path.join(__dirname, "auth_states");
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

// Auth state em Postgres (Fase 3) quando STORAGE_BACKEND=pg.
// Em modo json (legado): usa useMultiFileAuthState (arquivos em auth_states/).
const USE_PG_AUTH = (process.env.STORAGE_BACKEND || "json").toLowerCase() === "pg";
let _pgAuth = null;
function pgAuth() {
  if (!_pgAuth) _pgAuth = require("./baileys-auth-pg");
  return _pgAuth;
}

const log = pino({ level: "warn" });

// chave: `${userId}::${numberId}` -> { sock, status, qr, qrDataUrl, info, ... }
const sessions = new Map();

function key(userId, numberId) { return `${userId}::${numberId}`; }
function dirFor(userId, numberId) {
  const safeUser = String(userId).replace(/[^a-zA-Z0-9_-]/g, "_");
  const safeNum = String(numberId).replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(AUTH_DIR, safeUser, safeNum);
}

function normalizePhone(p) { return String(p).replace(/\D/g, ""); }
function jidFromPhone(phone) { return `${normalizePhone(phone)}@s.whatsapp.net`; }

async function startSession(userId, numberId) {
  userId = String(userId);
  numberId = String(numberId);
  const dir = dirFor(userId, numberId);
  if (!USE_PG_AUTH && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const k = key(userId, numberId);
  const existing = sessions.get(k);
  if (existing?.sock && existing.status === "connected") return existing;

  const { state, saveCreds } = USE_PG_AUTH
    ? await pgAuth().useDatabaseAuthState(`${userId}::${numberId}`)
    : await useMultiFileAuthState(dir);
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ["Nimbus", "Chrome", "1.0"],
    logger: log,
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  const session = sessions.get(k) || { userId, numberId, restartCount: 0 };
  session.sock = sock;
  session.status = session.status && session.status !== "logged_out" ? session.status : "connecting";
  session.lastError = null;
  sessions.set(k, session);
  publishStatus(session);

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      session.qr = qr;
      try { session.qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 280 }); } catch {}
      session.status = "awaiting_qr";
      publishStatus(session);
    }

    if (connection === "open") {
      session.status = "connected";
      session.qr = null;
      session.qrDataUrl = null;
      session.info = sock.user ? {
        id: sock.user.id,
        name: sock.user.name || sock.user.verifiedName || null,
        phone: (sock.user.id || "").split(":")[0].split("@")[0] || null,
      } : null;
      session.restartCount = 0;
      publishStatus(session);
    }

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      session.status = loggedOut ? "logged_out" : "disconnected";
      session.lastError = lastDisconnect?.error?.message || null;
      session.qr = null;
      session.qrDataUrl = null;
      publishStatus(session);

      if (loggedOut) {
        if (USE_PG_AUTH) {
          pgAuth().deleteSession(`${userId}::${numberId}`).catch(() => {});
        } else {
          try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
        }
        return;
      }

      session.restartCount = (session.restartCount || 0) + 1;
      const delay = Math.min(30000, 1500 * session.restartCount);
      setTimeout(() => {
        startSession(userId, numberId).catch(err => {
          console.error(`[whatsapp] erro ao reconectar ${userId}/${numberId}:`, err.message);
        });
      }, delay);
    }
  });

  return session;
}

function getSession(userId, numberId) {
  return sessions.get(key(userId, numberId));
}

function listSessions(userId) {
  const u = String(userId);
  return Array.from(sessions.values())
    .filter(s => s.userId === u)
    .map(s => ({
      numberId: s.numberId,
      status: s.status,
      info: s.info || null,
      lastError: s.lastError || null,
    }));
}

async function deleteSession(userId, numberId) {
  userId = String(userId);
  numberId = String(numberId);
  const k = key(userId, numberId);
  const s = sessions.get(k);
  if (s?.sock) {
    try { await s.sock.logout(); } catch {}
    try { s.sock.end(); } catch {}
  }
  sessions.delete(k);
  if (USE_PG_AUTH) {
    try { await pgAuth().deleteSession(`${userId}::${numberId}`); } catch {}
  } else {
    const dir = dirFor(userId, numberId);
    if (fs.existsSync(dir)) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  }
  if (PUBLISH_STATUS) {
    try { await sessionStatus().clear(userId, numberId); } catch {}
  }
}

function ensureConnected(userId, numberId) {
  const s = sessions.get(key(userId, numberId));
  if (!s?.sock) throw new Error("Sessão não encontrada — adicione o número primeiro.");
  if (s.status !== "connected") throw new Error(`Sessão não está conectada (status: ${s.status}).`);
  return s;
}

async function sendText(userId, numberId, jid, text) {
  const s = ensureConnected(userId, numberId);
  return s.sock.sendMessage(jid, { text });
}

async function sendImage(userId, numberId, jid, imageUrl, caption) {
  const s = ensureConnected(userId, numberId);
  return s.sock.sendMessage(jid, { image: { url: imageUrl }, caption });
}

async function createGroup(userId, numberId, name, participantPhones) {
  const s = ensureConnected(userId, numberId);
  const jids = participantPhones.map(jidFromPhone);
  const result = await s.sock.groupCreate(name, jids);
  let inviteLink = null;
  try {
    const code = await s.sock.groupInviteCode(result.id);
    inviteLink = `https://chat.whatsapp.com/${code}`;
  } catch (err) {
    console.warn(`[whatsapp] falha ao obter invite do grupo ${result.id}: ${err.message}`);
  }
  return {
    jid: result.id,
    name,
    inviteLink,
    participants: participantPhones.map(normalizePhone),
  };
}

async function getInviteLink(userId, numberId, jid) {
  const s = ensureConnected(userId, numberId);
  const code = await s.sock.groupInviteCode(jid);
  return `https://chat.whatsapp.com/${code}`;
}

async function revokeInvite(userId, numberId, jid) {
  const s = ensureConnected(userId, numberId);
  const code = await s.sock.groupRevokeInvite(jid);
  return `https://chat.whatsapp.com/${code}`;
}

async function listGroups(userId, numberId) {
  const s = ensureConnected(userId, numberId);
  const all = await s.sock.groupFetchAllParticipating();
  return Object.values(all).map(g => ({
    jid: g.id,
    name: g.subject,
    members: g.participants?.length || 0,
    creation: g.creation,
    description: g.desc || null,
  }));
}

async function leaveGroup(userId, numberId, jid) {
  const s = ensureConnected(userId, numberId);
  await s.sock.groupLeave(jid);
}

async function getGroupMetadata(userId, numberId, jid) {
  const s = ensureConnected(userId, numberId);
  return s.sock.groupMetadata(jid);
}

// Restaura sessões persistidas. Em modo PG: SELECT distinct sessionId no
// baileys_auth. Em modo arquivo: varre auth_states/<userId>/<numberId>/.
async function restoreSessions() {
  let pairs = [];
  if (USE_PG_AUTH) {
    try {
      const { prisma } = require("./db");
      const rows = await prisma().baileysAuth.findMany({
        where: { keyType: "creds" },
        select: { sessionId: true },
      });
      pairs = rows.map(r => {
        const [userId, numberId] = r.sessionId.split("::");
        return { userId, numberId };
      }).filter(p => p.userId && p.numberId);
    } catch (err) {
      console.error(`[whatsapp] falha listando sessões PG: ${err.message}`);
      return;
    }
  } else {
    if (!fs.existsSync(AUTH_DIR)) return;
    const userDirs = fs.readdirSync(AUTH_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
    for (const userId of userDirs) {
      const userPath = path.join(AUTH_DIR, userId);
      const numbers = fs.readdirSync(userPath, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
      for (const numberId of numbers) pairs.push({ userId, numberId });
    }
  }

  for (const { userId, numberId } of pairs) {
    startSession(userId, numberId).catch(err => {
      console.error(`[whatsapp] falha ao restaurar ${userId}/${numberId}:`, err.message);
    });
  }
  if (pairs.length > 0) console.log(`[whatsapp] restaurando ${pairs.length} sessão(ões) (auth=${USE_PG_AUTH ? "pg" : "file"})...`);
}

function status() {
  let connected = 0, total = 0;
  for (const s of sessions.values()) {
    total++;
    if (s.status === "connected") connected++;
  }
  return { totalSessions: total, connectedSessions: connected };
}

module.exports = {
  startSession,
  getSession,
  listSessions,
  deleteSession,
  sendText,
  sendImage,
  createGroup,
  getInviteLink,
  revokeInvite,
  listGroups,
  leaveGroup,
  getGroupMetadata,
  restoreSessions,
  jidFromPhone,
  normalizePhone,
  status,
};

function makeStub() {
  const fail = () => Promise.reject(new Error("Baileys não instalado. Rode: cd backend && npm install"));
  return {
    startSession: fail,
    getSession: () => null,
    listSessions: () => [],
    deleteSession: fail,
    sendText: fail,
    sendImage: fail,
    createGroup: fail,
    getInviteLink: fail,
    revokeInvite: fail,
    listGroups: fail,
    leaveGroup: fail,
    getGroupMetadata: fail,
    restoreSessions: () => {},
    jidFromPhone: () => null,
    normalizePhone: () => null,
    status: () => ({ totalSessions: 0, connectedSessions: 0, stub: true }),
  };
}
