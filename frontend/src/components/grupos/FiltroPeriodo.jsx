import { PRIMARY } from "../../data/constants";
import { PERIODOS_GRUPOS } from "../../data/grupos";
import { Card, Linha, Chip } from "../desempenho/comum";

// Chips de período + "Atualizar", da lista e do detalhe de um grupo. `children`
// entra embaixo (o filtro de campanha da lista).
export default function FiltroPeriodo({ periodoId, onPeriodo, onAtualizar, carregando, children }) {
  return (
    <Card>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <Linha>
          {PERIODOS_GRUPOS.map(p => (
            <Chip key={p.id} ativo={p.id === periodoId} onClick={() => onPeriodo(p.id)}>{p.label}</Chip>
          ))}
        </Linha>
        <button
          type="button"
          onClick={onAtualizar}
          disabled={carregando}
          style={{ background: "transparent", border: "none", padding: "8px 4px", margin: "-8px -4px", color: PRIMARY, fontSize: 12, cursor: carregando ? "default" : "pointer", fontFamily: "inherit", opacity: carregando ? 0.5 : 1 }}
        >
          {carregando ? "Carregando…" : "↻ Atualizar"}
        </button>
      </div>
      {children}
    </Card>
  );
}
