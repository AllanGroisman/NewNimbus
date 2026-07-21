import { PRIMARY } from "../../data/constants";

// Rodinha girando reutilizável. Usa a keyframe global `nimbus-spin` (index.css),
// a mesma do BusyOverlay. Inline por padrão (fluxo de conexão do WhatsApp).
//
// Props:
//   size  — diâmetro em px (default 16)
//   color — cor do arco em movimento (default PRIMARY)
export default function Spinner({ size = 16, color = PRIMARY, style }) {
  const border = Math.max(2, Math.round(size / 8));
  return (
    <span
      aria-hidden="true"
      style={{
        display: "inline-block",
        width: size,
        height: size,
        border: `${border}px solid var(--color-border-tertiary)`,
        borderTopColor: color,
        borderRadius: "50%",
        animation: "nimbus-spin 0.85s linear infinite",
        ...style,
      }}
    />
  );
}
