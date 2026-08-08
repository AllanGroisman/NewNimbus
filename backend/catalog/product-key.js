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

function productKey(p) {
  const link = p.link || "";
  const decoded = (() => { try { return decodeURIComponent(link); } catch { return link; } })();
  // Mercado Livre — formato /p/MLB123 ou /MLB-123-...
  const mml = decoded.match(/\/p\/MLB(\d+)/i)
        || decoded.match(/\/MLB-?(\d{6,})-/i)
        || decoded.match(/produto\.mercadolivre\.com\.br\/MLB-?(\d{6,})/i);
  if (mml) return crypto.createHash("md5").update("MLB" + mml[1]).digest("hex");
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

module.exports = { productKey };
