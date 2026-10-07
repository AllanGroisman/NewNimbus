// Registro diário do tamanho dos grupos de destino (aba Grupos) e a limpeza do
// histórico antigo.
//
// O número de membros é a verdade que os eventos de entrada/saída não garantem:
// número desconectado por muito tempo perde aviso. A cada passada, o valor atual
// de cada grupo que recebe campanha sobrescreve o do dia (dia de Brasília) — a
// linha fica com o último valor visto. É dessa série que sai a previsão de lotação.
//
// Roda no processo do server, como o auto-duplicate: o tamanho vem pela fachada
// `whatsapp` (no modo redis, RPC pro worker), uma chamada por número conectado, e
// lido do cache de metadata do socket (local.js groupSizes). Conta sem assinatura
// ativa fica de fora — é chamada ao WhatsApp, e o envio dela já está parado.

const { prisma } = require("../db");
const { hojeBR } = require("./calc");

const INTERVAL_MS = Number(process.env.GROUP_STATS_SNAPSHOT_MS) || 30 * 60 * 1000;
const DIA_MS = 24 * 60 * 60 * 1000;
// Quanto tempo cada tabela guarda. Os eventos de membro ficam mais: a permanência
// pareia a saída de hoje com a entrada de meses atrás.
const RETENCAO = {
  eventos: (Number(process.env.GROUP_STATS_EVENTS_DAYS) || 365) * DIA_MS,
  envios: (Number(process.env.GROUP_STATS_SENDS_DAYS) || 180) * DIA_MS,
  registros: (Number(process.env.GROUP_STATS_SNAPSHOTS_DAYS) || 730) * DIA_MS,
};

function getWa() { return require("../whatsapp"); }

// Admin sempre passa; o resto, só com assinatura ativa — o mesmo gate do scheduler.
async function contaAtiva(userId) {
  const auth = require("../auth");
  const billing = require("../billing");
  const user = await auth.findById(userId);
  const sub = await billing.getByUserId(userId);
  return billing.isActive(sub, user?.role);
}

// Grupos que recebem alguma campanha, agrupados por sessão: "userId::numberId" → [jid].
async function destinosPorSessao() {
  // `whatsappGroupIds` guarda o id do WhatsappGroup (quase sempre o próprio jid).
  const rows = await prisma().$queryRaw`
    SELECT wg."userId", wg."numberId", wg."jid"
      FROM "whatsapp_groups" wg
     WHERE EXISTS (SELECT 1 FROM "groups" g
                    WHERE g."userId" = wg."userId"
                      AND (g."whatsappGroupIds" @> jsonb_build_array(wg."id")
                           OR g."whatsappGroupIds" @> jsonb_build_array(wg."jid")))`;
  const out = new Map();
  for (const r of rows) {
    if (!r.jid || !r.numberId) continue;
    const k = `${r.userId}::${r.numberId}`;
    if (!out.has(k)) out.set(k, { userId: r.userId, numberId: r.numberId, jids: [] });
    const s = out.get(k);
    if (!s.jids.includes(r.jid)) s.jids.push(r.jid);
  }
  return [...out.values()];
}

async function gravar(userId, tamanhos, hoje) {
  const day = new Date(`${hoje}T00:00:00Z`);
  for (const t of tamanhos) {
    if (!t?.jid || !Number.isFinite(t.members)) continue;
    await prisma().groupMemberSnapshot.upsert({
      where: { userId_groupJid_day: { userId, groupJid: t.jid, day } },
      create: { userId, groupJid: t.jid, day, members: t.members },
      update: { members: t.members },
    });
  }
}

async function purgarAntigos(now = new Date()) {
  const t = now.getTime();
  const [eventos, envios, registros] = await Promise.all([
    prisma().groupMemberEvent.deleteMany({ where: { at: { lt: new Date(t - RETENCAO.eventos) } } }),
    prisma().groupSendEvent.deleteMany({ where: { at: { lt: new Date(t - RETENCAO.envios) } } }),
    prisma().groupMemberSnapshot.deleteMany({ where: { day: { lt: new Date(t - RETENCAO.registros) } } }),
  ]);
  const total = eventos.count + envios.count + registros.count;
  if (total) console.log(`[group-stats] limpeza: ${eventos.count} evento(s), ${envios.count} envio(s), ${registros.count} registro(s) antigos`);
  return { eventos: eventos.count, envios: envios.count, registros: registros.count };
}

let _running = false;
let _ultimaLimpeza = null;

// `wa` e `ativa` injetáveis pros testes. Devolve quantos grupos registrou.
async function tick({ wa = getWa(), ativa = contaAtiva, now = new Date() } = {}) {
  if (_running) return 0;
  _running = true;
  let gravados = 0;
  try {
    const hoje = hojeBR(now);
    const contas = new Map(); // userId → ativa? (uma consulta por usuário por passada)
    for (const s of await destinosPorSessao()) {
      try {
        if (!contas.has(s.userId)) contas.set(s.userId, await ativa(s.userId).catch(() => false));
        if (!contas.get(s.userId)) continue;
        const sessao = await wa.getSession(s.userId, s.numberId);
        if (sessao?.status !== "connected") continue;
        const tamanhos = await wa.groupSizes(s.userId, s.numberId, s.jids);
        await gravar(s.userId, tamanhos || [], hoje);
        gravados += (tamanhos || []).length;
      } catch (err) {
        console.error(`[group-stats] registro ${s.userId}/${s.numberId}: ${err.message}`);
      }
    }
    if (_ultimaLimpeza !== hoje) {
      _ultimaLimpeza = hoje;
      await purgarAntigos(now);
    }
  } catch (err) {
    console.error("[group-stats] tick:", err.message);
  } finally {
    _running = false;
  }
  return gravados;
}

let _timer = null;
function start() {
  if (_timer) return;
  _timer = setInterval(() => { tick(); }, INTERVAL_MS);
  if (_timer.unref) _timer.unref();
  setTimeout(() => { tick(); }, 2 * 60 * 1000).unref?.();
}

function stop() {
  if (_timer) clearInterval(_timer);
  _timer = null;
}

module.exports = { start, stop, tick, purgarAntigos, destinosPorSessao };
