import { useEffect, useRef } from "react";
import { PRIMARY, PRIMARY_DARK } from "../../data/constants";

// Faixa de abas. No celular não cabe tudo e ela rola de lado: a aba ativa é
// trazida pra dentro da tela quando muda (inclusive quando quem muda é o
// código, ex.: "ir para Agendamento"), e o degradê na borda avisa que tem mais.
export default function Tabs({ tabs, active, onChange }) {
  const stripRef = useRef(null);
  // Rola só a faixa, nunca a janela: scrollIntoView puxaria a página pra cima
  // quando a troca de aba vem de um botão lá embaixo.
  useEffect(() => {
    const strip = stripRef.current;
    const el = strip?.querySelector('[aria-current="page"]');
    if (!el) return;
    const left = el.offsetLeft;
    const right = left + el.offsetWidth;
    if (left < strip.scrollLeft) strip.scrollLeft = Math.max(0, left - 24);
    else if (right > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = right - strip.clientWidth + 24;
  }, [active]);

  return (
    <div style={{ position: "relative", marginBottom: 20 }}>
      <div ref={stripRef} style={{ position: "relative", display: "flex", borderBottom: "0.5px solid var(--color-border-tertiary)", overflowX: "auto", overflowY: "hidden" }}>
        {tabs.map(t => (
          <button
            key={t.id}
            data-tour={`tab-${t.id}`}
            aria-current={active === t.id ? "page" : undefined}
            onClick={() => onChange(t.id)}
            style={{
              padding: "10px 14px", border: "none", background: "transparent", fontSize: 13, cursor: "pointer",
              color: active === t.id ? PRIMARY_DARK : "var(--color-text-secondary)",
              fontWeight: active === t.id ? 500 : 400,
              // Sublinhado por sombra, não por borda + margin negativa: a margin
              // dava 1px de rolagem vertical e a faixa balançava ao arrastar.
              boxShadow: active === t.id ? `inset 0 -2px 0 ${PRIMARY}` : "none",
              display: "flex", alignItems: "center", gap: 5, whiteSpace: "nowrap", flexShrink: 0,
            }}
          >
            {t.label}
            {t.dot && <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#EF9F27", display: "inline-block" }} />}
          </button>
        ))}
      </div>
      <div aria-hidden="true" className="mobile-only" style={{
        position: "absolute", top: 0, right: 0, bottom: 1, width: 24, pointerEvents: "none",
        background: "linear-gradient(to right, transparent, var(--color-background-secondary))",
      }} />
    </div>
  );
}
