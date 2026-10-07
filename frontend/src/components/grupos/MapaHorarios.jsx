import { useState } from "react";
import { PRIMARY } from "../../data/constants";
import { Linha, Chip } from "../desempenho/comum";
import { DIAS_SEMANA, rotuloHorario } from "../../data/grupos";

const SERIES = [
  { id: "entradas", label: "Entradas", cor: PRIMARY, vazio: "Ninguém entrou no período." },
  { id: "saidas", label: "Saídas", cor: "var(--danger-text)", vazio: "Ninguém saiu por conta própria no período." },
];

// Dia da semana × hora: quanto mais forte a célula, mais gente entrou (ou saiu)
// naquele horário. `horarios` = { entradas: 7×24, saidas: 7×24, destaques }, linha
// 0 = segunda. As saídas são só as voluntárias — remoção é horário do admin.
export default function MapaHorarios({ horarios }) {
  const [serie, setSerie] = useState("entradas");
  const [sel, setSel] = useState(null); // { dow, hora }
  const atual = SERIES.find(s => s.id === serie);
  const grade = horarios?.[serie] || [];
  const max = Math.max(0, ...grade.flat());
  const destaques = horarios?.destaques?.[serie] || [];
  const valorSel = sel ? grade[sel.dow - 1]?.[sel.hora] ?? 0 : null;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        <div style={{ fontWeight: 500 }}>Melhores horários</div>
        <Linha>
          {SERIES.map(s => <Chip key={s.id} ativo={s.id === serie} onClick={() => { setSerie(s.id); setSel(null); }}>{s.label}</Chip>)}
        </Linha>
      </div>
      {max === 0 ? (
        <div style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>{atual.vazio}</div>
      ) : (
        <>
          <div aria-live="polite" style={{ fontSize: 11, color: "var(--color-text-secondary)", minHeight: 16, marginBottom: 4 }}>
            {sel && <><strong style={{ color: "var(--color-text-primary)" }}>{rotuloHorario(sel)}</strong>: {valorSel}</>}
          </div>
          <div onMouseLeave={() => setSel(null)} style={{ display: "grid", gridTemplateColumns: "28px repeat(24, minmax(0, 1fr))", gap: 2, alignItems: "center" }}>
            {DIAS_SEMANA.map((rotulo, d) => [
              <div key={`r${d}`} style={{ fontSize: 10, color: "var(--color-text-secondary)" }}>{rotulo}</div>,
              ...grade[d].map((n, h) => (
                <div
                  key={`${d}-${h}`}
                  title={`${rotuloHorario({ dow: d + 1, hora: h })}: ${n}`}
                  onMouseEnter={() => setSel({ dow: d + 1, hora: h })}
                  onClick={() => setSel({ dow: d + 1, hora: h })}
                  style={{
                    height: 14, borderRadius: 2, cursor: "pointer",
                    background: n > 0 ? atual.cor : "var(--color-background-secondary)",
                    opacity: n > 0 ? 0.2 + 0.8 * (n / max) : 1,
                    outline: sel && sel.dow === d + 1 && sel.hora === h ? "1px solid var(--color-text-primary)" : "none",
                  }}
                />
              )),
            ])}
            <div />
            {Array.from({ length: 24 }, (_, h) => (
              <div key={`h${h}`} style={{ fontSize: 9, color: "var(--color-text-secondary)", textAlign: "left", overflow: "visible", whiteSpace: "nowrap" }}>
                {h % 6 === 0 ? `${h}h` : ""}
              </div>
            ))}
          </div>
          {destaques.length > 0 && (
            <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 10 }}>
              {serie === "entradas" ? "Mais entradas" : "Mais saídas"}: {destaques.map(x => `${rotuloHorario(x)} (${x.n})`).join(" · ")}
            </div>
          )}
        </>
      )}
    </div>
  );
}
