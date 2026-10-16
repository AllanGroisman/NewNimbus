// app-state-key — a chave de "app state" que o celular entrega ao sistema.
//
// Por que isto existe: o "Limpar conversa" (chatModify, task 13) é um patch de app
// state, e o Baileys cifra esse patch com a chave cujo id está em
// `creds.myAppStateKeyId`. Quem entrega a chave é o celular, numa mensagem
// APP_STATE_SYNC_KEY_SHARE (normalmente logo depois de parear). Se a linha
// `app-state-sync-key` some do banco mas o id fica nas creds, TODA limpeza falha
// com `myAppStateKey ("…") not present` — foi o que aconteceu com um número em
// prod (2026-10-16: id nas creds, zero chaves salvas).
//
// O WhatsApp Web resolve isso pedindo a chave de novo ao próprio celular
// (protocolMessage APP_STATE_SYNC_KEY_REQUEST). O Baileys já processa a resposta
// (Utils/process-message.js grava a chave e atualiza myAppStateKeyId), só não
// manda o pedido — é o que fazemos aqui. Se o celular não responder, o único
// caminho é reconectar o número (QR novo traz chaves novas).

const { proto, jidNormalizedUser } = require("@whiskeysockets/baileys");

const MISSING_KEY_MSG = "Chave de sincronização ausente — reconecte o número (escaneie o QR de novo).";
// No máximo um pedido por sessão nesta janela: o celular responde em segundos
// quando responde, e insistir em rajada não muda isso.
const REQUEST_COOLDOWN_MS = Number(process.env.WA_APPKEY_REQUEST_COOLDOWN_MS) || 10 * 60 * 1000;
const WAIT_MS = Number(process.env.WA_APPKEY_WAIT_MS) || 15 * 1000;
const POLL_MS = Number(process.env.WA_APPKEY_POLL_MS) || 1000;

function isMissingKeyError(err) {
  return err?.data?.isMissingKey === true;
}

// true quando a chave atual (myAppStateKeyId) está no store. Sem id nas creds o
// celular ainda não mandou chave nenhuma — também conta como ausente.
async function hasAppStateKey(sock) {
  const id = sock?.authState?.creds?.myAppStateKeyId;
  if (!id) return false;
  const found = await sock.authState.keys.get("app-state-sync-key", [id]);
  return !!found?.[id];
}

// Manda pro próprio celular o pedido da chave. Mesmo formato do
// sendPeerDataOperationMessage do Baileys (Socket/messages-send.js): mensagem
// "peer" pro nosso jid. Devolve false quando o cooldown segurou o pedido.
async function requestAppStateKey(session, { now = Date.now() } = {}) {
  const sock = session?.sock;
  const id = sock?.authState?.creds?.myAppStateKeyId;
  const meId = sock?.authState?.creds?.me?.id;
  if (!id || !meId) return false;
  if (session.appKeyRequestedAt && now - session.appKeyRequestedAt < REQUEST_COOLDOWN_MS) return false;
  session.appKeyRequestedAt = now;
  await sock.relayMessage(jidNormalizedUser(meId), {
    protocolMessage: {
      type: proto.Message.ProtocolMessage.Type.APP_STATE_SYNC_KEY_REQUEST,
      appStateSyncKeyRequest: { keyIds: [{ keyId: Buffer.from(id, "base64") }] },
    },
  }, {
    additionalAttributes: { category: "peer", push_priority: "high_force" },
    additionalNodes: [{ tag: "meta", attrs: { appdata: "default" } }],
  });
  return true;
}

// Pede a chave (respeitando o cooldown) e espera ela chegar. true = chave no store.
async function recoverAppStateKey(session, { waitMs = WAIT_MS, pollMs = POLL_MS } = {}) {
  if (await hasAppStateKey(session.sock)) return true;
  try {
    await requestAppStateKey(session);
  } catch (err) {
    console.warn(`[whatsapp] pedido da chave de app state falhou ${session.userId}/${session.numberId}: ${err.message}`);
    return false;
  }
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, pollMs));
    if (await hasAppStateKey(session.sock)) return true;
  }
  return false;
}

module.exports = {
  MISSING_KEY_MSG,
  isMissingKeyError,
  hasAppStateKey,
  requestAppStateKey,
  recoverAppStateKey,
};
