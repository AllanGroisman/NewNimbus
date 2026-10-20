import { useEffect, useRef, useState } from "react";

// Bolinha "i" com uma explicação curta. Abre ao passar o mouse (desktop) ou ao
// tocar (celular, onde não existe hover); fecha ao tocar fora ou com Esc.
// `label` dá nome ao botão no leitor de tela; `children` é o texto do balão.
const LARGURA = 260;
const MARGEM = 16;

// Quanto o balão anda pra esquerda pra caber na tela: abre pra direita quando
// a bolinha está perto da margem esquerda, e recua quando ela está mais pro
// meio (um card da coluna da direita no celular).
function deslocamento(el) {
  if (!el || typeof window === "undefined") return { left: -8, largura: LARGURA };
  const x = el.getBoundingClientRect().left;
  const largura = Math.min(LARGURA, window.innerWidth - 2 * MARGEM);
  return { left: Math.max(MARGEM - x, Math.min(-8, window.innerWidth - MARGEM - x - largura)), largura };
}

export default function InfoTip({ label, children }) {
  const [hover, setHover] = useState(false);
  const [pinned, setPinned] = useState(false);
  const ref = useRef(null);
  const open = hover || pinned;
  const pos = open ? deslocamento(ref.current) : null;

  useEffect(() => {
    if (!pinned) return;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setPinned(false); };
    const onKey = (e) => { if (e.key === "Escape") setPinned(false); };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [pinned]);

  return (
    <span
      ref={ref}
      style={{ position: "relative", display: "inline-flex" }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        className="hit"
        onClick={() => setPinned(p => !p)}
        style={{
          width: 16, height: 16, borderRadius: "50%", padding: 0,
          border: "1px solid var(--color-border-secondary)", background: "transparent",
          color: "var(--color-text-secondary)", fontSize: 10, fontWeight: 600,
          fontFamily: "Georgia, serif", fontStyle: "italic", lineHeight: "14px",
          cursor: "pointer", flexShrink: 0,
        }}
      >i</button>
      {open && (
        <span
          role="tooltip"
          style={{
            position: "absolute", top: "calc(100% + 6px)", left: pos.left, zIndex: 20,
            width: "max-content", maxWidth: pos.largura,
            padding: "8px 10px", borderRadius: 8,
            background: "var(--color-background-primary)", color: "var(--color-text-primary)",
            border: "0.5px solid var(--color-border-secondary)",
            boxShadow: "0 4px 14px rgba(0,0,0,0.12)",
            fontSize: 12, lineHeight: 1.45, fontWeight: 400, whiteSpace: "normal",
          }}
        >{children}</span>
      )}
    </span>
  );
}
