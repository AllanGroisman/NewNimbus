// Contas puras da tela Desempenho (pages/Desempenho.jsx): períodos e formatos.
// Moram fora do componente pra serem testáveis sem renderizar nada.
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

export const PERIODOS = [
  { id: "7d", label: "7 dias" },
  { id: "30d", label: "30 dias" },
  { id: "90d", label: "90 dias" },
  { id: "mes", label: "Este mês" },
  { id: "mes-passado", label: "Mês passado" },
];

export const PERIODO_PADRAO = "30d";

// Período → { from, to }, datas inclusivas. Os "últimos N dias" terminam ONTEM:
// o painel do ML só fecha o dia seguinte, e é assim que ele mesmo conta (o
// "últimos 7 dias" de 29/09 é 22/09 a 28/09).
export function periodo(id, now = new Date()) {
  const hoje = hojeBR(now);
  const ontem = somaDias(hoje, -1);
  const [ano, mes] = hoje.split("-").map(Number);
  const inicioMes = `${hoje.slice(0, 8)}01`;
  switch (id) {
    case "7d": return { from: somaDias(hoje, -7), to: ontem };
    case "90d": return { from: somaDias(hoje, -90), to: ontem };
    // No dia 1º "ontem" é do mês passado: o período vira só o dia de hoje.
    case "mes": return { from: inicioMes, to: ontem < inicioMes ? hoje : ontem };
    case "mes-passado": {
      const a = mes === 1 ? ano - 1 : ano;
      const m = mes === 1 ? 12 : mes - 1;
      return { from: `${a}-${String(m).padStart(2, "0")}-01`, to: somaDias(inicioMes, -1) };
    }
    case "30d":
    default: return { from: somaDias(hoje, -30), to: ontem };
  }
}

export function formatBRL(v) {
  return (Number(v) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

export function formatInt(v) {
  return (Number(v) || 0).toLocaleString("pt-BR");
}

// Pedidos ÷ cliques, em %. "—" sem clique (não é 0%, é "não dá pra saber").
export function conversao(orders, clicks) {
  if (!clicks) return "—";
  return `${((orders / clicks) * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;
}

// "28/09" a partir de "2026-09-28".
export function diaCurto(dia) {
  const [, m, d] = String(dia).split("-");
  return d && m ? `${d}/${m}` : String(dia);
}
