import { useState } from "react";
import { botaoPrimario, botaoSecundario, hintStyle } from "../styles";

export default function SelectionBar({ total, selected, onAll, onNone, onDownload, busy, productLinks }) {
  const [copyMsg, setCopyMsg] = useState(null);

  const copyLinks = async () => {
    const lines = productLinks();
    if (!lines.length) {
      setCopyMsg("Nenhum produto");
    } else {
      try {
        await navigator.clipboard.writeText(lines.join("\n"));
        setCopyMsg(`${lines.length} copiado${lines.length > 1 ? "s" : ""}!`);
      } catch {
        setCopyMsg("Falha ao copiar");
      }
    }
    setTimeout(() => setCopyMsg(null), 2000);
  };

  return (
    <div style={{
      position: "sticky", top: 0, zIndex: 10,
      display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
      padding: "10px 0", marginBottom: 12,
      background: "var(--color-background-secondary)",
      borderBottom: "0.5px solid var(--color-border-tertiary)",
    }}>
      <button type="button" onClick={onAll} style={botaoSecundario}>Selecionar todos</button>
      <button type="button" onClick={onNone} disabled={!selected} style={{ ...botaoSecundario, opacity: selected ? 1 : 0.5 }}>Limpar</button>
      <span style={hintStyle}>{selected} de {total} selecionados</span>
      <div style={{ marginLeft: "auto", display: "flex", gap: 10, flexWrap: "wrap" }}>
        {productLinks && (
          <button
            type="button"
            onClick={copyLinks}
            style={botaoSecundario}
            title={selected ? "Copia os links dos produtos dos vídeos selecionados" : "Copia os links dos produtos de todos os vídeos"}
          >
            🛍 {copyMsg || "Copiar links dos produtos"}
          </button>
        )}
        <button
          type="button"
          onClick={onDownload}
          disabled={!selected || busy}
          style={botaoPrimario(!selected || busy)}
        >
          ⬇ Baixar {selected ? `(${selected})` : ""}
        </button>
      </div>
    </div>
  );
}
