// Os pares de cor moram no index.css (--badge-<cor>-bg / -text), com um conjunto
// por tema: aqui eram hex claros fixos, e no tema escuro os selos viravam
// pastilhas claras no meio da tela.
const COLORS = ["green", "red", "amber", "blue", "teal", "gray", "purple", "rose", "indigo", "cyan", "orange"];

export default function Badge({ color, children }) {
  const c = COLORS.includes(color) ? color : "gray";
  return (
    <span style={{
      background: `var(--badge-${c}-bg)`, color: `var(--badge-${c}-text)`,
      fontSize: 11, fontWeight: 500, padding: "2px 8px", borderRadius: 6,
      display: "inline-block", whiteSpace: "nowrap",
    }}>
      {children}
    </span>
  );
}
