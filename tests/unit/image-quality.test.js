// Leitura das dimensões pelo cabeçalho da imagem (JPEG, PNG, WebP, GIF).
// Função pura, sem rede — os buffers são montados na mão.

import "../helpers/env.js";
import { describe, it, expect } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const { parseImageHeader } = require(path.resolve(__dirname, "..", "..", "backend", "scraping", "image-quality.js"));

function pngHeader(width, height) {
  const buf = Buffer.alloc(24);
  buf.writeUInt32BE(0x89504e47, 0);
  buf.writeUInt32BE(0x0d0a1a0a, 4);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

function gifHeader(width, height) {
  const buf = Buffer.alloc(13);
  buf.write("GIF89a", 0, "ascii");
  buf.writeUInt16LE(width, 6);
  buf.writeUInt16LE(height, 8);
  return buf;
}

// SOI + um APP0 qualquer (pra garantir que o parser pula segmentos) + SOF0.
function jpegHeader(width, height) {
  const app0 = Buffer.alloc(20);
  app0.writeUInt16BE(0xffe0, 0);
  app0.writeUInt16BE(18, 2);            // tamanho do segmento (sem o marcador)
  const sof = Buffer.alloc(11);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(9, 2);
  sof.writeUInt8(8, 4);                 // precisão
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]);
}

function webpBase(fourcc, payload) {
  const head = Buffer.alloc(20);
  head.write("RIFF", 0, "ascii");
  head.writeUInt32LE(payload.length + 12, 4);
  head.write("WEBP", 8, "ascii");
  head.write(fourcc, 12, "ascii");
  head.writeUInt32LE(payload.length, 16);
  return Buffer.concat([head, payload]);
}

function webpVp8x(width, height) {
  const p = Buffer.alloc(10);
  p.writeUIntLE(width - 1, 4, 3);
  p.writeUIntLE(height - 1, 7, 3);
  return webpBase("VP8X", p);
}

function webpVp8l(width, height) {
  const p = Buffer.alloc(10);
  p.writeUInt8(0x2f, 0);
  p.writeUInt32LE(((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14), 1);
  return webpBase("VP8L", p);
}

function webpVp8(width, height) {
  const p = Buffer.alloc(14);
  p.writeUInt8(0x9d, 3);
  p.writeUInt8(0x01, 4);
  p.writeUInt8(0x2a, 5);
  p.writeUInt16LE(width, 6);
  p.writeUInt16LE(height, 8);
  return webpBase("VP8 ", p);
}

describe("parseImageHeader", () => {
  it("lê PNG", () => {
    expect(parseImageHeader(pngHeader(1200, 900))).toEqual({ format: "png", width: 1200, height: 900 });
  });

  it("lê GIF", () => {
    expect(parseImageHeader(gifHeader(320, 240))).toEqual({ format: "gif", width: 320, height: 240 });
  });

  it("lê JPEG pulando os segmentos até o SOF", () => {
    expect(parseImageHeader(jpegHeader(1500, 1500))).toEqual({ format: "jpeg", width: 1500, height: 1500 });
  });

  it("lê WebP nas três variantes (é o formato do Hub)", () => {
    expect(parseImageHeader(webpVp8x(1080, 720))).toEqual({ format: "webp", width: 1080, height: 720 });
    expect(parseImageHeader(webpVp8l(640, 480))).toEqual({ format: "webp", width: 640, height: 480 });
    expect(parseImageHeader(webpVp8(500, 280))).toEqual({ format: "webp", width: 500, height: 280 });
  });

  it("pega miniatura pequena (é o caso que interessa)", () => {
    const r = parseImageHeader(pngHeader(90, 90));
    expect(r.width).toBe(90);
    expect(r.height).toBe(90);
  });

  it("devolve null pra lixo, vazio ou cabeçalho truncado", () => {
    expect(parseImageHeader(null)).toBe(null);
    expect(parseImageHeader(Buffer.alloc(0))).toBe(null);
    expect(parseImageHeader(Buffer.from("<html>página de erro</html>"))).toBe(null);
    expect(parseImageHeader(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(null);   // JPEG sem SOF
  });

  it("devolve null quando as dimensões não fazem sentido", () => {
    expect(parseImageHeader(pngHeader(0, 100))).toBe(null);
  });
});
