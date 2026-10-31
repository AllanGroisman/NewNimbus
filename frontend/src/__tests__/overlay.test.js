// Pintor do overlay do Downloader (overlay.js).
//
// A caixa da camada de tweet decide o que o clique na prévia seleciona e
// arrasta, então tem que cobrir o retângulo atrás do tweet e acompanhar o
// "Tamanho do tweet". E o plano das camadas que somem decide quais PNGs o
// ffmpeg empilha: errar ali faz camada sumir na hora errada ou trocar de ordem.
import { describe, it, expect } from "vitest";
import { OUTRO, exitAlpha, exitEnd, hasOutro, hitTest, layerBox, overlayPlan, paintOutro } from "../components/admin/downloader/overlay";

// Sem canvas de verdade: a largura do texto é proporcional ao tamanho da fonte,
// o que basta para a geometria ser determinística.
const fakeCtx = () => ({
  font: "",
  measureText(text) {
    const px = Number(/(\d+)px/.exec(this.font)?.[1] || 10);
    return { width: String(text).length * px * 0.5 };
  },
});

const tweet = (extra = {}) => ({
  type: "tweet", x: 100, y: 200, w: 800, size: 50,
  name: "Nome", handle: "conta", text: "oi", date: "17:00", ...extra,
});

describe("layerBox do tweet", () => {
  it("escala a partir do canto (x, y)", () => {
    const ctx = fakeCtx();
    const a = layerBox(ctx, tweet());
    const b = layerBox(ctx, tweet({ scale: 2 }));
    expect(b.x).toBe(a.x);
    expect(b.y).toBe(a.y);
    expect(b.w).toBeCloseTo(a.w * 2);
    expect(b.h).toBeCloseTo(a.h * 2);
  });

  it("o retângulo soma a margem dos quatro lados, sem mover o texto", () => {
    const ctx = fakeCtx();
    const a = layerBox(ctx, tweet());
    const b = layerBox(ctx, tweet({ card: { show: true, padding: 40 } }));
    expect(b).toEqual({ x: a.x - 40, y: a.y - 40, w: a.w + 80, h: a.h + 80 });
  });

  it("retângulo desligado não muda a caixa", () => {
    const ctx = fakeCtx();
    expect(layerBox(ctx, tweet({ card: { show: false, padding: 40 } }))).toEqual(layerBox(ctx, tweet()));
  });

  it("a margem também escala com o tweet", () => {
    const ctx = fakeCtx();
    const a = layerBox(ctx, tweet({ scale: 0.5 }));
    const b = layerBox(ctx, tweet({ scale: 0.5, card: { show: true, padding: 40 } }));
    expect(b.x).toBeCloseTo(a.x - 20);
    expect(b.w).toBeCloseTo(a.w + 40);
  });

  it("escala absurda fica limitada", () => {
    const ctx = fakeCtx();
    const a = layerBox(ctx, tweet());
    expect(layerBox(ctx, tweet({ scale: 0 }))).toEqual(a); // 0 = sem escala
    expect(layerBox(ctx, tweet({ scale: 100 })).w).toBeCloseTo(a.w * 5);
  });
});

describe("hitTest", () => {
  it("clique na margem do retângulo, fora do texto, seleciona o tweet", () => {
    const ctx = fakeCtx();
    const template = { layers: [tweet({ card: { show: true, padding: 40 } })] };
    expect(hitTest(ctx, template, 80, 180)).toBe(0);
    expect(hitTest(ctx, { layers: [tweet()] }, 80, 180)).toBe(-1);
  });
});

describe("camada que some", () => {
  const camada = (nome, exit) => ({ type: "box", nome, x: 0, y: 0, w: 10, h: 10, ...(exit ? { exit } : {}) });
  const nomes = (t) => t.layers.map((l) => l.nome);

  it("a opacidade cai de 1 a 0 durante o sumiço, e sem tempo tudo aparece", () => {
    const l = camada("t", { at: 2, fade: 1 });
    expect(exitAlpha(l, 1.9)).toBe(1);
    expect(exitAlpha(l, 2.5)).toBeCloseTo(0.5);
    expect(exitAlpha(l, 3)).toBe(0);
    expect(exitAlpha(l, undefined)).toBe(1);
    expect(exitAlpha(camada("fixa"), 99)).toBe(1);
  });

  it("sumiço de 0s corta seco", () => {
    const l = camada("t", { at: 2, fade: 0 });
    expect(exitAlpha(l, 1.99)).toBe(1);
    expect(exitAlpha(l, 2)).toBe(0);
  });

  it("sem camada que some, o plano é o PNG único de sempre", () => {
    const t = { layers: [camada("a"), camada("b")] };
    const plano = overlayPlan(t);
    expect(nomes(plano.base)).toEqual(["a", "b"]);
    expect(plano.fades).toEqual([]);
  });

  it("fades são o quadro inteiro de antes de cada sumiço, o primeiro a sumir no topo", () => {
    const t = {
      format: "vertical",
      layers: [
        camada("fundo"),
        camada("tweet", { at: 5, fade: 1 }),
        camada("logo"), // por cima do tweet: tem que continuar por cima até ele sumir
        camada("aviso", { at: 2, fade: 0.5 }),
        camada("selo", { at: 5, fade: 1 }), // mesmo momento do tweet: mesmo PNG
      ],
    };
    const { base, fades } = overlayPlan(t);
    expect(nomes(base)).toEqual(["fundo", "logo"]);
    expect(fades.map((f) => [f.at, f.fade, nomes(f.template)])).toEqual([
      [5, 1, ["fundo", "tweet", "logo", "selo"]],
      [2, 0.5, ["fundo", "tweet", "logo", "aviso", "selo"]],
    ]);
    expect(fades[0].template.format).toBe("vertical");
    expect(exitEnd(t)).toBe(6);
  });
});

// Tela final: o que liga o concat no backend e o que vai pintado no PNG dela.
describe("tela final", () => {
  it("hasOutro só com show ligado e duração positiva", () => {
    expect(hasOutro({})).toBe(false);
    expect(hasOutro({ outro: { ...OUTRO, show: false } })).toBe(false);
    expect(hasOutro({ outro: { ...OUTRO, seconds: 0 } })).toBe(false);
    expect(hasOutro({ outro: OUTRO })).toBe(true);
  });

  const pintor = () => {
    const ctx = {
      ...fakeCtx(), textos: [], fills: 0,
      clearRect() {}, fillRect() {}, beginPath() {}, roundRect() {},
      fill() { this.fills++; },
      fillText(t, x, y) { this.textos.push({ t, x, y }); },
    };
    return ctx;
  };

  it("pinta o texto centralizado no quadro e o botão embaixo dele", () => {
    const ctx = pintor();
    paintOutro(ctx, { format: "vertical", outro: OUTRO });
    const cta = ctx.textos.at(-1);
    expect(cta.t).toBe(OUTRO.cta);
    expect(ctx.textos.slice(0, -1).map((l) => l.t).join(" ")).toContain("Entre no nosso grupo de descontos!");
    for (const l of ctx.textos) expect(l.x).toBe(540);
    expect(cta.y).toBeGreaterThan(ctx.textos.at(-2).y);
    expect(ctx.fills).toBe(1);
  });

  it("sem botão, nada de pílula", () => {
    const ctx = pintor();
    paintOutro(ctx, { format: "vertical", outro: { ...OUTRO, cta: "" } });
    expect(ctx.fills).toBe(0);
    expect(ctx.textos.length).toBeGreaterThan(0);
  });
});
