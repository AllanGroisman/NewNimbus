// URLs da Amazon BR — ASIN, link canônico e reconhecimento de domínio.
//
// Mora num módulo próprio (sem dependências) porque o catalog/product-key.js
// precisa dele: requerer affiliate.js de lá criaria ciclo (affiliate → config →
// storage → ...). Puro → testável.

// Domínios da Amazon BR (e os encurtadores dela). Não inclui .com/.es/etc:
// o sistema só opera na loja brasileira.
const AMAZON_HOSTS = /(^|\.)(amazon\.com\.br|amzn\.to|a\.co)$/i;

function isAmazonHost(url) {
  if (!url || typeof url !== "string") return false;
  try {
    return AMAZON_HOSTS.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

function extractASIN(url) {
  if (!url || typeof url !== "string") return null;
  const decoded = (() => { try { return decodeURIComponent(url); } catch { return url; } })();
  const patterns = [
    /\/dp\/([A-Z0-9]{10})(?:[/?]|$)/i,
    /\/gp\/product\/([A-Z0-9]{10})(?:[/?]|$)/i,
    /\/gp\/aw\/d\/([A-Z0-9]{10})(?:[/?]|$)/i,
    /\/product\/([A-Z0-9]{10})(?:[/?]|$)/i,
    /\/[a-z]{2}\/dp\/([A-Z0-9]{10})(?:[/?]|$)/i,
    /\/exec\/obidos\/asin\/([A-Z0-9]{10})(?:[/?]|$)/i,
    /[?&]asin=([A-Z0-9]{10})\b/i,
  ];
  for (const p of patterns) {
    const m = decoded.match(p);
    if (m) return m[1].toUpperCase();
  }
  return null;
}

// Link canônico da página do produto: sem slug de nome, sem /ref= de campanha
// (que às vezes força uma oferta específica) e sem query de tracking. É a URL
// que o scraper abre pra conferir o preço e a que vai pro catálogo.
// Aceita um ASIN solto ou uma URL da qual extrair o ASIN. null se não der.
function canonicalAmazonUrl(asinOrUrl) {
  if (!asinOrUrl || typeof asinOrUrl !== "string") return null;
  const raw = asinOrUrl.trim();
  const asin = /^[A-Z0-9]{10}$/i.test(raw) ? raw.toUpperCase() : extractASIN(raw);
  if (!asin) return null;
  return `https://www.amazon.com.br/dp/${asin}`;
}

module.exports = { isAmazonHost, extractASIN, canonicalAmazonUrl };
