import { PRIMARY, PRIMARY_DARK } from "../../data/constants";

export default function Tabs({ tabs, active, onChange }) {
  return (
    <div style={{ display: "flex", borderBottom: "0.5px solid var(--color-border-tertiary)", marginBottom: 20, overflowX: "auto" }}>
      {tabs.map(t => (
        <button
          key={t.id}
          data-tour={`tab-${t.id}`}
          onClick={() => onChange(t.id)}
          style={{
            padding: "8px 14px", border: "none", background: "transparent", fontSize: 13, cursor: "pointer",
            color: active === t.id ? PRIMARY_DARK : "var(--color-text-secondary)",
            fontWeight: active === t.id ? 500 : 400,
            borderBottom: active === t.id ? `2px solid ${PRIMARY}` : "2px solid transparent",
            marginBottom: -1, display: "flex", alignItems: "center", gap: 5, whiteSpace: "nowrap",
          }}
        >
          {t.label}
          {t.dot && <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#EF9F27", display: "inline-block" }} />}
        </button>
      ))}
    </div>
  );
}
