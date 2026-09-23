// Pintor do overlay. A MESMA função desenha a prévia na tela e gera o PNG que o
// ffmpeg queima no vídeo — é isso que garante que o arquivo final sai igualzinho
// ao que se vê no editor, sem depender de fonte instalada no servidor.

export const CANVAS = { vertical: [1080, 1920], horizontal: [1920, 1080] };

export const FONTS = [
  { value: "Inter, system-ui, sans-serif", label: "Inter (padrão)" },
  { value: "Impact, Haettenschweiler, sans-serif", label: "Impact (impacto)" },
  { value: "Arial Black, Arial, sans-serif", label: "Arial Black" },
  { value: "Arial, sans-serif", label: "Arial" },
  { value: "Trebuchet MS, sans-serif", label: "Trebuchet" },
  { value: "Georgia, serif", label: "Georgia" },
  { value: "Courier New, monospace", label: "Courier" },
];

export function frameSize(template) {
  return CANVAS[template?.format === "horizontal" ? "horizontal" : "vertical"];
}

// Dimensão de vídeo tem que ser par: libx264 com yuv420p recusa lado ímpar.
export const par = (n) => Math.max(2, Math.round(n / 2) * 2);

export function resolveText(layer, { title = "" } = {}) {
  const raw = String(layer.text || "").replace(/\{titulo\}/gi, title);
  return layer.uppercase ? raw.toUpperCase() : raw;
}

export function usesTitle(template) {
  return (template?.layers || []).some((l) => l.type === "text" && /\{titulo\}/i.test(l.text || ""));
}

const fontOf = (l) => `${l.weight || 400} ${l.size || 48}px ${l.font || FONTS[0].value}`;

// Quebra de linha na mão: o canvas não tem wrap, e é justamente essa quebra que
// precisa ser idêntica na prévia e no PNG.
function wrap(ctx, text, maxWidth) {
  const out = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(" ")) {
      const test = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(test).width > maxWidth) {
        out.push(line);
        line = word;
      } else {
        line = test;
      }
    }
    out.push(line);
  }
  return out;
}

// Área que o vídeo ocupa dentro do quadro. Mesma conta do backend
// (render.js/geometry) — as duas têm que dar exatamente o mesmo retângulo.
export function videoRect(template) {
  const [W, H] = frameSize(template);
  const top = par(Math.min(Math.max(0, Number(template?.video?.top) || 0), H - 2));
  const height = par(Math.min(Math.max(2, Number(template?.video?.height) || H), H - top));
  return { x: 0, y: top, w: W, h: height };
}

export function paintOverlay(ctx, template, opts = {}) {
  const [W, H] = frameSize(template);
  ctx.clearRect(0, 0, W, H);

  // O fundo é pintado no próprio PNG e o retângulo do vídeo vira um buraco
  // transparente. Assim as barras são literalmente o que se vê na prévia, e o
  // ffmpeg não precisa saber de cor nenhuma.
  const r = videoRect(template);
  if (r.h < H) {
    ctx.fillStyle = template?.video?.background || "#000000";
    ctx.fillRect(0, 0, W, H);
    ctx.clearRect(r.x, r.y, r.w, r.h);
  }

  for (const layer of template?.layers || []) {
    ctx.save();
    ctx.globalAlpha = layer.opacity ?? 1;
    if (layer.type === "box") paintBox(ctx, layer);
    else if (layer.type === "text") paintText(ctx, layer, opts);
    else if (layer.type === "image") paintImage(ctx, layer, opts.images);
    ctx.restore();
  }
}

function paintBox(ctx, l) {
  ctx.fillStyle = l.color || "#000000";
  ctx.beginPath();
  ctx.roundRect(l.x, l.y, l.w, l.h, Math.min(l.radius || 0, l.w / 2, l.h / 2));
  ctx.fill();
}

function paintText(ctx, l, opts) {
  ctx.font = fontOf(l);
  ctx.textBaseline = "top";
  ctx.textAlign = l.align || "left";
  const lines = wrap(ctx, resolveText(l, opts), l.w || Infinity);
  const step = (l.size || 48) * (l.lineHeight || 1.2);
  const at = (i) => [l.x, l.y + i * step];

  if (l.shadow?.blur || l.shadow?.y) {
    ctx.shadowColor = l.shadow.color || "rgba(0,0,0,0.45)";
    ctx.shadowBlur = l.shadow.blur || 0;
    ctx.shadowOffsetY = l.shadow.y || 0;
  }
  if (l.stroke?.width) {
    // O contorno leva a sombra e o preenchimento vem depois, limpo: senão a
    // sombra aparece duas vezes e suja o miolo da letra.
    ctx.lineWidth = l.stroke.width * 2; // metade do traço fica por dentro do glifo
    ctx.lineJoin = "round";
    ctx.strokeStyle = l.stroke.color || "#000000";
    lines.forEach((line, i) => ctx.strokeText(line, ...at(i)));
    ctx.shadowColor = "transparent";
  }
  ctx.fillStyle = l.color || "#ffffff";
  lines.forEach((line, i) => ctx.fillText(line, ...at(i)));
}

function paintImage(ctx, l, images) {
  const img = images?.get(l.src);
  if (img) ctx.drawImage(img, l.x, l.y, l.w, l.h);
}

// drawImage precisa do bitmap já decodificado, então as data-URLs das camadas de
// imagem são carregadas antes de qualquer desenho.
export function loadImages(template) {
  const srcs = [...new Set((template?.layers || []).filter((l) => l.type === "image" && l.src).map((l) => l.src))];
  return Promise.all(srcs.map((src) => new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve([src, img]);
    img.onerror = () => resolve(null); // logo quebrado não trava o resto do desenho
    img.src = src;
  }))).then((pairs) => new Map(pairs.filter(Boolean)));
}

export async function renderToDataUrl(template, opts = {}) {
  const [W, H] = frameSize(template);
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  paintOverlay(ctx, template, { ...opts, images: opts.images || await loadImages(template) });
  return canvas.toDataURL("image/png");
}

// Caixa ocupada pela camada, em pixels do quadro. Texto precisa do ctx porque só
// o measureText sabe a largura real depois da quebra de linha.
export function layerBox(ctx, l, opts = {}) {
  if (l.type !== "text") return { x: l.x, y: l.y, w: l.w, h: l.h };
  ctx.font = fontOf(l);
  const lines = wrap(ctx, resolveText(l, opts), l.w || Infinity);
  const step = (l.size || 48) * (l.lineHeight || 1.2);
  const w = Math.max(1, ...lines.map((s) => ctx.measureText(s).width));
  const align = l.align || "left";
  const x = align === "center" ? l.x - w / 2 : align === "right" ? l.x - w : l.x;
  return { x, y: l.y, w, h: step * lines.length };
}

// Índice da camada sob o ponto, de cima para baixo (a última desenhada ganha).
export function hitTest(ctx, template, px, py, opts = {}) {
  const layers = template?.layers || [];
  for (let i = layers.length - 1; i >= 0; i--) {
    const b = layerBox(ctx, layers[i], opts);
    if (px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) return i;
  }
  return -1;
}

// Presets de geometria do vídeo dentro do quadro: é isso que cria o formato
// "vídeo reduzido entre barras".
export function videoPresets(format) {
  const [, H] = CANVAS[format === "horizontal" ? "horizontal" : "vertical"];
  const faixa = Math.round(H * 0.14);
  return [
    { label: "Tela cheia", video: { top: 0, height: H } },
    { label: "Barra em cima", video: { top: par(faixa), height: par(H - faixa) } },
    { label: "Barras em cima e embaixo", video: { top: par(faixa), height: par(H - faixa * 2) } },
  ];
}

export function newLayer(type, template) {
  const [W, H] = frameSize(template);
  if (type === "box") {
    return { type: "box", x: 0, y: 0, w: W, h: Math.round(H * 0.14), color: "#cd6f04", opacity: 1, radius: 0 };
  }
  if (type === "image") {
    return { type: "image", src: "", x: Math.round(W * 0.04), y: Math.round(H * 0.88), w: 200, h: 120, opacity: 1 };
  }
  return {
    type: "text",
    x: Math.round(W / 2), y: Math.round(H * 0.05), w: Math.round(W * 0.9),
    text: "OLHA ESSE PREÇO", font: FONTS[1].value, size: Math.round(W / 15), weight: 800,
    color: "#ffffff", align: "center", lineHeight: 1.15, uppercase: true, opacity: 1,
    stroke: { color: "#000000", width: 0 },
    shadow: { color: "rgba(0,0,0,0.45)", blur: 0, y: 0 },
  };
}

export function emptyTemplate(format = "vertical") {
  const [, H] = CANVAS[format];
  return { name: "Novo template", format, video: { top: 0, height: H, background: "#111111", fit: "cover" }, layers: [] };
}
