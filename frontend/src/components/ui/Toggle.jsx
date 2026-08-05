import { PRIMARY } from "../../data/constants";

// Chavinha liga/desliga. É um <button role="switch"> (e não uma div) pra
// funcionar no teclado e ter nome no leitor de tela — passe `label` com o que
// a chave controla.
export default function Toggle({ value, onChange, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      aria-label={label}
      onClick={() => onChange(!value)}
      style={{
        width: 40, height: 22, borderRadius: 11, padding: 0,
        border: "none", appearance: "none",
        background: value ? PRIMARY : "var(--color-border-tertiary)",
        cursor: "pointer", position: "relative", transition: "background 0.2s", flexShrink: 0,
      }}
    >
      <div style={{
        width: 18, height: 18, borderRadius: "50%", background: "#fff",
        position: "absolute", top: 2, left: value ? 20 : 2, transition: "left 0.2s",
      }} />
    </button>
  );
}
