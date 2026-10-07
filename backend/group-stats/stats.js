// Estatísticas da aba Grupos — o SQL e a montagem das duas respostas da API:
// a visão geral (todos os grupos de destino, filtráveis por campanha) e o
// detalhe de um grupo. As contas sem banco estão em calc.js.
//
// Tudo sai do banco (group_member_events, group_send_events,
// group_member_snapshots); nada vai ao WhatsApp. As colunas são TIMESTAMP sem
// fuso, em UTC: o dia e a hora de Brasília saem de
//   (("at" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo')
// — o primeiro AT TIME ZONE diz que o valor é UTC, o segundo converte pro
// relógio local. Um só faria o caminho inverso e erraria o dia em 6 horas.

const { prisma } = require("../db");
const { AppError } = require("../infra/httpErrors");
const { somaDias, diasEntre, validaFormato } = require("../affiliate-reports/comum");
const calc = require("./calc");

const MAX_DIAS = 180;
const JANELA_APOS_ENVIO_MS = 60 * 60 * 1000;
// Dias de registro diário que entram na previsão de lotação.
const DIAS_PREVISAO = 14;
// Saldo de eventos usado na previsão quando ainda não há registros diários.
const DIAS_SALDO_RECENTE = 7;

function capDe(grupo) {
  // Com a duplicação automática ligada, o grupo "lota" quando ela age.
  if (grupo.autoDuplicate) return require("../whatsapp/auto-duplicate").FULL_AT;
  return calc.WA_GROUP_MAX;
}

// Período pedido → { from, to } validado. `to` no futuro vira hoje; mais de
// MAX_DIAS é recusado (as consultas são por grupo e por dia, e a tela não oferece).
function periodoValido({ from, to } = {}, now = new Date()) {
  const erro = validaFormato(from, to);
  if (erro) throw new AppError(erro);
  const hoje = calc.hojeBR(now);
  const ate = to > hoje ? hoje : to;
  if (from > ate) throw new AppError("O período começa depois de hoje.");
  if (diasEntre(from, ate) + 1 > MAX_DIAS) throw new AppError(`Escolha um período de até ${MAX_DIAS} dias.`);
  return { from, to: ate, hoje };
}

// Os grupos de destino do usuário: jid → { jid, nome, numberId, membrosSalvos,
// autoDuplicate, campanhas }. `whatsappGroupIds` guarda o id do WhatsappGroup,
// que quase sempre é o próprio jid — o fallback por jid cobre o resto.
async function destinos(userId) {
  const [campanhas, wgs] = await Promise.all([
    prisma().group.findMany({ where: { userId }, select: { id: true, name: true, whatsappGroupIds: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
    prisma().whatsappGroup.findMany({ where: { userId }, select: { id: true, jid: true, name: true, numberId: true, metadata: true } }),
  ]);
  const porId = new Map(wgs.map(w => [String(w.id), w]));
  const porJid = new Map(wgs.map(w => [String(w.jid || w.id), w]));
  const grupos = new Map();
  const comDestino = [];
  for (const c of campanhas) {
    const campanha = { id: String(c.id), name: c.name };
    let tem = false;
    for (const ref of Array.isArray(c.whatsappGroupIds) ? c.whatsappGroupIds : []) {
      const w = porId.get(String(ref)) || porJid.get(String(ref));
      if (!w) continue;
      const jid = w.jid || w.id;
      tem = true;
      if (!grupos.has(jid)) {
        const meta = w.metadata || {};
        grupos.set(jid, {
          jid,
          nome: w.name,
          numberId: w.numberId,
          membrosSalvos: Number.isFinite(Number(meta.members)) ? Number(meta.members) : null,
          autoDuplicate: !!meta.autoDuplicate,
          campanhas: [],
        });
      }
      const g = grupos.get(jid);
      if (!g.campanhas.some(x => x.id === campanha.id)) g.campanhas.push(campanha);
    }
    if (tem) comDestino.push(campanha);
  }
  return { grupos, campanhas: comDestino };
}

// ────────────────────────────────────────────────────────────────────────
// Consultas
// ────────────────────────────────────────────────────────────────────────

// Primeiro dia com algum dado do usuário — antes dele a tela diz "sem coleta".
async function coletandoDesde(userId) {
  const [r] = await prisma().$queryRaw`
    SELECT to_char(LEAST(
             (SELECT MIN("day") FROM "group_member_snapshots" WHERE "userId" = ${userId}),
             (SELECT MIN((("at" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo')::date)
                FROM "group_member_events" WHERE "userId" = ${userId})
           ), 'YYYY-MM-DD') AS dia`;
  return r?.dia || null;
}

// Entradas (por origem) e saídas (saiu/removido) por dia e grupo.
async function eventosPorDia(userId, jids, desde, ate) {
  const rows = await prisma().$queryRaw`
    SELECT to_char((("at" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo'), 'YYYY-MM-DD') AS dia,
           "groupJid",
           COUNT(*) FILTER (WHERE "kind" = 'join_link')::int  AS link,
           COUNT(*) FILTER (WHERE "kind" = 'join_added')::int AS adicionados,
           COUNT(*) FILTER (WHERE "kind" = 'join_other')::int AS outras,
           COUNT(*) FILTER (WHERE "kind" = 'left')::int       AS saiu,
           COUNT(*) FILTER (WHERE "kind" = 'removed')::int    AS removidos
      FROM "group_member_events"
     WHERE "userId" = ${userId} AND "groupJid" = ANY(${jids})
       AND "at" >= ${desde} AND "at" < ${ate}
     GROUP BY 1, 2`;
  return rows.map(r => ({
    dia: r.dia, jid: r.groupJid,
    link: Number(r.link), adicionados: Number(r.adicionados), outras: Number(r.outras),
    saiu: Number(r.saiu), removidos: Number(r.removidos),
  }));
}

async function enviosPorDia(userId, jids, desde, ate) {
  const rows = await prisma().$queryRaw`
    SELECT to_char((("at" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo'), 'YYYY-MM-DD') AS dia,
           "groupJid", COUNT(*)::int AS envios
      FROM "group_send_events"
     WHERE "userId" = ${userId} AND "groupJid" = ANY(${jids})
       AND "at" >= ${desde} AND "at" < ${ate}
     GROUP BY 1, 2`;
  return rows.map(r => ({ dia: r.dia, jid: r.groupJid, envios: Number(r.envios) }));
}

// Registros diários de tamanho a partir de `desdeDia` (inclusive), em ordem.
async function registros(userId, jids, desdeDia) {
  const rows = await prisma().$queryRaw`
    SELECT to_char("day", 'YYYY-MM-DD') AS dia, "groupJid", "members"
      FROM "group_member_snapshots"
     WHERE "userId" = ${userId} AND "groupJid" = ANY(${jids})
       AND "day" >= ${desdeDia}::date
     ORDER BY "day" ASC`;
  return rows.map(r => ({ dia: r.dia, jid: r.groupJid, members: Number(r.members) }));
}

// O registro mais recente de cada grupo, de qualquer data.
async function ultimosRegistros(userId, jids) {
  const rows = await prisma().$queryRaw`
    SELECT DISTINCT ON ("groupJid") "groupJid", to_char("day", 'YYYY-MM-DD') AS dia, "members"
      FROM "group_member_snapshots"
     WHERE "userId" = ${userId} AND "groupJid" = ANY(${jids})
     ORDER BY "groupJid", "day" DESC`;
  return new Map(rows.map(r => [r.groupJid, { dia: r.dia, members: Number(r.members) }]));
}

// Entradas − saídas de cada grupo desde `desde` (pra previsão sem registros).
async function saldoRecente(userId, jids, desde) {
  const rows = await prisma().$queryRaw`
    SELECT "groupJid",
           (COUNT(*) FILTER (WHERE "kind" LIKE 'join%') - COUNT(*) FILTER (WHERE "kind" IN ('left', 'removed')))::int AS saldo
      FROM "group_member_events"
     WHERE "userId" = ${userId} AND "groupJid" = ANY(${jids}) AND "at" >= ${desde}
     GROUP BY 1`;
  return new Map(rows.map(r => [r.groupJid, Number(r.saldo)]));
}

// ────────────────────────────────────────────────────────────────────────
// Montagem
// ────────────────────────────────────────────────────────────────────────

// Membros, lotação e previsão de um grupo, a partir dos dados já consultados.
function lotacaoDe(g, { ultimo, serie, saldo, hoje, coletando }) {
  const membros = ultimo ? ultimo.members : g.membrosSalvos;
  const cap = capDe(g);
  // O saldo de eventos cobre só os dias desde o início da coleta.
  const diasSaldo = coletando ? Math.min(DIAS_SALDO_RECENTE, diasEntre(coletando, hoje) + 1) : 0;
  return {
    membros,
    membrosEm: ultimo ? ultimo.dia : null,
    ocupacao: membros != null ? Math.round((membros / calc.WA_GROUP_MAX) * 1000) / 1000 : null,
    enchendo: membros != null && membros >= calc.WA_GROUP_ENCHENDO,
    cap,
    previsao: calc.previsaoLotacao({
      serie: (serie || []).map(r => ({ date: r.dia, members: r.members })),
      eventos: diasSaldo > 0 ? { saldo: saldo || 0, dias: diasSaldo } : null,
      membros: membros ?? NaN,
      cap,
      hoje,
    }),
  };
}

function agrupaPor(linhas, chave) {
  const m = new Map();
  for (const l of linhas) {
    const k = chave(l);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(l);
  }
  return m;
}

async function overview(userId, query = {}, { now = new Date() } = {}) {
  const { from, to, hoje } = periodoValido(query, now);
  const { grupos, campanhas } = await destinos(userId);
  const campanha = query.campanha ? String(query.campanha) : null;
  const lista = [...grupos.values()].filter(g => !campanha || g.campanhas.some(c => c.id === campanha));
  const jids = lista.map(g => g.jid);
  const coletando = await coletandoDesde(userId);
  const base = {
    from, to, cap: calc.WA_GROUP_MAX, enchendoEm: calc.WA_GROUP_ENCHENDO, coletandoDesde: coletando,
    campanhas,
  };
  const vazioDia = { entradas: 0, saidas: 0, saldo: 0, envios: 0 };
  if (!jids.length) {
    return {
      ...base,
      totais: { grupos: 0, membros: 0, entradas: 0, saidas: 0, saldo: 0, envios: 0 },
      porDia: calc.preencheDias(from, to, new Map(), vazioDia, coletando),
      grupos: [],
    };
  }

  const { desde, ate } = calc.limitesBR(from, to);
  const [evs, envs, ultimos, serie, saldos] = await Promise.all([
    eventosPorDia(userId, jids, desde, ate),
    enviosPorDia(userId, jids, desde, ate),
    ultimosRegistros(userId, jids),
    registros(userId, jids, somaDias(hoje, -DIAS_PREVISAO)),
    saldoRecente(userId, jids, calc.limitesBR(somaDias(hoje, -(DIAS_SALDO_RECENTE - 1)), hoje).desde),
  ]);

  const porDia = new Map();
  const porGrupo = new Map(jids.map(j => [j, { entradas: 0, saidas: 0, envios: 0 }]));
  const soma = (dia, campos) => {
    const d = porDia.get(dia) || { ...vazioDia };
    for (const [k, v] of Object.entries(campos)) d[k] += v;
    d.saldo = d.entradas - d.saidas;
    porDia.set(dia, d);
  };
  for (const e of evs) {
    const entradas = e.link + e.adicionados + e.outras;
    const saidas = e.saiu + e.removidos;
    soma(e.dia, { entradas, saidas });
    const g = porGrupo.get(e.jid);
    g.entradas += entradas;
    g.saidas += saidas;
  }
  for (const e of envs) {
    soma(e.dia, { envios: e.envios });
    porGrupo.get(e.jid).envios += e.envios;
  }

  const seriePorGrupo = agrupaPor(serie, r => r.jid);
  const linhas = lista.map(g => {
    const c = porGrupo.get(g.jid);
    return {
      jid: g.jid,
      nome: g.nome,
      numberId: g.numberId,
      campanhas: g.campanhas,
      autoDuplicate: g.autoDuplicate,
      ...lotacaoDe(g, { ultimo: ultimos.get(g.jid), serie: seriePorGrupo.get(g.jid), saldo: saldos.get(g.jid), hoje, coletando }),
      entradas: c.entradas,
      saidas: c.saidas,
      saldo: c.entradas - c.saidas,
      envios: c.envios,
    };
  });

  const totais = { grupos: linhas.length, membros: 0, entradas: 0, saidas: 0, saldo: 0, envios: 0 };
  for (const l of linhas) {
    totais.membros += l.membros || 0;
    totais.entradas += l.entradas;
    totais.saidas += l.saidas;
    totais.envios += l.envios;
  }
  totais.saldo = totais.entradas - totais.saidas;

  return { ...base, totais, porDia: calc.preencheDias(from, to, porDia, vazioDia, coletando), grupos: linhas };
}

async function detalhe(userId, jid, query = {}, { now = new Date() } = {}) {
  const { from, to, hoje } = periodoValido(query, now);
  const { grupos } = await destinos(userId);
  const g = grupos.get(String(jid || ""));
  if (!g) throw new AppError("Grupo não encontrado entre os destinos das suas campanhas.", { status: 404 });
  const jids = [g.jid];
  const { desde, ate } = calc.limitesBR(from, to);

  const [coletando, evs, envs, ultimos, serie, saldos, noPeriodo, vida, envios, grade] = await Promise.all([
    coletandoDesde(userId),
    eventosPorDia(userId, jids, desde, ate),
    enviosPorDia(userId, jids, desde, ate),
    ultimosRegistros(userId, jids),
    registros(userId, jids, somaDias(hoje, -DIAS_PREVISAO)),
    saldoRecente(userId, jids, calc.limitesBR(somaDias(hoje, -(DIAS_SALDO_RECENTE - 1)), hoje).desde),
    registros(userId, jids, from),
    // Cada evento do período com o anterior e o seguinte da mesma pessoa. A janela
    // olha o histórico inteiro do grupo (a entrada pode ser de antes do período, e
    // a saída de quem entrou nele pode ser de depois); o filtro do período vem fora.
    prisma().$queryRaw`
      SELECT "kind", "at", "prevKind", "prevAt", "nextKind" FROM (
        SELECT "kind", "at",
               LAG("kind") OVER w AS "prevKind",
               LAG("at")   OVER w AS "prevAt",
               LEAD("kind") OVER w AS "nextKind"
          FROM "group_member_events"
         WHERE "userId" = ${userId} AND "groupJid" = ${g.jid}
        WINDOW w AS (PARTITION BY "participant" ORDER BY "at", "id")
      ) t
      WHERE "at" >= ${desde} AND "at" < ${ate}`,
    // A hora anterior ao período entra: um envio às 23h40 da véspera ainda pega
    // as saídas da meia-noite.
    prisma().$queryRaw`
      SELECT "at", "productName" FROM "group_send_events"
       WHERE "userId" = ${userId} AND "groupJid" = ${g.jid}
         AND "at" >= ${new Date(desde.getTime() - JANELA_APOS_ENVIO_MS)} AND "at" < ${ate}
       ORDER BY "at" ASC`,
    prisma().$queryRaw`
      SELECT EXTRACT(ISODOW FROM (("at" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo'))::int AS dow,
             EXTRACT(HOUR   FROM (("at" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo'))::int AS hora,
             COUNT(*) FILTER (WHERE "kind" LIKE 'join%')::int AS entradas,
             COUNT(*) FILTER (WHERE "kind" = 'left')::int AS saidas
        FROM "group_member_events"
       WHERE "userId" = ${userId} AND "groupJid" = ${g.jid}
         AND "at" >= ${desde} AND "at" < ${ate}
       GROUP BY 1, 2`,
  ]);

  const vazioDia = { entradas: 0, entradasLink: 0, entradasAdicionados: 0, entradasOutras: 0, saidas: 0, saiu: 0, removidos: 0, saldo: 0, envios: 0, membros: null };
  const porDia = new Map();
  const dia = (d) => { if (!porDia.has(d)) porDia.set(d, { ...vazioDia }); return porDia.get(d); };
  const origem = { entradas: { link: 0, adicionado: 0, outro: 0 }, saidas: { saiu: 0, removido: 0 } };
  for (const e of evs) {
    const d = dia(e.dia);
    d.entradasLink = e.link;
    d.entradasAdicionados = e.adicionados;
    d.entradasOutras = e.outras;
    d.entradas = e.link + e.adicionados + e.outras;
    d.saiu = e.saiu;
    d.removidos = e.removidos;
    d.saidas = e.saiu + e.removidos;
    d.saldo = d.entradas - d.saidas;
    origem.entradas.link += e.link;
    origem.entradas.adicionado += e.adicionados;
    origem.entradas.outro += e.outras;
    origem.saidas.saiu += e.saiu;
    origem.saidas.removido += e.removidos;
  }
  for (const e of envs) dia(e.dia).envios = e.envios;
  for (const r of noPeriodo) dia(r.dia).membros = r.members;

  const linhasVida = vida.map(r => ({ kind: r.kind, at: r.at, prevKind: r.prevKind, prevAt: r.prevAt, nextKind: r.nextKind }));
  const lotacao = lotacaoDe(g, { ultimo: ultimos.get(g.jid), serie, saldo: saldos.get(g.jid), hoje, coletando });

  return {
    from, to, cap: calc.WA_GROUP_MAX, enchendoEm: calc.WA_GROUP_ENCHENDO, coletandoDesde: coletando,
    grupo: {
      jid: g.jid, nome: g.nome, numberId: g.numberId, campanhas: g.campanhas, autoDuplicate: g.autoDuplicate,
      membros: lotacao.membros, membrosEm: lotacao.membrosEm, ocupacao: lotacao.ocupacao, enchendo: lotacao.enchendo,
    },
    porDia: calc.preencheDias(from, to, porDia, vazioDia, coletando),
    origem,
    permanencia: calc.resumoPermanencia(linhasVida),
    aposEnvio: calc.saidasAposEnvio(
      envios.map(e => ({ at: e.at, produto: e.productName })),
      linhasVida.filter(l => l.kind === "left").map(l => ({ at: l.at })),
      { janelaMs: JANELA_APOS_ENVIO_MS, desde, ate, now },
    ),
    horarios: calc.gradeHorarios(grade),
    lotacao,
  };
}

module.exports = { overview, detalhe, destinos, periodoValido, MAX_DIAS };
