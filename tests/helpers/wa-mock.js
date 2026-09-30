// Mock do modulo whatsapp — instalado no require.cache antes do server.js
// ser carregado. Toda chamada a wa.sendText/sendImage vira no-op e fica
// registrada em `calls` pra os testes inspecionarem.

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

const calls = {
  sendText: [],
  sendImage: [],
  startSession: [],
  requestPairingCode: [],
  deleteSession: [],
  listGroups: [],
  createGroup: [],
  groupMemberJids: [],
};

// Gancho de falha: quando setado, sendText lança com esta mensagem. Serve pros
// testes que exercitam a perna que falha (ex.: sessão caída no /test).
let sendError = null;

// Espelha o msg-store do worker: quantas vezes o aparelho pediu reenvio da última
// mensagem. `known` é false quando o id não passou por este processo (worker
// reiniciado) — a rota de teste trata isso como "sem informação".
let msgStatsResult = { known: true, retries: 0, lastRetryAt: null };
let msgIdSeq = 0;

// Membros por jid de grupo, para o groupMemberJids (mensagem no privado, task 4).
// Já no formato que o real devolve: [{ jid }], sem o próprio número.
let groupMembers = new Map();

function reset() {
  for (const k of Object.keys(calls)) calls[k].length = 0;
  sendError = null;
  msgStatsResult = { known: true, retries: 0, lastRetryAt: null };
  msgIdSeq = 0;
  groupMembers = new Map();
}

const fakeSessions = new Map();

// Helper de teste: marca uma sessão como CONECTADA (QR escaneado). Necessário
// pra exercitar o whatsappGate do scheduler (scheduler.js:152), que só deixa
// enviar quando algum número vinculado tem sessão com status "connected".
// `startSession` deixa a sessão em "open" (iniciada mas não conectada), então
// os testes de envio precisam chamar isto explicitamente.
function connect(userId, numberId) {
  fakeSessions.set(`${userId}::${numberId}`, {
    numberId,
    status: "connected",
    qrDataUrl: null,
    info: { phone: "5511999999999" },
    lastError: null,
  });
  return { numberId, status: "connected" };
}

const mock = {
  __calls: calls,
  __reset: reset,
  __sessions: fakeSessions,

  async sendText(userId, numberId, jid, text) {
    if (sendError) throw new Error(sendError);
    calls.sendText.push({ userId, numberId, jid, text });
    // Como o real (worker.js reduz o WebMessageInfo a { ok, key }): a rota de teste
    // precisa do key.id pra perguntar depois se houve pedido de reenvio.
    return { ok: true, key: { id: `MSG${++msgIdSeq}` } };
  },
  async msgStats() { return msgStatsResult; },
  async sendImage(userId, numberId, jid, imageUrl, caption) {
    calls.sendImage.push({ userId, numberId, jid, imageUrl, caption });
    return { ok: true };
  },
  async startSession(userId, numberId) {
    calls.startSession.push({ userId, numberId });
    fakeSessions.set(`${userId}::${numberId}`, {
      numberId, status: "open", qrDataUrl: null, info: { phone: "5511999999999" }, lastError: null,
    });
    return { id: numberId, status: "open" };
  },
  // Espelha o contrato de local.js:requestPairingCode — recusa esperada volta como
  // valor ({ ok: false, reason }), não como exceção, porque o RPC do BullMQ não
  // carrega `err.code`. A sessão fica em "awaiting_qr": o código roda no MESMO
  // socket do QR, então não há status novo.
  async requestPairingCode(userId, numberId, phone) {
    calls.requestPairingCode.push({ userId, numberId, phone });
    fakeSessions.set(`${userId}::${numberId}`, {
      numberId, status: "awaiting_qr", qrDataUrl: null, info: null, lastError: null,
    });
    return {
      ok: true, code: "ABCD1234", formatted: "ABCD-1234", phone,
      expiresAt: Date.now() + 110000,
    };
  },
  async getSession(userId, numberId) {
    return fakeSessions.get(`${userId}::${numberId}`) || null;
  },
  async listSessions(userId) {
    // Espelha o contrato real (backend/whatsapp/local.js:snapshotOf):
    // { numberId, status, info, lastError, stuck, stale }.
    return [...fakeSessions.entries()]
      .filter(([k]) => k.startsWith(`${userId}::`))
      .map(([, s]) => ({
        numberId: s.numberId, status: s.status, info: s.info || null,
        lastError: s.lastError || null, stuck: s.stuck || false, stale: false,
      }));
  },
  // Espelha backend/whatsapp/local.js:listAllSessions — tudo agrupado por
  // usuário, que é como a aba de usuários do admin lê o status da lista inteira.
  async listAllSessions() {
    const out = {};
    for (const [k, s] of fakeSessions.entries()) {
      const userId = k.split("::")[0];
      (out[userId] ||= []).push({
        numberId: s.numberId, status: s.status, info: s.info || null,
        lastError: s.lastError || null, stuck: s.stuck || false, stale: false,
      });
    }
    return out;
  },
  __connect: connect,
  // Setter do gancho de falha (null desliga).
  __failSend: (msg) => { sendError = msg; },
  __setGroupMembers: (jid, members) => { groupMembers.set(jid, members); },
  // Setter do resultado do msgStats — simula o aparelho pedindo (ou não) reenvio.
  __setMsgStats: (stats) => { msgStatsResult = { known: true, retries: 0, lastRetryAt: null, ...stats }; },
  // Espelha backend/whatsapp/local.js:232-233 — o módulo real exporta os dois.
  normalizePhone(p) { return String(p).replace(/\D/g, ""); },
  jidFromPhone(phone) { return `${String(phone).replace(/\D/g, "")}@s.whatsapp.net`; },
  async deleteSession(userId, numberId) {
    calls.deleteSession.push({ userId, numberId });
    fakeSessions.delete(`${userId}::${numberId}`);
    return { ok: true };
  },
  async listGroups(userId, numberId) {
    calls.listGroups.push({ userId, numberId });
    return [];
  },
  async createGroup(userId, numberId, name, participants) {
    calls.createGroup.push({ userId, numberId, name, participants });
    return { id: "fake-group", name, jid: "fake@g.us", adminOnly: true };
  },
  async getInviteLink() { return "https://chat.whatsapp.com/fakeinvite"; },
  async revokeInvite() { return "https://chat.whatsapp.com/fakeinvite-revoked"; },
  async leaveGroup() { return { ok: true }; },
  async groupMemberJids(userId, numberId, jid) {
    calls.groupMemberJids.push({ userId, numberId, jid });
    return (groupMembers.get(jid) || []).map(m => (typeof m === "string" ? { jid: m } : m));
  },
  async restoreSessions() { return; },
  async status() { return { count: fakeSessions.size }; },
};

function installMock() {
  const target = path.resolve(__dirname, "..", "..", "backend", "whatsapp", "index.js");
  require.cache[target] = {
    id: target,
    filename: target,
    loaded: true,
    children: [],
    paths: [],
    exports: mock,
  };
  return mock;
}

export { installMock, mock, calls, reset, connect };
export const failSend = (msg) => mock.__failSend(msg);
export const setMsgStats = (stats) => mock.__setMsgStats(stats);
export const setGroupMembers = (jid, members) => mock.__setGroupMembers(jid, members);
