// {todos} no modelo da campanha: o envio leva todo participante do grupo em
// `mentions` — é isso que notifica quem silenciou o grupo. Sem metadata, ou num
// jid que não é de grupo, a mensagem sai normal, sem menção.
//
// Baileys e o adapter de auth entram por require.cache (mesma técnica de
// unit/whatsapp-send-mutex.test.js).
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
let sent = [];
// O que o groupMetadata do socket falso devolve (ou lança) no próximo envio.
let metaImpl = async () => ({ id: "g", participants: [] });
let metaCalls = 0;

function fakeSocket() {
  const ev = new EventEmitter();
  const sock = {
    ev: { on: (e, h) => ev.on(e, h), removeAllListeners: () => ev.removeAllListeners() },
    end: () => {},
    logout: async () => {},
    user: null,
    authState: { creds: { registered: true } },
    groupMetadata: async (jid) => { metaCalls++; return metaImpl(jid); },
    sendMessage: async (jid, content) => {
      sent.push({ jid, content });
      return { key: { id: `ID_${sent.length}` }, message: { conversation: content.text || content.caption } };
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

const USER = "user-mention";
const GROUP = "120363000000000001@g.us";
const PARTICIPANTS = [{ id: "111@lid" }, { id: "222@lid" }, { id: "5511999990000@s.whatsapp.net" }];

async function connected(numberId) {
  await wa.startSession(USER, numberId);
  sockets[sockets.length - 1].emit("connection.update", { connection: "open" });
}

describe("envio com @todos", () => {
  beforeEach(() => {
    sockets = []; sent = []; metaCalls = 0;
    metaImpl = async () => ({ id: GROUP, participants: PARTICIPANTS });
  });

  it("texto: todos os participantes vão em mentions", async () => {
    const NUM = "5511900000101";
    await connected(NUM);

    await wa.sendText(USER, NUM, GROUP, "oferta @todos", { mentionAll: true });

    expect(sent[0].content).toEqual({ text: "oferta @todos", mentions: PARTICIPANTS.map(p => p.id) });
    await wa.deleteSession(USER, NUM);
  });

  it("imagem: mentions vai junto da legenda", async () => {
    const NUM = "5511900000102";
    await connected(NUM);

    await wa.sendImage(USER, NUM, GROUP, "https://img/x.jpg", "legenda @todos", { mentionAll: true });

    expect(sent[0].content).toEqual({
      image: { url: "https://img/x.jpg" }, caption: "legenda @todos", mentions: PARTICIPANTS.map(p => p.id),
    });
    await wa.deleteSession(USER, NUM);
  });

  it("reaproveita o cache de metadata entre envios", async () => {
    const NUM = "5511900000103";
    await connected(NUM);

    await wa.sendText(USER, NUM, GROUP, "a", { mentionAll: true });
    await wa.sendText(USER, NUM, GROUP, "b", { mentionAll: true });

    expect(metaCalls).toBe(1);
    await wa.deleteSession(USER, NUM);
  });

  it("sem mentionAll a mensagem sai como sempre saiu", async () => {
    const NUM = "5511900000104";
    await connected(NUM);

    await wa.sendText(USER, NUM, GROUP, "normal");

    expect(sent[0].content).toEqual({ text: "normal" });
    expect(metaCalls).toBe(0);
    await wa.deleteSession(USER, NUM);
  });

  it("jid que não é de grupo ignora o mentionAll", async () => {
    const NUM = "5511900000105";
    await connected(NUM);

    await wa.sendText(USER, NUM, "5511988887777@s.whatsapp.net", "oi", { mentionAll: true });

    expect(sent[0].content).toEqual({ text: "oi" });
    await wa.deleteSession(USER, NUM);
  });

  it("metadata com erro: envia sem menção em vez de falhar", async () => {
    const NUM = "5511900000106";
    await connected(NUM);
    metaImpl = async () => { throw new Error("item-not-found"); };

    await wa.sendText(USER, NUM, GROUP, "oferta", { mentionAll: true });

    expect(sent[0].content).toEqual({ text: "oferta" });
    await wa.deleteSession(USER, NUM);
  });
});
