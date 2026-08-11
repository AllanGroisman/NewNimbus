// Controles de página: ← Anterior · X / Y · Próxima →
//
// Esse markup estava copiado em três telas (catálogo do /produtos, admin de
// repasse e catálogo do admin-scraper), cada uma com uma variação do guard e do
// estilo dos botões. Uma página só não tem o que paginar, então com
// `totalPages <= 1` o componente não renderiza nada — quem chama não precisa do
// próprio `{totalPages > 1 && ...}`.
export default function Pagination({ page, totalPages, onChange, disabled = false }) {
  const total = Math.max(1, Number(totalPages) || 1);
  if (total <= 1) return null;

  const cur = Math.min(total, Math.max(1, Number(page) || 1));
  const first = cur <= 1;
  const last = cur >= total;

  return (
    <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 8, marginTop: 18 }}>
      <button
        type="button"
        onClick={() => onChange(Math.max(1, cur - 1))}
        disabled={disabled || first}
        style={pagBtnStyle(disabled || first)}
      >
        ← Anterior
      </button>
      <span style={{ fontSize: 12, alignSelf: "center", padding: "0 10px" }}>{cur} / {total}</span>
      <button
        type="button"
        onClick={() => onChange(Math.min(total, cur + 1))}
        disabled={disabled || last}
        style={pagBtnStyle(disabled || last)}
      >
        Próxima →
      </button>
    </div>
  );
}

function pagBtnStyle(disabled) {
  return {
    padding: "6px 14px", borderRadius: 7,
    border: "0.5px solid var(--color-border-secondary)",
    background: "transparent", color: "inherit",
    fontSize: 12, fontFamily: "inherit",
    cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1,
  };
}
