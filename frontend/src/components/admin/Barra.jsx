// Barra de progresso fina com rótulo à esquerda e % (ou `direita`) à direita —
// usada nos painéis de andamento da colheita de cupons e do scraping.
export default function Barra({ valor, total, rotulo, direita }) {
  const pct = total > 0 ? Math.min(100, Math.round((valor / total) * 100)) : 0;
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12, marginBottom: 3 }}>
        <span>{rotulo}</span>
        <span style={{ color: "var(--color-text-secondary)", fontVariantNumeric: "tabular-nums" }}>{direita ?? `${pct}%`}</span>
      </div>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={valor}
        aria-label={rotulo}
        style={{ height: 6, borderRadius: 3, background: "var(--color-border-tertiary)", overflow: "hidden" }}
      >
        <div style={{ width: `${pct}%`, height: "100%", background: "var(--success-text)", transition: "width .3s" }} />
      </div>
    </div>
  );
}
