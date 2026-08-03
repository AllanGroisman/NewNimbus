// Qualidade da foto do produto.
//
// O ScrapTester conferia só se a URL da imagem existia — uma miniatura de 90×90
// passava igual a uma foto de 1200×1200, e era isso que fazia campanha sair com
// foto ruim no WhatsApp. Aqui a gente mede de verdade: baixa só o COMEÇO do
// arquivo (os primeiros 64 KB, via header Range) e lê as dimensões do cabeçalho
// da imagem. Não precisa do arquivo inteiro nem de biblioteca externa.
//
// Formatos suportados: JPEG, PNG, WebP (é o que o Hub serve) e GIF.

const MAX_HEADER_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 8000;

// ── Leitura do cabeçalho ───────────────────────────────────────────────────

// PNG: assinatura de 8 bytes + chunk IHDR com largura/altura em uint32 big-endian.
function parsePng(buf) {
  if (buf.length < 24) return null;
  if (buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  if (buf.toString("ascii", 12, 16) !== "IHDR") return null;
  return { format: "png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// GIF: "GIF87a"/"GIF89a" + largura/altura em uint16 little-endian.
function parseGif(buf) {
  if (buf.length < 10) return null;
  if (buf.toString("ascii", 0, 3) !== "GIF") return null;
  return { format: "gif", width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
}

// JPEG: percorre os marcadores até achar um SOF (Start Of Frame), que é onde as
// dimensões moram. Marcadores sem payload (RST, SOI) andam 2 bytes; o resto
// traz o próprio tamanho nos 2 bytes seguintes.
const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function parseJpeg(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 3 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }         // lixo entre segmentos: ressincroniza
    const marker = buf[i + 1];
    if (marker === 0xff) { i++; continue; }         // padding 0xFF
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) break;  // fim / início dos dados comprimidos
    const len = buf.readUInt16BE(i + 2);
    if (len < 2) return null;
    if (JPEG_SOF.has(marker)) {
      if (i + 9 > buf.length) return null;
      return { format: "jpeg", height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;                                       // cabeçalho truncado antes do SOF
}

// WebP: contêiner RIFF. Três variantes — VP8 (com perda), VP8L (sem perda) e
// VP8X (estendido, traz o tamanho do "canvas").
function parseWebp(buf) {
  if (buf.length < 30) return null;
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WEBP") return null;
  const chunk = buf.toString("ascii", 12, 16);

  if (chunk === "VP8X") {
    const width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
    const height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
    return { format: "webp", width, height };
  }
  if (chunk === "VP8L") {
    if (buf[20] !== 0x2f) return null;               // byte de assinatura do VP8L
    const bits = buf.readUInt32LE(21);
    return { format: "webp", width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8 ") {
    // 3 bytes de frame tag + sync code 0x9D 0x01 0x2A, aí vêm as dimensões
    // em uint16 LE (os 2 bits de cima são o fator de escala, descartados).
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null;
    return {
      format: "webp",
      width: buf.readUInt16LE(26) & 0x3fff,
      height: buf.readUInt16LE(28) & 0x3fff,
    };
  }
  return null;
}

// Descobre o formato pelo cabeçalho e devolve { format, width, height } ou null.
// Pura → testável sem rede.
function parseImageHeader(input) {
  if (!input) return null;
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buf.length < 10) return null;
  const parsed = parsePng(buf) || parseJpeg(buf) || parseWebp(buf) || parseGif(buf);
  if (!parsed) return null;
  if (!Number.isFinite(parsed.width) || !Number.isFinite(parsed.height)) return null;
  if (parsed.width <= 0 || parsed.height <= 0) return null;
  return parsed;
}

// ── Download ───────────────────────────────────────────────────────────────

// Lê no máximo MAX_HEADER_BYTES do corpo. Se o servidor honrar o Range já vem
// pouca coisa; se ignorar, a gente corta a leitura na mão.
async function readHead(res) {
  if (!res.body || typeof res.body.getReader !== "function") {
    const full = Buffer.from(await res.arrayBuffer());
    return full.subarray(0, MAX_HEADER_BYTES);
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (total < MAX_HEADER_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      total += value.length;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).subarray(0, MAX_HEADER_BYTES);
}

// Tamanho real do arquivo: com Range a resposta traz "content-range: bytes 0-N/TOTAL";
// sem Range, o content-length já é o total.
function totalBytesFrom(res) {
  const range = res.headers.get("content-range");
  const m = range && range.match(/\/\s*(\d+)\s*$/);
  if (m) return Number(m[1]);
  const len = Number(res.headers.get("content-length"));
  return Number.isFinite(len) && len > 0 ? len : null;
}

// Mede uma imagem. NUNCA lança: foto quebrada/404/timeout volta como
// { ok:false, error } — pro teste isso conta como foto ruim.
async function inspectImage(url, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!url || typeof url !== "string" || !/^https?:\/\//i.test(url)) {
    return { ok: false, url, width: null, height: null, bytes: null, format: null, error: "sem URL de imagem" };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        Range: `bytes=0-${MAX_HEADER_BYTES - 1}`,
        // Sem User-Agent de navegador algumas CDNs (Amazon principalmente) devolvem 403.
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      },
    });
    if (!res.ok && res.status !== 206) {
      return { ok: false, url, width: null, height: null, bytes: null, format: null, error: `HTTP ${res.status}` };
    }
    const head = await readHead(res);
    const parsed = parseImageHeader(head);
    const bytes = totalBytesFrom(res);
    if (!parsed) {
      return { ok: false, url, width: null, height: null, bytes, format: null, error: "formato não reconhecido" };
    }
    return { ok: true, url, width: parsed.width, height: parsed.height, bytes, format: parsed.format, error: null };
  } catch (err) {
    const error = err.name === "AbortError" ? `tempo esgotado (${timeoutMs}ms)` : err.message;
    return { ok: false, url, width: null, height: null, bytes: null, format: null, error };
  } finally {
    clearTimeout(timer);
  }
}

// Mede várias em paralelo controlado (a amostra do teste é pequena, mas não vale
// abrir 50 conexões de uma vez na mesma CDN). Devolve na MESMA ordem da entrada.
async function inspectImages(urls, { concurrency = 4, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const list = Array.isArray(urls) ? urls : [];
  const out = new Array(list.length);
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const i = next++;
      out[i] = await inspectImage(list[i], { timeoutMs });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
  return out;
}

module.exports = {
  inspectImage,
  inspectImages,
  parseImageHeader,
  MAX_HEADER_BYTES,
};
