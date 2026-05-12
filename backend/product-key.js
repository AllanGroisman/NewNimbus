// productKey — chave estável e determinística de produto.
//
// CRÍTICO: este hash é a PK no catálogo. Mudar a função obriga regerar todo
// o catálogo (e quebra cooldown/dedup pra produtos já enfileirados).
//
// Estratégia:
//   1. Se a URL tiver MLB ID (Mercado Livre), usa "MLB" + id
//   2. Senão, usa origin + pathname (descarta query strings de tracking)
//   3. Fallback: nome normalizado + store

const crypto = require("crypto");

function productKey(p) {
  const link = p.link || "";
  const decoded = (() => { try { return decodeURIComponent(link); } catch { return link; } })();
  const m = decoded.match(/\/p\/MLB(\d+)/i)
        || decoded.match(/\/MLB-?(\d{6,})-/i)
        || decoded.match(/produto\.mercadolivre\.com\.br\/MLB-?(\d{6,})/i);
  if (m) return crypto.createHash("md5").update("MLB" + m[1]).digest("hex");
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
