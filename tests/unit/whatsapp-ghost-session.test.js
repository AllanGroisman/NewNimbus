// A "conexão fantasma": o bug que motivou a Task 39.
//
// 1) startSession abria um socket NOVO a cada chamada enquanto a sessão não
//    estivesse "connected". Duas chamadas concorrentes (POST da rota + timer de
//    backoff + re-run de job stalled do BullMQ + restore no boot) deixavam DOIS
//    sockets no mesmo número: os dois mutavam a mesma sessão, os dois agendavam
//    reconexão e os dois gravavam chaves Signal na mesma linha de baileys_auth
//    (os "Bad MAC" do worker-error.log). O WhatsApp trata isso como conflito,
//    remove o device e o usuário cai de verdade.
// 2) O setTimeout do backoff não era rastreado: deleteSession apagava a sessão e
//    as credenciais, e o timer pendente a ressuscitava segundos depois com creds
//    novas, emitindo um QR que ninguém olha.
//
// Baileys e o adapter de auth entram por require.cache (mesma técnica do
// helpers/wa-mock.js) — aqui interessa a máquina de estados, não a rede.

import "../helpers/env.js";
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { EventEmitter } from "events";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(__dirname, "..", "..", "backend");
const LOCAL_JS = path.join(BACKEND, "whatsapp", "local.js");
const require = createRequire(pathToFileURL(LOCAL_JS));

const BAILEYS = require.resolve("@whiskeysockets/baileys");
const PG_AUTH = path.join(BACKEND, "auth", "baileys-pg.js");
const NOTIFIER = path.join(BACKEND, "notifications", "user-notifier.js");
const { DisconnectReason } = require("@whiskeysockets/baileys");

// Sockets criados nesta execução — o contador é a própria asserção do teste.
let sockets = [];

function fakeSocket() {
  const ev = new EventEmitter();
  const sock = {
    ev: {
      on: (e, h) => ev.on(e, h),
      removeAllListeners: () => ev.removeAllListeners(),
    },
    end: vi.fn(),
    logout: vi.fn().mockResolvedValue(undefined),
    user: null,
    authState: { creds: { registered: true } },
    // Atalho do teste pra empurrar um evento do Baileys pra dentro do handler.
    emit: (e, payload) => ev.emit(e, payload),
  };
  sockets.push(sock);
  return sock;
}

const stubbed = new Map();
function stub(modPath, exports) {
  if (!stubbed.has(modPath)) stubbed.set(modPath, require.cache[modPath]);
  require.cache[modPath] = {
    id: modPath, filename: modPath, loaded: true, exports, children: [], paths: [],
  };
}

const pgAuthStub = {
  useDatabaseAuthState: vi.fn(async () => ({
    state: { creds: {}, keys: { get: async () => ({}), set: async () => {} } },
    saveCreds: vi.fn(async () => {}),
  })),
  deleteSession: vi.fn(async () => {}),
  renameSession: vi.fn(async () => {}),
};

stub(BAILEYS, {
  default: fakeSocket,
  DisconnectReason,
  fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1] }),
});
stub(PG_AUTH, pgAuthStub);
// O notificador puxa prisma/config no require — irrelevante aqui.
stub(NOTIFIER, { onSessionStatus: async () => {}, markConnectedOnce: () => {} });

const wa = require(LOCAL_JS);

// Devolve o cache ao estado original: o require.cache do Node é do processo, e
// unit/whatsapp-close.test.js precisa do Baileys de verdade.
afterAll(() => {
  for (const [p, prev] of stubbed) {
    if (prev) require.cache[p] = prev; else delete require.cache[p];
  }
  delete require.cache[LOCAL_JS];
});

const USER = "user-fantasma";
const NUM = "5511999990000";
const netClose = {
  connection: "close",
  lastDisconnect: { error: { output: { statusCode: DisconnectReason.connectionLost }, message: "Connection Closed" } },
};

async function cleanup() {
  try { await wa.deleteSession(USER, NUM); } catch { /* ignore */ }
}

describe("startSession — um socket por número", () => {
  beforeEach(async () => { await cleanup(); sockets = []; vi.clearAllMocks(); });

  it("duas chamadas concorrentes abrem UM socket só (single-flight)", async () => {
    const [a, b] = await Promise.all([
      wa.startSession(USER, NUM),
      wa.startSession(USER, NUM),
    ]);
    expect(sockets).toHaveLength(1);
    expect(a).toBe(b);
    await cleanup();
  });

  it("chamar de novo com o socket vivo devolve a mesma sessão — não abre outro", async () => {
    await wa.startSession(USER, NUM);
    await wa.startSession(USER, NUM);
    expect(sockets).toHaveLength(1);
    await cleanup();
  });

  it("depois que o socket cai, uma chamada explícita abre um novo (e encerra o velho)", async () => {
    const s = await wa.startSession(USER, NUM);
    const primeiro = sockets[0];
    s.migrating = true;      // silencia o agendamento automático: aqui o foco é a chamada manual
    primeiro.emit("connection.update", netClose);
    await wa.startSession(USER, NUM);
    expect(sockets).toHaveLength(2);
    expect(primeiro.end).toHaveBeenCalled();
    await cleanup();
  });
});

describe("reconexão em backoff — não ressuscita sessão apagada", () => {
  beforeEach(async () => { await cleanup(); sockets = []; vi.clearAllMocks(); });

  it("queda de rede agenda reconexão e o socket volta sozinho", async () => {
    vi.useFakeTimers();
    try {
      await wa.startSession(USER, NUM);
      sockets[0].emit("connection.update", netClose);
      await vi.advanceTimersByTimeAsync(40_000);
      expect(sockets.length).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
      await cleanup();
    }
  });

  it("deleteSession cancela o timer pendente — nada renasce depois", async () => {
    vi.useFakeTimers();
    try {
      await wa.startSession(USER, NUM);
      sockets[0].emit("connection.update", netClose); // agenda o backoff
      await wa.deleteSession(USER, NUM);              // usuário apagou nesse meio tempo
      const antes = sockets.length;

      await vi.advanceTimersByTimeAsync(60_000);

      expect(sockets).toHaveLength(antes);            // nenhum socket novo
      expect(wa.listSessions(USER)).toHaveLength(0);  // e nenhuma sessão fantasma na lista
    } finally {
      vi.useRealTimers();
      await cleanup();
    }
  });

  it("socket substituído vira no-op: eventos dele não mexem mais na sessão", async () => {
    const s = await wa.startSession(USER, NUM);
    const velho = sockets[0];
    s.migrating = true;
    velho.emit("connection.update", netClose);
    await wa.startSession(USER, NUM);
    const nova = wa.getSession(USER, NUM);
    nova.migrating = false;
    nova.status = "connected";

    velho.emit("connection.update", netClose); // socket antigo ainda emitindo

    expect(wa.getSession(USER, NUM).status).toBe("connected");
    await cleanup();
  });
});
