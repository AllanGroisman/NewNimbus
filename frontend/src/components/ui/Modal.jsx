import { useEffect, useRef } from "react";

// Diálogo modal do sistema.
//
// Props:
//   title    — título mostrado no topo (também vira o rótulo acessível)
//   onClose  — chamado no ✕, no ESC e no clique fora
//   danger   — pinta o título de vermelho (ações destrutivas)
//   confirmOnClickOutside — quando true, o clique no fundo NÃO fecha. Use em
//     modais com formulário: fechar por clique acidental jogava fora tudo que
//     tinha sido digitado, sem nenhum aviso. ESC e ✕ continuam fechando.
export default function Modal({ title, children, onClose, danger, confirmOnClickOutside }) {
  const boxRef = useRef(null);

  // ESC fecha o modal.
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose?.(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Trava o scroll da página de trás enquanto o modal está aberto — sem isso a
  // roda do mouse rolava o conteúdo do fundo em vez do modal.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  // Foco: leva pro primeiro campo do modal (ou pro próprio modal, se não houver
  // campo) e devolve pro elemento de origem ao fechar.
  useEffect(() => {
    const previouslyFocused = document.activeElement;
    const box = boxRef.current;
    const first = box?.querySelector("input, textarea, select");
    (first || box)?.focus?.();
    return () => { previouslyFocused?.focus?.(); };
  }, []);

  return (
    <div
      onClick={confirmOnClickOutside ? undefined : onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, padding: 20 }}
    >
      <div
        ref={boxRef}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : undefined}
        tabIndex={-1}
        onClick={e => e.stopPropagation()}
        style={{ background: "var(--color-background-primary)", borderRadius: 14, padding: 24, width: "100%", maxWidth: 440, maxHeight: "90vh", overflowY: "auto", outline: "none" }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <div style={{ fontSize: 16, fontWeight: 500, color: danger ? "var(--danger-text)" : "var(--color-text-primary)" }}>{title}</div>
          <button onClick={onClose} aria-label="Fechar" style={{ background: "transparent", border: "none", cursor: "pointer", fontSize: 22, lineHeight: 1, color: "var(--color-text-secondary)", padding: 0 }}>&times;</button>
        </div>
        {children}
      </div>
    </div>
  );
}
