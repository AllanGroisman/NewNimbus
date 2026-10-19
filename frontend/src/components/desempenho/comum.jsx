import { useState } from "react";
import { PRIMARY } from "../../data/constants";
import BarrasPorDia from "../ui/BarrasPorDia";
import BarrasSaldo from "../grupos/BarrasSaldo";

// Peças da tela Desempenho usadas pela casca (pages/Desempenho.jsx) e pelo
// conteúdo de cada loja.

export function Card({ children, style }) {
  return (
    <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: 16, marginBottom: 12, ...style }}>
      {children}
    </div>
  );
}

export function Linha({ children, style }) {
  return <div style={{ display: "flex", gap: 8, flexWrap: "wrap", ...style }}>{children}</div>;
}

export function Chip({ ativo, onClick, children, disabled }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-pressed={ativo}
      style={{
        padding: "7px 12px", borderRadius: 999, fontSize: 12, fontFamily: "inherit",
        cursor: disabled ? "default" : "pointer",
        border: `0.5px solid ${ativo ? PRIMARY : "var(--color-border-secondary)"}`,
        background: ativo ? PRIMARY : "transparent",
        color: ativo ? "var(--color-background-primary)" : "var(--color-text-primary)",
      }}
    >
      {children}
    </button>
  );
}

// Card "Por dia": chips pra escolher a série e as barras. Dia sem nada vira a
// frase "Sem <série> no período." em vez de barras vazias. Série com
// `tipo: "saldo"` desenha entradas e saídas (BarrasSaldo) a partir dos campos
// `entradas`/`saidas` do dia; as outras leem `d[id]`. `onDia(date)` leva a tela
// pro dia tocado.
export function PorDia({ dias, series, onDia }) {
  const [serie, setSerie] = useState(series[0].id);
  const atual = series.find(x => x.id === serie) || series[0];
  const lista = dias || [];
  const ehSaldo = atual.tipo === "saldo";
  const pontos = ehSaldo ? [] : lista.map(d => ({ date: d.date, value: d[atual.id] || 0 }));
  const vazio = ehSaldo
    ? lista.every(d => !d.entradas && !d.saidas)
    : pontos.every(p => !p.value);
  return (
    <Card>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        <div style={{ fontWeight: 500 }}>Por dia</div>
        {series.length > 1 && (
          <Linha>
            {series.map(x => <Chip key={x.id} ativo={x.id === atual.id} onClick={() => setSerie(x.id)}>{x.label}</Chip>)}
          </Linha>
        )}
      </div>
      {vazio
        ? <div style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>Sem {atual.label.toLowerCase()} no período.</div>
        : ehSaldo
          ? <BarrasSaldo dias={lista} onDia={onDia} />
          : <BarrasPorDia dias={pontos} formata={atual.formata} onDia={onDia} />}
    </Card>
  );
}
