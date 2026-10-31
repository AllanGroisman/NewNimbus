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
// Offset par também, mas podendo ser zero (o par acima transformava top 0 em 2).
const even = (n) => Math.round(n / 2) * 2;

export function resolveText(layer, { title = "" } = {}) {
  const raw = String(layer.text || "").replace(/\{titulo\}/gi, title);
  return layer.uppercase ? raw.toUpperCase() : raw;
}

export function usesTitle(template) {
  return (template?.layers || []).some((l) => (l.type === "text" || l.type === "tweet") && /\{titulo\}/i.test(l.text || ""));
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
// Template sem left/width ocupa a largura toda.
export function videoRect(template) {
  const [W, H] = frameSize(template);
  const v = template?.video;
  const top = even(Math.min(Math.max(0, Number(v?.top) || 0), H - 2));
  const height = par(Math.min(Math.max(2, Number(v?.height) || H), H - top));
  const left = even(Math.min(Math.max(0, Number(v?.left) || 0), W - 2));
  const width = par(Math.min(Math.max(2, Number(v?.width) || W), W - left));
  return { x: left, y: top, w: width, h: height };
}

// Camada que some no meio do vídeo: `exit: { at, fade }`, em segundos.
export const hasExit = (l) => Boolean(l?.exit) && Number.isFinite(Number(l.exit.at));
const exitAt = (l) => Math.max(0, Number(l.exit.at) || 0);
const exitFade = (l) => Math.min(10, Math.max(0, Number(l.exit.fade) || 0));

// Quanto da camada aparece no instante `time` (só a prévia animada passa um).
// Sem `time`, tudo aparece — é assim que os PNGs do ffmpeg são desenhados.
export function exitAlpha(l, time) {
  if (time == null || !hasExit(l)) return 1;
  const at = exitAt(l);
  const fade = exitFade(l);
  if (time < at) return 1;
  return fade > 0 && time < at + fade ? 1 - (time - at) / fade : 0;
}

// Quando a prévia animada termina: o último sumiço, ou 0 se nada some.
export function exitEnd(template) {
  return Math.max(0, ...(template?.layers || []).filter(hasExit).map((l) => exitAt(l) + exitFade(l)));
}

// PNGs que o ffmpeg empilha quando há camadas que somem. `base` é o que fica o
// vídeo todo; cada fade é o quadro INTEIRO como estava antes de um grupo de
// camadas sumir, e some por cima do de baixo. Quadro inteiro, e não só a camada
// que some, porque assim a ordem das camadas continua certa: um logo por cima
// do tweet continua por cima dele até o tweet sumir. Fades na ordem de empilhar
// (de baixo para cima): o primeiro a sumir fica no topo.
export function overlayPlan(template) {
  const layers = template?.layers || [];
  const key = (l) => `${exitAt(l)}|${exitFade(l)}`;
  const groups = [...new Map(layers.filter(hasExit).map((l) => [key(l), { key: key(l), at: exitAt(l), fade: exitFade(l) }])).values()]
    .sort((a, b) => a.at - b.at || a.fade - b.fade);
  // Antes do grupo k sumir, os grupos 0..k-1 já foram.
  const before = (k) => ({
    ...template,
    layers: layers.filter((l) => !hasExit(l) || groups.findIndex((g) => g.key === key(l)) >= k),
  });
  return {
    base: { ...template, layers: layers.filter((l) => !hasExit(l)) },
    fades: groups.map((g, k) => ({ template: before(k), at: g.at, fade: g.fade })).reverse(),
  };
}

export function paintOverlay(ctx, template, opts = {}) {
  const [W, H] = frameSize(template);
  ctx.clearRect(0, 0, W, H);

  // O fundo é pintado no próprio PNG e o retângulo do vídeo vira um buraco
  // transparente. Assim as barras são literalmente o que se vê na prévia, e o
  // ffmpeg não precisa saber de cor nenhuma.
  const r = videoRect(template);
  if (r.h < H || r.w < W) {
    ctx.fillStyle = template?.video?.background || "#000000";
    ctx.fillRect(0, 0, W, H);
    ctx.clearRect(r.x, r.y, r.w, r.h);
  }

  for (const layer of template?.layers || []) {
    const alpha = (layer.opacity ?? 1) * exitAlpha(layer, opts.time);
    if (alpha <= 0) continue;
    ctx.save();
    ctx.globalAlpha = alpha;
    if (layer.type === "box") paintBox(ctx, layer);
    else if (layer.type === "text") paintText(ctx, layer, opts);
    else if (layer.type === "image") paintImage(ctx, layer, opts.images);
    else if (layer.type === "tweet") paintTweet(ctx, layer, opts);
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

// Camada "tweet": cartão no formato de post do Twitter/X. É uma camada só, e não
// texto + imagem soltos, porque o selo tem que andar junto com a largura do nome
// e a data tem que descer conforme o texto quebra linha.
const TWEET_FONT = '-apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
const TWEET_THEMES = {
  light: { name: "#0f1419", muted: "#536471", text: "#0f1419" },
  dark: { name: "#e7e9ea", muted: "#71767b", text: "#e7e9ea" },
};
// Roseta do selo de verificado, em unidades de uma caixa 24×24.
const SELO = "M22.25 12c0-1.43-.88-2.67-2.19-3.34.46-1.39.2-2.9-.81-3.91s-2.52-1.27-3.91-.81c-.66-1.31-1.91-2.19-3.34-2.19s-2.67.88-3.33 2.19c-1.4-.46-2.91-.2-3.92.81s-1.26 2.52-.8 3.91c-1.31.67-2.2 1.91-2.2 3.34s.89 2.67 2.2 3.34c-.46 1.39-.21 2.9.8 3.91s2.52 1.26 3.91.81c.67 1.31 1.91 2.19 3.34 2.19s2.68-.88 3.34-2.19c1.39.45 2.9.2 3.91-.81s1.27-2.52.81-3.91c1.31-.67 2.19-1.91 2.19-3.34z";

const tweetFonts = (s) => ({
  name: `700 ${Math.round(s * 0.95)}px ${TWEET_FONT}`,
  handle: `400 ${Math.round(s * 0.8)}px ${TWEET_FONT}`,
  text: `400 ${s}px ${TWEET_FONT}`,
  date: `400 ${Math.round(s * 0.6)}px ${TWEET_FONT}`,
});

// Retângulo atrás do tweet, no estilo do tweet embutido: branco com borda cinza.
export const TWEET_CARD = { show: true, color: "#ffffff", borderColor: "#cfd9de", borderWidth: 3, radius: 40, padding: 48 };

// "Tamanho do tweet": multiplica tudo, inclusive a largura e o retângulo.
const tweetScale = (l) => Math.min(5, Math.max(0.1, Number(l.scale) || 1));

// Posições de cada pedaço do tweet, com a origem (0,0) no canto da foto e antes
// da escala. A pintura e a caixa de seleção (layerBox) saem daqui, então as duas
// nunca discordam.
function tweetLayout(ctx, l, opts) {
  const s = l.size || 56;
  const f = tweetFonts(s);
  const w = l.w || 900;
  const avatar = Math.round(s * 3.1);
  const gap = Math.round(s * 0.35);
  const nameSize = Math.round(s * 0.95);
  const handleSize = Math.round(s * 0.8);
  const textX = avatar + gap;
  // Nome + @ centralizados na altura da foto.
  const headY = (avatar - (nameSize * 1.25 + handleSize * 1.2)) / 2;

  ctx.font = f.name;
  const nameW = ctx.measureText(l.name || "").width;
  const selo = Math.round(s * 0.9);

  ctx.font = f.text;
  const lines = wrap(ctx, resolveText(l, opts), w);
  const step = s * 1.3;
  const bodyY = avatar + Math.round(s * 0.5);
  const dateY = bodyY + lines.length * step + Math.round(s * 0.45);
  const dateSize = Math.round(s * 0.6);
  const bodyW = Math.max(0, ...lines.map((t) => ctx.measureText(t).width));
  const content = { x: 0, y: 0, w: Math.max(w, bodyW, avatar + gap + nameW + selo), h: dateY + dateSize * 1.2 };
  // O retângulo cresce para fora do conteúdo: ligar ou mudar a margem não
  // tira o texto do lugar.
  const pad = Math.max(0, Number(l.card?.padding) || 0);
  const card = { x: -pad, y: -pad, w: content.w + pad * 2, h: content.h + pad * 2 };
  return {
    fonts: f,
    avatar: { x: 0, y: 0, d: avatar },
    name: { x: textX, y: headY, w: nameW },
    selo: { x: textX + nameW + Math.round(s * 0.2), y: headY + (nameSize * 1.15 - selo) / 2, d: selo },
    handle: { x: textX, y: headY + nameSize * 1.25 },
    body: { x: 0, y: bodyY, lines, step },
    date: { x: 0, y: dateY },
    card,
    box: l.card?.show ? card : content,
  };
}

function paintCard(ctx, card, { x, y, w, h }) {
  // O contorno é traçado para dentro, para a borda de fora bater com a caixa
  // de seleção.
  const bw = Math.min(Math.max(0, Number(card.borderWidth) || 0), w / 2, h / 2);
  const r = Math.max(0, Math.min((Number(card.radius) || 0) - bw / 2, (w - bw) / 2, (h - bw) / 2));
  ctx.beginPath();
  ctx.roundRect(x + bw / 2, y + bw / 2, w - bw, h - bw, r);
  ctx.fillStyle = card.color || "#ffffff";
  ctx.fill();
  if (bw) {
    ctx.lineWidth = bw;
    ctx.strokeStyle = card.borderColor || "#cfd9de";
    ctx.stroke();
  }
}

function paintTweet(ctx, l, opts) {
  const c = TWEET_THEMES[l.theme === "dark" ? "dark" : "light"];
  const L = tweetLayout(ctx, l, opts);
  const k = tweetScale(l);
  ctx.translate(l.x, l.y);
  ctx.scale(k, k);
  ctx.textBaseline = "top";
  ctx.textAlign = "left";

  if (l.card?.show) paintCard(ctx, l.card, L.card);

  const { x, y, d } = L.avatar;
  ctx.save();
  ctx.beginPath();
  ctx.arc(x + d / 2, y + d / 2, d / 2, 0, Math.PI * 2);
  ctx.clip();
  const img = l.avatar ? opts.images?.get(l.avatar) : null;
  if (img) {
    // Recorte central: foto que não é quadrada não sai achatada.
    const lado = Math.min(img.width, img.height);
    ctx.drawImage(img, (img.width - lado) / 2, (img.height - lado) / 2, lado, lado, x, y, d, d);
  } else {
    ctx.fillStyle = "#cfd9de";
    ctx.fillRect(x, y, d, d);
  }
  ctx.restore();

  ctx.font = L.fonts.name;
  ctx.fillStyle = c.name;
  ctx.fillText(l.name || "", L.name.x, L.name.y);

  if (l.verified) {
    const { x: sx, y: sy, d: sd } = L.selo;
    ctx.save();
    ctx.translate(sx, sy);
    ctx.scale(sd / 24, sd / 24);
    ctx.fillStyle = "#1d9bf0";
    ctx.fill(new Path2D(SELO));
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2.2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(7.6, 12.2);
    ctx.lineTo(10.6, 15.1);
    ctx.lineTo(16.2, 9.1);
    ctx.stroke();
    ctx.restore();
  }

  ctx.font = L.fonts.handle;
  ctx.fillStyle = c.muted;
  const handle = String(l.handle || "").replace(/^@+/, "");
  if (handle) ctx.fillText(`@${handle}`, L.handle.x, L.handle.y);

  ctx.font = L.fonts.text;
  ctx.fillStyle = c.text;
  L.body.lines.forEach((t, i) => ctx.fillText(t, L.body.x, L.body.y + i * L.body.step));

  ctx.font = L.fonts.date;
  ctx.fillStyle = c.muted;
  ctx.fillText(l.date || "", L.date.x, L.date.y);
}

// Toda imagem que alguma camada desenha: o src das camadas de imagem e a foto
// das camadas de tweet.
export function imageSrcs(template) {
  return [...new Set((template?.layers || [])
    .map((l) => (l.type === "image" ? l.src : l.type === "tweet" ? l.avatar : ""))
    .filter(Boolean))];
}

// drawImage precisa do bitmap já decodificado, então as data-URLs das camadas de
// imagem são carregadas antes de qualquer desenho.
export function loadImages(template) {
  const srcs = imageSrcs(template);
  return Promise.all(srcs.map((src) => new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve([src, img]);
    img.onerror = () => resolve(null); // logo quebrado não trava o resto do desenho
    img.src = src;
  }))).then((pairs) => new Map(pairs.filter(Boolean)));
}

// Tela final: alguns segundos emendados depois do vídeo (o backend faz o
// concat). Uma tela só, sem camadas: fundo chapado, a chamada no meio e o
// "link na bio" num botão embaixo.
export const OUTRO = {
  show: true, seconds: 3, background: "#ffffff", color: "#0f1419",
  text: "Quer produtos como este do vídeo com as melhores promoções?\nEntre no nosso grupo de descontos!",
  cta: "LINK NA BIO 👆", ctaColor: "#ffffff", ctaBackground: "#1d9bf0",
};

export const hasOutro = (template) => Boolean(template?.outro?.show) && Number(template.outro.seconds) > 0;

export function paintOutro(ctx, template) {
  const [W, H] = frameSize(template);
  const o = { ...OUTRO, ...template?.outro };
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = o.background;
  ctx.fillRect(0, 0, W, H);

  const s = Math.round(Math.min(W, H) / 15);
  ctx.textBaseline = "top";
  ctx.textAlign = "center";
  ctx.font = `700 ${s}px ${TWEET_FONT}`;
  const lines = String(o.text || "").trim() ? wrap(ctx, String(o.text).trim(), W * 0.84) : [];
  const step = s * 1.3;
  const textH = lines.length * step;

  const cs = Math.round(s * 1.05);
  const cta = String(o.cta || "").trim();
  ctx.font = `800 ${cs}px ${TWEET_FONT}`;
  const pill = cta ? { w: ctx.measureText(cta).width + cs * 1.8, h: cs * 2.1 } : { w: 0, h: 0 };
  const gap = lines.length && cta ? s * 1.4 : 0;

  // O bloco (texto + botão) fica centralizado na altura.
  let y = (H - (textH + gap + pill.h)) / 2;
  ctx.fillStyle = o.color;
  ctx.font = `700 ${s}px ${TWEET_FONT}`;
  lines.forEach((t, i) => ctx.fillText(t, W / 2, y + i * step));
  y += textH + gap;

  if (cta) {
    ctx.fillStyle = o.ctaBackground;
    ctx.beginPath();
    ctx.roundRect((W - pill.w) / 2, y, pill.w, pill.h, pill.h / 2);
    ctx.fill();
    ctx.fillStyle = o.ctaColor;
    ctx.font = `800 ${cs}px ${TWEET_FONT}`;
    ctx.fillText(cta, W / 2, y + (pill.h - cs) / 2);
  }
}

export function renderOutroDataUrl(template) {
  const [W, H] = frameSize(template);
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  paintOutro(canvas.getContext("2d"), template);
  return canvas.toDataURL("image/png");
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
  if (l.type === "tweet") {
    const b = tweetLayout(ctx, l, opts).box;
    const k = tweetScale(l);
    return { x: l.x + b.x * k, y: l.y + b.y * k, w: b.w * k, h: b.h * k };
  }
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
  const [W, H] = CANVAS[format === "horizontal" ? "horizontal" : "vertical"];
  const faixa = Math.round(H * 0.14);
  const full = { left: 0, width: W };
  return [
    { label: "Tela cheia", video: { ...full, top: 0, height: H } },
    { label: "Barra em cima", video: { ...full, top: par(faixa), height: par(H - faixa) } },
    { label: "Barras em cima e embaixo", video: { ...full, top: par(faixa), height: par(H - faixa * 2) } },
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
  if (type === "tweet") {
    return {
      type: "tweet", x: Math.round(W * 0.08), y: Math.round(H * 0.08), w: Math.round(W * 0.84), size: Math.round(W / 19), scale: 1,
      avatar: "", name: "Nome da Conta", handle: "suaconta", verified: true,
      text: "Escreva aqui o texto do tweet.", date: "17:00 · 01 de Julho de 2021",
      theme: "light", opacity: 1,
      card: { ...TWEET_CARD },
    };
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
