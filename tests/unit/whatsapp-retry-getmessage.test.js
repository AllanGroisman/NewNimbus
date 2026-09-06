// A fiação que faz o "Aguardando mensagem" se resolver sozinho.
//
// Quando o celular do destinatário não decripta um pacote nosso, ele mostra
// "Aguardando mensagem. Essa ação pode levar alguns instantes" e manda um retry
// receipt pedindo o reenvio. O Baileys atende isso em sendMessagesAgain, mas só
// consegue se o callback `getMessage` do makeWASocket devolver a mensagem
// original. O default do Baileys é `async () => undefined` — sem passar o
// callback, o reenvio NUNCA sai e o placeholder fica pra sempre no celular.
//
// Este teste trava as duas pontas: o socket nasce com getMessage, e o que sai por
// sendText/sendImage volta por ele.
//
// Baileys e o adapter de auth entram por require.cache (mesma técnica de
// helpers/wa-mock.js e de unit/whatsapp-ghost-session.test.js).
import "../helpers/env.js";
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { EventEmitter } from "events";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(__dirname, "..", "..", "backend");
const LOCAL_JS = path.join(BACKEND, "whatsapp", "local.js");
const STORE_JS = path.join(BACKEND, "whatsapp", "msg-store.js");
const require = createRequire(pathToFileURL(LOCAL_JS));

const BAILEYS = require.resolve("@whiskeysockets/baileys");
const PG_AUTH = path.join(BACKEND, "auth", "baileys-pg.js");
const NOTIFIER = path.join(BACKEND, "notifications", "user-notifier.js");
// makeCacheableSignalKeyStore vem do Baileys de verdade: o local.js embrulha
// `state.keys` com ele antes de entregar ao socket, e um stub que não o
// exporte quebraria a abertura da sessão inteira.
const { DisconnectReason, makeCacheableSignalKeyStore } = require("@whiskeysockets/baileys");

// Config entregue ao makeWASocket — é metade da asserção deste arquivo.
let configs = [];
let sockets = [];
// O que o Baileys devolveria de um envio bem-sucedido.
let nextSendResult = null;
// Cada IQ de groupMetadata que o socket teria disparado.
let groupMetaCalls = [];

function fakeSocket(config) {
  configs.push(config);
  const ev = new EventEmitter();
  const sock = {
    ev: { on: (e, h) => ev.on(e, h), removeAllListeners: () => ev.removeAllListeners() },
    end: () => {},
    logout: async () => {},
    user: null,
    authState: { creds: { registered: true } },
    sendMessage: async () => nextSendResult,
    groupMetadata: async (jid) => { groupMetaCalls.push(jid); return { id: jid, subject: "G", participants: [] }; },
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
const msgStore = require(STORE_JS);

// Devolve o require.cache ao estado original: ele é do processo, e outros testes
// de whatsapp precisam do Baileys de verdade.
afterAll(() => {
  for (const [p, prev] of stubbed) {
    if (prev) require.cache[p] = prev; else delete require.cache[p];
  }
  delete require.cache[LOCAL_JS];
});

const USER = "user-retry";
const NUM = "5511999990001";
const JID = "5511988887777@s.whatsapp.net";

// Abre a sessão e a leva a "connected" — sem isso o ensureConnected barra o envio.
async function connected() {
  const s = await wa.startSession(USER, NUM);
  sockets[sockets.length - 1].emit("connection.update", { connection: "open" });
  return s;
}

describe("getMessage — o socket sabe reenviar o que mandou", () => {
  beforeEach(async () => {
    try { await wa.deleteSession(USER, NUM); } catch { /* ignore */ }
    configs = []; sockets = []; nextSendResult = null; groupMetaCalls = [];
    msgStore.__clear();
  });

  afterAll(async () => { try { await wa.deleteSession(USER, NUM); } catch { /* ignore */ } });

  it("o socket nasce com o callback getMessage", async () => {
    await wa.startSession(USER, NUM);
    expect(configs).toHaveLength(1);
    expect(typeof configs[0].getMessage).toBe("function");
  });

  it("texto enviado volta pelo getMessage — o caminho do sendMessagesAgain", async () => {
    nextSendResult = { key: { id: "MSG1", remoteJid: JID }, message: { conversation: "oi" } };
    await connected();
    await wa.sendText(USER, NUM, JID, "oi");

    // É exatamente assim que o Baileys chama: key do receipt + id da mensagem.
    const found = await configs[0].getMessage({ remoteJid: JID, fromMe: true, id: "MSG1" });
    expect(found).toEqual({ conversation: "oi" });
  });

  it("imagem enviada também volta (reenvio reaproveita as media keys)", async () => {
    const imageMessage = { url: "https://mmg.whatsapp.net/x", mediaKey: "k", caption: "promo" };
    nextSendResult = { key: { id: "MSG2", remoteJid: JID }, message: { imageMessage } };
    await connected();
    await wa.sendImage(USER, NUM, JID, "https://cdn/img.jpg", "promo");

    const found = await configs[0].getMessage({ remoteJid: JID, id: "MSG2" });
    expect(found).toEqual({ imageMessage });
  });

  it("id que nunca foi enviado devolve undefined em vez de lançar", async () => {
    await wa.startSession(USER, NUM);
    await expect(configs[0].getMessage({ remoteJid: JID, id: "DESCONHECIDA" })).resolves.toBeUndefined();
    await expect(configs[0].getMessage({})).resolves.toBeUndefined();
    await expect(configs[0].getMessage(undefined)).resolves.toBeUndefined();
  });

  // Retry de mensagem "peer": pedido interno que o próprio Baileys gera
  // (sendRetryRequest / placeholder resend). Chega sem remoteJid e nunca passou
  // por sendText, então não está no store por definição — e era a origem de
  // TODOS os "miss" que apareciam no log de diagnóstico, sem ser falha nenhuma.
  it("retry de mensagem peer (sem remoteJid) sai em silêncio, sem consultar o store", async () => {
    nextSendResult = { key: { id: "MSGP", remoteJid: JID }, message: { conversation: "oi" } };
    await connected();
    await wa.sendText(USER, NUM, JID, "oi");

    const peerKey = { id: "MSGP", fromMe: true, participant: "5511999990001@s.whatsapp.net" };
    await expect(configs[0].getMessage(peerKey)).resolves.toBeUndefined();
    // Não contou como pedido de reenvio: o store nem foi consultado.
    expect(msgStore.stats("MSGP")).toMatchObject({ retries: 0 });
  });
});

describe("cache de chaves e de metadata de grupo", () => {
  beforeEach(async () => {
    try { await wa.deleteSession(USER, NUM); } catch { /* ignore */ }
    configs = []; sockets = []; nextSendResult = null; groupMetaCalls = [];
    msgStore.__clear();
  });

  afterAll(async () => { try { await wa.deleteSession(USER, NUM); } catch { /* ignore */ } });

  it("o socket recebe as chaves Signal embrulhadas em cache, não o store cru", async () => {
    await wa.startSession(USER, NUM);
    const { auth } = configs[0];
    expect(auth.creds).toBeDefined();
    // makeCacheableSignalKeyStore devolve um objeto novo com get/set/clear — o
    // store cru do adapter não tem clear.
    expect(typeof auth.keys.get).toBe("function");
    expect(typeof auth.keys.clear).toBe("function");
  });

  it("metadata de grupo é servida do cache — um IQ por grupo, não um por envio", async () => {
    await connected();
    const GRUPO = "12345@g.us";

    const first = await configs[0].cachedGroupMetadata(GRUPO);
    expect(first).toMatchObject({ id: GRUPO });
    expect(groupMetaCalls).toEqual([GRUPO]);

    await configs[0].cachedGroupMetadata(GRUPO);
    await configs[0].cachedGroupMetadata(GRUPO);
    expect(groupMetaCalls).toEqual([GRUPO]);      // não foi à rede de novo
  });

  // Participante que entra/sai muda a lista de destinatários da sender key.
  // Servir lista velha é cifrar pra quem não consegue abrir — o "Aguardando
  // mensagem" do outro lado.
  it("mudança de participante invalida o cache daquele grupo", async () => {
    await connected();
    const GRUPO = "12345@g.us";
    await configs[0].cachedGroupMetadata(GRUPO);
    expect(groupMetaCalls).toEqual([GRUPO]);

    sockets[0].emit("group-participants.update", { id: GRUPO, action: "add" });
    await configs[0].cachedGroupMetadata(GRUPO);
    expect(groupMetaCalls).toEqual([GRUPO, GRUPO]);

    sockets[0].emit("groups.update", [{ id: GRUPO, subject: "novo nome" }]);
    await configs[0].cachedGroupMetadata(GRUPO);
    expect(groupMetaCalls).toHaveLength(3);
  });

  it("falha no groupMetadata devolve undefined — o Baileys busca por conta própria", async () => {
    await connected();
    sockets[0].groupMetadata = async () => { throw new Error("timeout"); };
    await expect(configs[0].cachedGroupMetadata("999@g.us")).resolves.toBeUndefined();
  });
});
