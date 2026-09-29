import { PRIMARY } from "../../data/constants";
import { diaCurto } from "../../data/desempenho";

// Barras de uma série diária, com a data embaixo. O MiniBar do painel da
// campanha tem os rótulos de dia da semana fixos; aqui o período é qualquer um
// (7 a 180 dias), então o rótulo sai da data e só aparece de tanto em tanto.
//
// `dias` = [{ date: "AAAA-MM-DD", value }]; `formata` vira o texto do tooltip.
export default function BarrasPorDia({ dias, formata = String, color = PRIMARY, height = 90 }) {
  const max = Math.max(...dias.map(d => d.value), 0);
  const passo = Math.max(1, Math.ceil(dias.length / 8));
  return (
    <div>
      <div style={{ display: "flex", gap: dias.length > 60 ? 1 : 2, alignItems: "flex-end", height }}>
        {dias.map(d => (
          <div
            key={d.date}
            title={`${diaCurto(d.date)}: ${formata(d.value)}`}
            style={{
              flex: 1,
              minWidth: 1,
              background: color,
              opacity: d.value > 0 ? 0.85 : 0.15,
              borderRadius: 2,
              height: max > 0 && d.value > 0 ? Math.max((d.value / max) * height, 3) : 2,
            }}
          />
        ))}
      </div>
      <div style={{ display: "flex", gap: dias.length > 60 ? 1 : 2, marginTop: 4 }}>
        {dias.map((d, i) => (
          <div key={d.date} style={{ flex: 1, minWidth: 1, position: "relative", height: 12 }}>
            {i % passo === 0 && (
              <span style={{ position: "absolute", left: 0, fontSize: 9, color: "var(--color-text-secondary)", whiteSpace: "nowrap" }}>
                {diaCurto(d.date)}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
