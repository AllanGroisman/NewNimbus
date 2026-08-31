// Um número grande com a legenda embaixo — o tijolo dos painéis de contagem das
// telas de Cupom.
export default function Numero({ label, valor }) {
  return (
    <div>
      <div style={{ fontSize: 18, fontWeight: 600 }}>{valor ?? "—"}</div>
      <div style={{ color: "var(--color-text-secondary)" }}>{label}</div>
    </div>
  );
}
