// Tela mostrada no lugar da página de afiliado quando o admin trancou a loja.
// O texto vem do painel admin (aba da loja → Disponibilidade).
export default function StoreLockedNotice({ storeLabel, message }) {
  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <h2 style={{ fontSize: 18, fontWeight: 500 }}>{storeLabel}</h2>
      </div>
      <div style={{
        background: "var(--color-background-primary)",
        border: "0.5px solid var(--color-border-tertiary)",
        borderRadius: 12, padding: "40px 24px", textAlign: "center",
      }}>
        <div style={{ fontSize: 32, marginBottom: 12 }}>🔒</div>
        <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 8 }}>{storeLabel} indisponível</div>
        <div style={{ fontSize: 13, color: "var(--color-text-secondary)", lineHeight: 1.6, maxWidth: 420, margin: "0 auto" }}>
          {message}
        </div>
      </div>
    </div>
  );
}
