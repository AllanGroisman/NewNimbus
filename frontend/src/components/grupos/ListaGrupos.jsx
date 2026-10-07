import { formatInt } from "../../data/desempenho";
import { formatSaldo, textoPrevisao, ordenaGrupos } from "../../data/grupos";
import Badge from "../ui/Badge";
import OcupacaoBarra from "./OcupacaoBarra";

const secundario = { fontSize: 12, color: "var(--color-text-secondary)" };

// Um cartão por grupo de destino, os que estão enchendo primeiro. Tocar abre o
// detalhe do grupo.
export default function ListaGrupos({ grupos, cap, enchendoEm, onAbrir }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {ordenaGrupos(grupos).map(g => (
        <button
          key={g.jid}
          type="button"
          onClick={() => onAbrir(g.jid)}
          style={{
            textAlign: "left", width: "100%", fontFamily: "inherit", cursor: "pointer",
            background: "var(--color-background-primary)", color: "var(--color-text-primary)",
            border: `0.5px solid ${g.enchendo ? "var(--warn-border)" : "var(--color-border-tertiary)"}`,
            borderRadius: 12, padding: 14,
          }}
        >
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
            <div style={{ fontWeight: 500, fontSize: 14, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g.nome}</div>
            <span aria-hidden style={{ color: "var(--color-text-secondary)" }}>›</span>
          </div>
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap", margin: "6px 0 10px" }}>
            {g.campanhas.map(c => <Badge key={c.id} color="gray">{c.name}</Badge>)}
          </div>

          <OcupacaoBarra membros={g.membros} cap={cap} enchendoEm={enchendoEm} />
          <div style={{ ...secundario, display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", marginTop: 6 }}>
            <span style={{ color: g.enchendo ? "var(--warn-text)" : undefined }}>
              {g.membros == null ? "Membros ainda não lidos" : `${formatInt(g.membros)} de ${formatInt(cap)} membros`}
            </span>
            {g.membros != null && <span>{textoPrevisao(g.previsao)}</span>}
          </div>

          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 10, fontSize: 13 }}>
            <span title="Entradas no período"><span style={{ color: "var(--success-text)" }}>▲</span> {formatInt(g.entradas)}</span>
            <span title="Saídas no período (saíram + removidos)"><span style={{ color: "var(--danger-text)" }}>▼</span> {formatInt(g.saidas)}</span>
            <span title="Entradas − saídas">saldo {formatSaldo(g.saldo)}</span>
            <span style={secundario} title="Ofertas enviadas pro grupo no período">{formatInt(g.envios)} envio(s)</span>
          </div>
        </button>
      ))}
    </div>
  );
}
