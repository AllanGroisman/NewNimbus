import { useState } from "react";
import { PRIMARY } from "../../data/constants";
import { diaCurto, formatInt } from "../../data/desempenho";
import { formatSaldo } from "../../data/grupos";

// Entradas e saídas por dia num gráfico só: entradas para cima, saídas para
// baixo, na mesma escala — o "saldo" é o quanto uma barra passa da outra. O
// BarrasPorDia não serve aqui porque não desenha valor negativo.
//
// `dias` = [{ date, entradas, saidas, saldo } | { date, semDados: true }]. Dia sem
// dado (antes de a coleta começar) fica só com o traço do eixo, apagado.
export default function BarrasSaldo({ dias, altura = 110 }) {
  const [sel, setSel] = useState(null);
  const metade = altura / 2;
  const max = Math.max(1, ...dias.map(d => Math.max(d.entradas || 0, d.saidas || 0)));
  const passo = Math.max(1, Math.ceil(dias.length / 8));
  const gap = dias.length > 60 ? 1 : 2;
  const escolhido = sel != null ? dias[sel] : null;
  const alt = (v) => (v > 0 ? Math.max((v / max) * (metade - 2), 3) : 0);

  return (
    <div>
      <div aria-live="polite" style={{ fontSize: 11, color: "var(--color-text-secondary)", minHeight: 16, marginBottom: 4 }}>
        {escolhido && (
          <>
            <strong style={{ color: "var(--color-text-primary)" }}>{diaCurto(escolhido.date)}</strong>:{" "}
            {escolhido.semDados
              ? "sem coleta nesse dia"
              : <>{formatInt(escolhido.entradas)} entrada(s) · {formatInt(escolhido.saidas)} saída(s) · saldo {formatSaldo(escolhido.saldo)}</>}
          </>
        )}
      </div>
      <div onMouseLeave={() => setSel(null)} style={{ display: "flex", gap, height: altura }}>
        {dias.map((d, i) => (
          <div
            key={d.date}
            title={d.semDados ? `${diaCurto(d.date)}: sem coleta` : `${diaCurto(d.date)}: +${d.entradas} / −${d.saidas}`}
            onMouseEnter={() => setSel(i)}
            onClick={() => setSel(s => (s === i ? null : i))}
            style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", cursor: "pointer", opacity: d.semDados ? 0.35 : 1 }}
          >
            <div style={{ height: metade, display: "flex", alignItems: "flex-end" }}>
              <div style={{ width: "100%", height: alt(d.entradas), background: PRIMARY, borderRadius: "2px 2px 0 0", opacity: sel === i ? 1 : 0.85 }} />
            </div>
            <div style={{ height: 1, background: "var(--color-border-secondary)" }} />
            <div style={{ height: metade - 1 }}>
              <div style={{ width: "100%", height: alt(d.saidas), background: "var(--danger-text)", borderRadius: "0 0 2px 2px", opacity: sel === i ? 1 : 0.7 }} />
            </div>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap, marginTop: 4 }}>
        {dias.map((d, i) => (
          <div key={d.date} style={{ flex: 1, minWidth: 0, position: "relative", height: 12 }}>
            {i % passo === 0 && (
              <span style={{ position: "absolute", ...(i >= dias.length - passo ? { right: 0 } : { left: 0 }), fontSize: 9, color: "var(--color-text-secondary)", whiteSpace: "nowrap" }}>
                {diaCurto(d.date)}
              </span>
            )}
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 14, fontSize: 11, color: "var(--color-text-secondary)", marginTop: 8 }}>
        <span><span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: PRIMARY, marginRight: 5 }} />Entradas</span>
        <span><span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: "var(--danger-text)", marginRight: 5 }} />Saídas</span>
      </div>
    </div>
  );
}
