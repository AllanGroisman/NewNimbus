// Estilos inline no mesmo padrão do Nimbus (cupomEstilos.js / ProductSearchTab.jsx).
import { PRIMARY, PRIMARY_DARK, PRIMARY_LIGHT } from "./constants";

export const cardStyle = {
  background: "var(--color-background-primary)",
  border: "0.5px solid var(--color-border-tertiary)",
  borderRadius: 12,
  padding: 16,
};

export const inputStyle = {
  width: "100%", padding: "9px 11px", borderRadius: 8,
  border: "0.5px solid var(--color-border-tertiary)",
  background: "var(--color-background-secondary)",
  color: "var(--color-text-primary)",
  fontSize: 13, fontFamily: "inherit", boxSizing: "border-box",
};

export const labelStyle = {
  fontSize: 12, color: "var(--color-text-secondary)",
  display: "block", marginBottom: 6,
};

export const hintStyle = { fontSize: 12, color: "var(--color-text-secondary)" };

export const botaoPrimario = (off) => ({
  padding: "9px 18px", borderRadius: 8, border: "none", fontSize: 13, fontWeight: 500,
  background: PRIMARY, color: "#fff", cursor: off ? "not-allowed" : "pointer", opacity: off ? 0.6 : 1,
  display: "inline-flex", alignItems: "center", gap: 8, whiteSpace: "nowrap", textDecoration: "none",
});

export const botaoSecundario = {
  padding: "7px 14px", borderRadius: 8, fontSize: 12, cursor: "pointer",
  border: "1px solid var(--color-border-tertiary)", background: "transparent",
  color: "var(--color-text-primary)", whiteSpace: "nowrap", textDecoration: "none",
  display: "inline-flex", alignItems: "center", gap: 6,
};

export const chipStyle = ({ active }) => ({
  padding: "6px 14px", borderRadius: 8,
  border: `0.5px solid ${active ? PRIMARY : "var(--color-border-tertiary)"}`,
  background: active ? PRIMARY_LIGHT : "transparent",
  color: active ? PRIMARY_DARK : "var(--color-text-secondary)",
  fontSize: 13, fontFamily: "inherit", cursor: "pointer",
  fontWeight: active ? 500 : 400,
});

export const modalBackdrop = {
  position: "fixed", inset: 0, zIndex: 100,
  background: "rgba(0,0,0,0.5)",
  display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
};

export const modalCard = {
  background: "var(--color-background-primary)",
  border: "0.5px solid var(--color-border-tertiary)",
  borderRadius: 12,
  width: "min(1040px, 100%)", maxHeight: "92vh",
  display: "flex", flexDirection: "column", overflow: "hidden",
};

export const skelBar = {
  height: 12, borderRadius: 6,
  background: "var(--color-background-secondary)",
  animation: "nimbus-skeleton 1.2s ease-in-out infinite",
};
