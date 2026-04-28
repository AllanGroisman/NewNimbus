import { PRIMARY } from "../../data/constants";

const days = ["S", "T", "Q", "Q", "S", "S", "D"];

export default function MiniBar({ data, color }) {
  const max = Math.max(...data, 1);
  return (
    <div style={{ display: "flex", gap: 4, alignItems: "flex-end", height: 48 }}>
      {data.map((v, i) => (
        <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
          <div style={{ width: "100%", background: color || PRIMARY, opacity: v === 0 ? 0.15 : 0.7 + (v / max) * 0.3, borderRadius: 3, height: Math.max((v / max) * 36, v > 0 ? 4 : 2) }} />
          <span style={{ fontSize: 9, color: "var(--color-text-secondary)" }}>{days[i]}</span>
        </div>
      ))}
    </div>
  );
}
