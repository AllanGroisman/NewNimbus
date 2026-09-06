// O store que sustenta o getMessage do socket (ver backend/whatsapp/msg-store.js).
//
// Sem ele, o retry receipt do destinatário fica sem resposta e a mensagem trava em
// "Aguardando mensagem. Essa ação pode levar alguns instantes" no celular dele.
// Aqui só a mecânica: guardar, devolver, expirar e não crescer sem limite.
//
// MAX/TTL são lidos no require, então o módulo entra por createRequire DEPOIS de
// ajustar o env — com `import` estático a leitura aconteceria antes.
//
// `get` é async desde que ganhou a camada Redis (ver whatsapp-msg-store-redis.test.js);
// aqui rodamos em memory mode, então nada toca em rede.
import "../helpers/env.js";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE_JS = path.resolve(__dirname, "..", "..", "backend", "whatsapp", "msg-store.js");
const require = createRequire(pathToFileURL(STORE_JS));

process.env.WA_MSG_STORE_MAX = "3";
process.env.WA_MSG_STORE_TTL_MS = "60000";
const store = require(STORE_JS);

const sent = (id, text) => ({ key: { id, remoteJid: "5511999999999@s.whatsapp.net" }, message: { conversation: text } });

describe("msg-store — mensagens enviadas disponíveis pro reenvio", () => {
  beforeEach(() => store.__clear());
  afterEach(() => vi.useRealTimers());

  it("devolve pelo id a mensagem que foi enviada", async () => {
    store.put(sent("MSG1", "oi"));
    expect(await store.get("MSG1")).toEqual({ conversation: "oi" });
  });

  it("id que nunca passou por aqui devolve undefined", async () => {
    expect(await store.get("NAO_EXISTE")).toBeUndefined();
    expect(await store.get(undefined)).toBeUndefined();
  });

  it("retorno malformado do Baileys não lança e não entra no store", async () => {
    expect(() => store.put(undefined)).not.toThrow();
    expect(() => store.put({})).not.toThrow();
    expect(() => store.put({ key: {}, message: { conversation: "x" } })).not.toThrow();
    expect(() => store.put({ key: { id: "SEM_CONTEUDO" } })).not.toThrow();
    expect(await store.get("SEM_CONTEUDO")).toBeUndefined();
    expect(store.__size()).toBe(0);
  });

  it("estourar o teto derruba a mais antiga e mantém a mais nova", async () => {
    for (const i of [1, 2, 3, 4]) store.put(sent(`MSG${i}`, `t${i}`));
    expect(store.__size()).toBe(3);
    expect(await store.get("MSG1")).toBeUndefined();     // a mais antiga saiu
    expect(await store.get("MSG4")).toEqual({ conversation: "t4" });
  });

  it("cada busca pelo reenvio é contada — é o único sinal de que o aparelho travou", async () => {
    store.put(sent("MSG1", "oi"));
    expect(store.stats("MSG1")).toMatchObject({ known: true, retries: 0 });

    await store.get("MSG1");   // o Baileys veio buscar pra atender um retry receipt
    await store.get("MSG1");   // e veio de novo
    const st = store.stats("MSG1");
    expect(st).toMatchObject({ known: true, retries: 2 });
    expect(typeof st.lastRetryAt).toBe("number");
  });

  it("stats de id que o processo não conhece não afirma nada", () => {
    expect(store.stats("NUNCA_VISTO")).toEqual({ known: false, retries: 0, lastRetryAt: null, source: null });
    expect(store.stats(undefined)).toEqual({ known: false, retries: 0, lastRetryAt: null, source: null });
  });

  it("stats depois do TTL volta a ser desconhecido", async () => {
    vi.useFakeTimers();
    store.put(sent("MSG1", "oi"));
    vi.advanceTimersByTime(61_000);
    await store.get("MSG1");                       // a leitura expira a entrada
    expect(store.stats("MSG1").known).toBe(false);
  });

  it("passado o TTL a mensagem não volta mais", async () => {
    vi.useFakeTimers();
    store.put(sent("MSG1", "oi"));
    vi.advanceTimersByTime(59_000);
    expect(await store.get("MSG1")).toEqual({ conversation: "oi" });
    vi.advanceTimersByTime(2_000);                 // 61s > TTL de 60s
    expect(await store.get("MSG1")).toBeUndefined();
    expect(store.__size()).toBe(0);                // expirou na leitura, sem timer
  });
});
