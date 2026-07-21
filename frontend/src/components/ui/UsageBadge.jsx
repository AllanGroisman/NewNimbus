import Badge from "./Badge";

// Contador "atual/limite" de uso vs. plano de assinatura. Valores-sentinela
// de "ilimitado" no backend (billing/limits.js) são >= 99 — exibimos como "N label · ilimitado".
export default function UsageBadge({ current, limit, label }) {
  if (limit === undefined || limit === null) return null;
  const unlimited = limit >= 99;
  const atLimit = !unlimited && current >= limit;
  return (
    <Badge color={atLimit ? "amber" : "green"}>
      {unlimited
        ? `${current}${label ? ` ${label}` : ""} · ilimitado`
        : `${current}/${limit}${label ? ` ${label}` : ""}`}
    </Badge>
  );
}
