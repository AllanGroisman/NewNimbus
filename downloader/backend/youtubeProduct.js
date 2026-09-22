// Produto marcado num Short do YouTube (YouTube Shopping).
//
// O yt-dlp não expõe isso. A página do Short traz `var ytInitialData = {...}`
// e cada produto vem num `productListItemRenderer` do painel de produtos. A URL
// da loja fica em onClickCommand → webCommandMetadata.url.
//
// A URL vem com a tag de afiliado de quem postou (matt_word/matt_tool no ML),
// então a query é descartada — só `pdp_filters` fica, porque aponta o anúncio.
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
const CACHE_TTL_MS = 60 * 60 * 1000;
const cache = new Map();

const VIDEO_URL = /^https:\/\/(?:(?:www\.|m\.)?youtube\.com\/(?:shorts\/|watch\?(?:.*&)?v=)|youtu\.be\/)([\w-]{11})/i;

function isVideoUrl(url) {
  return VIDEO_URL.test(url);
}

function collect(node, key, out) {
  if (!node || typeof node !== "object") return;
  if (node[key]) out.push(node[key]);
  for (const v of Object.values(node)) collect(v, key, out);
}

function cleanUrl(raw) {
  const u = new URL(raw);
  const keep = u.searchParams.get("pdp_filters");
  u.search = "";
  u.hash = "";
  if (keep) u.searchParams.set("pdp_filters", keep);
  return u.toString();
}

function toProduct(r) {
  const cmds = [];
  collect(r.onClickCommand, "webCommandMetadata", cmds);
  const raw = cmds.map((c) => c.url).find((u) => /^https?:\/\//.test(u || "") && !/youtube\.com/.test(u));
  if (!raw) return null;
  const url = cleanUrl(raw);
  const thumbs = r.thumbnail?.thumbnails || [];
  return {
    id: url.match(/MLB-?\d+/i)?.[0].replace("-", "") || url,
    title: r.title?.simpleText || "Produto",
    url,
    image: thumbs.length ? thumbs[thumbs.length - 1].url : null,
    price: r.price || null,
    merchant: r.merchantName || null,
  };
}

function extractInitialData(html) {
  const start = html.indexOf("var ytInitialData = ");
  if (start < 0) return null;
  const from = html.indexOf("{", start);
  const end = html.indexOf(";</script>", from);
  if (end < 0) return null;
  return JSON.parse(html.slice(from, end));
}

async function getProducts(videoUrl) {
  const videoId = videoUrl.match(VIDEO_URL)?.[1];
  const hit = cache.get(videoId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.products;

  const res = await fetch(`https://www.youtube.com/shorts/${videoId}`, {
    headers: { "User-Agent": UA, "Accept-Language": "pt-BR,pt;q=0.9" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`YouTube respondeu ${res.status}`);
  const data = extractInitialData(await res.text());
  if (!data) throw new Error("Página do Short sem dados (YouTube pode ter bloqueado a requisição)");

  const raws = [];
  collect(data, "productListItemRenderer", raws);
  const seen = new Set();
  const products = raws
    .map(toProduct)
    .filter((p) => p && !seen.has(p.id) && seen.add(p.id));

  cache.set(videoId, { at: Date.now(), products });
  return products;
}

module.exports = { getProducts, isVideoUrl };
