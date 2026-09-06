// A gravação do estado Signal (backend/auth/baileys-pg.js).
//
// O relayMessage do Baileys envolve o envio inteiro numa transação de chaves e só
// COMMITA no fim — quando o commit falha, o texto cifrado JÁ saiu na rede. Se a
// gravação for parcial (metade das mutações entra, metade não), ou se a falha
// passar em silêncio, o ratchet fica avançado na memória e velho no banco: a
// partir daí o destinatário não decripta mais nada e o celular dele mostra
// "Aguardando mensagem" pra sempre. Foi o que os logs de produção mostraram
// ("failed to commit 3 mutations" + pool de conexões estourado).
//
// Este arquivo trava as três garantias que evitam isso:
//   1. keys.set é UMA transação, tudo ou nada;
//   2. keys.get é UMA query (o fan-out de N findUnique era o que estourava o pool);
//   3. falha de gravação avisa quem abriu a sessão (onPersistError), em vez de
//      sumir dentro do retry silencioso do Baileys.
//
// `backend/db.js` entra por require.cache — os unitários não tocam em Postgres.
import "../helpers/env.js";
import { describe, it, expect, beforeEach } from "vitest";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(__dirname, "..", "..", "backend");
const AUTH_JS = path.join(BACKEND, "auth", "baileys-pg.js");
const DB_JS = path.join(BACKEND, "db.js");
const require = createRequire(pathToFileURL(AUTH_JS));

const { BufferJSON } = require("@whiskeysockets/baileys");

// Cada operação do Prisma vira um objeto-marcador; o $transaction só recebe a
// lista. É exatamente o contrato que o baileys-pg usa.
let calls;
let txResult;

const fakePrisma = {
  baileysAuth: {
    findUnique: async ({ where }) => { calls.findUnique.push(where); return null; },
    findMany: async (args) => { calls.findMany.push(args); return calls.rows; },
    upsert: (args) => { calls.upsert.push(args); return { op: "upsert", args }; },
    deleteMany: (args) => { calls.deleteMany.push(args); return { op: "deleteMany", args }; },
    delete: async (args) => { calls.delete.push(args); },
  },
  $transaction: async (ops) => {
    calls.transaction.push(ops);
    if (txResult instanceof Error) throw txResult;
    return ops;
  },
};

require.cache[DB_JS] = {
  id: DB_JS, filename: DB_JS, loaded: true, children: [], paths: [],
  exports: { prisma: () => fakePrisma, disconnect: async () => {} },
};

const auth = require(AUTH_JS);
const SESSION = "user-1::5511999999999";

beforeEach(() => {
  calls = { findUnique: [], findMany: [], upsert: [], deleteMany: [], delete: [], transaction: [], rows: [] };
  txResult = null;
});

describe("baileys-pg — gravação do estado Signal", () => {
  it("keys.set grava tudo numa transação só — nunca metade do ratchet", async () => {
    const { state } = await auth.useDatabaseAuthState(SESSION);

    await state.keys.set({
      "pre-key": { "1": { public: "p1" }, "2": { public: "p2" } },
      "session": { "5511@s.whatsapp.net": { rec: "x" } },
    });

    expect(calls.transaction).toHaveLength(1);
    expect(calls.transaction[0]).toHaveLength(3);
    expect(calls.upsert).toHaveLength(3);
    expect(calls.deleteMany).toHaveLength(0);
  });

  it("apagar chave usa deleteMany — um delete de linha inexistente abortaria a transação", async () => {
    const { state } = await auth.useDatabaseAuthState(SESSION);

    await state.keys.set({ "pre-key": { "7": null }, "session": { "abc": { rec: "x" } } });

    expect(calls.transaction).toHaveLength(1);
    expect(calls.deleteMany).toHaveLength(1);
    expect(calls.deleteMany[0].where).toMatchObject({ sessionId: SESSION, keyType: "pre-key", keyId: "7" });
    expect(calls.upsert).toHaveLength(1);
  });

  it("set vazio não abre transação à toa", async () => {
    const { state } = await auth.useDatabaseAuthState(SESSION);
    await state.keys.set({});
    expect(calls.transaction).toHaveLength(0);
  });

  it("keys.get busca N chaves numa query só — o fan-out estourava o pool", async () => {
    calls.rows = [{ keyId: "a", value: JSON.stringify({ rec: "A" }, BufferJSON.replacer) }];
    const { state } = await auth.useDatabaseAuthState(SESSION);
    calls.findMany = [];

    const got = await state.keys.get("session", ["a", "b"]);

    expect(calls.findMany).toHaveLength(1);
    expect(calls.findMany[0].where).toMatchObject({ sessionId: SESSION, keyType: "session" });
    expect(calls.findMany[0].where.keyId).toEqual({ in: ["a", "b"] });
    expect(got.a).toEqual({ rec: "A" });
    // `null`, não undefined: dentro de uma transação o Baileys só refaz a busca
    // do que voltou undefined.
    expect(got.b).toBeNull();
  });

  it("keys.get sem ids não vai ao banco", async () => {
    const { state } = await auth.useDatabaseAuthState(SESSION);
    calls.findMany = [];
    expect(await state.keys.get("session", [])).toEqual({});
    expect(calls.findMany).toHaveLength(0);
  });

  it("falha de gravação avisa quem abriu a sessão E propaga", async () => {
    const seen = [];
    const { state } = await auth.useDatabaseAuthState(SESSION, {
      onPersistError: (err) => seen.push(err),
    });
    txResult = new Error("Timed out fetching a new connection from the connection pool");

    await expect(state.keys.set({ "session": { "abc": { rec: "x" } } })).rejects.toThrow(/connection pool/);
    expect(seen).toHaveLength(1);
    expect(seen[0].message).toMatch(/connection pool/);
  });

  it("um onPersistError que explode não pode derrubar a gravação", async () => {
    const { state } = await auth.useDatabaseAuthState(SESSION, {
      onPersistError: () => { throw new Error("aviso quebrado"); },
    });
    txResult = new Error("banco fora");

    // O erro que sobe é o do BANCO, não o do aviso.
    await expect(state.keys.set({ "session": { "abc": { rec: "x" } } })).rejects.toThrow("banco fora");
  });
});
