// Contas puras da aba Grupos (pages/Grupos.jsx): períodos e textos. Moram fora
// do componente pra serem testáveis sem renderizar nada.
import { hojeBR, somaDias, formatInt } from "./desempenho";

// Diferente do Desempenho, aqui o dado é do próprio sistema e vale na hora: os
// períodos terminam HOJE (o do Desempenho termina ontem, porque o ML só fecha o
// dia seguinte).
export const PERIODOS_GRUPOS = [
  { id: "hoje", label: "Hoje" },
  { id: "7d", label: "7 dias" },
  { id: "30d", label: "30 dias" },
  { id: "90d", label: "90 dias" },
];

export const PERIODO_GRUPOS_PADRAO = "7d";

const DIAS = { "7d": 7, "30d": 30, "90d": 90 };

export function periodoGrupos(id, now = new Date()) {
  const hoje = hojeBR(now);
  const n = DIAS[id];
  return n ? { from: somaDias(hoje, -(n - 1)), to: hoje } : { from: hoje, to: hoje };
}

// Linha 0 = segunda (é como o backend manda a grade de horários).
export const DIAS_SEMANA = ["seg", "ter", "qua", "qui", "sex", "sáb", "dom"];

// `dow` do backend: 1 = segunda … 7 = domingo.
export function rotuloHorario({ dow, hora }) {
  return `${DIAS_SEMANA[dow - 1] || "?"} ${hora}h`;
}

// "40 min", "5 h", "3 dias". Abaixo de 2 dias fica em horas: "30 h" diz mais que
// "1 dia" pra quem quer saber se a pessoa saiu no mesmo dia.
export function formatDuracao(ms) {
  if (ms == null || !Number.isFinite(ms)) return "—";
  const min = Math.round(ms / 60000);
  if (min < 60) return `${Math.max(min, 1)} min`;
  const h = Math.round(ms / 3600000);
  if (h < 48) return `${h} h`;
  return `${Math.round(ms / 86400000)} dias`;
}

// +3 / −2 / 0. O sinal de menos tipográfico, pra não confundir com hífen.
export function formatSaldo(n) {
  const v = Number(n) || 0;
  if (v > 0) return `+${formatInt(v)}`;
  if (v < 0) return `−${formatInt(-v)}`;
  return "0";
}

export function formatPct(n) {
  return n == null ? "—" : `${n}%`;
}

// A previsão de lotação em uma frase curta.
export function textoPrevisao(previsao) {
  if (!previsao) return "Sem dados pra prever";
  switch (previsao.motivo) {
    case "cheio": return "Cheio";
    case "estavel": return "Estável";
    case "caindo": return "Perdendo membros";
    case "mais-de-um-ano": return "Mais de um ano pra lotar";
    default: {
      const d = previsao.diasParaLotar;
      const quando = previsao.dataPrevista ? ` (${previsao.dataPrevista.slice(8, 10)}/${previsao.dataPrevista.slice(5, 7)})` : "";
      return d <= 1 ? `Lota em até 1 dia${quando}` : `Lota em ~${d} dias${quando}`;
    }
  }
}

// O ritmo que a previsão usou, pra mostrar ao lado: "+12/dia".
export function textoRitmo(previsao) {
  if (previsao?.ritmoDia == null) return null;
  const r = previsao.ritmoDia;
  const v = Math.abs(r).toLocaleString("pt-BR", { maximumFractionDigits: 1 });
  return `${r > 0 ? "+" : r < 0 ? "−" : ""}${v}/dia`;
}

// Ordem da lista: os que estão enchendo primeiro (é onde há o que fazer), depois
// os maiores.
export function ordenaGrupos(grupos) {
  return [...(grupos || [])].sort((a, b) =>
    (b.enchendo ? 1 : 0) - (a.enchendo ? 1 : 0) || (b.membros ?? -1) - (a.membros ?? -1) || String(a.nome).localeCompare(String(b.nome)));
}
