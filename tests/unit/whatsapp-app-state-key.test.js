// A chave de app state que a limpeza automática (task 13) precisa — ver
// backend/whatsapp/app-state-key.js. Em prod um número ficou com o id da chave nas
// creds e nenhuma chave salva: todo "Limpar conversa" falhava com
// `myAppStateKey ("…") not present`. Aqui a mecânica do conserto: detectar a chave
// ausente, pedir ao celular (mensagem "peer" pro próprio jid) sem rajada, e esperar
// a resposta. Socket falso: nada toca em rede.
import "../helpers/env.js";
import { describe, it, expect } from "vitest";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEY_JS = path.resolve(__dirname, "..", "..", "backend", "whatsapp", "app-state-key.js");
const require = createRequire(pathToFileURL(KEY_JS));
const appKey = require(KEY_JS);

function fakeSession({ keyId = "AAAAAFGn", stored = false } = {}) {
  const keys = new Map(stored ? [[keyId, { keyData: "x" }]] : []);
  const relayed = [];
  const sock = {
    authState: {
      creds: { myAppStateKeyId: keyId, me: { id: "5511999999999:74@s.whatsapp.net" } },
      keys: { get: async (type, ids) => Object.fromEntries(ids.filter(id => type === "app-state-sync-key" && keys.has(id)).map(id => [id, keys.get(id)])) },
    },
    relayMessage: async (jid, msg, opts) => { relayed.push({ jid, msg, opts }); return "MSGID"; },
  };
  return { session: { userId: "u", numberId: "n", sock }, keys, relayed };
}

describe("isMissingKeyError", () => {
  it("reconhece o Boom do Baileys e mais nada", () => {
    expect(appKey.isMissingKeyError({ data: { isMissingKey: true } })).toBe(true);
    expect(appKey.isMissingKeyError(new Error("myAppStateKey"))).toBe(false);
    expect(appKey.isMissingKeyError(undefined)).toBe(false);
  });
});

describe("hasAppStateKey", () => {
  it("true só com a chave atual no store", async () => {
    expect(await appKey.hasAppStateKey(fakeSession({ stored: true }).session.sock)).toBe(true);
    expect(await appKey.hasAppStateKey(fakeSession().session.sock)).toBe(false);
    expect(await appKey.hasAppStateKey(fakeSession({ keyId: undefined }).session.sock)).toBe(false);
  });
});

describe("requestAppStateKey", () => {
  it("manda o pedido peer pro próprio jid com o id da chave", async () => {
    const { session, relayed } = fakeSession();
    expect(await appKey.requestAppStateKey(session)).toBe(true);
    expect(relayed).toHaveLength(1);
    const { jid, msg, opts } = relayed[0];
    expect(jid).toBe("5511999999999@s.whatsapp.net");
    expect(msg.protocolMessage.type).toBe(7);
    expect(Buffer.from(msg.protocolMessage.appStateSyncKeyRequest.keyIds[0].keyId).toString("base64")).toBe("AAAAAFGn");
    expect(opts.additionalAttributes).toMatchObject({ category: "peer" });
  });

  it("não repete o pedido dentro do cooldown", async () => {
    const { session, relayed } = fakeSession();
    const t0 = Date.now();
    await appKey.requestAppStateKey(session, { now: t0 });
    expect(await appKey.requestAppStateKey(session, { now: t0 + 1000 })).toBe(false);
    expect(relayed).toHaveLength(1);
    expect(await appKey.requestAppStateKey(session, { now: t0 + 11 * 60 * 1000 })).toBe(true);
    expect(relayed).toHaveLength(2);
  });
});

describe("recoverAppStateKey", () => {
  it("true quando a chave chega depois do pedido", async () => {
    const { session, keys, relayed } = fakeSession();
    session.sock.relayMessage = async (...a) => { relayed.push(a); setTimeout(() => keys.set("AAAAAFGn", {}), 20); };
    expect(await appKey.recoverAppStateKey(session, { waitMs: 500, pollMs: 10 })).toBe(true);
    expect(relayed).toHaveLength(1);
  });

  it("false quando o celular não responde", async () => {
    const { session } = fakeSession();
    expect(await appKey.recoverAppStateKey(session, { waitMs: 50, pollMs: 10 })).toBe(false);
  });

  it("não pede nada se a chave já está lá", async () => {
    const { session, relayed } = fakeSession({ stored: true });
    expect(await appKey.recoverAppStateKey(session, { waitMs: 50, pollMs: 10 })).toBe(true);
    expect(relayed).toHaveLength(0);
  });
});
