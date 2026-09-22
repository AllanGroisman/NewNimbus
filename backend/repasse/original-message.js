// Modo "mensagem original" do repasse: em vez de remontar o texto pelo modelo da
// campanha, repassa a mensagem do grupo líder exatamente como veio, trocando só
// os links pelos links de afiliado do usuário. Config por campanha em
// scraping.repasse.messageMode ("template" | "original"; ausente = "template").
// Puro → testável.

function isOriginalMode(group) {
  return group?.scraping?.repasse?.messageMode === "original";
}

// Troca cada `raw` (a string exata que extractUrls achou no texto) pelo `link`
// convertido. split/join em vez de regex: URL tem `?`, `&`, `.` e afins. Do mais
// longo pro mais curto, pra um URL que é prefixo de outro não ser trocado pela
// metade.
function rewriteText(text, pairs) {
  let out = String(text || "");
  const sorted = [...(pairs || [])]
    .filter(p => p && p.raw && p.link)
    .sort((a, b) => b.raw.length - a.raw.length);
  // Marcadores intermediários: sem eles, um link já trocado que contenha um `raw`
  // mais curto (ex.: o afiliado é o próprio produto + ?tag=) seria trocado de novo.
  const tokens = sorted.map((p, i) => `\u0000${i}\u0000`);
  sorted.forEach((p, i) => { out = out.split(p.raw).join(tokens[i]); });
  sorted.forEach((p, i) => { out = out.split(tokens[i]).join(p.link); });
  return out;
}

module.exports = { isOriginalMode, rewriteText };
