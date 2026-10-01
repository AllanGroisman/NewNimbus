// Media queries no JS — pro que o CSS sozinho não resolve: comportamento que
// muda no celular (autofoco, modo do QR, arrastar × botões). Layout continua
// nas classes do index.css; aqui é só "está no celular?" / "é toque?".
//
// Sem matchMedia (testes em happy-dom antigos, SSR) tudo responde false, e a
// tela fica no comportamento de desktop — o mesmo que os testes esperam.
import { useEffect, useState } from "react";

// Mesmo breakpoint do index.css (.mobile-only / .desktop-only).
export const MOBILE = "(max-width: 768px)";
// Dedo em vez de mouse — vale também pra tablet deitado, que passa dos 768px.
export const TOUCH = "(pointer: coarse)";

export function matches(query) {
  try {
    return typeof window !== "undefined" && Boolean(window.matchMedia?.(query)?.matches);
  } catch {
    return false;
  }
}

export const isTouch = () => matches(TOUCH);
export const isMobile = () => matches(MOBILE);

export function useMedia(query) {
  const [hit, setHit] = useState(() => matches(query));
  useEffect(() => {
    const mql = typeof window !== "undefined" ? window.matchMedia?.(query) : null;
    if (!mql) return;
    const onChange = () => setHit(mql.matches);
    onChange();
    // Safari < 14 só conhece addListener.
    if (mql.addEventListener) mql.addEventListener("change", onChange);
    else mql.addListener?.(onChange);
    return () => {
      if (mql.removeEventListener) mql.removeEventListener("change", onChange);
      else mql.removeListener?.(onChange);
    };
  }, [query]);
  return hit;
}
