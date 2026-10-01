// Base de 130px: no celular cabem 2 por linha (com 100px eram 3 espremidos, e o
// "R$ 12.345,67" quebrava depois do "R$" ou vazava do card).
export default function StatCard({ label, value, sub, color }) {
  return (
    <div style={{ background: "var(--color-background-secondary)", borderRadius: 10, padding: "12px 14px", flex: "1 1 130px", minWidth: 0 }}>
      <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 500, whiteSpace: "nowrap", color: color || "var(--color-text-primary)" }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 2 }}>{sub}</div>}
    </div>
  );
}
