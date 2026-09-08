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

// Cupom sem data de validade vale (é a mesma regra do `couponsListForKeys`: o
// filtro lá é `expiresAt IS NULL OR expiresAt > NOW()`). Data quebrada não derruba a
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

// O mesmo desconto, mas contado: o que a mensagem precisa para dizer QUANTO o
// cupom tira, e não só quanto sobra.
//
// Construída sobre o `precoComCupom` de propósito — as regras que recusam o cupom
// (vencido, não começou, compra mínima, teto, tipo desconhecido) moram lá e só lá.
// Se ele diz `null`, aqui também é `null`: nunca existe um rótulo "15% OFF" para um
// cupom que o cálculo recusou.
//
// `rotulo` é a REGRA do cupom ("15% OFF"), `economia` é o que ela vale neste preço
// ("R$ 284,85"). São coisas diferentes e a mensagem usa as duas em lugares
// diferentes — daí não haver um campo só.
function detalheDoCupom(price, rule) {
  const final = precoComCupom(price, rule);
  if (final === null) return null;

  const p = Number(price);
  const economia = Math.round((p - final) * 100) / 100;

  // O rótulo sai do `kind`, não da economia: um cupom de 15% com teto desconta
  // menos que 15% num produto caro, e escrever "12% OFF" ali seria descrever o
  // produto, não o cupom que o cliente vai usar no próximo.
  const value = Number(rule.value);
  const rotulo = String(rule.kind || "") === "percent"
    ? `${value}% OFF`
    : `R$ ${value.toLocaleString("pt-BR", { minimumFractionDigits: 2 })} OFF`;

  return { final, economia, rotulo };
}

module.exports = { precoComCupom, detalheDoCupom };
