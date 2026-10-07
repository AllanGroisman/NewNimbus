import { PRIMARY, WA_GROUP_MAX, WA_GROUP_ENCHENDO } from "../../data/constants";
import { formatInt } from "../../data/desempenho";

// Quanto do teto de membros do WhatsApp o grupo já ocupa. A marca vertical é o
// ponto em que a tela passa a avisar que está enchendo.
export default function OcupacaoBarra({ membros, cap = WA_GROUP_MAX, enchendoEm = WA_GROUP_ENCHENDO }) {
  if (membros == null) return null;
  const pct = Math.min(100, (membros / cap) * 100);
  const enchendo = membros >= enchendoEm;
  return (
    <div
      role="meter"
      aria-valuemin={0}
      aria-valuemax={cap}
      aria-valuenow={membros}
      aria-label={`${formatInt(membros)} de ${formatInt(cap)} membros`}
      style={{ position: "relative", height: 6, borderRadius: 3, background: "var(--color-background-secondary)" }}
    >
      <div style={{ width: `${pct}%`, height: "100%", borderRadius: 3, background: enchendo ? "var(--warn-text)" : PRIMARY }} />
      <div style={{ position: "absolute", left: `${(enchendoEm / cap) * 100}%`, top: -2, bottom: -2, width: 1, background: "var(--color-border-secondary)" }} />
    </div>
  );
}
