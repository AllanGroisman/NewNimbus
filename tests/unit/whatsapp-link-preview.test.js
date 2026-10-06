// Cartão da prévia do link (modo "Prévia do link" da campanha): o sistema monta o
// que o celular montaria ao colar o link — título + foto. A miniatura embutida sai
// com 192px (aparece mesmo com download automático desligado) e a foto em alta sobe
// como "thumbnail-link". Falha de foto/upload nunca derruba o envio.
//
// Baileys e o adapter de auth entram por require.cache (mesma técnica de
// unit/whatsapp-mention-all.test.js).
import "../helpers/env.js";
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { EventEmitter } from "events";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(__dirname, "..", "..", "backend");
const LOCAL_JS = path.join(BACKEND, "whatsapp", "local.js");
const LINK_PREVIEW_JS = path.join(BACKEND, "whatsapp", "link-preview.js");
const require = createRequire(pathToFileURL(LOCAL_JS));

const BAILEYS = require.resolve("@whiskeysockets/baileys");
const PG_AUTH = path.join(BACKEND, "auth", "baileys-pg.js");
const NOTIFIER = path.join(BACKEND, "notifications", "user-notifier.js");
const { DisconnectReason, makeCacheableSignalKeyStore } = require("@whiskeysockets/baileys");

let sockets = [];
let sent = [];
let metaImpl = async () => ({ id: "g", participants: [] });

const uploadFn = async () => ({ mediaUrl: "https://mmg/x", directPath: "/x" });
function fakeSocket() {
  const ev = new EventEmitter();
  const sock = {
    ev: { on: (e, h) => ev.on(e, h), removeAllListeners: () => ev.removeAllListeners() },
    end: () => {},
    logout: async () => {},
    user: null,
    authState: { creds: { registered: true } },
    groupMetadata: async (jid) => metaImpl(jid),
    waUploadToServer: uploadFn,
    sendMessage: async (jid, content) => {
      sent.push({ jid, content });
      return { key: { id: `ID_${sent.length}` }, message: { conversation: content.text } };
    },
    emit: (e, payload) => ev.emit(e, payload),
  };
  sockets.push(sock);
  return sock;
}

// Funções de mídia do Baileys trocáveis por teste.
const THUMB = Buffer.from("thumb-192");
const HQ = { directPath: "/hq", mediaKey: Buffer.from("k"), width: 800, height: 800 };
let thumbImpl;
let prepareImpl;
const thumbCalls = [];
const prepareCalls = [];

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
  extractImageThumb: async (buf, width) => { thumbCalls.push({ buf, width }); return thumbImpl(buf, width); },
  prepareWAMessageMedia: async (msg, opts) => { prepareCalls.push({ msg, opts }); return prepareImpl(msg, opts); },
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
const linkPreview = require(LINK_PREVIEW_JS);

afterAll(() => {
  vi.unstubAllGlobals();
  for (const [p, prev] of stubbed) {
    if (prev) require.cache[p] = prev; else delete require.cache[p];
  }
  delete require.cache[LOCAL_JS];
  delete require.cache[LINK_PREVIEW_JS];
});

const IMG_BYTES = Buffer.from("jpeg-original");
let fetchCalls;
function imageFetchOk() {
  return vi.fn(async (url) => {
    fetchCalls.push(url);
    return { ok: true, status: 200, arrayBuffer: async () => IMG_BYTES.buffer.slice(IMG_BYTES.byteOffset, IMG_BYTES.byteOffset + IMG_BYTES.length) };
  });
}

const SPEC = { url: "https://meli.la/MEU", title: "Fone Bluetooth", img: "https://img/x.jpg" };

beforeEach(() => {
  linkPreview._resetCache();
  sockets = []; sent = []; fetchCalls = [];
  thumbCalls.length = 0; prepareCalls.length = 0;
  thumbImpl = async () => ({ buffer: THUMB, original: { width: 800, height: 800 } });
  prepareImpl = async () => ({ imageMessage: HQ });
  vi.stubGlobal("fetch", imageFetchOk());
});

describe("buildLinkPreview", () => {
  it("monta o cartão com miniatura de 192px e a foto em alta como thumbnail-link", async () => {
    const p = await linkPreview.buildLinkPreview(SPEC, { upload: uploadFn, cacheKey: "n1" });

    expect(p).toEqual({
      "matched-text": SPEC.url, "canonical-url": SPEC.url, title: "Fone Bluetooth",
      jpegThumbnail: THUMB, highQualityThumbnail: HQ,
    });
    expect(fetchCalls).toEqual([SPEC.img]);
    expect(thumbCalls[0].width).toBe(192);
    // A miniatura vai no upload: assim o Baileys não gera a de 32px por cima.
    expect(prepareCalls[0].msg).toMatchObject({ jpegThumbnail: THUMB, width: 800, height: 800 });
    expect(Buffer.isBuffer(prepareCalls[0].msg.image)).toBe(true);
    expect(prepareCalls[0].opts).toMatchObject({ upload: uploadFn, mediaTypeOverride: "thumbnail-link" });
  });

  it("upload falhou: vai só a miniatura embutida", async () => {
    prepareImpl = async () => { throw new Error("upload 500"); };

    const p = await linkPreview.buildLinkPreview(SPEC, { upload: uploadFn, cacheKey: "n1" });

    expect(p.jpegThumbnail).toBe(THUMB);
    expect(p).not.toHaveProperty("highQualityThumbnail");
  });

  it("foto não baixou: cartão só com título e link", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 403 })));

    const p = await linkPreview.buildLinkPreview(SPEC, { upload: uploadFn, cacheKey: "n1" });

    expect(p).toEqual({ "matched-text": SPEC.url, "canonical-url": SPEC.url, title: "Fone Bluetooth" });
    expect(prepareCalls).toHaveLength(0);
  });

  it("sem foto no item: nem tenta baixar", async () => {
    const p = await linkPreview.buildLinkPreview({ ...SPEC, img: null }, { upload: uploadFn, cacheKey: "n1" });

    expect(p).toEqual({ "matched-text": SPEC.url, "canonical-url": SPEC.url, title: "Fone Bluetooth" });
    expect(fetchCalls).toHaveLength(0);
  });

  it("cache: o mesmo item pra vários grupos do mesmo número sobe a foto uma vez só", async () => {
    await linkPreview.buildLinkPreview(SPEC, { upload: uploadFn, cacheKey: "n1" });
    await linkPreview.buildLinkPreview(SPEC, { upload: uploadFn, cacheKey: "n1" });
    expect(prepareCalls).toHaveLength(1);

    // Outro número sobe pelo próprio socket.
    await linkPreview.buildLinkPreview(SPEC, { upload: uploadFn, cacheKey: "n2" });
    expect(prepareCalls).toHaveLength(2);
  });
});

describe("sendText com prévia do link", () => {
  const USER = "user-preview";
  const GROUP = "120363000000000001@g.us";

  async function connected(numberId) {
    await wa.startSession(USER, numberId);
    sockets[sockets.length - 1].emit("connection.update", { connection: "open" });
  }

  it("a mensagem leva o linkPreview montado pelo socket do número", async () => {
    const NUM = "5511900000201";
    await connected(NUM);

    await wa.sendText(USER, NUM, GROUP, "Fone https://meli.la/MEU", { linkPreview: SPEC });

    expect(sent[0].content).toEqual({
      text: "Fone https://meli.la/MEU",
      linkPreview: {
        "matched-text": SPEC.url, "canonical-url": SPEC.url, title: "Fone Bluetooth",
        jpegThumbnail: THUMB, highQualityThumbnail: HQ,
      },
    });
    expect(prepareCalls[0].opts.upload).toBe(uploadFn);
    await wa.deleteSession(USER, NUM);
  });

  it("junto com @todos: mentions e linkPreview na mesma mensagem", async () => {
    const NUM = "5511900000202";
    await connected(NUM);
    metaImpl = async () => ({ id: GROUP, participants: [{ id: "111@lid" }] });

    await wa.sendText(USER, NUM, GROUP, "x https://meli.la/MEU", { mentionAll: true, linkPreview: SPEC });

    expect(sent[0].content.mentions).toEqual(["111@lid"]);
    expect(sent[0].content.linkPreview.title).toBe("Fone Bluetooth");
    await wa.deleteSession(USER, NUM);
  });

  it("se a prévia estourar, a mensagem sai como texto puro", async () => {
    const NUM = "5511900000203";
    await connected(NUM);
    const spy = vi.spyOn(linkPreview, "buildLinkPreview").mockRejectedValue(new Error("boom"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await wa.sendText(USER, NUM, GROUP, "x https://meli.la/MEU", { linkPreview: SPEC });

    expect(sent[0].content).toEqual({ text: "x https://meli.la/MEU" });
    spy.mockRestore(); warn.mockRestore();
    await wa.deleteSession(USER, NUM);
  });

  it("sem linkPreview nas opções, nada muda", async () => {
    const NUM = "5511900000204";
    await connected(NUM);

    await wa.sendText(USER, NUM, GROUP, "normal https://meli.la/MEU");

    expect(sent[0].content).toEqual({ text: "normal https://meli.la/MEU" });
    expect(fetchCalls).toHaveLength(0);
    await wa.deleteSession(USER, NUM);
  });
});
