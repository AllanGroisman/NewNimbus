// Envios de uma mesma sessão nunca podem se sobrepor no socket.
//
// A fila `control` do BullMQ roda concurrency 4 (backend/infra/queue.js) e TODO
// envio vindo do server passa por ela — rota /send, /broadcast, notificações,
// admin — além do job de campanha na fila `send`. Sem trava, dois relayMessage
// rodam ao mesmo tempo no MESMO socket, e o addTransactionCapability do Baileys
// usa um transactionCache/mutations COMPARTILHADO com um contador simples: a
// transação que termina primeiro limpa o cache no `finally` no meio da outra, e
// as mutações do ratchet se perdem. O destinatário então não decripta e o
// celular dele fica no "Aguardando mensagem".
//
// Baileys e o adapter de auth entram por require.cache (mesma técnica de
// unit/whatsapp-retry-getmessage.test.js).
import "../helpers/env.js";
import { describe, it, expect, beforeEach, afterAll } from "vitest";
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
const { DisconnectReason, makeCacheableSignalKeyStore } = require("@whiskeysockets/baileys");

let sockets = [];
// Linha do tempo de entradas/saídas do sendMessage — é nela que a sobreposição
// apareceria.
let timeline = [];
// Envios em voo, por rótulo: resolvidos à mão pelo teste.
let pending = new Map();

function fakeSocket() {
  const ev = new EventEmitter();
  const sock = {
    ev: { on: (e, h) => ev.on(e, h), removeAllListeners: () => ev.removeAllListeners() },
    end: () => {},
    logout: async () => {},
    user: null,
    authState: { creds: { registered: true } },
    groupMetadata: async () => ({ id: "g", participants: [] }),
    sendMessage: (jid, content) => {
      const label = content.text;
      timeline.push(`entra:${label}`);
      return new Promise((resolve, reject) => {
        pending.set(label, {
          ok: () => {
            timeline.push(`sai:${label}`);
            resolve({ key: { id: `ID_${label}` }, message: { conversation: label } });
          },
          fail: (err) => {
            timeline.push(`erro:${label}`);
            reject(err);
          },
        });
      });
    },
    emit: (e, payload) => ev.emit(e, payload),
  };
  sockets.push(sock);
  return sock;
}

const stubbed = new Map();
function stub(modPath, exports) {
  if (!stubbed.has(modPath)) stubbed.set(modPath, require.cache[modPath]);
  require.cache[modPath] = { id: modPath, filename: modPath, loaded: true, exports, children: [], paths: [] };
}

stub(BAILEYS, {
  default: fakeSocket,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1] }),
});
stub(PG_AUTH, {
  useDatabaseAuthState: async () => ({
    state: { creds: {}, keys: { get: async () => ({}), set: async () => {} } },
    saveCreds: async () => {},
  }),
  deleteSession: async () => {},
  renameSession: async () => {},
});
stub(NOTIFIER, { onSessionStatus: async () => {}, markConnectedOnce: () => {} });

const wa = require(LOCAL_JS);

afterAll(() => {
  for (const [p, prev] of stubbed) {
    if (prev) require.cache[p] = prev; else delete require.cache[p];
  }
  delete require.cache[LOCAL_JS];
});

const USER = "user-mutex";
const JID = "5511988887777@s.whatsapp.net";

async function connected(numberId) {
  await wa.startSession(USER, numberId);
  sockets[sockets.length - 1].emit("connection.update", { connection: "open" });
}

// Dá uma volta no event loop pra qualquer envio destravado chegar ao sendMessage.
const tick = () => new Promise(r => setTimeout(r, 0));

describe("envio serializado por sessão", () => {
  beforeEach(() => {
    sockets = []; timeline = []; pending = new Map();
  });

  it("dois envios na mesma sessão não se sobrepõem — o segundo espera o primeiro", async () => {
    const NUM = "5511900000001";
    await connected(NUM);

    const p1 = wa.sendText(USER, NUM, JID, "A");
    const p2 = wa.sendText(USER, NUM, JID, "B");
    await tick();

    // B ainda nem chegou ao socket.
    expect(timeline).toEqual(["entra:A"]);

    pending.get("A").ok();
    await p1;
    await tick();
    pending.get("B").ok();
    await p2;

    expect(timeline).toEqual(["entra:A", "sai:A", "entra:B", "sai:B"]);
    await wa.deleteSession(USER, NUM);
  });

  it("um envio que falha não trava a fila do próximo", async () => {
    const NUM = "5511900000002";
    await connected(NUM);

    const p1 = wa.sendText(USER, NUM, JID, "A");
    const p2 = wa.sendText(USER, NUM, JID, "B");
    await tick();

    pending.get("A").fail(new Error("envio falhou"));
    await expect(p1).rejects.toThrow("envio falhou");
    await tick();

    // B seguiu em frente mesmo com A tendo quebrado.
    expect(timeline).toEqual(["entra:A", "erro:A", "entra:B"]);
    pending.get("B").ok();
    await expect(p2).resolves.toMatchObject({ key: { id: "ID_B" } });

    await wa.deleteSession(USER, NUM);
  });

  it("sessões diferentes seguem em paralelo", async () => {
    const N1 = "5511900000003";
    const N2 = "5511900000004";
    await connected(N1);
    await connected(N2);

    const p1 = wa.sendText(USER, N1, JID, "S1");
    const p2 = wa.sendText(USER, N2, JID, "S2");
    await tick();

    // Os dois entraram: a trava é POR sessão, não global.
    expect(timeline.sort()).toEqual(["entra:S1", "entra:S2"]);

    pending.get("S1").ok();
    pending.get("S2").ok();
    await Promise.all([p1, p2]);

    await wa.deleteSession(USER, N1);
    await wa.deleteSession(USER, N2);
  });
});
