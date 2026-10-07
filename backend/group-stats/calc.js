// Contas puras da aba Grupos: período em horário de Brasília, previsão de
// lotação, permanência, saídas após envio e mapa de horários. Sem banco, pra
// serem testadas com números na mão — o SQL fica em stats.js.

const { somaDias, diasEntre } = require("../affiliate-reports/comum");

const TZ_BR = "America/Sao_Paulo";
// O Brasil não tem horário de verão desde 2019: o fuso fixo serve pros limites do
// período. O agrupamento por dia/hora no SQL usa o nome do fuso (stats.js).
const OFFSET_BR = "-03:00";
const HORA_MS = 60 * 60 * 1000;

// O teto do WhatsApp por grupo, e a partir de quando a tela avisa que está
// enchendo (o mesmo 900 do cartão do grupo na campanha).
const WA_GROUP_MAX = 1024;
const WA_GROUP_ENCHENDO = 900;

function hojeBR(now = new Date()) {
  // en-CA formata como AAAA-MM-DD.
  return now.toLocaleDateString("en-CA", { timeZone: TZ_BR });
}

// Dias inclusivos "AAAA-MM-DD" → instantes UTC [desde, ate).
function limitesBR(from, to) {
  return {
    desde: new Date(`${from}T00:00:00${OFFSET_BR}`),
    ate: new Date(`${somaDias(to, 1)}T00:00:00${OFFSET_BR}`),
  };
}

function diasDoPeriodo(from, to) {
  const out = [];
  for (let d = from; d <= to; d = somaDias(d, 1)) out.push(d);
  return out;
}

// Um item por dia do período, com os valores de `porDia` (Map dia → objeto) ou
// os zeros de `vazio`. Dia antes de `coletandoDesde` vira { date, semDados: true }:
// "não havia coleta" é outra coisa que "ninguém entrou", e a tela mostra diferente.
// Sem `coletandoDesde` (nada coletado ainda), todo dia é sem dado.
function preencheDias(from, to, porDia, vazio, coletandoDesde) {
  return diasDoPeriodo(from, to).map(date => {
    if (!coletandoDesde || date < coletandoDesde) return { date, semDados: true };
    return { date, ...vazio, ...(porDia.get(date) || {}) };
  });
}

function mediana(valores) {
  if (!valores.length) return null;
  const v = [...valores].sort((a, b) => a - b);
  const meio = Math.floor(v.length / 2);
  return v.length % 2 ? v[meio] : (v[meio - 1] + v[meio]) / 2;
}

const umaCasa = (n) => Math.round(n * 10) / 10;

// Ritmo de crescimento (membros/dia) pela reta dos mínimos quadrados sobre os
// registros diários. Precisa de pelo menos 4 dias espalhados por 3 ou mais, senão
// um dia atípico vira tendência.
function ritmoDosRegistros(serie) {
  const validos = (serie || []).filter(p => p && p.date && Number.isFinite(p.members));
  if (validos.length < 4) return null;
  const pontos = validos.map(p => ({ x: diasEntre(validos[0].date, p.date), y: p.members }));
  const xs = pontos.map(p => p.x);
  if (Math.max(...xs) - Math.min(...xs) < 3) return null;
  const n = pontos.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = pontos.reduce((a, p) => a + p.y, 0) / n;
  let num = 0, den = 0;
  for (const p of pontos) { num += (p.x - mx) * (p.y - my); den += (p.x - mx) ** 2; }
  return den ? num / den : null;
}

// Quando o grupo lota no ritmo atual.
//   serie:   [{ date, members }] dos últimos ~14 dias, em ordem
//   eventos: { saldo, dias } — entradas − saídas recentes, pro grupo que ainda
//            não tem registros diários suficientes
//   cap:     1.024, ou o gatilho da duplicação automática quando ela está ligada
// Devolve { ritmoDia, diasParaLotar, dataPrevista, base, motivo } ou null sem dado.
// `motivo`: "cheio" | "estavel" | "caindo" | "mais-de-um-ano" | null (há previsão)
function previsaoLotacao({ serie, eventos, membros, cap = WA_GROUP_MAX, hoje }) {
  if (!Number.isFinite(membros)) return null;
  if (membros >= cap) return { ritmoDia: null, diasParaLotar: 0, dataPrevista: hoje, base: null, motivo: "cheio" };

  let ritmo = ritmoDosRegistros(serie);
  let base = "registros";
  if (ritmo == null && eventos && eventos.dias > 0) {
    ritmo = eventos.saldo / eventos.dias;
    base = "eventos";
  }
  if (ritmo == null) return null;

  const ritmoDia = umaCasa(ritmo);
  // Menos de ~2 pessoas por semana é ruído, não tendência.
  if (Math.abs(ritmo) <= 0.3) return { ritmoDia, diasParaLotar: null, dataPrevista: null, base, motivo: "estavel" };
  if (ritmo < 0) return { ritmoDia, diasParaLotar: null, dataPrevista: null, base, motivo: "caindo" };
  const dias = Math.ceil((cap - membros) / ritmo);
  if (dias > 365) return { ritmoDia, diasParaLotar: null, dataPrevista: null, base, motivo: "mais-de-um-ano" };
  return { ritmoDia, diasParaLotar: dias, dataPrevista: hoje ? somaDias(hoje, dias) : null, base, motivo: null };
}

// Permanência a partir dos eventos do período, cada um com o evento anterior e o
// seguinte da MESMA pessoa no grupo (LAG/LEAD no SQL):
//   [{ kind, at, prevKind, prevAt, nextKind }]
// O tempo de casa conta só a saída voluntária (`left`): remoção é decisão do admin
// (robô de spam tirado em minutos) e puxaria a mediana pra baixo sem dizer nada
// sobre o interesse de quem entrou. Saída sem entrada registrada (a pessoa entrou
// antes de a coleta começar) vai pra `semEntrada`.
function resumoPermanencia(linhas) {
  const estadias = [];
  const porOrigem = { join_link: [], join_added: [], join_other: [] };
  let saidas = 0, semEntrada = 0, entraram = 0, aindaNoGrupo = 0;
  for (const l of linhas || []) {
    if (String(l.kind).startsWith("join")) {
      entraram++;
      if (l.nextKind !== "left" && l.nextKind !== "removed") aindaNoGrupo++;
      continue;
    }
    if (l.kind !== "left") continue;
    saidas++;
    if (!String(l.prevKind || "").startsWith("join") || !l.prevAt) { semEntrada++; continue; }
    const ms = new Date(l.at) - new Date(l.prevAt);
    if (!(ms >= 0)) { semEntrada++; continue; }
    estadias.push(ms);
    porOrigem[l.prevKind]?.push(ms);
  }
  const ate = (lim) => estadias.filter(ms => ms <= lim).length;
  const pct = (n) => (estadias.length ? Math.round((n / estadias.length) * 100) : null);
  const ate1h = ate(HORA_MS), ate24h = ate(24 * HORA_MS), ate7d = ate(7 * 24 * HORA_MS);
  const origem = {};
  for (const [k, v] of Object.entries(porOrigem)) origem[k] = { n: v.length, medianaMs: mediana(v) };
  return {
    saidas,
    comEntrada: estadias.length,
    semEntrada,
    medianaMs: mediana(estadias),
    ate1h, ate24h, ate7d,
    pctAte1h: pct(ate1h), pctAte24h: pct(ate24h), pctAte7d: pct(ate7d),
    porOrigem: origem,
    entraram,
    aindaNoGrupo,
  };
}

// Quantas saídas voluntárias vieram logo depois de um envio.
//   envios: [{ at, produto }] — incluindo os da hora anterior ao período, que
//           ainda podem "pegar" saídas do começo dele
//   saidas: [{ at }]
// Cada saída conta uma vez, pro envio MAIS RECENTE antes dela, se estiver dentro
// da janela. O número sozinho engana: quem envia a cada 15 min tem a janela
// cobrindo o dia todo, e aí 100% das saídas são "após envio". Por isso a taxa por
// hora dentro × fora das janelas — é a comparação que diz se o envio espanta gente.
function saidasAposEnvio(envios, saidas, { janelaMs = HORA_MS, desde, ate, now = new Date() } = {}) {
  const t = (x) => new Date(x).getTime();
  const es = [...(envios || [])].sort((a, b) => t(a.at) - t(b.at));
  const ss = [...(saidas || [])].sort((a, b) => t(a.at) - t(b.at));
  const ini = desde ? t(desde) : (es.length ? t(es[0].at) : 0);
  const fim = Math.min(ate ? t(ate) : t(now), t(now));

  const porEnvio = new Array(es.length).fill(0);
  let j = -1, apos = 0;
  for (const s of ss) {
    const ts = t(s.at);
    while (j + 1 < es.length && t(es[j + 1].at) <= ts) j++;
    if (j >= 0 && ts - t(es[j].at) <= janelaMs) { porEnvio[j]++; apos++; }
  }

  // Horas cobertas pela união das janelas, dentro do período.
  let coberto = 0, abertoAte = -Infinity;
  for (const e of es) {
    const a = Math.max(t(e.at), ini, abertoAte);
    const b = Math.min(t(e.at) + janelaMs, fim);
    if (b > a) coberto += b - a;
    abertoAte = Math.max(abertoAte, t(e.at) + janelaMs);
  }
  const total = Math.max(0, fim - ini);
  const descoberto = Math.max(0, total - coberto);
  const porHora = (n, ms) => (ms >= HORA_MS / 4 ? Math.round((n / (ms / HORA_MS)) * 100) / 100 : null);

  const noPeriodo = es.filter(e => t(e.at) >= ini).length;
  return {
    janelaMin: Math.round(janelaMs / 60000),
    envios: noPeriodo,
    saidas: ss.length,
    saidasAposEnvio: apos,
    pct: ss.length ? Math.round((apos / ss.length) * 100) : null,
    mediaPorEnvio: noPeriodo ? Math.round((apos / noPeriodo) * 100) / 100 : null,
    taxaHora: { aposEnvio: porHora(apos, coberto), foraDeEnvio: porHora(ss.length - apos, descoberto) },
    piores: es
      .map((e, i) => ({ at: new Date(e.at).toISOString(), produto: e.produto || null, saidas: porEnvio[i] }))
      .filter(e => e.saidas > 0)
      .sort((a, b) => b.saidas - a.saidas || (a.at < b.at ? 1 : -1))
      .slice(0, 5),
  };
}

// Mapa dia da semana × hora. Linhas do SQL: [{ dow (ISODOW 1=segunda), hora, entradas, saidas }].
// Devolve as duas grades 7×24 (linha 0 = segunda) e os 3 horários de pico de cada.
function gradeHorarios(linhas) {
  const vazia = () => Array.from({ length: 7 }, () => new Array(24).fill(0));
  const entradas = vazia(), saidas = vazia();
  for (const l of linhas || []) {
    const d = Number(l.dow) - 1, h = Number(l.hora);
    if (!(d >= 0 && d < 7 && h >= 0 && h < 24)) continue;
    entradas[d][h] += Number(l.entradas) || 0;
    saidas[d][h] += Number(l.saidas) || 0;
  }
  const picos = (g) => g
    .flatMap((linha, d) => linha.map((n, hora) => ({ dow: d + 1, hora, n })))
    .filter(c => c.n > 0)
    .sort((a, b) => b.n - a.n || a.dow - b.dow || a.hora - b.hora)
    .slice(0, 3);
  return { entradas, saidas, destaques: { entradas: picos(entradas), saidas: picos(saidas) } };
}

module.exports = {
  TZ_BR,
  WA_GROUP_MAX,
  WA_GROUP_ENCHENDO,
  hojeBR,
  limitesBR,
  diasDoPeriodo,
  preencheDias,
  mediana,
  previsaoLotacao,
  resumoPermanencia,
  saidasAposEnvio,
  gradeHorarios,
};
