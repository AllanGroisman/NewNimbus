import { useState } from "react";
import { PRIMARY } from "../../data/constants";
import { diaCurto } from "../../data/desempenho";

// Barras de uma série diária, com a data embaixo. O MiniBar do painel da
// campanha tem os rótulos de dia da semana fixos; aqui o período é qualquer um
// (7 a 180 dias), então o rótulo sai da data e só aparece de tanto em tanto.
//
// `dias` = [{ date: "AAAA-MM-DD", value }]; `formata` vira o texto do valor.
// O valor de um dia aparece acima das barras ao passar o mouse ou tocar na
// barra — no celular não existe tooltip, e sem isso o gráfico não tinha número.
export default function BarrasPorDia({ dias, formata = String, color = PRIMARY, height = 90 }) {
  const [sel, setSel] = useState(null);
  const max = Math.max(...dias.map(d => d.value), 0);
  const passo = Math.max(1, Math.ceil(dias.length / 8));
  // Com muitos dias a barra encolhe até sumir o vão: 180 barras com 1px de vão
  // pediam ~360px e estouravam o card no celular.
  const gap = dias.length > 90 ? 0 : dias.length > 60 ? 1 : 2;
  const escolhido = sel != null ? dias[sel] : null;
  return (
    <div>
      <div aria-live="polite" style={{ fontSize: 11, color: "var(--color-text-secondary)", minHeight: 16, marginBottom: 4 }}>
        {escolhido && <><strong style={{ color: "var(--color-text-primary)" }}>{diaCurto(escolhido.date)}</strong>: {formata(escolhido.value)}</>}
      </div>
      <div onMouseLeave={() => setSel(null)} style={{ display: "flex", gap, alignItems: "flex-end", height }}>
        {dias.map((d, i) => (
          <div
            key={d.date}
            title={`${diaCurto(d.date)}: ${formata(d.value)}`}
            onMouseEnter={() => setSel(i)}
            onClick={() => setSel(s => (s === i ? null : i))}
            style={{
              flex: 1,
              minWidth: 0,
              alignSelf: "stretch",
              display: "flex",
              alignItems: "flex-end",
              cursor: "pointer",
            }}
          >
            <div style={{
              width: "100%",
              background: color,
              opacity: sel === i ? 1 : d.value > 0 ? 0.85 : 0.15,
              borderRadius: 2,
              height: max > 0 && d.value > 0 ? Math.max((d.value / max) * height, 3) : 2,
            }} />
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap, marginTop: 4 }}>
        {dias.map((d, i) => (
          <div key={d.date} style={{ flex: 1, minWidth: 0, position: "relative", height: 12 }}>
            {i % passo === 0 && (
              // Os do fim ancoram pela direita pra não vazar da borda do card.
              <span style={{ position: "absolute", ...(i >= dias.length - passo ? { right: 0 } : { left: 0 }), fontSize: 9, color: "var(--color-text-secondary)", whiteSpace: "nowrap" }}>
                {diaCurto(d.date)}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
