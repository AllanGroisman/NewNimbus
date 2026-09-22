// Produto do TikTok Shop anunciado num vídeo.
//
// O yt-dlp não expõe isso. A página do vídeo traz o estado inicial num
// <script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">, e o produto mora em
// itemStruct.anchors — como JSON dentro de string, dois níveis abaixo.
//
// Não confie em `product_id`: é um inteiro de 19 dígitos e o JSON.parse perde
// precisão (…696002 vira …696000). O id sai do `seo_url`, que é string.
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
const CACHE_TTL_MS = 60 * 60 * 1000;
const cache = new Map();

const VIDEO_URL = /^https:\/\/(www\.)?tiktok\.com\/@[^/]+\/video\/(\d+)/i;

function isVideoUrl(url) {
  return VIDEO_URL.test(url);
}

// Percorre o objeto abrindo as strings que são JSON e junta tudo que parece produto.
function collect(node, out) {
  if (typeof node === "string") {
    if (!/^\s*[[{]/.test(node)) return;
    try { node = JSON.parse(node); } catch { return; }
  }
  if (!node || typeof node !== "object") return;
  if (typeof node.seo_url === "string" && node.product_id) out.push(node);
  for (const v of Object.values(node)) collect(v, out);
}

function toProduct(raw) {
  const url = raw.seo_url.split("?")[0];
  const id = url.match(/(\d{10,})\/?$/)?.[1];
  if (!id) return null;
  return {
    id,
    title: raw.title || raw.elastic_title || "Produto",
    url,
    image: raw.cover_url || raw.img_url?.[0] || null,
  };
}

async function getProducts(videoUrl) {
  const videoId = videoUrl.match(VIDEO_URL)?.[2];
  const hit = cache.get(videoId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.products;

  const res = await fetch(videoUrl, {
    headers: { "User-Agent": UA, "Accept-Language": "pt-BR,pt;q=0.9" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`TikTok respondeu ${res.status}`);
  const html = await res.text();

  const m = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error("Página do vídeo sem dados (TikTok pode ter bloqueado a requisição)");
  const item = JSON.parse(m[1]).__DEFAULT_SCOPE__?.["webapp.video-detail"]?.itemInfo?.itemStruct;
  if (!item) throw new Error("Vídeo indisponível");

  const raws = [];
  collect(item.anchors || [], raws);
  const seen = new Set();
  const products = raws
    .map(toProduct)
    .filter((p) => p && !seen.has(p.id) && seen.add(p.id));

  cache.set(videoId, { at: Date.now(), products });
  return products;
}

module.exports = { getProducts, isVideoUrl };
