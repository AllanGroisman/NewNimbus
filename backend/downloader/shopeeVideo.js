// Vídeo do Shopee Vídeo (sv.shopee.com.br) e os produtos vinculados a ele.
//
// O yt-dlp não tem extrator da Shopee. A página do vídeo é Next.js e traz tudo
// no <script id="__NEXT_DATA__">: pageProps.timelineVideo.list[0] tem o mp4
// (content.video — o `url` é SEM marca d'água; a com marca é watermarkVideoUrl),
// a legenda, as visualizações e os produtos (content.products.itemList, só
// shopId/itemId — a API de item da Shopee barra requisição de servidor, então o
// produto vira só o link).
//
// O nome de usuário na URL não importa: /web/@_/video/<postId> abre qualquer
// vídeo. Perfil, ao contrário, é renderizado no navegador e não traz dado
// nenhum no HTML — por isso a Shopee entra só como vídeo avulso.
const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
const CACHE_TTL_MS = 60 * 60 * 1000;
const cache = new Map();

const HOST = /^https?:\/\/([\w-]+\.)*(shopee\.com\.br|shp\.ee)\//i;
// postId é base64 (termina em ==), às vezes vem com o = escapado.
const POST_ID = /\/(?:video|share-video)\/([A-Za-z0-9+/_-]+(?:=|%3D){0,2})/i;

function isVideoUrl(url) {
  return HOST.test(String(url || ""));
}

// Link de compartilhar (shp.ee/…, universal-link?redir=…) só revela o postId
// depois do redirect.
async function resolvePostId(url) {
  const direct = findPostId(url);
  if (direct) return direct;
  const res = await fetch(url, {
    headers: { "User-Agent": UA },
    redirect: "follow",
    signal: AbortSignal.timeout(15000),
  });
  const id = findPostId(res.url);
  if (!id) throw new Error("Link da Shopee sem vídeo — use o link de um vídeo do Shopee Vídeo.");
  return id;
}

function findPostId(url) {
  let u = String(url || "");
  try {
    const redir = new URL(u).searchParams.get("redir");
    if (redir) u = redir;
  } catch { /* não é URL: cai na regex, que também não acha nada */ }
  const m = u.match(POST_ID);
  return m ? decodeURIComponent(m[1]) : null;
}

// Maior H.264 disponível: H.265 é menor, mas não toca em todo celular/editor.
function bestMp4(video) {
  let formats = [...(video.formats || [])];
  try {
    const mms = JSON.parse(video.mmsData || "{}");
    formats = formats.concat(mms.formats || [], mms.default_format ? [mms.default_format] : []);
  } catch { /* mmsData é opcional */ }
  const h264 = formats.filter((f) => f?.url && (!f.codec || f.codec === "H264"));
  h264.sort((a, b) => (b.height || 0) - (a.height || 0));
  return h264[0]?.url || video.url;
}

async function fetchPost(postId) {
  const hit = cache.get(postId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;

  const pageUrl = `https://sv.shopee.com.br/web/@_/video/${encodeURIComponent(postId)}`;
  const res = await fetch(pageUrl, {
    headers: { "User-Agent": UA, "Accept-Language": "pt-BR,pt;q=0.9" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Shopee respondeu ${res.status}`);
  const html = await res.text();
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error("Página do vídeo sem dados (a Shopee pode ter bloqueado a requisição)");
  const post = JSON.parse(m[1]).props?.pageProps?.timelineVideo?.list?.[0];
  if (!post?.content?.video) throw new Error("Vídeo da Shopee indisponível");

  const { meta = {}, content } = post;
  const v = content.video;
  const data = {
    video: {
      id: postId,
      platform: "shopee",
      title: (content.caption || "").trim() || `Vídeo de ${meta.userName || "Shopee"}`,
      url: `https://sv.shopee.com.br/web/@${meta.userName || "_"}/video/${postId}`,
      thumbnail: v.cover || null,
      duration: v.duration ? v.duration / 1000 : null,
      views: meta.countInfo?.views ?? null,
      uploadDate: meta.ctime ? new Date(meta.ctime).toISOString().slice(0, 10).replace(/-/g, "") : null,
      channel: meta.userName || null,
      vertical: (v.height || 0) >= (v.width || 0),
    },
    media: bestMp4(v),
    products: (content.products?.itemList || []).map((p, i) => ({
      id: String(p.itemId),
      title: `Produto Shopee ${i + 1}`,
      url: `https://shopee.com.br/product/${p.shopId}/${p.itemId}`,
      image: null,
    })),
  };
  cache.set(postId, { at: Date.now(), data });
  return data;
}

async function getVideo(url) {
  return (await fetchPost(await resolvePostId(url))).video;
}

async function getProducts(url) {
  return (await fetchPost(await resolvePostId(url))).products;
}

// Mesmo contrato do ytdlp.downloadVideo: resolve com o caminho do arquivo.
// O mp4 é arquivo único e direto, sem merge — um fetch em stream basta.
async function downloadVideo(video, dir, onProgress) {
  const { video: info, media } = await fetchPost(await resolvePostId(video.url));
  const res = await fetch(media, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10 * 60 * 1000) });
  if (!res.ok || !res.body) throw new Error(`Shopee respondeu ${res.status} ao baixar o vídeo`);
  const total = Number(res.headers.get("content-length")) || 0;
  // postId tem "/" e "=" (base64): fora do nome do arquivo.
  const safeId = info.id.replace(/[^A-Za-z0-9_-]/g, "");
  const safeTitle = info.title.replace(/[\\/:*?"<>|\r\n]+/g, " ").slice(0, 80).trim() || "shopee";
  const file = path.join(dir, `${safeTitle} [${safeId}].mp4`);
  let got = 0;
  const body = Readable.fromWeb(res.body);
  body.on("data", (chunk) => {
    got += chunk.length;
    if (total) onProgress?.((got / total) * 100);
  });
  await pipeline(body, fs.createWriteStream(file));
  return file;
}

module.exports = { isVideoUrl, getVideo, getProducts, downloadVideo, findPostId };
