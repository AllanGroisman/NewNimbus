// productKey — chave estável e determinística de produto.
//
// CRÍTICO: este hash é a PK no catálogo. Mudar a função obriga regerar todo
// o catálogo (e quebra cooldown/dedup pra produtos já enfileirados).
//
// Estratégia:
//   1. Se a URL tiver MLB ID (Mercado Livre), usa "MLB" + id
//   2. Se a URL tiver padrão Shopee `i.<sellerId>.<itemId>`, usa "SHP" + ids
//   3. Se for Amazon e der pra extrair o ASIN, usa "AMZ" + asin
//   4. Senão, usa origin + pathname (descarta query strings de tracking)
//   5. Fallback: nome normalizado + store

const crypto = require("crypto");
const { isAmazonHost, extractASIN } = require("../scraping/amazon-url");

// O número do produto no ML, quando a URL traz um. Extraído daqui (e não só
// dentro do productKey) porque quem lê o catálogo por link precisa CONFERIR que
// achou o produto certo: /p/MLB… (catálogo) e /MLB-…- (anúncio) são numerações
// diferentes, e o productKey funde as duas — dois produtos distintos com o mesmo
// número dariam a mesma chave. Devolve "MLB123…" ou null.
function mlItemIdFromUrl(link) {
  if (!link || typeof link !== "string") return null;
  const decoded = (() => { try { return decodeURIComponent(link); } catch { return link; } })();
  const m = decoded.match(/\/p\/MLB(\d+)/i)
        || decoded.match(/\/MLB-?(\d{6,})-/i)
        || decoded.match(/produto\.mercadolivre\.com\.br\/MLB-?(\d{6,})/i);
  return m ? "MLB" + m[1] : null;
}

// Em qual numeração a URL fala: "catalogo" (/p/MLB…, /up/MLBU…) ou "anuncio"
// (/MLB-…-, produto.mercadolivre.com.br/MLB-…). Os dois espaços têm números
// próprios que podem coincidir, e o productKey funde ambos — quem lê o catálogo
// por link precisa comparar o espaço junto do número.
function mlUrlSpace(link) {
  if (!link || typeof link !== "string") return null;
  const decoded = (() => { try { return decodeURIComponent(link); } catch { return link; } })();
  if (/\/p\/MLB\d+/i.test(decoded) || /\/up\/MLBU\d+/i.test(decoded)) return "catalogo";
  if (/\/MLB-?\d{6,}-/i.test(decoded) || /produto\.mercadolivre\.com\.br\/MLB-?\d{6,}/i.test(decoded)) return "anuncio";
  return null;
}

function productKey(p) {
  const link = p.link || "";
  const decoded = (() => { try { return decodeURIComponent(link); } catch { return link; } })();
  // Mercado Livre — formato /p/MLB123 ou /MLB-123-...
  const mlId = mlItemIdFromUrl(link);
  if (mlId) return crypto.createHash("md5").update(mlId).digest("hex");
  // Shopee — formato `...-i.SELLERID.ITEMID` (com ou sem query)
  const msh = decoded.match(/[.\-/]i\.(\d+)\.(\d+)(?:[/?#]|$)/i);
  if (msh) return crypto.createHash("md5").update(`SHP${msh[1]}.${msh[2]}`).digest("hex");
  // Amazon — o ASIN é o identificador do produto. Sem isso, /dp/ASIN,
  // /gp/product/ASIN e /slug/dp/ASIN/ref=... viravam três linhas no catálogo.
  if (isAmazonHost(link)) {
    const asin = extractASIN(decoded);
    if (asin) return crypto.createHash("md5").update("AMZ" + asin).digest("hex");
  }
  if (link) {
    try {
      const u = new URL(link);
      return crypto.createHash("md5").update(u.origin + u.pathname).digest("hex");
    } catch {}
  }
  const nm = (p.name || "").toLowerCase().replace(/\s+/g, " ").trim();
  return crypto.createHash("md5").update(`${nm}|${p.store || ""}`).digest("hex");
}

module.exports = { productKey, mlItemIdFromUrl, mlUrlSpace };
