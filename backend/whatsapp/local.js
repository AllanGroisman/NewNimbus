// Em modo redis + worker process, publica snapshot da sessão no Redis pra que
// o server (whatsapp-proxy) consiga ler status/QR sem RPC. Lazy-required pra não
// criar conexão Redis em modo memory.
const PUBLISH_STATUS = (process.env.QUEUE_BACKEND || "memory").toLowerCase() === "redis"
  && process.env.WORKER_PROCESS === "true";
let _sessionStatus = null;
function sessionStatus() {
  if (!_sessionStatus) _sessionStatus = require("../infra/session-status");
  return _sessionStatus;
}
// Notifica o usuário (via WhatsNimbus) quando a sessão dele cai. Edge-triggered
// no user-notifier — chamamos em toda mudança de status; ele decide reenviar ou
// não. Fire-and-forget: nunca deixa um erro de notificação afetar o Baileys.
function notifySessionStatus(session) {
  try {
    require("../notifications/user-notifier")
      .onSessionStatus(session.userId, session.numberId, session.status)
      .catch(() => {});
  } catch { /* ignore */ }
}

function publishStatus(session) {
  notifySessionStatus(session);
  if (!PUBLISH_STATUS) return;
  // Fire-and-forget. Erros de Redis não devem derrubar Baileys.
  sessionStatus().publish(session.userId, session.numberId, {
    status: session.status,
    qr: session.qrDataUrl || null,
    info: session.info || null,
    lastError: session.lastError || null,
    stuck: session.stuck || false,
  }).catch(err => console.error(`[whatsapp-local] publishStatus falhou: ${err.message}`));
}

let baileys, QRCode, pino;
try {
  baileys = require("@whiskeysockets/baileys");
  QRCode = require("qrcode");
  pino = require("pino");
} catch (e) {
  console.error("[whatsapp] dependências de WhatsApp não instaladas:", e.message);
  console.error("[whatsapp] rode: cd backend && npm install");
  module.exports = makeStub();
  return;
}

const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion } = baileys;

// Auth state em Postgres (tabela baileys_auth via auth/baileys-pg.js).
let _pgAuth = null;
function pgAuth() {
  if (!_pgAuth) _pgAuth = require("../auth/baileys-pg");
  return _pgAuth;
}

const log = pino({ level: "warn" });

// chave: `${userId}::${numberId}` -> { sock, status, qr, qrDataUrl, info, ... }
const sessions = new Map();

// Setado por closeAll() no shutdown do worker: impede que o handler de "close"
// agende reconexão enquanto estamos encerrando o processo.
let shuttingDown = false;

function key(userId, numberId) { return `${userId}::${numberId}`; }

// Classifica um `connection: "close"` do Baileys num resultado puro e testável.
// Regra central da Task 1: só é estado terminal (mostra "Reconectar"/erro na tela)
// o logout real e o desligamento do worker. Todo o resto — restartRequired (515,
// o close NORMAL logo após escanear o QR), conflito (401 device_removed) e quedas
// de rede — vira "connecting" com lastError limpo, porque o handler reconecta
// sozinho; assim a UI mostra "Conectando..." (spinner) em vez de piscar erro.
//
// O WhatsApp manda 401 tanto pra logout real quanto pra "conflict"/device_removed
// (mesma conta em outro lugar, ou overlap de processos num restart). No conflito as
// credenciais continuam VÁLIDAS — apagá-las forçava re-scan a cada restart. Então
// só é logout definitivo o 401 que NÃO seja conflito.
function classifyClose(err, { shuttingDown = false } = {}) {
  const code = err?.output?.statusCode;
  const reasonTag = err?.data?.content?.[0]?.tag;
  const isConflict = reasonTag === "conflict" || /\(conflict\)/i.test(err?.message || "");
  const loggedOut = code === DisconnectReason.loggedOut && !isConflict;

  if (loggedOut) return { status: "logged_out", lastError: err?.message || null, reconnect: false };
  // Encerrando o worker: sock.end() disparou este close. Não reconecta e rebaixa
  // pra "disconnected" (coerente com closeAll), pra tela não ficar num "connecting"
  // eterno de uma sessão que o worker não tem mais.
  if (shuttingDown) return { status: "disconnected", lastError: err?.message || null, reconnect: false };
  return { status: "connecting", lastError: null, reconnect: true };
}

// A reconexão em background fica em "connecting" indefinidamente (spinner na tela,
// sem "Reconectar" aparente). O custo é que o envio fica bloqueado e o usuário não
// era avisado. Depois desta graça, consideramos a sessão "presa" e disparamos um
// alerta (uma vez por episódio) pra ele reconectar no painel. Pode virar env depois.
const STUCK_RECONNECT_MS = 90_000;

// Puro/testável: a sessão está reconectando (connecting) há mais que o limiar?
function isStuckReconnecting(reconnectingSince, now, thresholdMs = STUCK_RECONNECT_MS) {
  if (!reconnectingSince) return false;
  return (now - reconnectingSince) >= thresholdMs;
}

function notifySessionStuck(userId, numberId) {
  try {
    require("../notifications/user-notifier")
      .onSessionStuck(userId, numberId)
      .catch(() => {});
  } catch { /* ignore */ }
}

function normalizePhone(p) { return String(p).replace(/\D/g, ""); }
function jidFromPhone(phone) { return `${normalizePhone(phone)}@s.whatsapp.net`; }

async function startSession(userId, numberId) {
  userId = String(userId);
  numberId = String(numberId);

  const k = key(userId, numberId);
  const existing = sessions.get(k);
  if (existing?.sock && existing.status === "connected") return existing;

  const { state, saveCreds } = await pgAuth().useDatabaseAuthState(`${userId}::${numberId}`);
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ["Nimbus", "Chrome", "1.0"],
    logger: log,
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  const session = sessions.get(k) || { userId, numberId, restartCount: 0 };
  session.sock = sock;
  session.status = session.status && session.status !== "logged_out" ? session.status : "connecting";
  session.lastError = null;
  sessions.set(k, session);
  publishStatus(session);

  sock.ev.on("creds.update", saveCreds);

  // Captura de links do grupo líder (campanhas de repasse). Lazy-require pra não
  // carregar o módulo (nem prisma/scraper) fora do worker. Fire-and-forget: um
  // erro na captura nunca pode derrubar a sessão Baileys.
  sock.ev.on("messages.upsert", (ev) => {
    if (ev?.type !== "notify") return;
    try {
      require("../repasse/capture").onUpsert(userId, numberId, ev.messages).catch(() => {});
    } catch { /* ignore */ }
  });

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      session.qr = qr;
      try { session.qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 280 }); } catch {}
      session.status = "awaiting_qr";
      publishStatus(session);
    }

    if (connection === "open") {
      session.status = "connected";
      session.qr = null;
      session.qrDataUrl = null;
      session.info = sock.user ? {
        id: sock.user.id,
        name: sock.user.name || sock.user.verifiedName || null,
        phone: (sock.user.id || "").split(":")[0].split("@")[0] || null,
      } : null;
      session.restartCount = 0;
      session.reconnectingSince = null;
      session.stuck = false;
      publishStatus(session);

      // O numberId definitivo é o telefone. O id usado pra abrir o QR é provisório
      // (o frontend gera antes de saber o telefone). Se divergir, migramos a auth
      // pro id canônico (= telefone) e reabrimos sob ele — assim os grupos nunca
      // ficam órfãos apontando pra um id volátil que muda a cada re-scan. Damos um
      // tempo pro frontend capturar o connected+info (info.phone) sob o id tmp antes.
      const canonicalId = session.info?.phone ? normalizePhone(session.info.phone) : null;
      if (canonicalId && canonicalId !== numberId && !session.migrating) {
        setTimeout(() => {
          canonicalizeSession(userId, numberId, canonicalId).catch(e =>
            console.error(`[whatsapp] canonicalize erro ${userId}/${numberId}: ${e.message}`));
        }, 3000);
      }
    }

    if (connection === "close") {
      // Sessão em migração (canonicalizeSession fechou o sock tmp de propósito):
      // não publica nem reconecta — quem cuida do reabrir é a migração.
      if (session.migrating) return;

      const err = lastDisconnect?.error;
      const { status, lastError, reconnect } = classifyClose(err, { shuttingDown });

      session.status = status;
      session.lastError = lastError;
      session.qr = null;
      session.qrDataUrl = null;

      // Estado terminal (logout real do usuário, ou worker encerrando): não
      // reconecta sozinho. No logout NÃO apagamos as credenciais aqui — a remoção
      // definitiva acontece só pela ação explícita do usuário (deleteSession), pra
      // nunca derrubar sessão boa sem querer.
      if (!reconnect) {
        session.reconnectingSince = null;
        session.stuck = false;
        publishStatus(session);
        return;
      }

      // Marca o início do episódio de reconexão (uma vez, até reconectar). Se já
      // arrasta há mais que a graça, marcamos `stuck` (o frontend usa isso pra
      // revelar "Reconectar" — fonte da verdade é o backend, não depende da tela
      // aberta) e avisamos o usuário. Os "close" recorrem a cada ≤30s, então a
      // checagem aqui basta; a idempotência do aviso fica no user-notifier.
      if (!session.reconnectingSince) session.reconnectingSince = Date.now();
      session.stuck = isStuckReconnecting(session.reconnectingSince, Date.now());
      publishStatus(session);
      if (session.stuck) notifySessionStuck(userId, numberId);

      session.restartCount = (session.restartCount || 0) + 1;
      const delay = Math.min(30000, 1500 * session.restartCount);
      setTimeout(() => {
        startSession(userId, numberId).catch(err => {
          console.error(`[whatsapp] erro ao reconectar ${userId}/${numberId}:`, err.message);
        });
      }, delay);
    }
  });

  return session;
}

// Migra uma sessão recém-conectada do id provisório (tmp) pro id canônico (=
// telefone). Best-effort: se algo falhar, tenta garantir que reste uma sessão
// viva sob o id canônico — nunca deixa o usuário sem sessão. Como o adapter de
// auth captura o sessionId no closure (não dá pra renomear in-place), o caminho
// é: fecha o sock tmp -> renomeia a auth no banco -> reabre sob o canônico.
async function canonicalizeSession(userId, tmpId, canonicalId) {
  const tmpKey = key(userId, tmpId);
  const session = sessions.get(tmpKey);
  // Guarda: pode ter sido cancelada (cancelQR/deleteSession) ou caído nesse meio tempo.
  if (!session || session.status !== "connected" || session.migrating) return;
  session.migrating = true;

  // 1. Fecha o socket tmp (sem logout) pra parar de gravar auth sob o id tmp.
  try { session.sock?.end(undefined); } catch {}
  await new Promise(r => setTimeout(r, 600));

  // 2. Move a auth (creds recém-escaneadas + keys) do id tmp pro canônico.
  await pgAuth().renameSession(`${userId}::${tmpId}`, `${userId}::${canonicalId}`);

  // 3. Limpa a sessão tmp do Map e do Redis.
  sessions.delete(tmpKey);
  if (PUBLISH_STATUS) { try { await sessionStatus().clear(userId, tmpId); } catch {} }

  // 4. Descarta qualquer sessão canônica anterior (será substituída pela auth nova).
  const canonKey = key(userId, canonicalId);
  const prevCanon = sessions.get(canonKey);
  if (prevCanon) {
    prevCanon.migrating = true;
    try { prevCanon.sock?.end(undefined); } catch {}
    sessions.delete(canonKey);
  }

  // 5. Reabre sob o id canônico (lê a auth renomeada, reconecta sem QR).
  await startSession(userId, canonicalId);
  console.log(`[whatsapp] sessão canonicalizada ${userId}: ${tmpId} -> ${canonicalId}`);
}

function getSession(userId, numberId) {
  return sessions.get(key(userId, numberId));
}

function listSessions(userId) {
  const u = String(userId);
  return Array.from(sessions.values())
    .filter(s => s.userId === u)
    .map(s => ({
      numberId: s.numberId,
      status: s.status,
      info: s.info || null,
      lastError: s.lastError || null,
      stuck: s.stuck || false,
    }));
}

async function deleteSession(userId, numberId) {
  userId = String(userId);
  numberId = String(numberId);
  const k = key(userId, numberId);
  const s = sessions.get(k);
  if (s?.sock) {
    try { await s.sock.logout(); } catch {}
    try { s.sock.end(); } catch {}
  }
  sessions.delete(k);
  try { await pgAuth().deleteSession(`${userId}::${numberId}`); } catch {}
  if (PUBLISH_STATUS) {
    try { await sessionStatus().clear(userId, numberId); } catch {}
  }
}

function ensureConnected(userId, numberId) {
  const s = sessions.get(key(userId, numberId));
  if (!s?.sock) throw new Error("Sessão não encontrada — adicione o número primeiro.");
  if (s.status !== "connected") throw new Error(`Sessão não está conectada (status: ${s.status}).`);
  return s;
}

async function sendText(userId, numberId, jid, text) {
  const s = ensureConnected(userId, numberId);
  return s.sock.sendMessage(jid, { text });
}

async function sendImage(userId, numberId, jid, imageUrl, caption) {
  const s = ensureConnected(userId, numberId);
  return s.sock.sendMessage(jid, { image: { url: imageUrl }, caption });
}

async function createGroup(userId, numberId, name, participantPhones) {
  const s = ensureConnected(userId, numberId);
  const jids = participantPhones.map(jidFromPhone);
  const result = await s.sock.groupCreate(name, jids);
  let inviteLink = null;
  try {
    const code = await s.sock.groupInviteCode(result.id);
    inviteLink = `https://chat.whatsapp.com/${code}`;
  } catch (err) {
    console.warn(`[whatsapp] falha ao obter invite do grupo ${result.id}: ${err.message}`);
  }
  return {
    jid: result.id,
    name,
    inviteLink,
    participants: participantPhones.map(normalizePhone),
  };
}

async function getInviteLink(userId, numberId, jid) {
  const s = ensureConnected(userId, numberId);
  const code = await s.sock.groupInviteCode(jid);
  return `https://chat.whatsapp.com/${code}`;
}

async function revokeInvite(userId, numberId, jid) {
  const s = ensureConnected(userId, numberId);
  const code = await s.sock.groupRevokeInvite(jid);
  return `https://chat.whatsapp.com/${code}`;
}

async function listGroups(userId, numberId) {
  const s = ensureConnected(userId, numberId);
  const all = await s.sock.groupFetchAllParticipating();
  return Object.values(all).map(g => ({
    jid: g.id,
    name: g.subject,
    members: g.participants?.length || 0,
    creation: g.creation,
    description: g.desc || null,
  }));
}

async function leaveGroup(userId, numberId, jid) {
  const s = ensureConnected(userId, numberId);
  await s.sock.groupLeave(jid);
}

async function getGroupMetadata(userId, numberId, jid) {
  const s = ensureConnected(userId, numberId);
  return s.sock.groupMetadata(jid);
}

// Restaura sessões persistidas (SELECT distinct sessionId em baileys_auth).
// CRÍTICO: só restaura sessões cujo número AINDA existe em whatsapp_numbers.
// Auth órfã (de número deletado) precisa ser limpa, senão reconecta um "device
// fantasma" do mesmo telefone — o WhatsApp trata 2 conexões do mesmo número como
// conflito (device_removed/401), derruba a sessão e apaga as credenciais, forçando
// re-scan a cada restart.
async function restoreSessions() {
  const { prisma } = require("../db");

  let pairs = [];
  try {
    const rows = await prisma().baileysAuth.findMany({
      where: { keyType: "creds" },
      select: { sessionId: true },
    });
    pairs = rows.map(r => {
      const [userId, numberId] = r.sessionId.split("::");
      return { userId, numberId };
    }).filter(p => p.userId && p.numberId);
  } catch (err) {
    console.error(`[whatsapp] falha listando sessões PG: ${err.message}`);
    return;
  }

  // Cruza com os números que ainda existem no painel. Se a query falhar, NÃO
  // limpamos nada (fallback conservador: restaura tudo, comportamento antigo).
  let validNumbers = null;
  try {
    const nums = await prisma().whatsappNumber.findMany({ select: { id: true, userId: true } });
    validNumbers = new Set(nums.map(n => `${n.userId}::${n.id}`));
    // WhatsNimbus (remetente do sistema) não tem linha em whatsapp_numbers —
    // é whitelistado pela config pra não ser tratado como auth órfã e limpo.
    try {
      const wn = require("../notifications/whatsnimbus");
      const cfg = wn.readConfig();
      if (cfg.numberId) validNumbers.add(`${wn.WHATSNIMBUS_USER_ID}::${cfg.numberId}`);
    } catch (e) {
      console.error(`[whatsapp] whitelist WhatsNimbus falhou: ${e.message}`);
    }
  } catch (err) {
    console.error(`[whatsapp] falha listando números (sem reconciliação): ${err.message}`);
  }

  let live = pairs;
  if (validNumbers) {
    live = [];
    for (const p of pairs) {
      if (validNumbers.has(`${p.userId}::${p.numberId}`)) {
        live.push(p);
      } else {
        console.log(`[whatsapp] limpando auth órfã ${p.userId}/${p.numberId} (número não existe mais)`);
        pgAuth().deleteSession(`${p.userId}::${p.numberId}`).catch(() => {});
      }
    }
  }

  for (const { userId, numberId } of live) {
    startSession(userId, numberId).catch(err => {
      console.error(`[whatsapp] falha ao restaurar ${userId}/${numberId}:`, err.message);
    });
  }
  if (live.length > 0) console.log(`[whatsapp] restaurando ${live.length} sessão(ões)...`);
}

// Encerra graciosamente todas as sessões antes do worker sair. Usa sock.end()
// (fecha o websocket SEM deslogar — não apaga creds) pra que o WhatsApp registre
// a saída do device; assim o próximo worker reconecta sem disparar conflito
// (device_removed/401) por duas conexões simultâneas do mesmo número.
async function closeAll() {
  shuttingDown = true;
  const pubs = [];
  for (const s of sessions.values()) {
    try { s.sock?.end(undefined); } catch {}
    // Parte C: rebaixa o status pra "disconnected" no Redis ANTES de sair, pra a
    // tela não mostrar "connected" stale de uma sessão que o worker não tem mais.
    // O publish do handler de close é fire-and-forget e pode não chegar antes do
    // process.exit; aqui aguardamos explicitamente.
    if (PUBLISH_STATUS) {
      s.status = "disconnected";
      pubs.push(
        sessionStatus().publish(s.userId, s.numberId, {
          status: "disconnected",
          info: s.info || null,
        }).catch(() => {})
      );
    }
  }
  await Promise.allSettled(pubs);
  // Pequena folga pro frame de close chegar ao WhatsApp antes do process.exit.
  await new Promise(r => setTimeout(r, 400));
}

function status() {
  let connected = 0, total = 0;
  for (const s of sessions.values()) {
    total++;
    if (s.status === "connected") connected++;
  }
  return { totalSessions: total, connectedSessions: connected };
}

module.exports = {
  startSession,
  getSession,
  listSessions,
  deleteSession,
  sendText,
  sendImage,
  createGroup,
  getInviteLink,
  revokeInvite,
  listGroups,
  leaveGroup,
  getGroupMetadata,
  restoreSessions,
  closeAll,
  jidFromPhone,
  normalizePhone,
  status,
  classifyClose,
  isStuckReconnecting,
};

function makeStub() {
  const fail = () => Promise.reject(new Error("Baileys não instalado. Rode: cd backend && npm install"));
  return {
    startSession: fail,
    getSession: () => null,
    listSessions: () => [],
    deleteSession: fail,
    sendText: fail,
    sendImage: fail,
    createGroup: fail,
    getInviteLink: fail,
    revokeInvite: fail,
    listGroups: fail,
    leaveGroup: fail,
    getGroupMetadata: fail,
    restoreSessions: () => {},
    closeAll: () => Promise.resolve(),
    jidFromPhone: () => null,
    normalizePhone: () => null,
    status: () => ({ totalSessions: 0, connectedSessions: 0, stub: true }),
  };
}
