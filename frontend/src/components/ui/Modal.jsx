import { useEffect, useRef } from "react";
import { isTouch } from "../../data/useMedia";

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
  // campo) e devolve pro elemento de origem ao fechar. No toque o foco vai pra
  // caixa, não pro campo: focar um campo abre o teclado na hora, por cima do
  // que o modal tem pra mostrar (o aviso do DM em massa, o QR do WhatsApp).
  useEffect(() => {
    const previouslyFocused = document.activeElement;
    const box = boxRef.current;
    const first = isTouch() ? null : box?.querySelector("input, textarea, select");
    (first || box)?.focus?.();
    return () => { previouslyFocused?.focus?.(); };
  }, []);

  // Padding e altura máxima moram nas classes modal-* do index.css: mudam no
  // celular (menos margem, caixa colada no topo, longe do teclado).
  return (
    <div
      className="modal-backdrop"
      onClick={confirmOnClickOutside ? undefined : onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, padding: 20 }}
    >
      <div
        ref={boxRef}
        className="modal-box"
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : undefined}
        tabIndex={-1}
        onClick={e => e.stopPropagation()}
        style={{ background: "var(--color-background-primary)", borderRadius: 14, width: "100%", maxWidth: 440, display: "flex", flexDirection: "column", outline: "none" }}
      >
        <div className="modal-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 12, flexShrink: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 500, minWidth: 0, overflowWrap: "anywhere", color: danger ? "var(--danger-text)" : "var(--color-text-primary)" }}>{title}</div>
          <button onClick={onClose} aria-label="Fechar" style={{ background: "transparent", border: "none", cursor: "pointer", fontSize: 22, lineHeight: 1, color: "var(--color-text-secondary)", width: 36, height: 36, margin: "-6px -8px -6px 0", borderRadius: 8, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>&times;</button>
        </div>
        {/* Só o corpo rola: o título e o ✕ ficam sempre à vista. O paddingTop
            dá folga pro contorno de foco do primeiro campo não ser cortado. */}
        <div className="modal-body" style={{ overflowY: "auto", minHeight: 0, paddingTop: 4 }}>
          {children}
        </div>
      </div>
    </div>
  );
}
