// Resumo do log de repasse — a visão que faltava pra enxergar PROBLEMA em vez de
// caso isolado. Dez descartes seguidos do mesmo link apareciam como dez linhas
// parecidas; aqui viram "Mercado Livre: 0% de aprovação, nenhum link desde 14h03".
//
// Fica fora do server.js pra poder ser testado sem HTTP, no mesmo espírito do
// catalog.getStats().

const { ERROR_KINDS } = require("./error-kinds");

// Os dois resultados que significam "o link virou produto". `cooldown` e
// `duplicate` não contam como falha nem como sucesso: o produto até era bom, só
// não era hora de mandar de novo — por isso ficam fora do denominador da taxa.
const OK_OUTCOMES = ["queued", "pending"];
const NEUTRAL_OUTCOMES = ["cooldown", "duplicate"];

const MIN_HOURS = 1;
const MAX_HOURS = 24 * 7;

function clampHours(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return 24;
  return Math.min(MAX_HOURS, Math.max(MIN_HOURS, n));
}

async function buildSummary(prisma, { hours, where = {} } = {}) {
  const h = clampHours(hours);
  const since = new Date(Date.now() - h * 60 * 60 * 1000);
  const baseWhere = { ...where, createdAt: { gte: since } };

  const [byOutcomeRaw, byKindRaw, byStoreOutcomeRaw, lastOkRaw, hourRows] = await Promise.all([
    prisma().repasseCaptureLog.groupBy({ by: ["outcome"], where: baseWhere, _count: { _all: true } }),
    prisma().repasseCaptureLog.groupBy({
      by: ["errorKind"],
      where: { ...baseWhere, errorKind: { not: null } },
      _count: { _all: true },
      _max: { createdAt: true },
    }),
    prisma().repasseCaptureLog.groupBy({ by: ["store", "outcome"], where: baseWhere, _count: { _all: true } }),
    // `lastOkAt` NÃO é limitado pela janela: a pergunta que ele responde é "desde
    // quando parou", e a resposta pode estar antes do início da janela. Sem isso,
    // uma loja parada há 3 dias mostraria "nunca funcionou", que é outra coisa.
    prisma().repasseCaptureLog.groupBy({
      by: ["store"],
      where: { ...where, outcome: { in: OK_OUTCOMES } },
      _max: { createdAt: true },
    }),
    hourlySeries(prisma, since, where),
  ]);

  const byOutcome = {};
  let total = 0;
  for (const r of byOutcomeRaw) {
    byOutcome[r.outcome] = r._count._all;
    total += r._count._all;
  }

  const byErrorKind = byKindRaw
    .map(r => ({ kind: r.errorKind, count: r._count._all, lastAt: r._max.createdAt }))
    .sort((a, b) => b.count - a.count);

  // Motivo dominante por loja, pra a faixa de alerta poder dizer a causa.
  const kindByStore = await topKindPerStore(prisma, baseWhere);
  const lastOkByStore = new Map(lastOkRaw.map(r => [r.store, r._max.createdAt]));

  const storeAgg = new Map();
  for (const r of byStoreOutcomeRaw) {
    const key = r.store || "desconhecida";
    const acc = storeAgg.get(key) || { store: key, total: 0, ok: 0, discarded: 0, neutral: 0 };
    acc.total += r._count._all;
    if (OK_OUTCOMES.includes(r.outcome)) acc.ok += r._count._all;
    else if (NEUTRAL_OUTCOMES.includes(r.outcome)) acc.neutral += r._count._all;
    else acc.discarded += r._count._all;
    storeAgg.set(key, acc);
  }

  const byStore = [];
  for (const acc of storeAgg.values()) {
    const denom = acc.ok + acc.discarded;
    const lastOkAt = lastOkByStore.get(acc.store === "desconhecida" ? null : acc.store) || null;
    byStore.push({
      store: acc.store,
      total: acc.total,
      ok: acc.ok,
      discarded: acc.discarded,
      // null (e não 0) quando não houve nenhuma tentativa que contasse: 0% de zero
      // tentativas seria um alarme falso.
      successRate: denom ? Math.round((acc.ok / denom) * 100) : null,
      lastOkAt: lastOkAt ? new Date(lastOkAt).toISOString() : null,
      failuresSinceLastOk: await failuresSince(prisma, where, acc.store, lastOkAt),
      topErrorKind: kindByStore.get(acc.store) || null,
    });
  }
  byStore.sort((a, b) => b.total - a.total);

  return {
    hours: h,
    since: since.toISOString(),
    total,
    byOutcome,
    byErrorKind,
    byStore,
    byHour: hourRows,
    // O catálogo viaja junto pra a UI nunca ficar dessincronizada da lista fechada
    // do backend (são ~9 entradas — o custo é irrelevante).
    kinds: ERROR_KINDS,
  };
}

// Quantos descartes se acumularam desde o último sucesso daquela loja. É esse
// número, junto do `lastOkAt`, que transforma "0% de aprovação" em "0% desde as
// 14h03, 90 tentativas seguidas" — a diferença entre um número e um diagnóstico.
async function failuresSince(prisma, where, store, lastOkAt) {
  const storeFilter = store === "desconhecida" ? null : store;
  return prisma().repasseCaptureLog.count({
    where: {
      ...where,
      store: storeFilter,
      outcome: "discarded",
      ...(lastOkAt ? { createdAt: { gt: lastOkAt } } : {}),
    },
  });
}

async function topKindPerStore(prisma, baseWhere) {
  const rows = await prisma().repasseCaptureLog.groupBy({
    by: ["store", "errorKind"],
    where: { ...baseWhere, errorKind: { not: null } },
    _count: { _all: true },
  });
  const best = new Map();
  for (const r of rows) {
    const key = r.store || "desconhecida";
    const cur = best.get(key);
    if (!cur || r._count._all > cur.count) best.set(key, { kind: r.errorKind, count: r._count._all });
  }
  return new Map([...best].map(([k, v]) => [k, v.kind]));
}

// Série por hora. Precisa de SQL cru porque o groupBy do Prisma não trunca data —
// é o mesmo recurso que coupons/pg.js já usa. Os filtros entram por parâmetro
// (nunca por concatenação), com o mesmo truque de "NULL = sem filtro" em cada um.
async function hourlySeries(prisma, since, where) {
  const store = where.store || null;
  const userId = where.userId || null;
  const groupId = where.groupId != null ? BigInt(where.groupId) : null;
  const rows = await prisma().$queryRaw`
    SELECT date_trunc('hour', "createdAt") AS hour,
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE "outcome" IN ('queued', 'pending'))::int AS ok,
           COUNT(*) FILTER (WHERE "outcome" = 'discarded')::int AS discarded
      FROM "repasse_capture_log"
     WHERE "createdAt" >= ${since}
       AND (${store}::text IS NULL OR "store" = ${store})
       AND (${userId}::text IS NULL OR "userId" = ${userId})
       AND (${groupId}::bigint IS NULL OR "groupId" = ${groupId})
     GROUP BY 1
     ORDER BY 1 ASC
  `;
  return rows.map(r => ({
    hour: new Date(r.hour).toISOString(),
    total: Number(r.total),
    ok: Number(r.ok),
    discarded: Number(r.discarded),
  }));
}

module.exports = { buildSummary, clampHours, OK_OUTCOMES, NEUTRAL_OUTCOMES };
