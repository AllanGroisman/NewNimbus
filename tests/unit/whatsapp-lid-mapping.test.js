// O mapa PN↔LID nativo do Baileys 7, gravado pelo NOSSO adapter de Postgres.
//
// Este é o teste que substitui o antigo whatsapp-lid-patch.test.js. Aquele
// assertava strings literais do fonte patchado em node_modules; este prova o
// comportamento que a migração comprou.
//
// O bug: o WhatsApp passou a endereçar aparelhos por LID (4269197504618@lid) em
// vez do telefone (555596168060@s.whatsapp.net). Sem um mapa PN↔LID, o Baileys
// 6.7.23 montava o destinatário da sender key de grupo como `<telefone>@lid` —
// endereço que não existe. A chave não chegava a ninguém, o grupo inteiro ficava
// em "Aguardando mensagem" e pedia reenvio até desistir: 3.044 pedidos num dia,
// 3.013 num só grupo.
//
// O 7 tem LIDMappingStore nativo, e ele persiste pelo `keys.get`/`keys.set` do
// nosso backend/auth/baileys-pg.js — que nunca soube o que é um "lid-mapping".
// É essa junção que o teste exercita, ponta a ponta, sem rede e sem Postgres:
//
//   LIDMappingStore → addTransactionCapability → makeCacheableSignalKeyStore
//     → useDatabaseAuthState (nosso) → encode/AES/BufferJSON → "banco"
//
// Os números são os do incidente real, documentados em backend/whatsapp/README.md.
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

// Chave fixa: queremos o caminho CIFRADO (AES-256-GCM, prefixo "v1:"), que é como
// as linhas existem em produção. Precisa estar no env ANTES de carregar o módulo,
// que resolve a chave uma vez só, no load.
process.env.SESSION_ENC_KEY = "0".repeat(64);

const {
  DEFAULT_CONNECTION_CONFIG,
  addTransactionCapability,
  makeCacheableSignalKeyStore,
} = require("@whiskeysockets/baileys");

const PN = "555596168060@s.whatsapp.net";
const PN_USER = "555596168060";
const LID = "4269197504618@lid";
const LID_USER = "4269197504618";
const SESSION = "u1::555596168060";

// "Banco" em memória com a mesma PK composta da tabela baileys_auth. Guarda o
// value JÁ codificado — é isso que faz o round-trip provar encode/decode.
let rows;

function apply(op, args) {
  const w = args.where?.sessionId_keyType_keyId;
  if (op === "upsert") {
    rows.set(`${w.sessionId}|${w.keyType}|${w.keyId}`, { ...w, value: args.create.value });
  } else if (op === "deleteMany") {
    rows.delete(`${args.where.sessionId}|${args.where.keyType}|${args.where.keyId}`);
  }
}

// Thenable: aplica ao ser aguardado. Cobre os dois caminhos do adapter — o
// writeKey, que dá `await upsert(...)` direto, e o keys.set, que junta as ops
// numa lista e entrega ao $transaction.
const lazy = (op, args) => ({ then(res) { apply(op, args); res(undefined); } });

const fakePrisma = {
  baileysAuth: {
    findUnique: async ({ where }) => {
      const w = where.sessionId_keyType_keyId;
      return rows.get(`${w.sessionId}|${w.keyType}|${w.keyId}`) || null;
    },
    findMany: async ({ where }) => {
      const wanted = new Set(where.keyId.in);
      return [...rows.values()].filter(
        r => r.sessionId === where.sessionId && r.keyType === where.keyType && wanted.has(r.keyId),
      );
    },
    upsert: args => lazy("upsert", args),
    deleteMany: args => lazy("deleteMany", args),
  },
  $transaction: async ops => Promise.all(ops),
};

require.cache[DB_JS] = {
  id: DB_JS, filename: DB_JS, loaded: true, children: [], paths: [],
  exports: { prisma: () => fakePrisma, disconnect: async () => {} },
};

const { useDatabaseAuthState } = require(AUTH_JS);

const silent = { level: "silent", trace() {}, debug() {}, info() {}, warn() {}, error() {}, child() { return silent; } };

// Monta a pilha exatamente como o socket do Baileys 7 monta (Socket/socket.js):
// o addTransactionCapability entra POR CIMA do makeCacheableSignalKeyStore, e é
// dele que vem o `keys.transaction(exec, 'lid-mapping')` que o LIDMappingStore usa.
async function makeRepo(pnToLIDFunc) {
  const { state } = await useDatabaseAuthState(SESSION);
  const keys = addTransactionCapability(
    makeCacheableSignalKeyStore(state.keys, silent),
    silent,
    DEFAULT_CONNECTION_CONFIG.transactionOpts,
  );
  return DEFAULT_CONNECTION_CONFIG.makeSignalRepository({ creds: state.creds, keys }, silent, pnToLIDFunc);
}

beforeEach(() => { rows = new Map(); });

describe("mapa PN↔LID do Baileys 7 sobre o auth-state de Postgres", () => {
  it("grava o keyType 'lid-mapping', que o adapter nunca precisou conhecer", async () => {
    const repo = await makeRepo(async () => []);
    await repo.lidMapping.storeLIDPNMappings([{ lid: LID, pn: PN }]);

    const lidRows = [...rows.values()].filter(r => r.keyType === "lid-mapping");
    // Duas linhas por par: o direto e o reverso (Signal/lid-mapping.js).
    expect(lidRows.map(r => r.keyId).sort()).toEqual([`${LID_USER}_reverse`, PN_USER]);
    // E cifradas: é assim que elas existem no banco de verdade.
    for (const r of lidRows) expect(r.value.startsWith("v1:")).toBe(true);
  });

  it("resolve o PN para o LID — com o DEVICE preservado", async () => {
    const repo = await makeRepo(async () => []);
    await repo.lidMapping.storeLIDPNMappings([{ lid: LID, pn: PN }]);

    expect(await repo.lidMapping.getLIDForPN(PN)).toBe(LID);
    // ESTA é a conta que o 6.7.23 errava. Ele produzia "555596168060:47@lid" —
    // o telefone no domínio @lid, endereço inexistente, e a sender key do grupo
    // não chegava a ninguém.
    expect(await repo.lidMapping.getLIDForPN("555596168060:47@s.whatsapp.net")).toBe("4269197504618:47@lid");
    expect(await repo.lidMapping.getLIDForPN("555596168060:31@s.whatsapp.net")).toBe("4269197504618:31@lid");
  });

  it("o mapa sobrevive ao processo: um store novo relê do banco, sem ir à USync", async () => {
    const gravador = await makeRepo(async () => []);
    await gravador.lidMapping.storeLIDPNMappings([{ lid: LID, pn: PN }]);

    // Store novo = cache LRU frio. Se resolver, veio do "Postgres" — ou seja, o
    // encode/decode (BufferJSON + AES) preservou o valor.
    let usyncChamadas = 0;
    const leitor = await makeRepo(async () => { usyncChamadas++; return []; });

    expect(await leitor.lidMapping.getLIDForPN(PN)).toBe(LID);
    // O reverso volta com o device explícito (":0"), que é como o Baileys
    // formata o endereço do aparelho principal.
    expect(await leitor.lidMapping.getPNForLID(LID)).toBe("555596168060:0@s.whatsapp.net");
    // Se tivesse ido à rede, o mapa persistido não estaria valendo de nada.
    expect(usyncChamadas).toBe(0);
  });
});
