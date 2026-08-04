// Leitura das dimensões pelo cabeçalho da imagem (JPEG, PNG, WebP, GIF).
// Função pura, sem rede — os buffers são montados na mão.

import "../helpers/env.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const { parseImageHeader, pickBestImage } = require(path.resolve(__dirname, "..", "..", "backend", "scraping", "image-quality.js"));

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

// Escolha entre a foto da página e a versão "em alta" montada por reescrita da
// URL. Aqui tem rede — o fetch global é mockado com respostas por URL.
describe("pickBestImage", () => {
  const THUMB = "https://http2.mlstatic.com/D_NQ_NP_682596-MLB112404223609_052026-O.webp";
  const BIG = "https://http2.mlstatic.com/D_NQ_NP_682596-MLB112404223609_052026-F.webp";

  // Resposta mínima no formato que o inspectImage consome (Range → 206 + body).
  function imageResponse(buffer) {
    return {
      ok: true,
      status: 206,
      headers: new Headers({ "content-range": `bytes 0-${buffer.length - 1}/${buffer.length}` }),
      body: null,
      arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length),
    };
  }

  function mockFetch(byUrl) {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const entry = byUrl[url];
      if (!entry) return { ok: false, status: 404, headers: new Headers(), body: null, arrayBuffer: async () => new ArrayBuffer(0) };
      if (entry === "throw") throw new Error("socket hang up");
      return imageResponse(entry);
    }));
  }

  afterEach(() => vi.unstubAllGlobals());

  it("fica com a candidata quando ela é maior (o caso do -O → -F)", async () => {
    mockFetch({ [THUMB]: webpVp8(428, 500), [BIG]: webpVp8(810, 947) });
    expect(await pickBestImage(THUMB, BIG)).toBe(BIG);
  });

  it("volta pra original quando a candidata é MENOR (banner do ML)", async () => {
    mockFetch({ [THUMB]: webpVp8(1368, 164), [BIG]: webpVp8(1201, 144) });
    expect(await pickBestImage(THUMB, BIG)).toBe(THUMB);
  });

  it("volta pra original quando a candidata dá 404", async () => {
    mockFetch({ [THUMB]: webpVp8(428, 500) });
    expect(await pickBestImage(THUMB, BIG)).toBe(THUMB);
  });

  it("volta pra original quando as duas falham", async () => {
    mockFetch({ [THUMB]: "throw", [BIG]: "throw" });
    expect(await pickBestImage(THUMB, BIG)).toBe(THUMB);
  });

  it("não gasta rede quando não há o que comparar", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    expect(await pickBestImage(THUMB, THUMB)).toBe(THUMB);
    expect(await pickBestImage(THUMB, null)).toBe(THUMB);
    expect(await pickBestImage(null, BIG)).toBe(BIG);
    expect(spy).not.toHaveBeenCalled();
  });
});
