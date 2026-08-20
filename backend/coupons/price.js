// Quanto sobra do preço quando o cupom pega.
//
// Puro de propósito: não sabe de banco, não sabe de produto. Recebe o preço e as
// regras do cupom (uma linha de `ml_coupons`) e devolve o preço final — ou `null`
// quando o cupom NÃO se aplica.
//
// O `null` é a resposta que importa. É ele que faz o `{preco_com_cupom}` do modelo
// de mensagem virar o preço normal em vez de anunciar um desconto que o Mercado
// Livre não daria: cupom vencido, compra mínima não atingida, cupom sem valor
// conhecido. Prometer errado aqui vira cliente clicando e pagando mais caro.

// Cupom sem data de validade vale (é a mesma regra do `couponsForKeys`: o filtro
// lá é `expiresAt IS NULL OR expiresAt > NOW()`). Data quebrada não derruba a
// conta — só uma data legível E no passado invalida.
function venceu(v) {
  if (!v) return false;
  const t = new Date(v).getTime();
  return Number.isFinite(t) && t <= Date.now();
}

function aindaNaoComecou(v) {
  if (!v) return false;
  const t = new Date(v).getTime();
  return Number.isFinite(t) && t > Date.now();
}

function precoComCupom(price, rule) {
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0) return null;
  if (!rule) return null;

  const value = Number(rule.value);
  if (!Number.isFinite(value) || value <= 0) return null;

  // `startsAt` é gravado desde sempre e não era conferido em lugar nenhum. Cupom
  // que ainda não começou não desconta nada hoje.
  if (venceu(rule.expiresAt) || aindaNaoComecou(rule.startsAt)) return null;

  // Compra mínima: abaixo dela o cupom simplesmente não pega no produto.
  const min = Number(rule.minPurchase);
  if (Number.isFinite(min) && min > 0 && p < min) return null;

  // `kind` sai do parser da página (`scraping/ml-cupons.js`), que escreve
  // "desconhecido" quando não deu pra ler; o default da coluna é "unknown". Os
  // dois querem dizer a mesma coisa: não dá pra calcular.
  let desconto;
  const kind = String(rule.kind || "");
  if (kind === "percent") {
    if (value >= 100) return null; // 100% OFF não existe — é dado quebrado
    desconto = (p * value) / 100;
  } else if (kind === "fixed") {
    desconto = value;
  } else {
    return null;
  }

  // O teto do cupom ("cap_amount" do ML): ele nunca desconta mais que isso.
  const teto = Number(rule.maxDiscount);
  if (Number.isFinite(teto) && teto > 0) desconto = Math.min(desconto, teto);

  const final = Math.round((p - desconto) * 100) / 100;
  // Desconto que zera o produto ou não muda nada não é preço pra anunciar.
  if (!(final > 0) || final >= p) return null;
  return final;
}

module.exports = { precoComCupom };
