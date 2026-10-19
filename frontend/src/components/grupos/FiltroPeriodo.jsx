import { PRIMARY } from "../../data/constants";
import { PRESETS_GRUPOS, MAX_DIAS_GRUPOS } from "../../data/grupos";
import { hojeBR } from "../../data/periodos";
import { Card } from "../desempenho/comum";
import SeletorPeriodo from "../ui/SeletorPeriodo";

// Período (presets, datas livres e ‹ ›) + "Atualizar", da lista e do detalhe de
// um grupo. `periodo` = { id } ou { id: "custom", from, to }; os períodos daqui
// terminam hoje (o dado é do próprio sistema). `children` entra embaixo (o
// filtro de campanha da lista).
export default function FiltroPeriodo({ periodo, onPeriodo, onAtualizar, carregando, children }) {
  return (
    <Card>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <SeletorPeriodo valor={periodo} onChange={onPeriodo} presets={PRESETS_GRUPOS} terminaHoje max={hojeBR()} maxDias={MAX_DIAS_GRUPOS} />
        </div>
        <button
          type="button"
          onClick={onAtualizar}
          disabled={carregando}
          style={{ background: "transparent", border: "none", padding: "8px 4px", margin: "-2px -4px 0", color: PRIMARY, fontSize: 12, cursor: carregando ? "default" : "pointer", fontFamily: "inherit", opacity: carregando ? 0.5 : 1, whiteSpace: "nowrap", flexShrink: 0 }}
        >
          {carregando ? "Carregando…" : "↻ Atualizar"}
        </button>
      </div>
      {children}
    </Card>
  );
}
