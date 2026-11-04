import { useState } from "react";
import { PRIMARY, PRIMARY_DARK, PRIMARY_LIGHT } from "../data/constants";

const inputStyle = {
  padding: "7px 10px",
  borderRadius: 8,
  border: "0.5px solid var(--color-border-tertiary)",
  background: "var(--color-background-secondary)",
  fontSize: 13,
  width: "100%",
};

const btnStyle = {
  padding: "6px 12px",
  borderRadius: 7,
  border: "0.5px solid var(--color-border-secondary)",
  background: "transparent",
  fontSize: 12,
  cursor: "pointer",
};

// Lista de palavras em chips: digitar + Enter adiciona, × remove. Vírgula também
// separa — colar "cupom, codigo, voucher" de uma vez é o caminho natural.
export default function WordList({ words, onChange, placeholder }) {
  const [draft, setDraft] = useState("");

  function add() {
    const novas = draft.split(",").map(w => w.trim().toLowerCase()).filter(Boolean);
    if (!novas.length) return;
    onChange([...words, ...novas.filter(w => !words.includes(w))]);
    setDraft("");
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {words.length === 0 && (
          <span style={{ fontSize: 12, color: "var(--color-text-secondary)", fontStyle: "italic" }}>nenhuma palavra</span>
        )}
        {words.map(w => (
          <span key={w}
            style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 10px", borderRadius: 7, border: `0.5px solid ${PRIMARY}`, background: PRIMARY_LIGHT, color: PRIMARY_DARK, fontSize: 12 }}>
            {w}
            <button type="button" onClick={() => onChange(words.filter(x => x !== w))}
              aria-label={`remover ${w}`}
              style={{ border: "none", background: "transparent", color: PRIMARY_DARK, cursor: "pointer", fontSize: 13, lineHeight: 1, padding: 0 }}>
              ×
            </button>
          </span>
        ))}
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <input
          value={draft}
          placeholder={placeholder}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
          style={{ ...inputStyle, maxWidth: 260 }}
        />
        <button type="button" onClick={add} style={btnStyle}>+ Adicionar</button>
      </div>
    </div>
  );
}
