// whatsapp-proxy.js — usado pelo SERVER em modo redis (Fase 2.1).
//
// Espelha a API pública de whatsapp-local.js, mas:
//   - Status reads (getSession, listSessions, status): consultam o cache em Redis
//     que o worker mantém via session-status.publish.
//   - Ops (start/delete session, send, group ops): enfileiram na control queue
//     e aguardam resposta do worker via callControl (BullMQ RPC).
//
// Algumas funções que eram síncronas em whatsapp-local viraram async aqui (read
// do Redis). server.js precisa usar `await` — funciona em ambos modos porque
// `await` em valor não-Promise resolve imediatamente.

const queue = require("../infra/queue");
const sessionStatus = require("../infra/session-status");

// Utilitários puros — duplicados aqui pra evitar require do local (que carregaria Baileys).
function normalizePhone(p) { return String(p).replace(/\D/g, ""); }
function jidFromPhone(phone) { return `${normalizePhone(phone)}@s.whatsapp.net`; }

async function startSession(userId, numberId) {
  // Worker faz startSession local + publica status. Devolvemos snapshot inicial.
  return queue.callControl("startSession", [String(userId), String(numberId)], { timeoutMs: 30000 });
}

async function getSession(userId, numberId) {
  const s = await sessionStatus.read(userId, numberId);
  if (!s) return null;
  return {
    userId: s.userId,
    numberId: s.numberId,
    status: s.status,
    qr: s.qr || null,
    qrDataUrl: s.qr || null,    // alias — server.js usa qrDataUrl
    info: s.info || null,
    lastError: s.lastError || null,
    stuck: s.stuck || false,
    // true quando o status veio rebaixado por obsolescência (worker morto ou
    // snapshot velho) em vez de um evento real do Baileys.
    stale: s.stale || false,
  };
}

async function listSessions(userId) {
  const rows = await sessionStatus.listForUser(userId);
  return rows.map(s => ({
    numberId: s.numberId,
    status: s.status,
    info: s.info || null,
    lastError: s.lastError || null,
    stuck: s.stuck || false,
    stale: s.stale || false,
  }));
}

async function listAllSessions() {
  return sessionStatus.listAllByUser();
}

async function deleteSession(userId, numberId) {
  return queue.callControl("deleteSession", [String(userId), String(numberId)], { timeoutMs: 15000 });
}

async function sendText(userId, numberId, jid, text) {
  return queue.callControl("sendText", [String(userId), String(numberId), jid, text], { timeoutMs: 30000 });
}

async function sendImage(userId, numberId, jid, imageUrl, caption) {
  return queue.callControl("sendImage", [String(userId), String(numberId), jid, imageUrl, caption], { timeoutMs: 60000 });
}

async function createGroup(userId, numberId, name, participantPhones) {
  return queue.callControl("createGroup", [String(userId), String(numberId), name, participantPhones], { timeoutMs: 60000 });
}

async function getInviteLink(userId, numberId, jid) {
  return queue.callControl("getInviteLink", [String(userId), String(numberId), jid], { timeoutMs: 15000 });
}

async function revokeInvite(userId, numberId, jid) {
  return queue.callControl("revokeInvite", [String(userId), String(numberId), jid], { timeoutMs: 15000 });
}

async function listGroups(userId, numberId) {
  return queue.callControl("listGroups", [String(userId), String(numberId)], { timeoutMs: 60000 });
}

async function leaveGroup(userId, numberId, jid) {
  return queue.callControl("leaveGroup", [String(userId), String(numberId), jid], { timeoutMs: 15000 });
}

async function getGroupMetadata(userId, numberId, jid) {
  return queue.callControl("getGroupMetadata", [String(userId), String(numberId), jid], { timeoutMs: 30000 });
}

// No-op no server. Worker faz restore das sessões no próprio boot.
function restoreSessions() {
  console.log("[whatsapp-proxy] restoreSessions delegado pro worker");
}

// No-op no server: quem owna os sockets é o worker (ver local.closeAll).
async function closeAll() {}

// Agregado lido do Redis (não chama worker).
async function status() {
  try {
    return await sessionStatus.aggregateStatus();
  } catch (err) {
    return { totalSessions: 0, connectedSessions: 0, error: err.message };
  }
}

module.exports = {
  startSession, getSession, listSessions, listAllSessions, deleteSession,
  sendText, sendImage,
  createGroup, getInviteLink, revokeInvite, listGroups, leaveGroup, getGroupMetadata,
  restoreSessions, closeAll, status,
  jidFromPhone, normalizePhone,
};
