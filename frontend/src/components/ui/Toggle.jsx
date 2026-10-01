import { PRIMARY } from "../../data/constants";

// Chavinha liga/desliga. É um <button role="switch"> (e não uma div) pra
// funcionar no teclado e ter nome no leitor de tela — passe `label` com o que
// a chave controla. O `hit` estende a área de toque além dos 22px de altura.
export default function Toggle({ value, onChange, label, disabled = false }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      aria-label={label}
      disabled={disabled}
      className="hit"
      onClick={() => { if (!disabled) onChange(!value); }}
      style={{
        width: 40, height: 22, borderRadius: 11, padding: 0,
        border: "none", appearance: "none",
        background: value ? PRIMARY : "var(--color-border-tertiary)",
        cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1,
        position: "relative", transition: "background 0.2s", flexShrink: 0,
      }}
    >
      <div style={{
        width: 18, height: 18, borderRadius: "50%", background: "#fff",
        position: "absolute", top: 2, left: value ? 20 : 2, transition: "left 0.2s",
      }} />
    </button>
  );
}
