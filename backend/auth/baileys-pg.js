// Auth state Baileys em Postgres.
//
// Persiste credenciais Baileys na tabela `baileys_auth`. Mesma interface que
// Baileys espera: { state: { creds, keys: { get, set } }, saveCreds }.
//
// Vantagens:
//   - Trocar de máquina sem perder sessão (basta apontar pro mesmo Postgres)
//   - Backup automático (vai junto no dump do PG)
//   - Múltiplos workers podem ler do mesmo storage (Phase 2.2 — sticky routing)

const { initAuthCreds, BufferJSON, proto } = require("@whiskeysockets/baileys");
const { prisma } = require("../db");

// Encode/decode do valor — BufferJSON suporta os Buffer nodes do Signal protocol
function encode(value) {
  return JSON.stringify(value, BufferJSON.replacer);
}
function decode(str) {
  if (str == null) return null;
  return JSON.parse(str, BufferJSON.reviver);
}

async function readKey(sessionId, keyType, keyId) {
  const row = await prisma().baileysAuth.findUnique({
    where: { sessionId_keyType_keyId: { sessionId, keyType, keyId: keyId || "" } },
  });
  return row ? decode(row.value) : null;
}

async function writeKey(sessionId, keyType, keyId, value) {
  const v = encode(value);
  await prisma().baileysAuth.upsert({
    where: { sessionId_keyType_keyId: { sessionId, keyType, keyId: keyId || "" } },
    create: { sessionId, keyType, keyId: keyId || "", value: v },
    update: { value: v },
  });
}

async function deleteKey(sessionId, keyType, keyId) {
  try {
    await prisma().baileysAuth.delete({
      where: { sessionId_keyType_keyId: { sessionId, keyType, keyId: keyId || "" } },
    });
  } catch {
    // ignore — chave não existia
  }
}

async function deleteSession(sessionId) {
  await prisma().baileysAuth.deleteMany({ where: { sessionId } });
}

// API que Baileys consome. Espelha useMultiFileAuthState.
async function useDatabaseAuthState(sessionId) {
  // Carrega creds (cria nova se nunca existiu)
  const stored = await readKey(sessionId, "creds", "");
  const creds = stored || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(ids.map(async id => {
            let value = await readKey(sessionId, type, id);
            if (type === "app-state-sync-key" && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            data[id] = value;
          }));
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const type of Object.keys(data)) {
            for (const id of Object.keys(data[type])) {
              const value = data[type][id];
              if (value) tasks.push(writeKey(sessionId, type, id, value));
              else tasks.push(deleteKey(sessionId, type, id));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    // Baileys chama em creds.update; ref ao `creds` é mutada por Baileys.
    saveCreds: async () => {
      await writeKey(sessionId, "creds", "", creds);
    },
  };
}

module.exports = { useDatabaseAuthState, deleteSession, readKey, writeKey, deleteKey };
