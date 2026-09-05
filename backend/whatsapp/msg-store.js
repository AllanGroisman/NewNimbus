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
// Escopo de propósito curto: a janela real de retry é de segundos a poucos minutos
// (maxMsgRetryCount do Baileys é 5). Fica só em memória, no mesmo processo do
// socket que recebe o receipt — um restart do worker perde os pendentes daquele
// instante, e esse é o trade-off aceito em troca de zero infra nova.
//
// Chaveado pelo `id` puro, não por `jid:id`: o receipt monta a key a partir do que
// o WhatsApp devolveu, e o remoteJid de lá pode vir na forma LID enquanto gravamos
// a forma PN (@s.whatsapp.net). Casar por jid perderia justo os casos que
// interessam; id de mensagem do WhatsApp já é único.

const MAX = Number(process.env.WA_MSG_STORE_MAX) || 1000;
const TTL_MS = Number(process.env.WA_MSG_STORE_TTL_MS) || 60 * 60 * 1000; // 1h

// id -> { message, at, retries, lastRetryAt }. A ordem de iteração do Map é a de
// inserção, então o primeiro `keys().next()` é sempre o mais antigo — evicção FIFO
// sem estrutura extra.
//
// `retries` é o contador de vezes que o Baileys veio buscar esta mensagem aqui. Ele
// só faz isso pra atender um retry receipt, ou seja: **cada incremento é a prova de
// que o aparelho do destinatário mostrou "Aguardando mensagem"**. É o único sinal
// que temos disso — o WhatsApp não avisa de outro jeito.
const store = new Map();

// Recebe o WebMessageInfo que o sock.sendMessage devolveu. Guarda o proto COMO
// VEIO: no caso de imagem, o reenvio reaproveita as media keys e não sobe o
// arquivo de novo. Nunca lança — um retorno inesperado do Baileys não pode
// derrubar um envio que já deu certo.
function put(sent) {
  const id = sent && sent.key && sent.key.id;
  const message = sent && sent.message;
  if (!id || !message) return;
  store.delete(id); // reinsere no fim: mantém a ordem FIFO honesta
  store.set(String(id), { message, at: Date.now(), retries: 0, lastRetryAt: null });
  while (store.size > MAX) store.delete(store.keys().next().value);
}

// Chamado SÓ pelo getMessage do socket, que só é chamado pra atender retry receipt.
// Por isso contamos aqui: quem lê é o reenvio. Expira na leitura — junto com o teto
// do put(), segura o tamanho sem varredura periódica (nada de timer segurando o
// processo vivo).
function get(id) {
  if (!id) return undefined;
  const entry = store.get(String(id));
  if (!entry) {
    logRetry(id, "miss");
    return undefined;
  }
  if (Date.now() - entry.at > TTL_MS) {
    store.delete(String(id));
    logRetry(id, "expirado");
    return undefined;
  }
  entry.retries += 1;
  entry.lastRetryAt = Date.now();
  logRetry(id, `hit #${entry.retries}`);
  return entry.message;
}

// O que a rota de teste consulta pra saber se o aparelho pediu reenvio. `known:false`
// = o id caiu do teto/TTL ou nunca passou por este processo (worker reiniciado), e aí
// não dá pra afirmar nada — a rota trata como "sem informação", não como sucesso.
function stats(id) {
  const entry = id ? store.get(String(id)) : null;
  if (!entry) return { known: false, retries: 0, lastRetryAt: null };
  return { known: true, retries: entry.retries, lastRetryAt: entry.lastRetryAt };
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
  // Só pra teste.
  __clear: () => store.clear(),
  __size: () => store.size,
};
