const path = require("path");
const fs = require("fs");

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
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const k = key(userId, numberId);
  const existing = sessions.get(k);
  if (existing?.sock && existing.status === "connected") return existing;

  const { state, saveCreds } = await useMultiFileAuthState(dir);
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

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      session.qr = qr;
      try { session.qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 280 }); } catch {}
      session.status = "awaiting_qr";
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
    }

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      session.status = loggedOut ? "logged_out" : "disconnected";
      session.lastError = lastDisconnect?.error?.message || null;
      session.qr = null;
      session.qrDataUrl = null;

      if (loggedOut) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
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
  const dir = dirFor(userId, numberId);
  if (fs.existsSync(dir)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
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

// Restaura sessões persistidas — varre auth_states/<userId>/<numberId>/
function restoreSessions() {
  if (!fs.existsSync(AUTH_DIR)) return;
  const userDirs = fs.readdirSync(AUTH_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  let count = 0;
  for (const userId of userDirs) {
    const userPath = path.join(AUTH_DIR, userId);
    const numbers = fs.readdirSync(userPath, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
    for (const numberId of numbers) {
      count++;
      startSession(userId, numberId).catch(err => {
        console.error(`[whatsapp] falha ao restaurar ${userId}/${numberId}:`, err.message);
      });
    }
  }
  if (count > 0) console.log(`[whatsapp] restaurando ${count} sessão(ões)...`);
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
  };
}
