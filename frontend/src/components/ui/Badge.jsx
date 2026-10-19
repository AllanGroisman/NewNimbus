// Os pares de cor moram no index.css (--badge-<cor>-bg / -text), com um conjunto
// por tema: aqui eram hex claros fixos, e no tema escuro os selos viravam
// pastilhas claras no meio da tela.
const COLORS = ["green", "red", "amber", "blue", "teal", "gray", "purple", "rose", "indigo", "cyan", "orange"];

// `quebra`: texto longo quebra linha em vez de passar da largura do celular.
export default function Badge({ color, children, quebra = false }) {
  const c = COLORS.includes(color) ? color : "gray";
  return (
    <span style={{
      background: `var(--badge-${c}-bg)`, color: `var(--badge-${c}-text)`,
      fontSize: 11, fontWeight: 500, padding: "2px 8px", borderRadius: 6,
      display: "inline-block", whiteSpace: quebra ? "normal" : "nowrap",
      ...(quebra ? { maxWidth: "100%", overflowWrap: "anywhere" } : {}),
    }}>
      {children}
    </span>
  );
}
