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
const { geometry, filtergraph } = require(path.join(backend, "downloader", "render.js"));

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
