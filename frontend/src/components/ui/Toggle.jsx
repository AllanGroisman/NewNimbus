import { PRIMARY } from "../../data/constants";

export default function Toggle({ value, onChange }) {
  return (
    <div
      onClick={() => onChange(!value)}
      style={{
        width: 40, height: 22, borderRadius: 11,
        background: value ? PRIMARY : "var(--color-border-tertiary)",
        cursor: "pointer", position: "relative", transition: "background 0.2s", flexShrink: 0,
      }}
    >
      <div style={{
        width: 18, height: 18, borderRadius: "50%", background: "#fff",
        position: "absolute", top: 2, left: value ? 20 : 2, transition: "left 0.2s",
      }} />
    </div>
  );
}
