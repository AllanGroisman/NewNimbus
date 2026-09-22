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

const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = baileys;

// Auth state em Postgres (tabela baileys_auth via auth/baileys-pg.js).
let _pgAuth = null;
function pgAuth() {
  if (!_pgAuth) _pgAuth = require("../auth/baileys-pg");
  return _pgAuth;
}

// "warn" no dia a dia. WA_LOG_LEVEL=debug/trace liga o log de protocolo do
// Baileys — necessário pra diagnosticar sessão que não conecta e não fecha.
//
// Fora isso, rodamos em `debug` com um destino que FILTRA. Subir o nível inteiro
// despejaria os ~6.700 `Bad MAC`/dia no log, então deixamos passar warn/error
// como sempre e, abaixo disso, só o que casa com KEEP_LINES. Duas famílias de
// linha importam:
//
//   1. o caminho de RETRY (`recv retry request`, `message not available`,
//      `forced new session for retry recp`, `fetching sessions`) — a única
//      evidência de por que o placeholder "Aguardando mensagem" não some;
//   2. o FANOUT da sender key de grupo (`sending new sender key`, `sending
//      message to N devices`). No Baileys 6 esse sinal só existia porque o nosso
//      patch o promovia a `info`; no 7 ele nasce em `debug`
//      (Socket/messages-send.ts, `logger.debug({ senderKeyJids }, 'sending new
//      sender key')`). Sem deixá-lo passar, um fanout VAZIO volta a ser
//      indistinguível de um envio bom — foi exatamente essa cegueira que
//      escondeu por dias o bug que deixou um grupo inteiro sem ver a promoção.
//      `senderKeyJids` vazio num grupo com participantes é o bug acontecendo;
//   3. o mapa PN<->LID nativo do 7 (`Own LID session created successfully`, em
//      Socket/socket.ts). Nasce em `info` — que é 30, ABAIXO do nosso corte de
//      40 — então também precisa estar aqui. É a confirmação, no connect, de que
//      o LIDMappingStore assumiu o trabalho que o patch do 6.x fazia no chute.
//
// WA_RETRY_DEBUG=0 desliga sem deploy.
const KEEP_LINES = /retry|fetching sessions|not available|forced new session|sender key|sending message to|lid session|lid mapping/i;

// Separado do destino pra poder ser testado sem montar um pino inteiro
// (tests/unit/whatsapp-log-filter.test.js). Linha sem `level` numérico passa:
// preferimos ruído a engolir algo que não sabemos classificar.
function keepLogLine(rec) {
  if (!rec || typeof rec.level !== "number") return true;
  // 40 = warn no pino. Abaixo disso, só o que casa com KEEP_LINES.
  return rec.level >= 40 || KEEP_LINES.test(rec.msg || "");
}

function makeLogger() {
  const explicit = process.env.WA_LOG_LEVEL;
  if (explicit) return pino({ level: explicit });
  if (process.env.WA_RETRY_DEBUG === "0") return pino({ level: "warn" });
  const dest = {
    write(line) {
      try {
        if (keepLogLine(JSON.parse(line))) process.stdout.write(line);
      } catch {
        process.stdout.write(line);
      }
    },
  };
  return pino({ level: "debug" }, dest);
}

const log = makeLogger();

// Nome que o celular mostra em WhatsApp › Aparelhos conectados. É o browser[0]
// do Baileys, que ele manda como `os` do device (`generateRegistrationNode`, em
// Utils/validate-connection.js): o app renderiza "Google Chrome (<browser[0]>)".
//
// Fora de produção (NIMBUS_MODE=ngrok/e2e) o rótulo vira "Teste": a máquina de
// testes pareia no MESMO celular que a produção, e com os dois devices chamados
// "(Nimbus)" não há como saber qual desconectar. WHATSAPP_DEVICE_LABEL sobrepõe,
// pra uma segunda máquina de teste ter rótulo próprio.
//
// Vale só pra pareamento NOVO: o campo viaja no registro do device. Sessão que já
// tem credencial entra por generateLoginNode, que não reenvia isso — o nome do
// device já pareado não muda.
//
// Lê o process.env direto (e não o `mode` do config/loadEnv) porque NIMBUS_MODE
// sempre vem do ambiente do PM2, nunca de arquivo .env; assim não dependemos da
// ordem de require deste módulo.
function deviceLabel() {
  const custom = String(process.env.WHATSAPP_DEVICE_LABEL || "").trim();
  if (custom) return custom;
  return (process.env.NIMBUS_MODE || "prod").toLowerCase() === "prod" ? "Nimbus" : "Teste";
}

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

// Fila de envio por sessão. A fila `control` do BullMQ roda concurrency 4
// (infra/queue.js) e TODO envio vindo do server passa por ela, além do job de
// campanha na fila `send`. Sem esta trava, dois relayMessage rodam ao mesmo
// tempo no MESMO socket — e o addTransactionCapability do Baileys usa um
// `transactionCache`/`mutations` compartilhado com um contador simples: quando a
// transação de fora termina primeiro, o `finally` dela limpa o cache no meio da
// outra e as mutações do ratchet se perdem. O destinatário então não decripta e
// fica no "Aguardando mensagem". Sessões diferentes seguem em paralelo.
const sendChains = new Map();

function withSendLock(k, fn) {
  const prev = sendChains.get(k) || Promise.resolve();
  // `prev.then(fn, fn)`: um envio que falhou não pode travar a fila do próximo.
  const run = prev.then(fn, fn);
  const next = run.catch(() => {});
  sendChains.set(k, next);
  next.then(() => { if (sendChains.get(k) === next) sendChains.delete(k); });
  return run;
}

// Quanto tempo o cache de metadata de grupo vale. Sem `cachedGroupMetadata` o
// Baileys dispara um IQ de groupMetadata ao vivo a CADA envio em grupo, dentro
// da transação de chaves — num link ruim isso estoura no meio da cifra.
const GROUP_META_TTL_MS = 5 * 60 * 1000;
const GROUP_META_MAX = 200;

// Falha ao gravar o estado Signal: o ratchet avançou na memória e não no banco
// (o texto cifrado já saiu na rede quando o commit falha). Continuar enviando a
// partir daí garante que aquele destinatário não decripta mais nada. Derrubamos
// o socket: a reconexão relê o estado do banco. Debounce porque o Baileys tenta
// o mesmo commit 10x, e derrubar o socket 10 vezes seguidas não ajuda ninguém.
const PERSIST_FAIL_DEBOUNCE_MS = 30_000;

function handlePersistError(session, gen, err) {
  if (!isCurrentGen(session, gen) || !session.socketAlive) return;
  const now = Date.now();
  if (session.lastPersistFailAt && (now - session.lastPersistFailAt) < PERSIST_FAIL_DEBOUNCE_MS) return;
  session.lastPersistFailAt = now;
  console.error(`[whatsapp] key store falhou ${session.userId}/${session.numberId} (${err?.message || err})` +
    ` — derrubando o socket pra recarregar o estado do banco`);
  try { session.sock?.end(new Error("estado Signal não pôde ser gravado")); } catch {}
}

function key(userId, numberId) { return `${userId}::${numberId}`; }

// ── Aliases de canonicalização ──────────────────────────────────────────────
// Quando a sessão do id provisório vira o id-telefone, o id provisório deixa de
// existir e o GET da rota responderia 404 pra sempre. Guardamos aqui um
// redirecionamento de vida curta para o painel que só voltar a consultar depois
// (aba em segundo plano no fluxo de código de pareamento) ainda ver "connected"
// com o `info` do telefone. Em modo redis quem serve o painel é o snapshot do
// session-status (publishAlias); este Map cobre o modo memória e o próprio worker.
const aliases = new Map(); // key(userId, tmpId) → { info, canonicalNumberId, expiresAt }
const ALIAS_TTL_MS = 600_000; // 10 min — mesmo TTL do snapshot no Redis

function setAlias(userId, tmpId, { info = null, canonicalNumberId = null } = {}) {
  aliases.set(key(userId, tmpId), { info, canonicalNumberId, expiresAt: Date.now() + ALIAS_TTL_MS });
}

function getAlias(userId, tmpId) {
  const k = key(userId, tmpId);
  const a = aliases.get(k);
  if (!a) return null;
  if (a.expiresAt <= Date.now()) { aliases.delete(k); return null; }
  return a;
}

function clearAlias(userId, tmpId) { aliases.delete(key(userId, tmpId)); }

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
      // A ABERTURA falhou (ex.: Postgres fora, e é justamente quando isso
      // acontece). Sem reagendar aqui a sessão fica parada pra sempre: o handler
      // de "close" — que é quem normalmente marca o próximo backoff — nem chega
      // a existir, porque não houve socket.
      const s = sessions.get(k);
      if (!s || shuttingDown) return;
      s.restartCount = (s.restartCount || 0) + 1;
      scheduleReconnect(userId, numberId, k,
        Math.min(30000, 1500 * s.restartCount) + Math.floor(Math.random() * 1000));
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

// ── Código de pareamento (8 dígitos) ────────────────────────────────────────
// Espera pelo handshake antes de pedir o código (ver waitPairingReady).
const PAIRING_READY_TIMEOUT_MS = 20_000;
// Vida útil que MOSTRAMOS pro usuário. O relógio de verdade é a lista de refs do
// QR, que o requestPairingCode não cancela: quando ela esgota o socket morre
// (~2 min). Ficamos deliberadamente ABAIXO disso pra oferecer "gerar novo código"
// antes do backend derrubar a sessão por baixo da tela.
const PAIRING_CODE_TTL_MS = 110_000;
// Vida útil aproximada do socket contada da ABERTURA dele: é o prazo das refs do QR,
// que o requestPairingCode não cancela. Serve só pra contagem regressiva da tela não
// prometer mais do que o socket vai viver (ver pairingPayload).
const PAIRING_SOCKET_LIFE_MS = 120_000;
// O `browser` que o socket de PAREAMENTO precisa usar.
//
// O deviceLabel() vive na posição 0 da tupla, que é o SISTEMA OPERACIONAL — é um
// abuso deliberado, pra o celular mostrar "Nimbus"/"Teste" em Aparelhos
// conectados. O README do Baileys autoriza isso explicitamente só pro QR ("You
// can customize browser name if you connect with QR-CODE"), e a doc é categórica
// sobre o outro caminho: "When logging in using pairing code, you should only set
// a valid/logical browser config, otherwise the pair will fail."
//
// E falha em silêncio: o IQ de pareamento é fire-and-forget, então o código sai
// normalmente e só o celular recusa. Foi o que aconteceu no primeiro teste real —
// com "Nimbus" de SO e "1.0" de versão, nenhum telefone servia.
//
// Este é o default do próprio Baileys (Browsers.ubuntu("Chrome")), que é o que o
// exemplo de pairing code da doc usa ao não passar `browser` nenhum.
//
// Custo aceito: número pareado por código aparece no celular como Ubuntu, sem o
// rótulo Nimbus/Teste. Vale só pro pareamento — o rótulo viaja no registro do
// device, e sessão já pareada reconecta por generateLoginNode, que não o reenvia.
const PAIRING_BROWSER = ["Ubuntu", "Chrome", "22.04.4"];

// Clique duplo / retry humano devolve o código vigente. Cada requestPairingCode
// INVALIDA o anterior (sobrescreve creds.pairingCode), então emitir dois seguidos
// deixaria na tela um código que o WhatsApp já não aceita.
const PAIRING_MIN_INTERVAL_MS = 5_000;

// Prova DURÁVEL de que a sessão pareou algum dia.
//
// `requestPairingCode` grava `creds.me` e `creds.pairingCode` ANTES de qualquer
// pareamento, e o nosso handler de `creds.update` persiste isso no Postgres — o
// veneno sobrevive a restart e ao restoreSessions. Por isso `creds.me` sozinho
// deixou de ser prova: uma tentativa de código abandonada passaria por "pareada"
// e desligaria os dois caminhos de limpeza (401 de handshake e 408 de QR
// esgotado), deixando a sessão em loop de reconexão pra sempre.
//
// Quem pareou de verdade tem `creds.account` — o ADVSignedDeviceIdentity que o
// configureSuccessfulPairing grava, e que vale pros DOIS fluxos (é o mesmo
// handler `CB:iq,,pair-success`) — ou `creds.registered`, que só o fluxo de
// código seta. Para toda sessão que existe hoje (sem `pairingCode`) isto é
// idêntico a `!!creds.me?.id`: nenhuma mudança de comportamento no caminho do QR.
function isPairedCreds(creds) {
  if (!creds?.me?.id) return false;
  if (creds.pairingCode && !creds.registered && !creds.account) return false;
  return true;
}

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
// `paired` = a sessão JÁ pareou algum dia. Quem responde isso é `isPairedCreds`,
// NÃO um `!!creds.me?.id` cru — ver o comentário lá em cima.
//
// ATENÇÃO: NÃO use `creds.registered` pra isso. No Baileys 6.7.23 esse campo só
// é setado no fluxo de PAIRING CODE (Socket/messages-recv.js, link_code_pairing);
// quem pareia por QR — que é todo mundo aqui — fica com `registered: false` pra
// sempre, mesmo conectado e funcionando há meses. Usar aquele campo fazia toda
// sessão real ser tratada como "nunca pareada", e os três caminhos abaixo APAGAM
// a auth nesse caso: o usuário era obrigado a ler o QR de novo, e cada re-scan
// queima um slot de aparelho conectado (os devices :47, :59, :61 do mesmo número
// no log). Aparelho antigo evicted = sessão Signal morta em todos os contatos =
// "Aguardando mensagem" pra todo lado.
//
// (O `registered` deixou de ser inútil quando entrou o código de pareamento: ele
// é um dos dois marcadores que o `isPairedCreds` aceita. O que continua proibido
// é usá-lo SOZINHO, que é o que quebrava toda sessão pareada por QR.)
//
// `pairingAttempt`: esta sessão pediu um código e ainda não pareou. Só troca a
// CÓPIA das duas mensagens de falha — quem lê "QR não escaneado a tempo" depois
// de digitar um código não entende do que a tela está falando.
function classifyClose(err, {
  shuttingDown = false,
  paired = true,
  pairingAttempt = false,
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
    if (!paired) {
      return {
        status: "disconnected",
        lastError: pairingAttempt
          ? "Falha ao parear. Confira o número e gere um código novo."
          : "Falha ao parear. Tente ler o QR de novo.",
        reconnect: false,
        cleanup: true,
      };
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
  if (qrExpired && !paired) {
    return {
      status: "disconnected",
      lastError: pairingAttempt
        ? "O código não foi usado a tempo. Gere um novo."
        : "QR não escaneado a tempo.",
      reconnect: false,
      cleanup: true,
    };
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
  // Sem esta guarda, uma sessão real presa em "connecting" por 10 min (internet
  // fora, Postgres fora) era varrida daqui com a auth apagada junto. É
  // `isPairedCreds` e não `creds.me` porque um pedido de código de pareamento
  // grava `creds.me` sem ter pareado nada — a tentativa abandonada PRECISA ser
  // varrida (ver o comentário do isPairedCreds).
  if (isPairedCreds(session.sock?.authState?.creds)) return false;
  if (session.status !== "awaiting_qr" && session.status !== "connecting") return false;
  return (now - (session.createdAt || now)) >= maxAgeMs;
}

function normalizePhone(p) { return String(p).replace(/\D/g, ""); }
function jidFromPhone(phone) { return `${normalizePhone(phone)}@s.whatsapp.net`; }

// ── Código de pareamento ────────────────────────────────────────────────────
// Alternativa ao QR: o usuário digita o telefone, recebe 8 caracteres e os digita
// no celular (Dispositivos vinculados › Vincular com número de telefone).
//
// Roda no MESMO socket do QR de propósito. O Baileys aceita o scan do QR mesmo
// com um código pendente, então trocar de modo na tela não reinicia nada — e um
// socket dedicado exigiria mexer no qrTimeout, que é opção de construção.
//
// Erro esperado volta como VALOR ({ ok: false, reason }), não como exceção: o RPC
// do BullMQ só carrega `message` de um Error, então `err.code` não sobreviveria à
// travessia server↔worker. Throw fica pra falha genuína (Sentry).
const pairingInflight = new Map();

// Bookkeeping de UI. Nada de correção depende destes campos — quem responde
// "pareou?" é o isPairedCreds, que lê as creds.
function clearPairing(session) {
  if (!session) return;
  session.pairingCode = null;
  session.pairingPhone = null;
  session.pairingRequestedAt = null;
}

function pairingFail(reason, message) {
  return { ok: false, reason, message };
}

function pairingPayload(s) {
  return {
    ok: true,
    code: s.pairingCode,
    // O celular mostra o código em dois blocos de 4.
    formatted: `${s.pairingCode.slice(0, 4)}-${s.pairingCode.slice(4)}`,
    phone: s.pairingPhone,
    // O relógio de verdade é o das refs do QR, e ele começa na ABERTURA do socket,
    // não na emissão do código. Contar só da emissão prometia tempo que o socket não
    // tinha (o pedido vem depois do handshake, às vezes bem depois). Vence o primeiro.
    expiresAt: Math.min(
      s.pairingRequestedAt + PAIRING_CODE_TTL_MS,
      (s.socketOpenedAt || s.pairingRequestedAt) + PAIRING_SOCKET_LIFE_MS,
    ),
  };
}

// O socket precisa estar ALÉM do handshake noise pra receber o IQ do
// link_code_companion_reg — `ws.isOpen` não serve, é anterior a isso e um sendNode
// ali vira frame que o servidor não lê. O sinal certo é o primeiro `qr` da geração
// atual (o WhatsApp só o manda depois do handshake, no mesmo pair-device que
// habilita o pareamento), e o handler de connection.update já o grava em
// `session.qr`. Poll em vez de listener: um listener precisaria do próprio cleanup
// na troca de geração, no close e no deleteSession.
//
// ATENÇÃO ao "da geração atual": o objeto `session` sobrevive à troca de socket,
// então `session.qr` sozinho pode ser o QR do socket ANTERIOR — é o caso normal da
// tela, que abre em modo QR e reabre o socket ao pedir o código. Aceitar aquele QR
// fazia o requestPairingCode sair com o WebSocket novo ainda nem aberto, e o Baileys
// respondia "Connection Closed" (era o erro ao clicar em "Gerar código"). Por isso o
// `qrGen`: só vale QR emitido POR ESTA geração.
async function waitPairingReady(k, session, gen, timeoutMs = PAIRING_READY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = sessions.get(k);
    if (s !== session || !isCurrentGen(s, gen)) {
      return pairingFail("SOCKET_GONE", "A conexão reiniciou. Tente de novo.");
    }
    if (s.status === "connected") {
      return pairingFail("ALREADY_CONNECTED", "Este número já está conectado.");
    }
    if (!s.socketAlive) {
      return pairingFail("SOCKET_GONE", "A conexão com o WhatsApp caiu. Tente de novo.");
    }
    if (s.qr && s.qrGen === gen) return null;
    if (Date.now() >= deadline) {
      return pairingFail("PAIRING_TIMEOUT", "O WhatsApp não respondeu a tempo. Tente de novo.");
    }
    await new Promise(r => { const t = setTimeout(r, 200); t.unref?.(); });
  }
}

// Gate: validação + idempotência + single-flight, igual ao startSession.
async function requestPairingCode(userId, numberId, phone) {
  userId = String(userId);
  numberId = String(numberId);
  const digits = normalizePhone(phone);
  // Faixa E.164 (o servidor já validou o formato BR; aqui é a rede de segurança
  // de quem chama pelo RPC).
  if (digits.length < 10 || digits.length > 15) {
    return pairingFail("BAD_PHONE", "Telefone inválido.");
  }

  const k = key(userId, numberId);
  const cur = sessions.get(k);
  if (cur?.status === "connected") {
    return pairingFail("ALREADY_CONNECTED", "Este número já está conectado.");
  }
  // Sessão com credencial boa não recebe pair-device: ela loga direto e o
  // waitPairingReady esperaria os 20s inteiros à toa.
  if (isPairedCreds(cur?.sock?.authState?.creds)) {
    return pairingFail("ALREADY_PAIRED", "Este número já está pareado. Use Reconectar.");
  }
  if (cur?.pairingCode && cur.pairingPhone === digits && cur.socketAlive
      && (Date.now() - (cur.pairingRequestedAt || 0)) < PAIRING_MIN_INTERVAL_MS) {
    return pairingPayload(cur);
  }

  const inflight = pairingInflight.get(k);
  if (inflight) return inflight;

  const p = _requestPairingCode(userId, numberId, k, digits)
    .finally(() => { if (pairingInflight.get(k) === p) pairingInflight.delete(k); });
  pairingInflight.set(k, p);
  return p;
}

async function _requestPairingCode(userId, numberId, k, digits) {
  // startSession já é idempotente e single-flight: cobre os três estados
  // possíveis (sem sessão / socket morto esperando backoff / socket vivo). O
  // `pairing` garante o browser válido — e reabre o socket se o que existe foi
  // aberto pro QR.
  const session = await startSession(userId, numberId, { pairing: true });
  const gen = session.gen;

  const notReady = await waitPairingReady(k, session, gen);
  if (notReady) return notReady;

  // O sendNode do link_code_companion_reg lança `Connection Closed` quando o
  // WebSocket morre entre o waitPairingReady e aqui. É falha de rede esperada, não
  // bug: vira recusa (503 na rota) em vez de 500 + Sentry.
  let code;
  try {
    code = await session.sock.requestPairingCode(digits);
  } catch (err) {
    console.warn(`[whatsapp] requestPairingCode falhou ${userId}/${numberId}: ${err.message}`);
    return pairingFail("SOCKET_GONE", "A conexão caiu antes de gerar o código. Tente de novo.");
  }
  // O socket pode ter sido trocado durante o await: o código emitido pertence a
  // um socket que já não existe.
  if (!isCurrentGen(sessions.get(k), gen)) {
    return pairingFail("SOCKET_GONE", "A conexão reiniciou. Gere um código novo.");
  }

  session.pairingCode = code;
  session.pairingPhone = digits;
  session.pairingRequestedAt = Date.now();
  // NUNCA logar o código: é credencial de vinculação enquanto vale.
  console.log(`[whatsapp] código de pareamento emitido ${userId}/${numberId} (tel ${digits})`);
  return pairingPayload(session);
}

// Gate fino: idempotência + single-flight. O trabalho de verdade fica em _openSocket.
async function startSession(userId, numberId, opts = {}) {
  userId = String(userId);
  numberId = String(numberId);
  const k = key(userId, numberId);

  // Curto-circuito idempotente. ANTES valia só pra "connected" — por isso um POST
  // durante o QR abria um segundo socket. Agora vale pra qualquer sessão com
  // socket VIVO (connecting/awaiting_qr/connected). Sessão cujo socket já caiu e
  // só espera o backoff NÃO curto-circuita: a ação explícita do usuário
  // ("Reconectar") deve tentar na hora.
  // Um socket vivo só serve se estiver no modo certo: pedir código de pareamento
  // num socket aberto com o browser do QR é exatamente o que faz o celular
  // recusar o código (ver PAIRING_BROWSER).
  const existing = sessions.get(k);
  if (existing?.sock && existing.socketAlive && (!opts.pairing || existing.pairingMode)) return existing;

  const inflight = starting.get(k);
  if (inflight && !opts.pairing) return inflight;
  // Abertura em curso no modo errado: espera terminar e reabre no modo certo.
  if (inflight) await inflight.catch(() => {});

  const p = _openSocket(userId, numberId, k, opts)
    .finally(() => { if (starting.get(k) === p) starting.delete(k); });
  starting.set(k, p);
  return p;
}

async function _openSocket(userId, numberId, k, opts = {}) {
  cancelReconnect(k);

  // `browser` é opção de CONSTRUÇÃO do socket: não dá pra trocar depois. Quando o
  // chamador não diz nada (reconexão por backoff, restore), herdamos a intenção
  // que a sessão já tinha — senão o primeiro reconnect voltaria pro rótulo
  // customizado e derrubaria o pareamento em andamento.
  const pairing = opts.pairing ?? (sessions.get(k)?.pairingMode ?? false);

  // Encerra o socket anterior ANTES de abrir outro e desliga os listeners: um
  // socket zumbi continua recebendo eventos e gravando auth por baixo.
  const prev = sessions.get(k);
  if (prev?.sock) {
    prev.socketAlive = false;
    try { prev.sock.ev.removeAllListeners(); } catch {}
    try { prev.sock.end(undefined); } catch {}
    prev.sock = null;
  }

  // A geração é reservada ANTES do socket porque o onPersistError do auth state
  // já precisa saber a qual delas pertence (ver handlePersistError).
  const gen = ++_gen;
  const sessionRef = () => sessions.get(k);

  const authOpts = { onPersistError: (err) => handlePersistError(sessionRef(), gen, err) };
  let { state, saveCreds } = await pgAuth().useDatabaseAuthState(`${userId}::${numberId}`, authOpts);

  // Auth de uma tentativa de código ABANDONADA envenena todas as seguintes.
  //
  // O requestPairingCode do Baileys grava `creds.me` (Socket/socket.js) ANTES de
  // parear nada, e o nosso handler de creds.update persiste isso no Postgres. No
  // handshake seguinte o Baileys olha só pra isso: `if (!creds.me) registro senão
  // login`. Com o `me` fantasma ele manda LOGIN com credencial que não existe →
  // 401 na hora, sem QR e sem pair-device. Era a fila de "close code=401 Connection
  // Failure" do log, e o motivo de a 2ª tentativa em diante nunca funcionar.
  //
  // Só apagamos o que o isPairedCreds já considera NÃO pareado — número pareado de
  // verdade não chega aqui (o gate devolve ALREADY_PAIRED/ALREADY_CONNECTED antes) e,
  // se chegasse, a guarda o preserva. Sem logout: não há device pra desvincular.
  if (pairing && state.creds?.me?.id && !isPairedCreds(state.creds)) {
    console.log(`[whatsapp] auth de pareamento incompleta descartada ${userId}/${numberId}`);
    await pgAuth().deleteSession(`${userId}::${numberId}`);
    ({ state, saveCreds } = await pgAuth().useDatabaseAuthState(`${userId}::${numberId}`, authOpts));
  }
  const version = await cachedBaileysVersion();

  // Metadata de grupo por socket. Zera na reconexão de propósito: estado velho de
  // participante é justamente o que faz a sender key ir pra lista errada.
  const groupMetaCache = new Map();
  // Um IQ de groupMetadata por envio em grupo saía caro e ficava dentro da
  // transação de chaves. Devolver undefined em caso de erro é o contrato: o
  // Baileys busca por conta própria. O envio com @todos (mentionsFor) lê daqui
  // também, pra não pagar um IQ a mais por mensagem.
  const cachedGroupMetadata = async (jid) => {
    const hit = groupMetaCache.get(jid);
    if (hit && (Date.now() - hit.at) < GROUP_META_TTL_MS) return hit.meta;
    try {
      const meta = await sock.groupMetadata(jid);
      if (meta) {
        groupMetaCache.set(jid, { at: Date.now(), meta });
        while (groupMetaCache.size > GROUP_META_MAX) {
          groupMetaCache.delete(groupMetaCache.keys().next().value);
        }
      }
      return meta;
    } catch {
      return undefined;
    }
  };

  const sock = makeWASocket({
    version: version || undefined,
    auth: {
      creds: state.creds,
      // Sem este wrapper cada chave Signal lida custa um SELECT no Postgres +
      // um AES-GCM: um envio de grupo pede as sessões de dezenas de devices de
      // uma vez, e o pool de conexões estourava dentro do caminho de cifra. O
      // cache é por socket e só é seguro porque um único worker é dono de cada
      // sessão (ver README.md deste diretório).
      keys: makeCacheableSignalKeyStore(state.keys, log),
    },
    printQRInTerminal: false,
    browser: pairing ? PAIRING_BROWSER : [deviceLabel(), "Chrome", "1.0"],
    logger: log,
    syncFullHistory: false,
    markOnlineOnConnect: false,
    // Retry receipt: quando o celular do destinatário não decripta o pacote, ele
    // mostra "Aguardando mensagem. Essa ação pode levar alguns instantes" e pede o
    // reenvio. O Baileys atende esse pedido em sendMessagesAgain buscando a
    // mensagem original AQUI. Sem este callback vale o default do Baileys
    // (`async () => undefined`): o reenvio nunca sai e o placeholder fica pra
    // sempre no celular do usuário. Ver whatsapp/msg-store.js.
    getMessage: async (key) => {
      // Retry de mensagem "peer" — pedido interno que o próprio Baileys gera
      // (`sendRetryRequest: requested placeholder resend`). Vem sem remoteJid e
      // nunca passou por sendText, então não está no store por definição, e
      // reenviá-la não faria sentido (o relayMessage iria pra um jid indefinido).
      // Devolver undefined em silêncio evita encher o log de "miss" que não são
      // falha nenhuma — eram TODOS os misses observados no diagnóstico.
      if (!key?.remoteJid) return undefined;
      return msgStore.get(key.id);
    },
    cachedGroupMetadata,
  });

  const session = sessions.get(k) || { userId, numberId, restartCount: 0, createdAt: Date.now() };
  session.sock = sock;
  session.groupMeta = cachedGroupMetadata;
  session.gen = gen;
  session.socketAlive = true;
  session.terminal = false; // um start explícito sempre tira do estado terminal
  session.pairingMode = pairing;
  session.socketOpenedAt = Date.now();
  // Socket novo invalida qualquer código pendente: o link_code_companion_reg vale
  // só pra conexão que o emitiu.
  clearPairing(session);
  // ...e invalida o QR junto. Quem zera o QR é o handler de close (lá embaixo), mas
  // ele NÃO roda nesta troca: o bloco acima tira os listeners antes do end(). Sem
  // isto o QR velho continuava no snapshot (tela mostrando um QR que já não vale) e,
  // pior, o waitPairingReady o tomava como prova de handshake concluído.
  session.qr = null;
  session.qrDataUrl = null;
  session.qrGen = null;
  // Sem QR na mão, 'awaiting_qr' seria mentira: a tela cai no painel cru
  // "Status: awaiting_qr" em vez do spinner de conectando, até o socket novo emitir
  // o dele.
  if (session.status === "awaiting_qr") session.status = "connecting";
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

  // Invalidação do cache de metadata: participante que entra/sai muda a lista de
  // destinatários da sender key. Servir lista velha é mandar a mensagem cifrada
  // pra quem não consegue abrir — o "Aguardando mensagem" do outro lado.
  sock.ev.on("groups.update", (updates) => {
    if (!isCurrentGen(session, gen)) return;
    for (const u of updates || []) if (u?.id) groupMetaCache.delete(u.id);
  });
  sock.ev.on("group-participants.update", (u) => {
    if (!isCurrentGen(session, gen)) return;
    if (u?.id) groupMetaCache.delete(u.id);
  });

  sock.ev.on("connection.update", async (update) => {
    if (!isCurrentGen(session, gen)) return; // socket antigo: no-op total
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      session.qr = qr;
      // De qual geração é este QR. O objeto session atravessa a troca de socket, e o
      // waitPairingReady precisa distinguir "QR desta conexão" de "QR da anterior".
      session.qrGen = gen;
      try { session.qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 280 }); } catch {}
      session.status = "awaiting_qr";
      publishStatus(session);
    }

    if (connection === "open") {
      session.status = "connected";
      session.qr = null;
      session.qrDataUrl = null;
      clearPairing(session);
      // "Once you are fully paired, you can switch the browser config back to
      // normal" — daqui em diante o socket pode voltar ao rótulo customizado.
      session.pairingMode = false;
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
      const creds = sock.authState?.creds;
      const paired = isPairedCreds(creds);
      const result = classifyClose(err, {
        shuttingDown,
        paired,
        pairingAttempt: !paired && !!creds?.pairingCode,
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
      clearPairing(session);

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

  // 3. Tira a sessão tmp do Map e deixa no lugar dela um REDIRECIONAMENTO.
  // Apagar o snapshot (o que se fazia antes) fazia o GET /api/whatsapp/sessions/<tmpId>
  // responder 404 pra sempre a partir daqui, e o modal do painel só tinha os 3s
  // agendados no connection.open pra ver "connected". Quem vincula pelo código de 8
  // dígitos PRECISA sair do navegador pra digitar no celular — a aba fica suspensa,
  // perde a janela, e o número acabava conectado no worker e ausente do banco.
  sessions.delete(tmpKey);
  starting.delete(tmpKey);
  setAlias(userId, tmpId, { info: session.info, canonicalNumberId: canonicalId });
  if (PUBLISH_STATUS) {
    try {
      await sessionStatus().publishAlias(userId, tmpId, {
        info: session.info,
        canonicalNumberId: canonicalId,
      });
    } catch {}
  }

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

// Só leitura de status (a rota GET da sessão, o snapshot do worker). Quem vai
// USAR o socket passa por ensureConnected, que lê o Map direto e portanto nunca
// enxerga um alias — o alias não tem sock.
function getSession(userId, numberId) {
  const s = sessions.get(key(userId, numberId));
  if (s) return s;
  const a = getAlias(userId, numberId);
  if (!a) return undefined;
  return {
    userId: String(userId),
    numberId: String(numberId),
    status: "connected",
    info: a.info || null,
    qr: null,
    qrDataUrl: null,
    lastError: null,
    stuck: false,
    alias: true,
    canonicalNumberId: a.canonicalNumberId || null,
  };
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
  // O painel dispara DELETE no id provisório ao fechar o modal. Se ficasse um
  // alias pra trás, uma tentativa seguinte com o mesmo id leria "connected" de
  // uma vinculação que o usuário acabou de descartar.
  clearAlias(userId, numberId);
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
// ensureConnected fica DENTRO da trava: numa fila de envios o socket pode ter
// caído entre o enfileiramento e a vez deste envio.
// {todos} no modelo da campanha: todo participante vai em `mentions` — é isso
// que notifica, inclusive quem silenciou o grupo. Em grupo endereçado por LID os
// ids já vêm como LID, e é assim que o Baileys quer. Sem metadata o envio sai sem
// menção: marcar todo mundo não vale derrubar a mensagem.
async function mentionsFor(s, jid, opts) {
  if (!opts?.mentionAll || !String(jid).endsWith("@g.us")) return undefined;
  const meta = s.groupMeta ? await s.groupMeta(jid) : undefined;
  const ids = (meta?.participants || []).map(p => p.id).filter(Boolean);
  if (!ids.length) {
    console.warn(`[whatsapp] @todos sem participantes em ${jid} — enviando sem menção`);
    return undefined;
  }
  return ids;
}

async function sendText(userId, numberId, jid, text, opts = {}) {
  return withSendLock(key(userId, numberId), async () => {
    const s = ensureConnected(userId, numberId);
    const mentions = await mentionsFor(s, jid, opts);
    const sent = await s.sock.sendMessage(jid, mentions ? { text, mentions } : { text });
    msgStore.put(sent);
    return sent;
  });
}

async function sendImage(userId, numberId, jid, imageUrl, caption, opts = {}) {
  return withSendLock(key(userId, numberId), async () => {
    const s = ensureConnected(userId, numberId);
    const mentions = await mentionsFor(s, jid, opts);
    const content = { image: { url: imageUrl }, caption };
    const sent = await s.sock.sendMessage(jid, mentions ? { ...content, mentions } : content);
    msgStore.put(sent);
    return sent;
  });
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
        // Alias (id provisório → canônico) não é sessão nossa e não deve ser
        // rebaixado: ele existe justamente pra um painel que voltou do segundo
        // plano ainda ler "connected". Ele expira sozinho pelo TTL.
        if (owned.has(sk) || snap.terminal || snap.alias) continue;
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

// Consultado pela rota de teste (via control queue, em modo redis): quantas vezes o
// aparelho pediu o reenvio desta mensagem. Ver msg-store.js.
function msgStats(id) {
  return msgStore.stats(id);
}

module.exports = {
  startSession,
  requestPairingCode,
  getSession,
  listSessions,
  listAllSessions,
  deleteSession,
  sendText,
  sendImage,
  msgStats,
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
  isPairedCreds,
  keepLogLine,
  setAlias,
  getAlias,
  clearAlias,
};

function makeStub() {
  const fail = () => Promise.reject(new Error("Baileys não instalado. Rode: cd backend && npm install"));
  return {
    startSession: fail,
    requestPairingCode: fail,
    getSession: () => null,
    listSessions: () => [],
    listAllSessions: () => ({}),
    deleteSession: fail,
    sendText: fail,
    sendImage: fail,
    msgStats: () => ({ known: false, retries: 0, lastRetryAt: null }),
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
