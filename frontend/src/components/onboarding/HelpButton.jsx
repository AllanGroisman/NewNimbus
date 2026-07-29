import { useState, useEffect } from "react";
import { PRIMARY } from "../../data/constants";
import { tourForPage } from "../../data/onboarding";

// Botão de ajuda fixo no canto (tasks 38 e 39): oferece o tour da tela em que
// a pessoa está agora e os tutoriais escritos.
// Fica abaixo dos modais (z-index 100) pra não flutuar por cima de um diálogo.
export default function HelpButton({ page, hasGroupOpen, onStartTour, onOpenTutorials }) {
  const [open, setOpen] = useState(false);
  const tour = tourForPage(page, hasGroupOpen);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const item = {
    display: "block", width: "100%", textAlign: "left",
    padding: "9px 12px", background: "transparent", border: "none",
    fontSize: 13, cursor: "pointer", color: "var(--color-text-primary)",
  };

  return (
    <>
      {open && (
        <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 94 }} />
      )}
      <div style={{ position: "fixed", right: 18, bottom: 18, zIndex: 95 }}>
        {open && (
          <div
            role="menu"
            aria-label="Ajuda"
            style={{
              position: "absolute", bottom: 52, right: 0, width: 250,
              background: "var(--color-background-primary)",
              border: "0.5px solid var(--color-border-tertiary)",
              borderRadius: 12, padding: 6, boxShadow: "0 8px 28px rgba(0,0,0,0.22)",
            }}
          >
            <button role="menuitem" style={item} onClick={() => { setOpen(false); onStartTour?.(tour.id); }}>
              ✨ {tour.title}
              <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 2 }}>{tour.description || "Mostra onde fica cada coisa desta tela."}</div>
            </button>
            <button role="menuitem" style={item} onClick={() => { setOpen(false); onOpenTutorials?.(); }}>
              ⊙ Ver todos os tutoriais e tours
            </button>
          </div>
        )}
        <button
          data-tour="help-button"
          onClick={() => setOpen(v => !v)}
          aria-label="Ajuda e guias"
          aria-expanded={open}
          title="Ajuda e guias"
          style={{
            width: 40, height: 40, borderRadius: "50%", border: "none", cursor: "pointer",
            background: PRIMARY, color: "#fff", fontSize: 18, fontWeight: 600,
            boxShadow: "0 4px 14px rgba(0,0,0,0.22)",
          }}
        >
          ?
        </button>
      </div>
    </>
  );
}
