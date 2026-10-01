import Logo from "./Logo";

// Card centralizado das telas de fora do sistema (login, /assinar, /bem-vindo).
// Extraído pra que as páginas do checkout público tenham exatamente a mesma
// moldura da tela de login — é a mesma pessoa, no meio do mesmo caminho.
export default function AuthCard({ subtitle, maxWidth = 360, children }) {
  return (
    // auth-page/auth-card (index.css): menos margem no celular e altura que
    // desconta a barra do navegador.
    <div className="auth-page" style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div className="auth-card" style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 16, padding: 32, width: "100%", maxWidth }}>
        <div style={{ textAlign: "center", marginBottom: 24 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, fontSize: 28, fontWeight: 500, color: "var(--color-brand)" }}>
            <Logo size={34} />
            <span>Nimbus</span>
          </div>
          {subtitle && (
            <div style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>{subtitle}</div>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}

// Avisos das telas públicas — mesmas variáveis de cor usadas no Login.
export function Alert({ kind = "info", children }) {
  const palette = {
    error:   { bg: "var(--danger-bg)",  border: "var(--danger-border)",  text: "var(--danger-text)" },
    success: { bg: "var(--success-bg)", border: "var(--success-border)", text: "var(--success-text)" },
    info:    { bg: "var(--color-background-secondary)", border: "var(--color-border-tertiary)", text: "var(--color-text-primary)" },
  }[kind] || {};
  return (
    <div style={{ background: palette.bg, border: `0.5px solid ${palette.border}`, color: palette.text, borderRadius: 8, padding: "10px 12px", fontSize: 12 }}>
      {children}
    </div>
  );
}
