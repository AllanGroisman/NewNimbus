// Templates do Admin › Downloader: o que o backend aceita guardar e como a
// geometria do template vira filtergraph do ffmpeg.
//
// A cor das barras entra no filtergraph quando o vídeo está em "caber inteiro"
// (é ela que pinta a sobra ao lado do vídeo, como no TwitterReact). O valor vem
// do body do POST /jobs, então qualquer coisa fora de #rrggbb tem que virar
// preto — senão um ";" no campo vira um filtro a mais na linha de comando.

import "../helpers/env.js";
import { describe, it, expect } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const backend = path.resolve(__dirname, "..", "..", "backend");
const { sanitize } = require(path.join(backend, "downloader", "templates.js"));
const { geometry, filtergraph, fadeTimes } = require(path.join(backend, "downloader", "render.js"));

const PNG = "data:image/png;base64,iVBORw0KGgo=";
const tweet = (extra = {}) => ({
  type: "tweet", x: 84, y: 150, w: 912, size: 56, avatar: PNG,
  name: "Nome", handle: "conta", verified: true, text: "oi", date: "17:00", theme: "light", opacity: 1,
  ...extra,
});

describe("sanitize", () => {
  it("guarda a camada de tweet inteira", () => {
    const out = sanitize({ name: "T", layers: [tweet()] });
    expect(out.layers).toEqual([tweet()]);
  });

  it("tweet com foto que não é data-URL de imagem fica, só sem a foto", () => {
    const out = sanitize({ layers: [tweet({ avatar: "https://exemplo.com/foto.png" })] });
    expect(out.layers).toHaveLength(1);
    expect(out.layers[0].avatar).toBe("");
  });

  it("tweet com foto grande demais fica sem a foto", () => {
    const out = sanitize({ layers: [tweet({ avatar: PNG + "A".repeat(2 * 1024 * 1024) })] });
    expect(out.layers[0].avatar).toBe("");
  });

  it("continua descartando tipo desconhecido e imagem inválida", () => {
    const out = sanitize({
      layers: [{ type: "video" }, { type: "image", src: "javascript:x" }, { type: "image", src: PNG }],
    });
    expect(out.layers.map((l) => l.type)).toEqual(["image"]);
  });
});

describe("filtergraph", () => {
  const tpl = (video) => ({ format: "vertical", video: { top: 620, height: 1000, ...video } });

  it("no contain, a sobra ao lado do vídeo sai na cor das barras", () => {
    const g = filtergraph(geometry(tpl({ fit: "contain", background: "#FFFFFF" })));
    expect(g).toContain("color=0xFFFFFF[base]");
  });

  it("cor malformada vira preto e não entra no filtergraph", () => {
    const g = filtergraph(geometry(tpl({ fit: "contain", background: "#fff;drawtext=text=x" })));
    expect(g).toContain("color=black[base]");
    expect(g).not.toContain("drawtext");
  });

  it("sem cor nenhuma, preto como antes", () => {
    expect(filtergraph(geometry(tpl({ fit: "contain" })))).toContain("color=black[base]");
  });

  it("no cover nada muda: o vídeo enche a faixa e o pad é preto", () => {
    const g = filtergraph(geometry(tpl({ fit: "cover", background: "#ffffff" })));
    expect(g).toContain("crop=1080:1000,setsar=1,pad=1080:1920:0:620:color=black[base]");
  });
});

describe("vídeo como retângulo livre", () => {
  const tpl = (video, format = "vertical") => ({ format, video });

  it("template antigo, sem left/width, sai na largura toda", () => {
    const g = geometry(tpl({ top: 620, height: 1000 }));
    expect(g).toMatchObject({ left: 0, width: 1080, top: 620, height: 1000 });
  });

  it("tela cheia começa no topo (o par transformava top 0 em 2)", () => {
    expect(geometry(tpl({ top: 0, height: 1920 }))).toMatchObject({ top: 0, height: 1920 });
  });

  it("no cover, o vídeo reduzido é cortado no tamanho e colado na posição", () => {
    const g = filtergraph(geometry(tpl({ top: 620, height: 1000, left: 140, width: 800, fit: "cover" })));
    expect(g).toContain("scale=800:1000:force_original_aspect_ratio=increase");
    expect(g).toContain("crop=800:1000,setsar=1,pad=1080:1920:140:620:color=black[base]");
  });

  it("no contain, a sobra é centralizada dentro do retângulo, não do quadro", () => {
    const g = filtergraph(geometry(tpl({ top: 620, height: 1000, left: 140, width: 800, fit: "contain", background: "#ffffff" })));
    expect(g).toContain("scale=800:1000:force_original_aspect_ratio=decrease");
    expect(g).toContain("pad=1080:1920:140+trunc((800-iw)/4)*2:620+trunc((1000-ih)/4)*2:color=0xffffff[base]");
  });

  it("retângulo que passa da borda é encolhido para caber, com lados pares", () => {
    const g = geometry(tpl({ top: 0, height: 1920, left: 901, width: 999 }));
    expect(g.left).toBe(902);
    expect(g.width).toBe(178);
    expect(g.left + g.width).toBeLessThanOrEqual(1080);
    expect(g.left % 2 + g.width % 2).toBe(0);
  });

  it("o sanitize guarda left e width do vídeo", () => {
    const out = sanitize({ video: { top: 620, height: 1000, left: 140, width: 800 } });
    expect(out.video).toMatchObject({ left: 140, width: 800 });
  });

  it("o sanitize guarda a escala e o retângulo do tweet", () => {
    const card = { show: true, color: "#000000", borderColor: "#ff0000", borderWidth: 4, radius: 20, padding: 30 };
    const out = sanitize({ layers: [tweet({ scale: 1.5, card })] });
    expect(out.layers[0]).toMatchObject({ scale: 1.5, card });
  });
});

// A prévia (videoRect, no front) e o ffmpeg (geometry) têm que concordar no
// pixel: senão o vídeo sai num lugar e as camadas, desenhadas em cima do buraco
// que a prévia calculou, em outro.
describe("paridade prévia × ffmpeg", () => {
  const casos = {
    antigo: { format: "vertical", video: { top: 620, height: 1000 } },
    tela_cheia: { format: "vertical", video: { top: 0, height: 1920, left: 0, width: 1080 } },
    reduzido: { format: "vertical", video: { top: 620, height: 997, left: 259, width: 563 } },
    fora_do_quadro: { format: "vertical", video: { top: 1900, height: 500, left: 1070, width: 400 } },
    lixo: { format: "vertical", video: { top: "x", height: -5, left: null, width: "abc" } },
    horizontal: { format: "horizontal", video: { top: 101, height: 801, left: 333, width: 1201 } },
    sem_video: { format: "horizontal" },
  };

  for (const [nome, t] of Object.entries(casos)) {
    it(nome, async () => {
      const { videoRect } = await import("../../frontend/src/components/admin/downloader/overlay.js");
      const g = geometry(t);
      expect(videoRect(t)).toEqual({ x: g.left, y: g.top, w: g.width, h: g.height });
    });
  }
});

// Camada que some: um PNG a mais por momento de sumiço, empilhado por cima do
// overlay fixo com fade no alpha. Os tempos vêm do body do POST /jobs.
describe("filtergraph com camadas que somem", () => {
  const geo = geometry({ format: "vertical", video: { top: 0, height: 1920 } });

  it("cada fade repete o PNG, corta no fim do sumiço e some no alpha", () => {
    const g = filtergraph(geo, fadeTimes([{ file: "f.png", at: 5, fade: 1 }], 30));
    expect(g).toContain("[base][ovl]overlay=0:0:format=yuv444:eof_action=repeat[s0]");
    expect(g).toContain("[2:v]scale=1080:1920:flags=lanczos,format=rgba,loop=loop=-1:size=1:start=0,trim=end=6,fade=t=out:st=5:d=1:alpha=1[f0]");
    expect(g).toContain("[s0][f0]overlay=0:0:format=yuv444:eof_action=pass,format=yuv420p[v]");
  });

  it("dois fades encadeiam na ordem recebida, o último sai como [v]", () => {
    const g = filtergraph(geo, fadeTimes([{ file: "a", at: 5, fade: 1 }, { file: "b", at: 2, fade: 0.5 }], 30));
    expect(g).toContain("[s0][f0]overlay=0:0:format=yuv444:eof_action=pass[s1]");
    expect(g).toContain("[3:v]scale=1080:1920:flags=lanczos,format=rgba,loop=loop=-1:size=1:start=0,trim=end=2.5,fade=t=out:st=2:d=0.5:alpha=1[f1]");
    expect(g).toContain("[s1][f1]overlay=0:0:format=yuv444:eof_action=pass,format=yuv420p[v]");
  });

  it("o corte nunca passa do fim do vídeo (o overlay esticaria a saída)", () => {
    expect(fadeTimes([{ file: "a", at: 6, fade: 1 }], 4.2)).toEqual([{ file: "a", at: 6, fade: 1, end: 4.2 }]);
  });

  it("sem duração conhecida, corta no fim do sumiço", () => {
    expect(fadeTimes([{ file: "a", at: 2, fade: 1 }], null)[0].end).toBe(3);
  });

  it("sumiço de 0s corta seco, sem filtro de fade", () => {
    const g = filtergraph(geo, fadeTimes([{ file: "a", at: 2, fade: 0 }], 30));
    expect(g).toContain("trim=end=2[f0]");
    expect(g).not.toContain("fade=");
  });

  it("camada que some no instante zero nem entra", () => {
    expect(fadeTimes([{ file: "a", at: 0, fade: 0 }], 30)).toEqual([]);
  });

  it("sem fades, o filtergraph é o de sempre", () => {
    expect(filtergraph(geo, [])).toBe(filtergraph(geo));
    expect(filtergraph(geo)).toContain("eof_action=repeat,format=yuv420p[v]");
  });
});
