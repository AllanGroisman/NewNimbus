import { useState } from "react";
import { botaoPrimario, botaoSecundario, hintStyle, inputStyle } from "./downloaderEstilos";

export default function SelectionBar({
  total, selected, onAll, onNone, onDownload, busy, preparing, productLinks,
  templates = [], templateId, onTemplate, onEditTemplates,
}) {
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
      // Abaixo da barra fixa do topo no celular (--topbar-h é 0 no desktop).
      position: "sticky", top: "var(--topbar-h)", zIndex: 10,
      display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
      padding: "10px 0", marginBottom: 12,
      background: "var(--color-background-secondary)",
      borderBottom: "0.5px solid var(--color-border-tertiary)",
    }}>
      <button type="button" onClick={onAll} style={botaoSecundario}>Selecionar todos</button>
      <button type="button" onClick={onNone} disabled={!selected} style={{ ...botaoSecundario, opacity: selected ? 1 : 0.5 }}>Limpar</button>
      <span style={hintStyle}>{selected} de {total} selecionados</span>
      <div style={{ marginLeft: "auto", display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <select
          value={templateId || ""}
          onChange={(e) => onTemplate?.(e.target.value)}
          title="Aplica um template por cima do vídeo antes de salvar"
          style={{ ...inputStyle, width: "auto", minWidth: 150 }}
        >
          <option value="">🎬 Sem template</option>
          {templates.map((t) => <option key={t.id} value={t.id}>🎨 {t.name}</option>)}
        </select>
        <button type="button" onClick={onEditTemplates} style={botaoSecundario}>Editar</button>
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
          {preparing ? "Preparando…" : `⬇ Baixar${selected ? ` (${selected})` : ""}${templateId ? " com template" : ""}`}
        </button>
      </div>
    </div>
  );
}
