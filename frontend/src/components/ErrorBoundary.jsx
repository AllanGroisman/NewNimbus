import { Component } from "react";

// Rede de segurança contra tela branca. Sem isso, qualquer exceção durante o
// render (um dado malformado vindo do backend, por exemplo) desmonta a árvore
// inteira do React e o usuário fica olhando uma página em branco, sem nem
// saber que deu erro.
//
// Precisa ser class component: getDerivedStateFromError/componentDidCatch não
// têm equivalente em hooks.
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Log técnico fica no console; a tela mostra só o texto em português.
    console.error("[nimbus] erro de render:", error, info?.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div style={{
        minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
        padding: 24, background: "var(--color-background-secondary, #f6f7f9)",
      }}>
        <div style={{
          maxWidth: 460, width: "100%", textAlign: "center",
          background: "var(--color-background-primary, #fff)",
          border: "0.5px solid var(--color-border-secondary, #e3e5e8)",
          borderRadius: 12, padding: "28px 24px",
        }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>⚠️</div>
          <h1 style={{ fontSize: 18, margin: "0 0 8px", color: "var(--color-text-primary, #1a1a1a)" }}>
            Algo deu errado nesta tela
          </h1>
          <p style={{ fontSize: 14, lineHeight: 1.5, margin: "0 0 20px", color: "var(--color-text-secondary, #666)" }}>
            Não foi você. Recarregue a página para continuar — se acontecer de novo, avise o suporte.
          </p>
          <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{
                padding: "9px 18px", borderRadius: 8, border: "none", cursor: "pointer",
                fontSize: 13, fontWeight: 500,
                background: "var(--color-primary, #4f46e5)", color: "#fff",
              }}
            >
              Recarregar a página
            </button>
            <button
              type="button"
              onClick={() => { window.location.href = "/"; }}
              style={{
                padding: "9px 18px", borderRadius: 8, cursor: "pointer",
                fontSize: 13, fontWeight: 500,
                background: "transparent",
                border: "0.5px solid var(--color-border-secondary, #e3e5e8)",
                color: "var(--color-text-primary, #1a1a1a)",
              }}
            >
              Voltar ao painel
            </button>
          </div>
          {import.meta.env?.DEV && (
            <details style={{ marginTop: 20, textAlign: "left", fontSize: 12 }}>
              <summary style={{ cursor: "pointer", color: "var(--color-text-secondary, #666)" }}>
                Detalhe técnico (só em desenvolvimento)
              </summary>
              <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", marginTop: 8 }}>
                {String(this.state.error?.stack || this.state.error)}
              </pre>
            </details>
          )}
        </div>
      </div>
    );
  }
}
