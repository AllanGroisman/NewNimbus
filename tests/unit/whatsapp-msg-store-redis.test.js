// A camada durável do msg-store (backend/whatsapp/msg-store.js).
//
// O store em memória vive no processo do socket, tem teto de 1000 e TTL de 1h.
// Isso deixava um buraco: todo `pm2 reload` de deploy, todo `max_memory_restart`
// e todo crash do worker transformavam os retry receipts pendentes daquele
// instante em placeholder eterno — o aparelho pedia o reenvio, o getMessage
// respondia undefined, e o "Aguardando mensagem" nunca mais saía da tela.
// Com o Redis (só em QUEUE_BACKEND=redis), o reenvio ainda é possível depois de
// o processo ter sido reiniciado.
//
// QUEUE_BACKEND e MAX/TTL são lidos no require, então o módulo entra por
// createRequire DEPOIS de ajustar o env; o ioredis entra por require.cache.
import "../helpers/env.js";
import { describe, it, expect, beforeEach } from "vitest";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE_JS = path.resolve(__dirname, "..", "..", "backend", "whatsapp", "msg-store.js");
const require = createRequire(pathToFileURL(STORE_JS));
const IOREDIS = require.resolve("ioredis");

// Redis de mentira: um Map com os mesmos verbos que o store usa.
const redisData = new Map();
let redisFail = null;
const fakeClient = {
  on: () => {},
  set: async (k, v) => { if (redisFail) throw redisFail; redisData.set(k, v); return "OK"; },
  get: async (k) => { if (redisFail) throw redisFail; return redisData.get(k) ?? null; },
};
require.cache[IOREDIS] = {
  id: IOREDIS, filename: IOREDIS, loaded: true, children: [], paths: [],
  exports: function IORedis() { return fakeClient; },
};

process.env.QUEUE_BACKEND = "redis";
process.env.WA_MSG_STORE_MAX = "2";
process.env.WA_MSG_STORE_TTL_MS = "60000";
const store = require(STORE_JS);

const sent = (id, text) => ({ key: { id, remoteJid: "5511999999999@s.whatsapp.net" }, message: { conversation: text } });
const flush = () => new Promise(r => setTimeout(r, 0));

describe("msg-store — camada durável no Redis", () => {
  beforeEach(() => { store.__clear(); redisData.clear(); redisFail = null; });

  it("liga a camada durável quando o backend de fila é redis", () => {
    expect(store.USE_REDIS).toBe(true);
  });

  it("o que foi enviado sobrevive ao restart do worker", async () => {
    store.put(sent("MSG1", "oi"));
    await flush();
    expect(redisData.has("nimbus:wamsg:MSG1")).toBe(true);

    store.__clear();                               // é isso que um restart faz
    expect(await store.get("MSG1")).toEqual({ conversation: "oi" });
  });

  it("a mensagem revivida do Redis volta pra memória — rajada de retry não vai à rede duas vezes", async () => {
    store.put(sent("MSG1", "oi"));
    await flush();
    store.__clear();

    await store.get("MSG1");
    expect(store.__size()).toBe(1);
    expect(store.stats("MSG1")).toMatchObject({ known: true, retries: 1, source: "redis" });

    await store.get("MSG1");
    expect(store.stats("MSG1")).toMatchObject({ retries: 2 });
  });

  it("o que caiu do teto de memória ainda é reenviável", async () => {
    for (const i of [1, 2, 3]) store.put(sent(`MSG${i}`, `t${i}`));
    await flush();
    expect(store.__size()).toBe(2);                 // MSG1 saiu da memória

    expect(await store.get("MSG1")).toEqual({ conversation: "t1" });
  });

  it("stats diz de onde veio o hit", async () => {
    store.put(sent("MSG1", "oi"));
    await flush();
    await store.get("MSG1");
    expect(store.stats("MSG1").source).toBe("memoria");
  });

  it("id que ninguém conhece continua devolvendo undefined", async () => {
    expect(await store.get("NAO_EXISTE")).toBeUndefined();
  });

  it("Redis fora do ar não derruba nem o envio nem a busca", async () => {
    redisFail = new Error("ECONNREFUSED");
    expect(() => store.put(sent("MSG1", "oi"))).not.toThrow();
    await flush();
    // A memória continua servindo normalmente...
    expect(await store.get("MSG1")).toEqual({ conversation: "oi" });
    // ...e o que só existiria no Redis simplesmente não é achado.
    store.__clear();
    expect(await store.get("MSG1")).toBeUndefined();
  });
});
