// Faixa de mensagem — o único jeito de mostrar erro/aviso/sucesso no app.
// Antes cada tela reescrevia essa div (mesmo estilo, copiado ~15 vezes) e
// algumas usavam alert() do navegador. O visual saiu do banner de saveError
// do App.jsx, que já era o melhor do sistema.
//
// Props:
//   tone      — "error" | "warn" | "success" | "info" (default "error")
//   message   — texto pronto pro usuário (use errText(err, fallback) do api.js)
//   onRetry   — se passado, mostra o botão "Tentar de novo"
//   retryLabel— rótulo alternativo pro botão de retry
//   onDismiss — se passado, mostra o "×" pra fechar
//   actions   — [{ label, onClick }] pra botões extras ("Ver planos", etc.)
//   children  — conteúdo livre no lugar do texto simples

const TONES = {
  error:   { bg: "var(--danger-bg)",  border: "var(--danger-border)",  text: "var(--danger-text)" },
  warn:    { bg: "var(--warn-bg)",    border: "var(--warn-border)",    text: "var(--warn-text)" },
  success: { bg: "var(--success-bg)", border: "var(--success-border)", text: "var(--success-text)" },
  info:    { bg: "var(--info-bg)",    border: "var(--info-border)",    text: "var(--info-text)" },
};

export default function AlertBanner({
  tone = "error",
  message,
  onRetry,
  retryLabel = "Tentar de novo",
  onDismiss,
  actions,
  children,
  style,
}) {
  if (!message && !children) return null;
  const c = TONES[tone] || TONES.error;
  const btn = {
    padding: "6px 12px", borderRadius: 8, background: c.text,
    color: "var(--color-background-primary)", border: "none",
    fontSize: 12, cursor: "pointer", fontWeight: 500, whiteSpace: "nowrap",
  };

  return (
    <div
      // Erro e aviso interrompem o leitor de tela; sucesso/info são educados.
      role={tone === "error" || tone === "warn" ? "alert" : "status"}
      style={{
        background: c.bg, border: `0.5px solid ${c.border}`, color: c.text,
        padding: "10px 14px", borderRadius: 8, fontSize: 13, marginBottom: 12,
        display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
        ...style,
      }}
    >
      <span style={{ flex: 1, minWidth: 200 }}>{children || message}</span>
      {onRetry && <button type="button" onClick={onRetry} style={btn}>{retryLabel}</button>}
      {(actions || []).map((a) => (
        <button type="button" key={a.label} onClick={a.onClick} style={btn}>{a.label}</button>
      ))}
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Fechar aviso"
          style={{ background: "none", border: "none", color: c.text, cursor: "pointer", fontSize: 16, lineHeight: 1, padding: "0 2px" }}
        >
          ×
        </button>
      )}
    </div>
  );
}
