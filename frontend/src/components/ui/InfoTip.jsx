import { useEffect, useRef, useState } from "react";

// Bolinha "i" com uma explicação curta. Abre ao passar o mouse (desktop) ou ao
// tocar (celular, onde não existe hover); fecha ao tocar fora ou com Esc.
// `label` dá nome ao botão no leitor de tela; `children` é o texto do balão.
export default function InfoTip({ label, children }) {
  const [hover, setHover] = useState(false);
  const [pinned, setPinned] = useState(false);
  const ref = useRef(null);
  const open = hover || pinned;

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
            // Abre pra direita: pensado pra bolinha perto da margem esquerda (rótulo
            // de uma linha), com largura que ainda cabe numa tela de 320px.
            position: "absolute", top: "calc(100% + 6px)", left: -8, zIndex: 20,
            width: "max-content", maxWidth: "min(260px, calc(100vw - 120px))",
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
