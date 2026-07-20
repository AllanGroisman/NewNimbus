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
  deleteSession: [],
  listGroups: [],
  createGroup: [],
};

function reset() {
  for (const k of Object.keys(calls)) calls[k].length = 0;
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
    calls.sendText.push({ userId, numberId, jid, text });
    return { ok: true };
  },
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
  async getSession(userId, numberId) {
    return fakeSessions.get(`${userId}::${numberId}`) || null;
  },
  async listSessions(userId) {
    // Espelha o contrato real (backend/whatsapp/local.js:229): { numberId, status, info, lastError }.
    return [...fakeSessions.entries()]
      .filter(([k]) => k.startsWith(`${userId}::`))
      .map(([, s]) => ({ numberId: s.numberId, status: s.status, info: s.info || null, lastError: s.lastError || null }));
  },
  __connect: connect,
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
    return { id: "fake-group", name, jid: "fake@g.us" };
  },
  async getInviteLink() { return "https://chat.whatsapp.com/fakeinvite"; },
  async revokeInvite() { return "https://chat.whatsapp.com/fakeinvite-revoked"; },
  async leaveGroup() { return { ok: true }; },
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
