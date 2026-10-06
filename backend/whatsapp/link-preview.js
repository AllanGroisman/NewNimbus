// link-preview — o "cartão" do link (foto + título em cima do texto) do modo
// "Prévia do link" das campanhas (`scraping.imageMode = "link"`).
//
// No WhatsApp quem monta esse cartão é o aparelho que ENVIA: o celular abre o link
// e embute título e imagem na mensagem — o de quem recebe não busca nada. Aqui o
// envio sai pelo Baileys, então o sistema faz esse papel, com os dados do produto
// que ele já tem (nome e foto). Não abre o link: a loja pode bloquear (a Amazon
// bloqueia robô) e abrir o link de afiliado contaria um clique falso.
//
// A imagem vai em duas camadas:
//   1. `jpegThumbnail` — miniatura embutida na própria mensagem. Não é download de
//      mídia, então aparece mesmo pra quem desligou o download automático de fotos.
//      O Baileys gera a dele com 32px (borrada); aqui sai com INLINE_THUMB_WIDTH.
//   2. `highQualityThumbnail` — a foto sobe pro servidor do WhatsApp como
//      "thumbnail-link" (o mesmo caminho do getUrlInfo do Baileys) e o cartão
//      fica grande.
// Falhou o upload, vai só a miniatura; falhou a foto, vai o cartão só com título.
// A prévia nunca derruba o envio.
//
// Cache por número+link+foto: um envio vai pra N grupos em sequência, e sem ele
// seriam N downloads e N uploads da mesma foto.

const INLINE_THUMB_WIDTH = 192;
// Somados, cabem folgados no prazo de 60s do RPC do sendText (whatsapp/proxy.js).
const IMG_TIMEOUT_MS = 15000;
const UPLOAD_TIMEOUT_MS = 20000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 200;

const cache = new Map(); // key -> { at, promise }

// Lido na hora da chamada (não no load) pra os testes trocarem via require.cache.
function baileys() {
  return require("@whiskeysockets/baileys");
}

async function fetchImage(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(IMG_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ao baixar a foto`);
  return Buffer.from(await res.arrayBuffer());
}

async function build({ url, title, img }, { upload, logger }) {
  const preview = { "matched-text": url, "canonical-url": url, title: String(title || url) };
  if (!img) return preview;

  const b = baileys();
  let buf, thumb;
  try {
    buf = await fetchImage(img);
    thumb = await b.extractImageThumb(buf, INLINE_THUMB_WIDTH);
    preview.jpegThumbnail = thumb.buffer;
  } catch (err) {
    logger?.warn?.({ err: err.message, img }, "prévia do link: foto falhou — cartão só com título");
    return preview;
  }

  if (!upload) return preview;
  try {
    // Com o `jpegThumbnail` já no upload, o Baileys não gera o de 32px por cima.
    const { imageMessage } = await b.prepareWAMessageMedia(
      { image: buf, jpegThumbnail: thumb.buffer, width: thumb.original?.width, height: thumb.original?.height },
      { upload, mediaTypeOverride: "thumbnail-link", mediaUploadTimeoutMs: UPLOAD_TIMEOUT_MS, logger },
    );
    if (imageMessage) preview.highQualityThumbnail = imageMessage;
  } catch (err) {
    logger?.warn?.({ err: err.message, img }, "prévia do link: upload da foto falhou — vai só a miniatura");
  }
  return preview;
}

// `cacheKey` identifica o número que envia: a foto em alta sobe pelo socket dele.
async function buildLinkPreview(spec, { upload, logger, cacheKey = "" } = {}) {
  const key = `${cacheKey}|${spec.url}|${spec.img || ""}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.promise;

  const promise = build(spec, { upload, logger });
  cache.set(key, { at: now, promise });
  promise.catch(() => cache.delete(key));
  if (cache.size > CACHE_MAX) {
    for (const [k, v] of cache) {
      if (cache.size <= CACHE_MAX && now - v.at < CACHE_TTL_MS) break;
      cache.delete(k);
    }
  }
  return promise;
}

function _resetCache() {
  cache.clear();
}

module.exports = { buildLinkPreview, INLINE_THUMB_WIDTH, _resetCache };
