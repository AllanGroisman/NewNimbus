// Períodos das telas de números (Desempenho, visão geral da campanha, Grupos):
// presets, datas livres, a seta ‹ › e o "período anterior" da variação. Contas
// puras, testáveis sem renderizar nada.
//
// Um período é `{ id }` (um preset) ou `{ id: "custom", from, to }`. O preset é
// resolvido na hora da busca (resolvePeriodo): a tela aberta na virada da
// meia-noite continua certa. Dias são "AAAA-MM-DD" de Brasília, contados ao
// meio-dia UTC pra fugir de fuso.
import { TZ_BR } from "./constants";

// "AAAA-MM-DD" do dia de hoje em Brasília — o mesmo relógio do painel do ML.
export function hojeBR(now = new Date()) {
  // en-CA formata como AAAA-MM-DD.
  return now.toLocaleDateString("en-CA", { timeZone: TZ_BR });
}

export function somaDias(dia, n) {
  const d = new Date(`${dia}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function diasEntre(from, to) {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400000);
}

const DIA_RE = /^\d{4}-\d{2}-\d{2}$/;
const ultimoDiaDoMes = (ano, mes) => new Date(Date.UTC(ano, mes, 0)).getUTCDate();   // mes 1-12
const doisDig = (n) => String(n).padStart(2, "0");

// `mes` 1-12; mês fora da faixa vira o ano certo (0 = dezembro do ano anterior).
function diaDoMes(ano, mes, dia) {
  const d = new Date(Date.UTC(ano, mes - 1, 1, 12));
  const a = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  return `${a}-${doisDig(m)}-${doisDig(Math.min(dia, ultimoDiaDoMes(a, m)))}`;
}

export const PRESETS = {
  hoje: { label: "Hoje" },
  ontem: { label: "Ontem" },
  "7d": { label: "7 dias", dias: 7 },
  "30d": { label: "30 dias", dias: 30 },
  "90d": { label: "90 dias", dias: 90 },
  mes: { label: "Este mês" },
  "mes-passado": { label: "Mês passado" },
};

// Período → { id, from, to }, datas inclusivas.
//
// `terminaHoje: false` (Desempenho): os "últimos N dias" terminam ONTEM — o
// painel do ML só fecha o dia seguinte, e é assim que ele mesmo conta (o
// "últimos 7 dias" de 29/09 é 22/09 a 28/09). `terminaHoje: true` (Grupos): o
// dado é do próprio sistema e vale na hora, então termina hoje.
export function resolvePeriodo(p, { terminaHoje = false, now = new Date() } = {}) {
  const id = p?.id;
  if (id === "custom") return { id, from: p.from, to: p.to };
  const hoje = hojeBR(now);
  const ontem = somaDias(hoje, -1);
  const fim = terminaHoje ? hoje : ontem;
  const [ano, mes] = hoje.split("-").map(Number);
  const inicioMes = `${hoje.slice(0, 8)}01`;
  switch (id) {
    case "hoje": return { id, from: hoje, to: hoje };
    case "ontem": return { id, from: ontem, to: ontem };
    // No dia 1º "ontem" é do mês passado: o período vira só o dia de hoje.
    case "mes": return { id, from: inicioMes, to: terminaHoje || ontem < inicioMes ? hoje : ontem };
    case "mes-passado": return { id, from: diaDoMes(ano, mes - 1, 1), to: somaDias(inicioMes, -1) };
    default: {
      const dias = PRESETS[id]?.dias;
      if (!dias) return null;
      return { id, from: somaDias(fim, -(dias - 1)), to: fim };
    }
  }
}

// Mês de calendário: o período começa no dia 1º e fica num mês só, e é o mês
// inteiro, um dos presets de mês ("Este mês" vai só até ontem) ou veio de um
// deles pela seta (`porMes`).
function ehDeMes({ id, from, to, porMes }) {
  if (from.slice(8) !== "01" || from.slice(0, 7) !== to.slice(0, 7)) return false;
  if (porMes || id === "mes" || id === "mes-passado") return true;
  const [a, m, d] = to.split("-").map(Number);
  return d === ultimoDiaDoMes(a, m);
}

// O período vizinho, pra trás (dir -1) ou pra frente (+1), do mesmo tamanho: a
// seta ‹ › da tela e — pra trás — o "período anterior" da variação, que é
// exatamente o que a seta abriria (e por isso já cai no cache quando ela abre).
// Mês anda por mês de calendário: "Este mês" de 1 a 18/10 ↔ 1 a 18/09.
//
// `min`/`max` são os limites da tela: o que passa de `max` encosta nele mantendo
// o tamanho; o que começa antes de `min` é cortado nele. Devolve null quando não
// há pra onde andar.
export function deslocaPeriodo(periodo, dir, { min = null, max = null } = {}) {
  const { from, to } = periodo;
  if (!DIA_RE.test(String(from)) || !DIA_RE.test(String(to))) return null;
  if (dir > 0 && max && to >= max) return null;
  if (dir < 0 && min && from <= min) return null;

  let novoFrom, novoTo;
  const porMes = ehDeMes(periodo);
  if (porMes) {
    const [a, m] = from.split("-").map(Number);
    const inteiro = to.slice(8) === String(ultimoDiaDoMes(a, m));
    novoFrom = diaDoMes(a, m + dir, 1);
    const [na, nm] = novoFrom.split("-").map(Number);
    novoTo = diaDoMes(na, nm, inteiro ? 31 : Number(to.slice(8)));
  } else {
    const tamanho = diasEntre(from, to) + 1;
    novoFrom = somaDias(from, dir * tamanho);
    novoTo = somaDias(to, dir * tamanho);
  }
  if (max && novoTo > max) {
    const tamanho = diasEntre(novoFrom, novoTo);
    novoTo = max;
    novoFrom = porMes ? `${max.slice(0, 8)}01` : somaDias(max, -tamanho);
  }
  if (min && novoFrom < min) novoFrom = min;
  if (min && novoTo < min) return null;
  return porMes ? { id: "custom", from: novoFrom, to: novoTo, porMes } : { id: "custom", from: novoFrom, to: novoTo };
}

// O período anterior da variação: o vizinho de trás, sem limite (quem decide se
// ele ainda existe na loja é o backend).
export function periodoAnterior(intervalo) {
  const ant = deslocaPeriodo(intervalo, -1);
  return ant ? { from: ant.from, to: ant.to } : null;
}

// Intervalo que coincide com um preset vira o preset (o chip acende de novo
// quando a seta volta pra ele).
export function comoPreset(intervalo, presets, opcoes) {
  for (const id of presets) {
    const r = resolvePeriodo({ id }, opcoes);
    if (r && r.from === intervalo.from && r.to === intervalo.to) return { id };
  }
  return { id: "custom", from: intervalo.from, to: intervalo.to };
}

// Traz o período pra dentro dos limites de outra tela (trocar de loja no
// Desempenho): preset que não existe ali vira o mais parecido ("Hoje" → "Ontem"
// no ML); datas livres encostam no limite.
export function ajustaAoLimite(p, { presets, min = null, max = null, terminaHoje = false, now = new Date() }) {
  if (p.id !== "custom") {
    if (presets.includes(p.id)) return p;
    if (p.id === "hoje" && presets.includes("ontem")) return { id: "ontem" };
    return { id: presets.find(id => id !== "hoje" && id !== "ontem") || presets[0] };
  }
  let { from, to } = p;
  if (max && to > max) to = max;
  if (min && from < min) from = min;
  if (from > to) from = to;
  if (min && to < min) to = from = min;
  return comoPreset({ from, to }, presets, { terminaHoje, now });
}

const dataBR = (dia, comAno) => {
  const [a, m, d] = dia.split("-");
  return comAno ? `${d}/${m}/${a}` : `${d}/${m}`;
};

// O que há de errado nas datas escolhidas à mão, ou null.
export function validaPersonalizado(from, to, { min = null, max = null, maxDias = null } = {}) {
  if (!DIA_RE.test(String(from || "")) || !DIA_RE.test(String(to || ""))) return "Escolha as duas datas.";
  if (from > to) return "A data inicial é depois da final.";
  if (max && to > max) return `Escolha até ${dataBR(max, true)}.`;
  if (min && from < min) return `Os dados começam em ${dataBR(min, true)}.`;
  if (maxDias && diasEntre(from, to) + 1 > maxDias) return `Escolha um período de até ${maxDias} dias.`;
  return null;
}

const SEMANA = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

// "Hoje", "Ontem", "qua, 15/10" ou "12/10 a 18/10" (com o ano quando não é o atual).
export function rotuloPeriodo({ from, to }, now = new Date()) {
  const hoje = hojeBR(now);
  const anoAtual = hoje.slice(0, 4);
  if (from === to) {
    if (from === hoje) return "Hoje";
    if (from === somaDias(hoje, -1)) return "Ontem";
    const dia = SEMANA[new Date(`${from}T12:00:00Z`).getUTCDay()];
    return `${dia}, ${dataBR(from, from.slice(0, 4) !== anoAtual)}`;
  }
  const comAno = from.slice(0, 4) !== anoAtual || to.slice(0, 4) !== anoAtual;
  return `${dataBR(from, comAno)} a ${dataBR(to, comAno)}`;
}

// O dia mais antigo que a Shopee ainda responde — o mesmo que o backend usa
// (affiliate-reports/shopee.js inicioMinimo): o mais recente entre 120 dias e o
// dia 1º de 3 meses atrás.
export function inicioShopee(hoje) {
  const [a, m] = hoje.split("-").map(Number);
  const primeiroDoMes = diaDoMes(a, m - 3, 1);
  const porDias = somaDias(hoje, -120);
  return primeiroDoMes > porDias ? primeiroDoMes : porDias;
}

// Variação do período anterior pro atual, em %: { pct, direcao } ou null quando
// não dá pra comparar (sem anterior, ou anterior zerado — de 0 pra 5 não é "%").
export function variacao(atual, anterior) {
  const a = Number(atual);
  const b = Number(anterior);
  if (anterior == null || !Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
  const pct = Math.round(((a - b) / Math.abs(b)) * 100);
  return { pct, direcao: pct > 0 ? "sobe" : pct < 0 ? "desce" : "igual" };
}
