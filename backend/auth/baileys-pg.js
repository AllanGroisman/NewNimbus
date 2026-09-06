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

// Lê VÁRIAS chaves do mesmo tipo numa query só. O Baileys pede as sessões Signal
// de dezenas de devices de uma vez num envio de grupo; com um findUnique por
// chave isso viravam dezenas de queries paralelas contra um pool de 5 conexões,
// e o timeout de pool derrubava o keys.get/keys.set no meio da cifra.
async function readKeys(sessionId, keyType, keyIds) {
  const wanted = keyIds.map(id => id || "");
  const rows = await prisma().baileysAuth.findMany({
    where: { sessionId, keyType, keyId: { in: wanted } },
  });
  const byId = new Map(rows.map(r => [r.keyId, r.value]));
  const out = {};
  for (const id of keyIds) {
    const raw = byId.get(id || "");
    // `null` (e não undefined) no que não existe: dentro de uma transação o
    // Baileys só refaz a busca do que voltou `undefined` (addTransactionCapability).
    out[id] = raw == null ? null : decode(raw);
  }
  return out;
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
  } catch (err) {
    // P2025 = a linha não existia; qualquer outra coisa (pool esgotado, banco
    // fora) precisa subir. Engolir tudo aqui fazia o consumo de uma pre-key
    // parecer persistido quando não foi — origem dos "Key used already or never
    // filled" e, do outro lado, do "Aguardando mensagem" que não some.
    if (err?.code !== "P2025") throw err;
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
//
// `onPersistError` é chamado quando uma gravação do estado Signal falha. Isso
// NÃO é um detalhe de log: o `relayMessage` do Baileys envolve o envio inteiro
// numa transação de chaves e só COMMITA no fim — o texto cifrado já saiu na
// rede quando a gravação falha. Se ninguém reage, o ratchet fica avançado na
// memória e velho no banco, e a partir daí o destinatário não decripta mais
// nada: é o "Aguardando mensagem" que não some sozinho. Quem passa o callback
// (whatsapp/local.js) derruba o socket pra que a reconexão releia o banco.
async function useDatabaseAuthState(sessionId, { onPersistError } = {}) {
  // Carrega creds (cria nova se nunca existiu)
  const stored = await readKey(sessionId, "creds", "");
  const creds = stored || initAuthCreds();

  // O Baileys tenta o commit 10x com 3s de intervalo e desiste EM SILÊNCIO
  // (addTransactionCapability). Este wrapper é o único lugar onde a falha ainda
  // é visível — daqui ela vira log e aviso, e depois segue subindo pro Baileys
  // tentar de novo.
  const reportPersistError = (what, err) => {
    console.error(`[baileys-auth] falha ao gravar ${what} de ${sessionId}: ${err.message}`);
    try { onPersistError?.(err); } catch { /* nunca deixa o aviso quebrar a gravação */ }
  };

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          if (!ids?.length) return {};
          const data = await readKeys(sessionId, type, ids);
          if (type === "app-state-sync-key") {
            for (const id of Object.keys(data)) {
              if (data[id]) data[id] = proto.Message.AppStateSyncKeyData.fromObject(data[id]);
            }
          }
          return data;
        },
        // ATÔMICO. Antes era um Promise.all de upserts soltos: morrer no meio
        // gravava METADE das mutações do ratchet, o que é pior que não gravar
        // nada — o estado fica inconsistente em vez de só velho, e o peer nunca
        // mais decripta. O Baileys entrega aqui o mapa inteiro de mutações de
        // uma transação (auth-utils: state.set(mutations)), então "tudo ou nada"
        // é exatamente a semântica certa.
        set: async (data) => {
          const ops = [];
          for (const type of Object.keys(data)) {
            for (const id of Object.keys(data[type])) {
              const value = data[type][id];
              const keyId = id || "";
              if (value) {
                const v = encode(value);
                ops.push(prisma().baileysAuth.upsert({
                  where: { sessionId_keyType_keyId: { sessionId, keyType: type, keyId } },
                  create: { sessionId, keyType: type, keyId, value: v },
                  update: { value: v },
                }));
              } else {
                // deleteMany (e não delete): apagar linha inexistente é normal
                // aqui, e o P2025 do `delete` abortaria a transação inteira.
                ops.push(prisma().baileysAuth.deleteMany({
                  where: { sessionId, keyType: type, keyId },
                }));
              }
            }
          }
          if (!ops.length) return;
          try {
            await prisma().$transaction(ops);
          } catch (err) {
            reportPersistError(`${ops.length} chave(s) Signal`, err);
            throw err;
          }
        },
      },
    },
    // Baileys chama em creds.update; ref ao `creds` é mutada por Baileys.
    // Falhar aqui é tão grave quanto falhar no keys.set: é neste blob que vive o
    // contador de pre-keys (nextPreKeyId/firstUnuploadedPreKeyId), e perdê-lo faz
    // o servidor servir pre-key já usada ("Key used already or never filled").
    saveCreds: async () => {
      try {
        await writeKey(sessionId, "creds", "", creds);
      } catch (err) {
        reportPersistError("creds", err);
        throw err;
      }
    },
  };
}

module.exports = { useDatabaseAuthState, deleteSession, renameSession, readKey, readKeys, writeKey, deleteKey };
