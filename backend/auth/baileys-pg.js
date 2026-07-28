// Auth state Baileys em Postgres.
//
// Persiste credenciais Baileys na tabela `baileys_auth`. Mesma interface que
// Baileys espera: { state: { creds, keys: { get, set } }, saveCreds }.
//
// Vantagens:
//   - Trocar de máquina sem perder sessão (basta apontar pro mesmo Postgres)
//   - Backup automático (vai junto no dump do PG)
//   - Múltiplos workers podem ler do mesmo storage (Phase 2.2 — sticky routing)

const crypto = require("crypto");
const { initAuthCreds, BufferJSON, proto } = require("@whiskeysockets/baileys");
const { prisma } = require("../db");

// ── Cifra em repouso ────────────────────────────────────────────────────
// Estas linhas guardam as chaves do Signal e as credenciais completas da sessão
// do WhatsApp: quem as lê assume a conta do cliente e envia em nome dele. Como
// elas vão junto em todo dump do banco (e os dumps sobem pra nuvem), ficar em
// texto puro significa que um backup vazado = todos os WhatsApps sequestrados.
//
// SESSION_ENC_KEY = 32 bytes em hex. Sem a variável, grava em claro (mesmo
// comportamento de antes) e avisa — assim nada quebra em quem ainda não migrou.
//
// ATENÇÃO: perder a chave = perder as sessões. Restaurar um backup numa máquina
// nova exige levar o SESSION_ENC_KEY junto; sem ele, é preciso reescanear o QR
// de cada número.
const ENC_PREFIX = "v1:";
const _encKey = (() => {
  const raw = String(process.env.SESSION_ENC_KEY || "").trim();
  if (!raw) {
    console.warn("[baileys-auth] SESSION_ENC_KEY não definida — sessões gravadas SEM cifra.");
    return null;
  }
  const buf = Buffer.from(raw, "hex");
  if (buf.length !== 32) {
    console.warn(`[baileys-auth] SESSION_ENC_KEY inválida (${buf.length} bytes, esperado 32) — gravando SEM cifra.`);
    return null;
  }
  return buf;
})();

// Encode/decode do valor — BufferJSON suporta os Buffer nodes do Signal protocol
function encode(value) {
  const json = JSON.stringify(value, BufferJSON.replacer);
  if (!_encKey) return json;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", _encKey, iv);
  const ct = Buffer.concat([cipher.update(json, "utf8"), cipher.final()]);
  return ENC_PREFIX + [iv, cipher.getAuthTag(), ct].map(b => b.toString("base64")).join(":");
}

function decode(str) {
  if (str == null) return null;
  // Linhas antigas são JSON puro — seguem legíveis, e são regravadas cifradas na
  // próxima escrita do Baileys (que acontece o tempo todo).
  if (!str.startsWith(ENC_PREFIX)) return JSON.parse(str, BufferJSON.reviver);
  if (!_encKey) throw new Error("[baileys-auth] sessão cifrada mas SESSION_ENC_KEY não está definida");
  const [ivB64, tagB64, ctB64] = str.slice(ENC_PREFIX.length).split(":");
  const decipher = crypto.createDecipheriv("aes-256-gcm", _encKey, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const json = Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
  return JSON.parse(json, BufferJSON.reviver);
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

// Move TODAS as linhas de auth de um sessionId pra outro (ex: id provisório do
// scan -> id canônico = telefone). Numa transação: apaga o destino antes pra não
// colidir na PK composta (sessionId, keyType, keyId). Usado pela canonicalização
// de numberId no connect (ver whatsapp/local.js).
async function renameSession(oldSessionId, newSessionId) {
  if (!oldSessionId || !newSessionId || oldSessionId === newSessionId) return;
  await prisma().$transaction([
    prisma().baileysAuth.deleteMany({ where: { sessionId: newSessionId } }),
    prisma().baileysAuth.updateMany({
      where: { sessionId: oldSessionId },
      data: { sessionId: newSessionId },
    }),
  ]);
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

module.exports = { useDatabaseAuthState, deleteSession, renameSession, readKey, writeKey, deleteKey };
