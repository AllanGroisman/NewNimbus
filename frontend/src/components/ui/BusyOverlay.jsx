import { PRIMARY } from "../../data/constants";

// Overlay bloqueante mostrado durante operações longas (busca no catálogo,
// scrape on-demand, etc). Cobre a tela inteira com backdrop opaco e impede
// cliques no resto da UI. Botão Cancelar dispara onCancel (AbortController
// do chamador deve abortar a request).
//
// Props:
//   title    — texto principal (default: "Aguarde...")
//   message  — texto secundário opcional
//   onCancel — callback opcional; omitido = sem botão cancelar
export default function BusyOverlay({ title = "Aguarde...", message, onCancel }) {
  return (
    <div
      // captura cliques e teclas em tudo que está atrás
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      role="dialog"
      aria-modal="true"
      aria-live="polite"
      style={{
        position: "fixed", inset: 0, zIndex: 9999,
        background: "rgba(0, 0, 0, 0.55)",
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 20,
        // não deixa o usuário "escapar" via tab
        cursor: "wait",
      }}
    >
      <div
        style={{
          background: "var(--color-background-primary)",
          border: "0.5px solid var(--color-border-tertiary)",
          borderRadius: 14, padding: "26px 28px",
          width: "100%", maxWidth: 340,
          display: "flex", flexDirection: "column", alignItems: "center", gap: 14,
          boxShadow: "0 8px 32px rgba(0,0,0,0.25)",
          cursor: "default",
        }}
      >
        <div
          aria-hidden="true"
          style={{
            width: 36, height: 36,
            border: `3px solid var(--color-border-tertiary)`,
            borderTopColor: PRIMARY,
            borderRadius: "50%",
            animation: "nimbus-spin 0.85s linear infinite",
          }}
        />
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 14, fontWeight: 500, color: "var(--color-text-primary)" }}>{title}</div>
          {message && (
            <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 4 }}>{message}</div>
          )}
        </div>
        {onCancel && (
          <button
            onClick={onCancel}
            style={{
              marginTop: 4, padding: "7px 18px", borderRadius: 8,
              background: "transparent", color: "var(--color-text-primary)",
              border: "0.5px solid var(--color-border-secondary)",
              fontSize: 13, cursor: "pointer", fontWeight: 500,
            }}
          >Cancelar</button>
        )}
      </div>
    </div>
  );
}
