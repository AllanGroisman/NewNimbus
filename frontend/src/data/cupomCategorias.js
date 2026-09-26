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
//
// Cupom de LOJA ("Em produtos de Agrotrator") tem categoria própria e ela vem na
// frente: ele vale só para os produtos daquele vendedor, e essa é a informação
// que decide se ele serve pra alguma coisa. A vertical dele, quando existe, é
// secundária — e na maioria das vezes nem existe, porque a passada de carimbo
// pega poucas páginas de cada categoria.
export function categoriasDoCupom(c, labels) {
  const chaves = Array.isArray(c?.groupings) ? c.groupings : [];
  const nomes = chaves.map(k => rotuloCategoria(k, labels)).filter(Boolean);
  if (c?.scope === "store") return `Loja${c.sellerName ? ` · ${c.sellerName}` : ""}`;
  return nomes.length ? nomes.join(" · ") : "—";
}

// A mesma linha, cortada para caber na tabela: as `max` primeiras categorias e
// quantas ficaram de fora. Cupom que aparece em cinco verticais escrevia as cinco
// na célula e empurrava a tabela para a rolagem lateral; o resto vai para o
// `title`, que é o `categoriasDoCupom` inteiro.
export function resumoCategorias(c, labels, max = 2) {
  const completo = categoriasDoCupom(c, labels);
  if (c?.scope === "store") return { texto: completo, resto: 0, completo };
  const nomes = (Array.isArray(c?.groupings) ? c.groupings : []).map(k => rotuloCategoria(k, labels)).filter(Boolean);
  if (nomes.length <= max) return { texto: completo, resto: 0, completo };
  return { texto: nomes.slice(0, max).join(" · "), resto: nomes.length - max, completo };
}

// O prazo de um cupom em palavras (Admin › Cupons, task 17):
// "vence em 5h", "vence em 2 dias", "venceu hoje", "venceu há 3 dias", "sem validade".
export function prazoDoCupom(expiresAt, agora = Date.now()) {
  if (!expiresAt) return { texto: "sem validade", tom: "neutro" };
  const t = new Date(expiresAt).getTime();
  if (!Number.isFinite(t)) return { texto: "validade ilegível", tom: "neutro" };
  const h = (t - agora) / 36e5;
  if (h <= 0) {
    const d = Math.floor(-h / 24);
    return { texto: d >= 1 ? `venceu há ${d} ${d === 1 ? "dia" : "dias"}` : "venceu hoje", tom: "vencido" };
  }
  if (h < 24) return { texto: `vence em ${Math.max(1, Math.round(h))}h`, tom: "urgente" };
  const d = Math.round(h / 24);
  return { texto: `vence em ${d} ${d === 1 ? "dia" : "dias"}`, tom: d <= 3 ? "urgente" : "ok" };
}
