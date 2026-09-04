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
    // Logout real: o snapshot sobrevive mais tempo no Redis (ver session-status),
    // pra tela seguir mostrando "Desconectado (relogar)" depois de um restart —
    // a auth foi apagada, então a sessão não aparece mais em restoreSessions.
    terminal: session.terminal || false,
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

// "warn" no dia a dia. WA_LOG_LEVEL=debug/trace liga o log de protocolo do
// Baileys — necessário pra diagnosticar sessão que não conecta e não fecha.
const log = pino({ level: process.env.WA_LOG_LEVEL || "warn" });

// Últimas mensagens enviadas por este processo — serve o getMessage do socket
// (retry receipt). Módulo puro, sem IO: pode entrar direto no topo.
const msgStore = require("./msg-store");

// chave: `${userId}::${numberId}` -> { sock, status, qr, qrDataUrl, info, ... }
const sessions = new Map();

// Aberturas de sessão em voo, por chave. Sem isto, duas chamadas concorrentes
// (rota POST + timer de reconexão + re-run de job "stalled" do BullMQ + restore)
// criavam DOIS makeWASocket sobre a MESMA sessão: os dois handlers mutavam o
// mesmo objeto, os dois agendavam reconexão, e os dois gravavam chaves Signal
// conflitantes na mesma linha de baileys_auth — origem dos "Bad MAC" /
// "Key used already or never filled" no log, e do conflito que faz o WhatsApp
// remover o device (usuário desconectado de verdade).
const starting = new Map();

// Época do socket. Cada socket aberto recebe uma geração; o handler de um socket
// substituído vira no-op. `removeAllListeners` cobre o caso normal, esta guarda
// cobre o evento que já estava na fila do event loop na hora da troca.
let _gen = 0;

// Timers de reconexão por chave. Sem rastrear o handle, um deleteSession não
// cancelava o setTimeout pendente e a sessão "ressuscitava" segundos depois com
// credenciais novas (initAuthCreds), emitindo um QR que ninguém escaneia — a
// "conexão fantasma" que o scripts/kill-pending-session.js existia pra matar na mão.
const reconnectTimers = new Map();

// Setado por closeAll() no shutdown do worker: impede que o handler de "close"
// agende reconexão enquanto estamos encerrando o processo.
let shuttingDown = false;

function key(userId, numberId) { return `${userId}::${numberId}`; }

// Puro/testável: o handler pertence ao socket vigente desta sessão?
function isCurrentGen(session, gen) { return !!session && session.gen === gen; }

function cancelReconnect(k) {
  const t = reconnectTimers.get(k);
  if (t) { clearTimeout(t); reconnectTimers.delete(k); }
}

function scheduleReconnect(userId, numberId, k, delayMs) {
  cancelReconnect(k);
  const t = setTimeout(() => {
    reconnectTimers.delete(k);
    // Segunda trava: se a sessão saiu do Map (deleteSession/canonicalização) ou
    // o worker está encerrando, não ressuscita nada.
    if (!sessions.has(k) || shuttingDown) return;
    startSession(userId, numberId).catch(err => {
      console.error(`[whatsapp] erro ao reconectar ${userId}/${numberId}:`, err.message);
    });
  }, delayMs);
  t.unref?.();
  reconnectTimers.set(k, t);
}

// fetchLatestBaileysVersion é rede sem timeout. Chamá-la em TODA abertura de
// sessão (inclusive em cada retry do backoff) deixava o job de controle lento a
// ponto de o BullMQ declarar "stalled" e reprocessar — gerando socket duplicado.
const WA_VERSION_TTL_MS = 6 * 60 * 60 * 1000;
const WA_VERSION_TIMEOUT_MS = 4000;
let _waVersion = null, _waVersionAt = 0, _waVersionInflight = null;

async function cachedBaileysVersion() {
  if (_waVersion && (Date.now() - _waVersionAt) < WA_VERSION_TTL_MS) return _waVersion;
  if (_waVersionInflight) return _waVersionInflight;
  _waVersionInflight = Promise.race([
    fetchLatestBaileysVersion().then(r => r?.version).catch(() => null),
    new Promise(r => setTimeout(() => r(null), WA_VERSION_TIMEOUT_MS)),
  ]).then(v => {
    if (v) { _waVersion = v; _waVersionAt = Date.now(); }
    return _waVersion; // null na 1ª vez → Baileys usa a versão embutida
  }).finally(() => { _waVersionInflight = null; });
  return _waVersionInflight;
}

// Depois de um close por conflito, a reconexão imediata costuma voltar um 401
// "Connection Failure" SECO (sem tag). Tratar isso como logout derrubava sessão
// boa de quem só tinha dois sockets brigando — e, como logout agora apaga as
// credenciais, o custo do engano é o usuário ter que ler o QR de novo.
const CONFLICT_GRACE_MS = 60_000;
const CONFLICT_MAX_RETRIES = 3;

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
// só é logout definitivo o 401 que NÃO seja conflito nem eco de um conflito recente.
function classifyClose(err, {
  shuttingDown = false,
  registered = true,
  now = Date.now(),
  lastConflictAt = null,
  conflictRetries = 0,
} = {}) {
  const code = err?.output?.statusCode;
  const reasonTag = err?.data?.content?.[0]?.tag;
  const isConflict = reasonTag === "conflict" || /\(conflict\)/i.test(err?.message || "");

  // Encerrando o worker: sock.end() disparou este close. Não reconecta e rebaixa
  // pra "disconnected" (coerente com closeAll), pra tela não ficar num "connecting"
  // eterno de uma sessão que o worker não tem mais.
  if (shuttingDown) return { status: "disconnected", lastError: err?.message || null, reconnect: false };

  // Conflito explícito: creds seguem válidas, reconecta e marca a janela.
  if (isConflict) return { status: "connecting", lastError: null, reconnect: true, conflict: true };

  if (code === DisconnectReason.loggedOut) {
    // Eco do conflito: 401 seco logo depois de um close por conflito. Reconecta
    // por um número limitado de vezes em vez de declarar logout na hora.
    const echo = lastConflictAt != null
      && (now - lastConflictAt) < CONFLICT_GRACE_MS
      && conflictRetries < CONFLICT_MAX_RETRIES;
    if (echo) return { status: "connecting", lastError: null, reconnect: true, conflictEcho: true };
    // Sessão que nunca pareou não tem device pra "deslogar": 401 aqui é falha de
    // handshake. Reconectar só geraria QR novo em loop, então encerra e limpa a
    // auth parcial — o usuário reabre o QR quando quiser tentar de novo.
    if (!registered) {
      return { status: "disconnected", lastError: "Falha ao parear. Tente ler o QR de novo.", reconnect: false, cleanup: true };
    }
    return { status: "logged_out", lastError: err?.message || null, reconnect: false, terminal: true };
  }

  // QR nunca escaneado: a sessão NÃO está registrada (nenhum telefone pareou) e o
  // Baileys encerrou porque esgotou as tentativas de QR (408 "QR refs attempts
  // ended"). Reconectar aqui só gera um QR novo que ninguém escaneia → loop
  // infinito (era o caso do usuário que abria o QR e fechava a aba: a sessão órfã
  // reciclava de 3 em 3 min pra sempre, queimando CPU). Vira terminal e sinaliza
  // limpeza; o usuário reabre o QR explicitamente ("cancele e tente novamente")
  // quando for de fato escanear. Só vale pra sessão não-registrada: pra uma já
  // autenticada, 408 é timeout de rede normal e deve reconectar como antes.
  const qrExpired = code === DisconnectReason.timedOut && /QR refs attempts ended/i.test(err?.message || "");
  if (qrExpired && !registered) {
    return { status: "disconnected", lastError: "QR não escaneado a tempo.", reconnect: false, cleanup: true };
  }

  return { status: "connecting", lastError: null, reconnect: true };
}

// A reconexão em background fica em "connecting" indefinidamente (spinner na tela,
// sem "Reconectar" aparente). Depois desta graça, marcamos a sessão como "presa"
// (`session.stuck`), que o frontend usa pra revelar o botão "Reconectar". A
// NOTIFICAÇÃO ao dono é responsabilidade do user-notifier (grace + recuperação a
// partir do status), não daqui — aqui só computamos o flag de UI.
const STUCK_RECONNECT_MS = 90_000;

// Puro/testável: a sessão está reconectando (connecting) há mais que o limiar?
function isStuckReconnecting(reconnectingSince, now, thresholdMs = STUCK_RECONNECT_MS) {
  if (!reconnectingSince) return false;
  return (now - reconnectingSince) >= thresholdMs;
}

// Puro/testável: sessão provisória órfã? Ninguém escaneou (nunca registrada) e ela
// está parada esperando QR além do limite. Acontece quando o usuário fecha a aba
// no meio do fluxo: o frontend tenta apagar no unload, mas se falhar sobra uma
// sessão sob um id `Date.now()` que não existe em whatsapp_numbers — invisível na
// tela e impossível de remover por lá. O branch do 408 já cobre parte disto, mas
// só quando o Baileys desiste, o que pode demorar ou nunca acontecer.
const ORPHAN_QR_MAX_AGE_MS = 10 * 60 * 1000;
function isOrphanQrSession(session, now, maxAgeMs = ORPHAN_QR_MAX_AGE_MS) {
  if (!session) return false;
  if (session.sock?.authState?.creds?.registered) return false;
  if (session.status !== "awaiting_qr" && session.status !== "connecting") return false;
  return (now - (session.createdAt || now)) >= maxAgeMs;
}

function normalizePhone(p) { return String(p).replace(/\D/g, ""); }
function jidFromPhone(phone) { return `${normalizePhone(phone)}@s.whatsapp.net`; }

// Gate fino: idempotência + single-flight. O trabalho de verdade fica em _openSocket.
async function startSession(userId, numberId) {
  userId = String(userId);
  numberId = String(numberId);
  const k = key(userId, numberId);

  // Curto-circuito idempotente. ANTES valia só pra "connected" — por isso um POST
  // durante o QR abria um segundo socket. Agora vale pra qualquer sessão com
  // socket VIVO (connecting/awaiting_qr/connected). Sessão cujo socket já caiu e
  // só espera o backoff NÃO curto-circuita: a ação explícita do usuário
  // ("Reconectar") deve tentar na hora.
  const existing = sessions.get(k);
  if (existing?.sock && existing.socketAlive) return existing;

  const inflight = starting.get(k);
  if (inflight) return inflight;

  const p = _openSocket(userId, numberId, k)
    .finally(() => { if (starting.get(k) === p) starting.delete(k); });
  starting.set(k, p);
  return p;
}

async function _openSocket(userId, numberId, k) {
  cancelReconnect(k);

  // Encerra o socket anterior ANTES de abrir outro e desliga os listeners: um
  // socket zumbi continua recebendo eventos e gravando auth por baixo.
  const prev = sessions.get(k);
  if (prev?.sock) {
    prev.socketAlive = false;
    try { prev.sock.ev.removeAllListeners(); } catch {}
    try { prev.sock.end(undefined); } catch {}
    prev.sock = null;
  }

  const { state, saveCreds } = await pgAuth().useDatabaseAuthState(`${userId}::${numberId}`);
  const version = await cachedBaileysVersion();

  const sock = makeWASocket({
    version: version || undefined,
    auth: state,
    printQRInTerminal: false,
    browser: ["Nimbus", "Chrome", "1.0"],
    logger: log,
    syncFullHistory: false,
    markOnlineOnConnect: false,
    // Retry receipt: quando o celular do destinatário não decripta o pacote, ele
    // mostra "Aguardando mensagem. Essa ação pode levar alguns instantes" e pede o
    // reenvio. O Baileys atende esse pedido em sendMessagesAgain buscando a
    // mensagem original AQUI. Sem este callback vale o default do Baileys
    // (`async () => undefined`): o reenvio nunca sai e o placeholder fica pra
    // sempre no celular do usuário. Ver whatsapp/msg-store.js.
    getMessage: async (key) => msgStore.get(key && key.id),
  });
  const gen = ++_gen;

  const session = sessions.get(k) || { userId, numberId, restartCount: 0, createdAt: Date.now() };
  session.sock = sock;
  session.gen = gen;
  session.socketAlive = true;
  session.terminal = false; // um start explícito sempre tira do estado terminal
  session.status = session.status && session.status !== "logged_out" ? session.status : "connecting";
  session.lastError = null;
  sessions.set(k, session);
  publishStatus(session);

  sock.ev.on("creds.update", () => {
    if (!isCurrentGen(session, gen)) return;
    Promise.resolve(saveCreds()).catch(err =>
      console.error(`[whatsapp] saveCreds ${userId}/${numberId}: ${err.message}`));
  });

  // Captura de links dos grupos líderes (campanhas de repasse). Lazy-require pra não
  // carregar o módulo (nem prisma/scraper) fora do worker. Fire-and-forget: um
  // erro na captura nunca pode derrubar a sessão Baileys.
  sock.ev.on("messages.upsert", (ev) => {
    if (!isCurrentGen(session, gen)) return;
    if (ev?.type !== "notify") return;
    try {
      require("../repasse/capture").onUpsert(userId, numberId, ev.messages).catch(() => {});
    } catch { /* ignore */ }
  });

  sock.ev.on("connection.update", async (update) => {
    if (!isCurrentGen(session, gen)) return; // socket antigo: no-op total
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
      session.lastConflictAt = null;
      session.conflictRetries = 0;
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
        }, 3000).unref?.();
      }
    }

    if (connection === "close") {
      session.socketAlive = false;
      // Sessão em migração (canonicalizeSession fechou o sock tmp de propósito):
      // não publica nem reconecta — quem cuida do reabrir é a migração.
      if (session.migrating) return;

      const err = lastDisconnect?.error;
      const registered = !!sock.authState?.creds?.registered;
      const result = classifyClose(err, {
        shuttingDown,
        registered,
        lastConflictAt: session.lastConflictAt || null,
        conflictRetries: session.conflictRetries || 0,
      });
      const { status, lastError, reconnect, cleanup, terminal } = result;

      // Contabilidade da janela de conflito (ver CONFLICT_GRACE_MS).
      if (result.conflict) { session.lastConflictAt = Date.now(); session.conflictRetries = 0; }
      if (result.conflictEcho) { session.conflictRetries = (session.conflictRetries || 0) + 1; }

      // Diagnóstico: `classifyClose` rebaixa quase tudo pra "connecting" com
      // lastError null (de propósito, pra UI não piscar erro). Sem este log, uma
      // sessão presa em loop de reconexão não deixa NENHUM rastro do motivo.
      console.warn(`[whatsapp] close ${userId}/${numberId} → ${status}` +
        ` code=${err?.output?.statusCode ?? "-"}` +
        ` tag=${err?.data?.content?.[0]?.tag ?? "-"}` +
        ` msg=${err?.message || "-"}` +
        ` tentativa=${(session.restartCount || 0) + 1}`);

      session.status = status;
      session.lastError = lastError;
      session.qr = null;
      session.qrDataUrl = null;

      // Estado terminal (logout real do usuário, ou worker encerrando): não
      // reconecta sozinho.
      if (!reconnect) {
        cancelReconnect(k);
        session.reconnectingSince = null;
        session.stuck = false;

        // Logout REAL confirmado: as credenciais estão mortas (o aparelho
        // desvinculou o device). Publicamos o estado terminal ANTES de limpar —
        // o snapshot fica mais tempo no Redis e a tela segue mostrando
        // "Desconectado (relogar)" com o botão Reconectar. Apagar a auth é o que
        // impede o restore de re-tentar essa sessão morta a cada boot do worker,
        // que era o que enchia o log de 401 e de erros de decrypt do libsignal.
        if (terminal) {
          session.terminal = true;
          session.lastError = "Sua conta foi desconectada no aparelho. Leia o QR de novo.";
          publishStatus(session);
          sessions.delete(k);
          starting.delete(k);
          try { sock.end(undefined); } catch {}
          pgAuth().deleteSession(`${userId}::${numberId}`).catch(err =>
            console.error(`[whatsapp] limpeza pós-logout ${userId}/${numberId}: ${err.message}`));
          return;
        }

        publishStatus(session);
        // QR expirado numa sessão nunca registrada: remove o órfão do worker e
        // apaga a auth parcial (pre-keys/noise, sem creds válidas) pra não deixar
        // resquício. Mantém o status "disconnected" publicado (com lastError) pro
        // frontend mostrar o aviso + "cancele e tente novamente". NÃO faz logout
        // (não há device pareado).
        if (cleanup) {
          sessions.delete(k);
          starting.delete(k);
          try { sock.end(undefined); } catch {}
          pgAuth().deleteSession(`${userId}::${numberId}`).catch(() => {});
        }
        return;
      }

      // Marca o início do episódio de reconexão (uma vez, até reconectar). Se já
      // arrasta há mais que a graça, marcamos `stuck` — o frontend usa isso pra
      // revelar "Reconectar" (fonte da verdade é o backend, não depende da tela
      // aberta). A notificação ao dono sai pelo user-notifier a partir do status.
      if (!session.reconnectingSince) session.reconnectingSince = Date.now();
      session.stuck = isStuckReconnecting(session.reconnectingSince, Date.now());
      publishStatus(session);

      session.restartCount = (session.restartCount || 0) + 1;
      // Jitter: sem ele, N sessões que caem juntas (queda de rede, restart do
      // worker) voltam todas no mesmo instante e brigam por rede/CPU.
      const delay = Math.min(30000, 1500 * session.restartCount) + Math.floor(Math.random() * 1000);
      scheduleReconnect(userId, numberId, k, delay);
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
  cancelReconnect(tmpKey);

  // 1. Fecha o socket tmp (sem logout) pra parar de gravar auth sob o id tmp.
  session.socketAlive = false;
  try { session.sock?.ev.removeAllListeners(); } catch {}
  try { session.sock?.end(undefined); } catch {}
  await new Promise(r => setTimeout(r, 600));

  // 2. Move a auth (creds recém-escaneadas + keys) do id tmp pro canônico.
  await pgAuth().renameSession(`${userId}::${tmpId}`, `${userId}::${canonicalId}`);

  // 3. Limpa a sessão tmp do Map e do Redis.
  sessions.delete(tmpKey);
  starting.delete(tmpKey);
  if (PUBLISH_STATUS) { try { await sessionStatus().clear(userId, tmpId); } catch {} }

  // 4. Descarta qualquer sessão canônica anterior (será substituída pela auth nova).
  const canonKey = key(userId, canonicalId);
  cancelReconnect(canonKey);
  const prevCanon = sessions.get(canonKey);
  if (prevCanon) {
    prevCanon.migrating = true;
    prevCanon.socketAlive = false;
    try { prevCanon.sock?.ev.removeAllListeners(); } catch {}
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

function snapshotOf(s) {
  return {
    numberId: s.numberId,
    status: s.status,
    info: s.info || null,
    lastError: s.lastError || null,
    stuck: s.stuck || false,
    // Em memory/worker o dono é este processo, então nunca é obsoleto — mas o
    // campo existe pra o contrato ser idêntico ao do proxy.
    stale: false,
  };
}

function listSessions(userId) {
  const u = String(userId);
  return Array.from(sessions.values())
    .filter(s => s.userId === u)
    .map(snapshotOf);
}

// Todas as sessões agrupadas por usuário — a aba de usuários do admin precisa do
// status de conexão da lista inteira, e um listSessions por linha seria N+1.
function listAllSessions() {
  const out = {};
  for (const s of sessions.values()) {
    (out[s.userId] ||= []).push(snapshotOf(s));
  }
  return out;
}

async function deleteSession(userId, numberId) {
  userId = String(userId);
  numberId = String(numberId);
  const k = key(userId, numberId);
  // Cancelar ANTES de qualquer await: um timer de backoff disparando no meio da
  // remoção recriava a sessão logo depois de apagada (a conexão fantasma clássica).
  cancelReconnect(k);
  starting.delete(k);
  const s = sessions.get(k);
  sessions.delete(k);
  if (s) {
    s.socketAlive = false;
    if (s.sock) {
      try { s.sock.ev.removeAllListeners(); } catch {}
      try { await s.sock.logout(); } catch {}
      try { s.sock.end(); } catch {}
    }
  }
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

// O retorno vai pro msg-store antes de voltar: é dele que o getMessage tira a
// mensagem quando o destinatário pede reenvio. Guardamos o proto como veio — no
// caso da imagem, o reenvio reaproveita as media keys em vez de subir de novo.
async function sendText(userId, numberId, jid, text) {
  const s = ensureConnected(userId, numberId);
  const sent = await s.sock.sendMessage(jid, { text });
  msgStore.put(sent);
  return sent;
}

async function sendImage(userId, numberId, jid, imageUrl, caption) {
  const s = ensureConnected(userId, numberId);
  const sent = await s.sock.sendMessage(jid, { image: { url: imageUrl }, caption });
  msgStore.put(sent);
  return sent;
}

async function createGroup(userId, numberId, name, participantPhones) {
  const s = ensureConnected(userId, numberId);
  const jids = participantPhones.map(jidFromPhone);
  const result = await s.sock.groupCreate(name, jids);

  // Grupo nasce restrito: só admins mandam mensagem ("announcement").
  // O criador é admin automaticamente, então a sessão tem permissão. Se falhar,
  // o grupo continua valendo — só avisamos quem chamou via adminOnly=false.
  let adminOnly = true;
  try {
    await s.sock.groupSettingUpdate(result.id, "announcement");
  } catch (err) {
    adminOnly = false;
    console.warn(`[whatsapp] falha ao restringir envio ao admin no grupo ${result.id}: ${err.message}`);
  }

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
    adminOnly,
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

// ── Manutenção periódica ────────────────────────────────────────────────────
// Dois timers, iniciados uma vez por processo (por restoreSessions, que roda no
// boot do worker e do server em memory mode).
const REPUBLISH_MS = 60_000;
const ORPHAN_SWEEP_MS = 5 * 60 * 1000;
let _maintenanceStarted = false;

function startMaintenance() {
  if (_maintenanceStarted) return;
  _maintenanceStarted = true;

  // Republish periódico. O worker publica por EVENTO, então uma sessão conectada
  // pode ficar horas sem escrever no Redis — e aí a idade do snapshot não serve
  // como sinal de vida. Com este refresh, `updatedAt` velho passa a significar
  // "nenhum worker vivo é dono desta chave" (ver infra/session-status.js).
  if (PUBLISH_STATUS) {
    const t = setInterval(() => {
      for (const s of sessions.values()) {
        try { publishStatus(s); } catch {}
      }
    }, REPUBLISH_MS);
    t.unref?.();
  }

  // Varredura de sessões provisórias órfãs (usuário fechou a aba no meio do QR).
  const o = setInterval(() => {
    const now = Date.now();
    for (const [k, s] of sessions) {
      if (!isOrphanQrSession(s, now)) continue;
      console.log(`[whatsapp] limpando sessão provisória órfã ${s.userId}/${s.numberId} (QR nunca escaneado)`);
      cancelReconnect(k);
      s.socketAlive = false;
      s.status = "disconnected";
      s.lastError = "QR não escaneado a tempo.";
      publishStatus(s);
      try { s.sock?.ev.removeAllListeners(); } catch {}
      try { s.sock?.end(undefined); } catch {}
      sessions.delete(k);
      starting.delete(k);
      pgAuth().deleteSession(`${s.userId}::${s.numberId}`).catch(() => {});
    }
  }, ORPHAN_SWEEP_MS);
  o.unref?.();
}

// Restaura sessões persistidas (SELECT distinct sessionId em baileys_auth).
// CRÍTICO: só restaura sessões cujo número AINDA existe em whatsapp_numbers.
// Auth órfã (de número deletado) precisa ser limpa, senão reconecta um "device
// fantasma" do mesmo telefone — o WhatsApp trata 2 conexões do mesmo número como
// conflito (device_removed/401), derruba a sessão e apaga as credenciais, forçando
// re-scan a cada restart.
const RESTORE_STAGGER_MS = 1500;

async function restoreSessions() {
  const { prisma } = require("../db");
  startMaintenance();

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

  // Reconciliação do cache de status: o Redis pode ter snapshots de um worker
  // anterior que morreu sem passar pelo closeAll (OOM do pm2, SIGKILL, uncaught).
  // Sem isso a tela e o admin mostram "conectado" por até 24h de uma sessão que
  // ninguém tem. Rebaixa o que NÃO vamos restaurar e marca como "connecting" o
  // que vamos, pro updatedAt nascer fresco.
  if (PUBLISH_STATUS) {
    const owned = new Set(live.map(p => `${p.userId}::${p.numberId}`));
    try {
      const snaps = await sessionStatus().listAllRaw();
      for (const snap of snaps) {
        const sk = `${snap.userId}::${snap.numberId}`;
        if (owned.has(sk) || snap.terminal) continue;
        await sessionStatus().publish(snap.userId, snap.numberId, {
          status: "disconnected", info: snap.info || null, lastError: null,
        }).catch(() => {});
      }
    } catch (err) {
      console.error(`[whatsapp] reconciliação de snapshots falhou: ${err.message}`);
    }
    for (const p of live) {
      await sessionStatus().publish(p.userId, p.numberId, { status: "connecting" }).catch(() => {});
    }
  }

  // O aviso "seu WhatsApp desconectou" é edge-triggered a partir de um Set POR
  // PROCESSO: sem semear, uma sessão que não volta depois do restart nunca
  // dispararia o alerta (ela não chegou a "connected" neste processo).
  try {
    const notifier = require("../notifications/user-notifier");
    for (const p of live) notifier.markConnectedOnce?.(p.userId, p.numberId);
  } catch { /* ignore */ }

  // Escalonado: N handshakes simultâneos no boot brigam por rede/CPU e viram
  // timeout, que vira reconexão, que vira mais handshake.
  live.forEach(({ userId, numberId }, i) => {
    const t = setTimeout(() => {
      startSession(userId, numberId).catch(err => {
        console.error(`[whatsapp] falha ao restaurar ${userId}/${numberId}:`, err.message);
      });
    }, i * RESTORE_STAGGER_MS);
    t.unref?.();
  });
  if (live.length > 0) console.log(`[whatsapp] restaurando ${live.length} sessão(ões)...`);
}

// Encerra graciosamente todas as sessões antes do worker sair. Usa sock.end()
// (fecha o websocket SEM deslogar — não apaga creds) pra que o WhatsApp registre
// a saída do device; assim o próximo worker reconecta sem disparar conflito
// (device_removed/401) por duas conexões simultâneas do mesmo número.
async function closeAll() {
  shuttingDown = true;
  for (const k of Array.from(reconnectTimers.keys())) cancelReconnect(k);
  starting.clear();
  const pubs = [];
  for (const s of sessions.values()) {
    s.socketAlive = false;
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
  listAllSessions,
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
  isCurrentGen,
  isOrphanQrSession,
};

function makeStub() {
  const fail = () => Promise.reject(new Error("Baileys não instalado. Rode: cd backend && npm install"));
  return {
    startSession: fail,
    getSession: () => null,
    listSessions: () => [],
    listAllSessions: () => ({}),
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
