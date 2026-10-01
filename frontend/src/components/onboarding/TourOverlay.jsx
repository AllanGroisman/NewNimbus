import { useState, useEffect, useLayoutEffect, useRef, useCallback } from "react";
import { PRIMARY } from "../../data/constants";
import { TOUR_TAB_EVENT } from "../../data/onboarding";

// Tour de holofote (task 38): escurece a tela e ilumina um pedaço de cada vez,
// com um balão explicando pra que serve aquilo. Roda em cima da tela de
// verdade, então o que a pessoa vê no tour é exatamente o que ela vai usar.
//
// Cada passo aponta pra um `data-tour="..."` espalhado pelas telas. Passo cujo
// alvo não existe (ex.: item que só admin enxerga, ou tela que ainda não
// carregou) é PULADO sozinho — um tour nunca pode travar o sistema.

const PAD = 6;                 // folga em volta do elemento iluminado
const BALLOON_W = 300;
// Tempo procurando o alvo antes de desistir do passo. Curto de propósito: a
// troca de tela é síncrona, então só cobre um ou dois quadros de renderização —
// e num celular, onde o menu lateral fica escondido, o tour não pode ficar
// parado meio segundo em cada passo que não existe ali.
const LOOKUP_TIMEOUT_MS = 450;

// Primeiro alvo VISÍVEL com esse data-tour. A sidebar, por exemplo, é renderizada
// duas vezes (desktop e gaveta do mobile) e a escondida mede 0x0.
function findTarget(anchor) {
  const nodes = document.querySelectorAll(`[data-tour="${CSS.escape ? CSS.escape(anchor) : anchor}"]`);
  for (const el of nodes) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return el;
  }
  return null;
}

// Um passo pode apontar pra vários elementos (ex.: as três lojas do menu) — aí
// o holofote abre um retângulo só, cobrindo todos. Alvo que não existe naquela
// tela é simplesmente ignorado; o passo só é pulado se nenhum aparecer.
function findTargets(anchor) {
  const list = Array.isArray(anchor) ? anchor : [anchor];
  return list.map(findTarget).filter(Boolean);
}

function unionRect(els) {
  let top = Infinity, left = Infinity, right = -Infinity, bottom = -Infinity;
  for (const el of els) {
    const r = el.getBoundingClientRect();
    top = Math.min(top, r.top);
    left = Math.min(left, r.left);
    right = Math.max(right, r.left + r.width);
    bottom = Math.max(bottom, r.top + r.height);
  }
  return { top, left, width: right - left, height: bottom - top };
}

export default function TourOverlay({ tour, onNavigate, onFinish }) {
  const steps = tour?.steps || [];
  const [i, setI] = useState(0);
  // Recorte do passo atual, guardado junto do índice: assim, ao trocar de
  // passo, o holofote do passo anterior some sozinho sem precisar limpar nada.
  const [spot, setSpot] = useState(null);
  const [balloonH, setBalloonH] = useState(190);
  const targetRef = useRef(null);
  const balloonRef = useRef(null);
  const step = steps[i];
  const rect = spot && spot.i === i ? spot.rect : null;

  // Callbacks em ref: o efeito que procura o alvo NÃO pode reiniciar só porque
  // o pai re-renderizou e criou funções novas — isso reiniciaria o passo em loop.
  const cbRef = useRef({ onNavigate, onFinish });
  useEffect(() => { cbRef.current = { onNavigate, onFinish }; });

  // Pra que lado o tour está andando. Passo cujo alvo não existe é pulado no
  // mesmo sentido: voltando, não pode empurrar a pessoa pra frente de novo.
  const dirRef = useRef(1);

  const finish = useCallback(() => cbRef.current.onFinish?.(), []);
  const goNext = useCallback(() => {
    dirRef.current = 1;
    if (i + 1 >= steps.length) finish();
    else setI(i + 1);
  }, [i, steps.length, finish]);
  const goPrev = useCallback(() => {
    dirRef.current = -1;
    setI(v => Math.max(0, v - 1));
  }, []);

  // Trava o scroll do fundo enquanto o tour roda (mesmo tratamento do Modal).
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  // Localiza o alvo do passo atual: troca de tela/aba se preciso, espera o
  // elemento aparecer, rola até ele e mede. Se não aparecer, pula o passo.
  //
  // A medição roda dentro de um requestAnimationFrame (nunca no corpo do
  // efeito): dá um quadro pra tela nova renderizar e evita mexer no estado
  // durante o próprio efeito.
  useEffect(() => {
    if (!step) { finish(); return; }
    let cancelled = false;
    let raf = 0;
    if (step.page) cbRef.current.onNavigate?.(step.page);
    if (step.tab) window.dispatchEvent(new CustomEvent(TOUR_TAB_EVENT, { detail: step.tab }));
    const startedAt = Date.now();

    const tick = () => {
      if (cancelled) return;
      const els = findTargets(step.anchor);
      if (els.length > 0) {
        targetRef.current = els;
        // Rola já medindo: o balão aparece no lugar certo na hora, e o listener
        // de scroll acompanha o resto da rolagem suave.
        els[0].scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
        setSpot({ i, rect: unionRect(els) });
        return;
      }
      if (Date.now() - startedAt > LOOKUP_TIMEOUT_MS) {
        const proximo = i + dirRef.current;
        if (proximo < 0 || proximo >= steps.length) finish();
        else setI(proximo);
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => { cancelled = true; cancelAnimationFrame(raf); };
  }, [i, step, steps.length, finish]);

  // Redimensionar a janela ou rolar move o alvo — o recorte tem que acompanhar.
  const hasRect = !!rect;
  useEffect(() => {
    if (!hasRect) return;
    const remeasure = () => {
      const els = targetRef.current;
      if (els?.length) setSpot({ i, rect: unionRect(els) });
    };
    window.addEventListener("resize", remeasure);
    window.addEventListener("scroll", remeasure, true);
    return () => {
      window.removeEventListener("resize", remeasure);
      window.removeEventListener("scroll", remeasure, true);
    };
  }, [hasRect, i]);

  // Teclado: setas navegam, ESC sai.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); finish(); }
      else if (e.key === "ArrowRight") { e.preventDefault(); goNext(); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); goPrev(); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [goNext, goPrev, finish]);

  // Foco no balão a cada passo, pra leitor de tela anunciar o texto novo.
  useEffect(() => { balloonRef.current?.focus?.(); }, [i, hasRect]);
  useLayoutEffect(() => {
    const h = balloonRef.current?.offsetHeight;
    if (h) setBalloonH(h);
  }, [i, hasRect]);

  if (!step) return null;

  const vw = typeof window !== "undefined" ? window.innerWidth : 1024;
  const vh = typeof window !== "undefined" ? window.innerHeight : 768;
  const width = Math.min(BALLOON_W, vw - 24);

  // O balão só existe colado no alvo. Enquanto o passo está sendo localizado
  // (troca de aba, scroll), fica só o escurecido — antes ele piscava no meio da
  // tela e depois saltava pro lugar certo.
  let top = 0;
  let left = 0;
  if (rect) {
    const below = rect.top + rect.height + PAD + 12;
    const above = rect.top - PAD - 12 - balloonH;
    const fitsBelow = below + balloonH + 12 <= vh;
    // Alvo mais alto que a tela (comum no celular, com tudo empilhado): não
    // cabe nem embaixo nem em cima, e o balão vai pro rodapé da tela — preso no
    // topo ele cobria justamente o começo do que estava sendo mostrado.
    top = fitsBelow ? below : above >= 12 ? above : Math.max(12, vh - balloonH - 12);
    left = Math.min(Math.max(12, rect.left), vw - width - 12);
  }

  const btn = (extra = {}) => ({
    padding: "7px 14px", borderRadius: 8, fontSize: 12, fontWeight: 500,
    border: "none", cursor: "pointer", ...extra,
  });

  return (
    <>
      {/* Bloqueia cliques na tela de trás enquanto o tour roda. */}
      <div style={{ position: "fixed", inset: 0, zIndex: 9000, background: rect ? "transparent" : "rgba(0,0,0,0.55)" }} />

      {/* O recorte iluminado: a sombra gigante é o que escurece o resto da tela. */}
      {rect && (
        <div
          aria-hidden="true"
          style={{
            position: "fixed", zIndex: 9001, pointerEvents: "none",
            top: rect.top - PAD, left: rect.left - PAD,
            width: rect.width + PAD * 2, height: rect.height + PAD * 2,
            borderRadius: 10,
            boxShadow: "0 0 0 9999px rgba(0,0,0,0.55)",
            outline: `2px solid ${PRIMARY}`,
            transition: "top 0.18s, left 0.18s, width 0.18s, height 0.18s",
          }}
        />
      )}

      {rect && (
      <div
        ref={balloonRef}
        role="dialog"
        aria-modal="true"
        aria-label={`${tour.title}: ${step.title}`}
        tabIndex={-1}
        style={{
          position: "fixed", zIndex: 9002, top, left, width,
          // Texto longo em tela baixa (celular deitado): rola dentro do balão em
          // vez de empurrar os botões pra fora da tela, com a página travada.
          maxHeight: vh - 24, overflowY: "auto",
          background: "var(--color-background-primary)",
          border: "0.5px solid var(--color-border-tertiary)",
          borderRadius: 12, padding: 16, outline: "none",
          boxShadow: "0 8px 28px rgba(0,0,0,0.28)",
        }}
      >
        <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 4 }}>
          {tour.title} · {i + 1} de {steps.length}
        </div>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>{step.title}</div>
        <div style={{ fontSize: 13, color: "var(--color-text-secondary)", lineHeight: 1.5, marginBottom: 14 }}>
          {step.text}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <button onClick={finish} style={btn({ background: "transparent", color: "var(--color-text-secondary)", padding: "9px 6px", marginLeft: -6, whiteSpace: "nowrap" })}>
            Sair do tour
          </button>
          <div style={{ flex: 1 }} />
          {i > 0 && (
            <button onClick={goPrev} style={btn({ background: "var(--color-background-secondary)", color: "var(--color-text-primary)" })}>
              ← Voltar
            </button>
          )}
          <button onClick={goNext} style={btn({ background: PRIMARY, color: "#fff" })}>
            {i + 1 >= steps.length ? "Terminar" : "Próximo →"}
          </button>
        </div>
      </div>
      )}
    </>
  );
}
