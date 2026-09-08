// msg-store — as últimas mensagens que ESTE processo enviou, pra poder reenviar.
//
// Por que isto existe: quando o celular do destinatário não consegue decriptar um
// pacote nosso (sessão Signal nova ou com o ratchet dessincronizado), ele mostra
// "Aguardando mensagem. Essa ação pode levar alguns instantes" e manda um *retry
// receipt* de volta pedindo o reenvio. O Baileys atende esse pedido em
// `sendMessagesAgain` (Socket/messages-recv.js), mas pra isso precisa recuperar a
// mensagem original — e ele pergunta ao app, pelo callback `getMessage(key)` do
// makeWASocket. O default do Baileys é `async () => undefined`: sem um store, o
// reenvio nunca sai e o placeholder fica no celular do usuário PRA SEMPRE.
//
// Duas camadas:
//   1. memória, no processo do socket — atende o caso normal sem tocar em rede;
//   2. Redis (só em QUEUE_BACKEND=redis), TTL de 24h — atende o retry receipt que
//      chega DEPOIS de um restart do worker. Sem ela, todo `pm2 reload` de deploy,
//      todo `max_memory_restart` e todo crash transformavam os retries pendentes
//      daquele instante em placeholder eterno; e o teto de 1000 mensagens em
//      memória também derrubava os pendentes de uma campanha grande.
//
// Chaveado pelo `id` puro, não por `jid:id`: o receipt monta a key a partir do que
// o WhatsApp devolveu, e o remoteJid de lá pode vir na forma LID enquanto gravamos
// a forma PN (@s.whatsapp.net). Casar por jid perderia justo os casos que
// interessam; id de mensagem do WhatsApp já é único.

const MAX = Number(process.env.WA_MSG_STORE_MAX) || 1000;
const TTL_MS = Number(process.env.WA_MSG_STORE_TTL_MS) || 60 * 60 * 1000; // 1h

// A camada durável só existe onde o Redis já é dependência dura (worker em modo
// redis). Em memory mode — dev e testes — o comportamento é o de antes.
const USE_REDIS = (process.env.QUEUE_BACKEND || "memory").toLowerCase() === "redis";
const REDIS_TTL_S = Number(process.env.WA_MSG_STORE_REDIS_TTL_S) || 24 * 60 * 60;
const RKEY = (id) => `nimbus:wamsg:${id}`;

// id -> { message, at, retries, lastRetryAt, source }. A ordem de iteração do Map
// é a de inserção, então o primeiro `keys().next()` é sempre o mais antigo —
// evicção FIFO sem estrutura extra.
//
// `retries` é o contador de vezes que o Baileys veio buscar esta mensagem aqui. Ele
// só faz isso pra atender um retry receipt, ou seja: **cada incremento é a prova de
// que o aparelho do destinatário mostrou "Aguardando mensagem"**. É o único sinal
// que temos disso — o WhatsApp não avisa de outro jeito.
const store = new Map();

let _redis = null;
function redis() {
  if (_redis) return _redis;
  const IORedis = require("ioredis");
  _redis = new IORedis(process.env.REDIS_URL || "redis://localhost:6379", {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    retryStrategy: (times) => Math.min(times * 200, 3000),
  });
  _redis.on("error", () => { /* já logamos por operação; não derruba o worker */ });
  return _redis;
}

// O proto do Baileys tem Buffers dentro (media keys, principalmente): BufferJSON
// é o mesmo par replacer/reviver que auth/baileys-pg.js usa pra persistir chaves.
// Lazy pra este módulo seguir barato de carregar em teste.
function bufferJSON() {
  return require("@whiskeysockets/baileys").BufferJSON;
}

// Recebe o WebMessageInfo que o sock.sendMessage devolveu. Guarda o proto COMO
// VEIO: no caso de imagem, o reenvio reaproveita as media keys e não sobe o
// arquivo de novo. Nunca lança — um retorno inesperado do Baileys não pode
// derrubar um envio que já deu certo.
function put(sent) {
  const id = sent && sent.key && sent.key.id;
  const message = sent && sent.message;
  if (!id || !message) return;
  store.delete(id); // reinsere no fim: mantém a ordem FIFO honesta
  // `jid` não serve pro reenvio (o Baileys traz o dele no receipt) — é só pro
  // alerta poder dizer PARA ONDE a mensagem presa tinha ido. Fica só em memória:
  // o Redis guarda o proto puro, que é o que o getMessage precisa.
  store.set(String(id), {
    message,
    jid: (sent.key && sent.key.remoteJid) || null,
    at: Date.now(),
    retries: 0,
    lastRetryAt: null,
    source: null,
  });
  while (store.size > MAX) store.delete(store.keys().next().value);

  if (!USE_REDIS) return;
  // Fire-and-forget: a mensagem já foi entregue ao WhatsApp: um Redis fora do ar
  // não pode transformar um envio bem-sucedido em erro pro usuário.
  try {
    const payload = JSON.stringify(message, bufferJSON().replacer);
    redis().set(RKEY(id), payload, "EX", REDIS_TTL_S)
      .catch(err => console.error(`[wa] msg-store: falha ao gravar ${id} no Redis: ${err.message}`));
  } catch (err) {
    console.error(`[wa] msg-store: falha ao serializar ${id}: ${err.message}`);
  }
}

// Chamado SÓ pelo getMessage do socket, que só é chamado pra atender retry receipt.
// Por isso contamos aqui: quem lê é o reenvio. Expira na leitura — junto com o teto
// do put(), segura o tamanho sem varredura periódica (nada de timer segurando o
// processo vivo).
async function get(id) {
  if (!id) return undefined;
  const key = String(id);
  const entry = store.get(key);

  if (entry && (Date.now() - entry.at) <= TTL_MS) return hit(key, entry, entry.source || "memoria");
  if (entry) store.delete(key); // expirado em memória; o Redis ainda pode ter

  const fromRedis = await readRedis(key);
  if (fromRedis) {
    // Reidrata a memória pra um segundo retry do mesmo aparelho (é comum vir em
    // rajada) não voltar à rede.
    // Sem `jid`: o Redis guarda só o proto. O alerta sai com destino "—", que é
    // honesto — melhor que inventar um jid a partir da key do receipt, que pode
    // vir em LID enquanto gravamos PN.
    const revived = { message: fromRedis, jid: null, at: Date.now(), retries: 0, lastRetryAt: null, source: "redis" };
    store.set(key, revived);
    while (store.size > MAX) store.delete(store.keys().next().value);
    return hit(key, revived, "redis");
  }

  logRetry(key, entry ? "expirado" : "miss");
  return undefined;
}

function hit(key, entry, source) {
  entry.retries += 1;
  entry.lastRetryAt = Date.now();
  entry.source = source;
  logRetry(key, `hit #${entry.retries} (${source})`);
  maybeAlert(key, entry);
  return entry.message;
}

// Alguns reenvios são normais — sessão Signal nova com um contato, aparelho que
// ficou offline. O que NÃO é normal é a mesma mensagem voltar dezenas de vezes:
// isso é um grupo inteiro que não conseguiu abrir o que mandamos, e nada no
// sistema percebia — o envio já tinha sido registrado como "envio ok" e o
// problema só chegava por reclamação do usuário, dias depois.
//
// Dispara UMA vez por mensagem, ao cruzar o teto. Um alerta por aparelho seria
// exatamente a enxurrada que estamos tentando denunciar.
const ALERT_AT = Number(process.env.WA_RETRY_ALERT_AT) || 15;

function maybeAlert(id, entry) {
  if (entry.alerted || entry.retries < ALERT_AT) return;
  entry.alerted = true;
  // Lazy-require e fire-and-forget: isto roda no meio do atendimento de um retry
  // receipt do Baileys. Um notifier fora do ar não pode atrapalhar o reenvio.
  try {
    require("../notifications/admin-notifier")
      .notifyRetryStorm({ id, retries: entry.retries, jid: entry.jid || null })
      .catch((err) => console.error(`[wa] msg-store: alerta de reenvio falhou: ${err.message}`));
  } catch (err) {
    console.error(`[wa] msg-store: alerta de reenvio falhou: ${err.message}`);
  }
}

async function readRedis(key) {
  if (!USE_REDIS) return null;
  try {
    const raw = await redis().get(RKEY(key));
    return raw ? JSON.parse(raw, bufferJSON().reviver) : null;
  } catch (err) {
    console.error(`[wa] msg-store: falha ao ler ${key} do Redis: ${err.message}`);
    return null;
  }
}

// O que a rota de teste consulta pra saber se o aparelho pediu reenvio. `known:false`
// = o id caiu do teto/TTL e não estava no Redis, ou nunca passou por aqui, e aí
// não dá pra afirmar nada — a rota trata como "sem informação", não como sucesso.
function stats(id) {
  const entry = id ? store.get(String(id)) : null;
  if (!entry) return { known: false, retries: 0, lastRetryAt: null, source: null };
  return { known: true, retries: entry.retries, lastRetryAt: entry.lastRetryAt, source: entry.source };
}

// Uma linha por pedido de reenvio. Acontece só quando uma mensagem NOSSA falhou a
// decriptação no destinatário — volume desprezível, e é o sinal que faltava pra
// diagnosticar o placeholder eterno.
function logRetry(id, outcome) {
  if (process.env.WA_RETRY_DEBUG === "0") return;
  console.log(`[wa] retry pedido id=${id} ${outcome}`);
}

module.exports = {
  put,
  get,
  stats,
  MAX,
  TTL_MS,
  USE_REDIS,
  // Só pra teste.
  __clear: () => store.clear(),
  __size: () => store.size,
};
