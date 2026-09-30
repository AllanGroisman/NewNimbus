// Progresso de cada grupo de um disparo no privado (task 6). O cartão do grupo,
// na aba Grupos, mostra só a parte dele: quantos já receberam e em que fase está.
//
// fase: preparing — o disparo ainda está montando a lista;
//       queued    — um disparo mais antigo (de qualquer campanha) ainda tem gente
//                   para receber pelo mesmo número, e vai antes;
//       waiting   — o número está esperando (teto diário, desconectado);
//       sending   — enviando, uma mensagem a cada 20–45s;
//       finished  — ninguém mais para receber, ou o disparo acabou.
const { prisma } = require("../db");
const runner = require("./runner");

const lista = (v) => (Array.isArray(v) ? v : []).map(String);

// `broadcasts`: linhas de dm_broadcasts; `whatsappGroups`: os do estado do
// usuário, para achar o jid (os destinatários guardam o grupo pelo jid).
// Devolve cada disparo com `grupos: [{ whatsappGroupId, numberId, total, sent,
// failed, canceled, pending, fase, nextAt, motivo }]`.
async function comPartes(userId, broadcasts, whatsappGroups) {
  if (!broadcasts.length) return [];
  const porId = new Map((whatsappGroups || []).map(w => [String(w.id), w]));
  const [contagens, vezes] = await Promise.all([
    prisma().dmBroadcastRecipient.groupBy({
      by: ["broadcastId", "groupJid", "numberId", "status"],
      where: { broadcastId: { in: broadcasts.map(b => b.id) } },
      _count: { _all: true },
    }),
    // Em cada número, o disparo mais antigo com gente para receber é o que está
    // enviando; os outros daquele número estão na fila.
    prisma().dmBroadcastRecipient.groupBy({
      by: ["numberId"],
      where: { status: "pending", broadcast: { userId, status: "running" } },
      _min: { broadcastId: true },
    }),
  ]);
  const daVez = new Map(vezes.map(v => [v.numberId, v._min.broadcastId]));

  return broadcasts.map(b => ({
    ...b,
    grupos: lista(b.whatsappGroupIds).map(gid => {
      const w = porId.get(gid);
      const jid = String(w?.jid || gid);
      const p = {
        whatsappGroupId: gid, numberId: w?.numberId != null ? String(w.numberId) : null,
        total: 0, sent: 0, failed: 0, canceled: 0, pending: 0,
        fase: "finished", nextAt: null, motivo: null,
      };
      for (const c of contagens) {
        if (c.broadcastId !== b.id || c.groupJid !== jid || !(c.status in p)) continue;
        p[c.status] += c._count._all;
        p.total += c._count._all;
        p.numberId = c.numberId;
      }
      if (b.status === "preparing") {
        p.fase = "preparing";
      } else if (b.status === "running" && p.pending > 0) {
        const vez = daVez.get(p.numberId);
        const espera = runner.estadoNumero(b.userId, p.numberId);
        if (vez != null && vez < b.id) p.fase = "queued";
        else if (espera) Object.assign(p, { fase: "waiting", nextAt: espera.nextAt, motivo: espera.motivo });
        else p.fase = "sending";
      }
      return p;
    }),
  }));
}

// Os grupos (whatsappGroupId) com uma parte ainda andando, em qualquer campanha
// do usuário: a mesma pessoa não pode receber dois disparos ao mesmo tempo sem
// querer.
async function gruposOcupados(userId, whatsappGroups) {
  const ativos = await prisma().dmBroadcast.findMany({ where: { userId, status: { in: runner.ATIVOS } } });
  const partes = await comPartes(userId, ativos, whatsappGroups);
  return new Set(partes.flatMap(b => b.grupos.filter(p => p.fase !== "finished").map(p => p.whatsappGroupId)));
}

module.exports = { comPartes, gruposOcupados };
