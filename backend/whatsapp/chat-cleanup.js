// Limpeza automática das conversas de grupo (task 13).
//
// Grupo de oferta recebe mensagem e mídia o dia inteiro e o WhatsApp do celular
// fica pesado. Por número, o usuário marca os grupos e a frequência, e este job
// manda o "Limpar conversa" (whatsapp/local.js clearGroupChats) quando vence.
//
// Roda no processo do server, como o auto-duplicate: a limpeza em si passa pela
// fachada `whatsapp` (no modo redis, RPC para o worker, dono das sessões). A
// configuração mora em whatsapp_chat_cleanup — tabela própria porque
// whatsapp_numbers é regravada inteira a cada PUT /api/state.
const { prisma } = require("../db");

const INTERVAL_MS = Number(process.env.CHAT_CLEANUP_INTERVAL_MS) || 10 * 60 * 1000;
// As opções do popup: 6h, 12h, 24h, 3 dias, 7 dias.
const INTERVALS = [6, 12, 24, 72, 168];
const MAX_JIDS = 200;

function getWa() { return require("./index"); }

function toDto(row) {
  return {
    numberId: row.numberId,
    enabled: !!row.enabled,
    intervalHours: row.intervalHours,
    jids: Array.isArray(row.jids) ? row.jids : [],
    lastRunAt: row.lastRunAt ? row.lastRunAt.toISOString() : null,
    lastResult: row.lastResult || null,
  };
}

async function list(userId) {
  const rows = await prisma().whatsappChatCleanup.findMany({ where: { userId: String(userId) } });
  return rows.map(toDto);
}

// Devolve { error } com a mensagem pro usuário, ou { config } normalizada.
function validate(body) {
  const b = body || {};
  const intervalHours = Number(b.intervalHours);
  if (!INTERVALS.includes(intervalHours)) {
    return { error: `Frequência inválida. Opções: ${INTERVALS.join(", ")} horas.` };
  }
  if (!Array.isArray(b.jids)) return { error: "jids obrigatório (lista de grupos)." };
  if (b.jids.some(j => typeof j !== "string" || !/@g\.us$/.test(j))) {
    return { error: "Só grupos podem ser limpos (jid terminado em @g.us)." };
  }
  const jids = [...new Set(b.jids)];
  if (jids.length > MAX_JIDS) return { error: `No máximo ${MAX_JIDS} grupos por número.` };
  return { config: { enabled: !!b.enabled, intervalHours, jids } };
}

async function save(userId, numberId, config) {
  const where = { userId_numberId: { userId: String(userId), numberId: String(numberId) } };
  const row = await prisma().whatsappChatCleanup.upsert({
    where,
    create: { userId: String(userId), numberId: String(numberId), ...config },
    update: config,
  });
  return toDto(row);
}

function summarize(results) {
  const r = Array.isArray(results) ? results : [];
  return {
    at: new Date().toISOString(),
    cleared: r.filter(x => x.status === "cleared").length,
    skipped: r.filter(x => x.status === "skipped").length,
    errors: r.filter(x => x.status === "error").length,
    items: r.slice(0, 500),
  };
}

// Roda a limpeza dos grupos marcados agora. Sessão fora do ar lança (vem do
// ensureConnected do worker) e NÃO avança lastRunAt — o tick tenta de novo.
async function run(userId, numberId) {
  const row = await prisma().whatsappChatCleanup.findUnique({
    where: { userId_numberId: { userId: String(userId), numberId: String(numberId) } },
  });
  const jids = row && Array.isArray(row.jids) ? row.jids : [];
  if (!row || !jids.length) return { ran: false, reason: "sem_grupos" };
  const results = await getWa().clearGroupChats(String(userId), String(numberId), jids);
  const lastResult = summarize(results);
  const updated = await prisma().whatsappChatCleanup.update({
    where: { id: row.id },
    data: { lastRunAt: new Date(), lastResult },
  });
  return { ran: true, ...toDto(updated) };
}

function isDue(row, now = Date.now()) {
  if (!row.enabled) return false;
  if (!Array.isArray(row.jids) || !row.jids.length) return false;
  if (!row.lastRunAt) return true;
  return new Date(row.lastRunAt).getTime() + row.intervalHours * 3600 * 1000 <= now;
}

// Números já avisados como fora do ar neste processo.
const _offlineLogged = new Set();

let _running = false;
async function tick(now = Date.now()) {
  if (_running) return;
  _running = true;
  try {
    const rows = await prisma().whatsappChatCleanup.findMany({ where: { enabled: true } });
    for (const row of rows) {
      if (!isDue(row, now)) continue;
      try {
        const r = await run(row.userId, row.numberId);
        _offlineLogged.delete(`${row.userId}::${row.numberId}`);
        if (r.ran) {
          console.log(`[chat-cleanup] ${row.userId}/${row.numberId}: ${r.lastResult.cleared} limpos, ${r.lastResult.skipped} pulados, ${r.lastResult.errors} erros`);
        }
      } catch (err) {
        // Número desconectado é o caso comum: fica para o próximo ciclo. A
        // configuração sobrevive ao "Desconectar" (mesma rota do "Remover"), então
        // um número parado repetiria o aviso a cada ciclo — loga uma vez só.
        const k = `${row.userId}::${row.numberId}`;
        const offline = /não está conectada|não encontrada/i.test(String(err?.message || ""));
        if (!offline || !_offlineLogged.has(k)) console.error(`[chat-cleanup] ${row.userId}/${row.numberId}: ${err.message}`);
        if (offline) _offlineLogged.add(k);
      }
    }
  } catch (err) {
    console.error("[chat-cleanup] tick:", err.message);
  } finally {
    _running = false;
  }
}

let _timer = null;
function start() {
  if (_timer) return;
  _timer = setInterval(tick, INTERVAL_MS);
  if (_timer.unref) _timer.unref();
  setTimeout(tick, 90 * 1000).unref?.();
}

module.exports = { start, tick, list, validate, save, run, isDue, INTERVALS, MAX_JIDS };
