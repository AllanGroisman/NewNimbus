// A categoria do cupom do ML, do jeito que a tela mostra.
//
// O ML separa os cupons por categoria e o cupom guarda em QUAIS ele apareceu — só
// que como chave crua (`ce_vertical`), num array, porque o mesmo cupom aparece em
// vários grupos. O nome bonito ("Eletrônicos") só o ML diz, e só na leitura da aba:
// o backend vai mesclando esse dicionário a cada rodada (backend/coupons/sync.js) e
// manda no status. Puro de propósito — é o pedaço testável sem montar a tela.

// O nome da categoria do ML a partir da chave crua do cupom (`ce_vertical`). O
// dicionário vem do status (backend/coupons/sync.js, mesclado a cada rodada); sem
// ele — categoria vista antes de o mapa existir — fica a chave, que ainda diz mais
// do que um traço.
export function rotuloCategoria(chave, labels) {
  if (!chave) return "";
  return (labels && labels[chave]) || String(chave);
}

// As categorias de um cupom em uma linha só: "Eletrônicos · Moda".
export function categoriasDoCupom(c, labels) {
  const chaves = Array.isArray(c?.groupings) ? c.groupings : [];
  const nomes = chaves.map(k => rotuloCategoria(k, labels)).filter(Boolean);
  return nomes.length ? nomes.join(" · ") : "—";
}
