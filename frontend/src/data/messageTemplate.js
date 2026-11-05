// Cópia do renderTemplate do backend (backend/scheduler.js) pra prévia do editor
// de modelos bater com a mensagem realmente enviada. Mudou lá, muda aqui — o
// tests/unit/template-parity.test.js roda os dois sobre os mesmos itens e
// exige saídas idênticas.
//
// Regra única: variável SEM VALOR derruba a linha inteira. Linhas em branco que
// sobram quando um bloco inteiro some viram uma só.

const TEMPLATE_TOKEN_RE = /\{(\w+)\}/g;

// Número grande compacto: 1234 -> "1,2 mil", 1500000 -> "1,5 mi".
function formatCompact(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return null;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1).replace(".", ",").replace(",0", "")} mi`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1).replace(".", ",").replace(",0", "")} mil`;
  return String(v);
}

function formatVendas(p) {
  if (p?.soldCount != null && Number(p.soldCount) > 0) return `${formatCompact(p.soldCount)} vendidos`;
  if (p?.sold) { const s = String(p.sold).trim(); return /vendid/i.test(s) ? s : `${s} vendidos`; }
  return "";
}

export function templateValues(p, { modeloTemPreco = false } = {}) {
  const num = v => (v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
  const pos = v => (num(v) > 0 ? num(v) : null);
  const text = v => (v == null ? "" : String(v).trim()) || null;
  const fmt = v => `R$ ${v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const price = pos(p.price);
  const original = price != null && pos(p.originalPrice) > price ? pos(p.originalPrice) : null;
  let discount = num(p.discount) >= 1 ? Math.round(num(p.discount)) : null;
  if (discount == null && original != null) {
    const fromPair = Math.round((1 - price / original) * 100);
    discount = fromPair >= 1 ? fromPair : null;
  }
  const withCoupon = pos(p.priceWithCoupon);
  const saving = pos(p.couponSaving);
  const rating = pos(p.rating);

  let base = original;
  if (base == null && price != null && discount != null && discount < 100) base = price / (1 - discount / 100);
  if (base == null) base = price;
  const final = withCoupon ?? price;
  // Só o cupom desconta (sem "De" e sem % de promoção): o "De" vira o preço sem
  // cupom, pra o "Por" com cupom e o {desconto_total} terem de onde partir. Não
  // vale se o modelo mostra o {preco} — sairia "De 1.099 / Por 1.099".
  const deDoCupom = original == null && discount == null && withCoupon != null && withCoupon < price && !modeloTemPreco;
  const totalPct = base != null && final != null ? Math.round((1 - final / base) * 100) : null;
  const totalSaving = base != null && final != null ? Math.round((base - final) * 100) / 100 : null;

  return {
    produto: text(p.name),
    preco: price != null ? fmt(price) : null,
    preco_com_cupom: withCoupon != null ? fmt(withCoupon) : (price != null ? fmt(price) : null),
    preco_antigo: original != null ? fmt(original) : (deDoCupom ? fmt(price) : null),
    desconto: discount != null ? `${discount}%` : null,
    economia: original != null ? fmt(Math.round((original - price) * 100) / 100) : null,
    loja: text(p.store),
    vendas: formatVendas(p) || null,
    avaliacao: rating != null ? rating.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : null,
    frete: p.freeShipping === true ? "Frete grátis" : null,
    cupom: text(p.coupon),
    desconto_cupom: text(p.couponLabel),
    economia_cupom: saving != null ? fmt(saving) : null,
    desconto_total: totalPct >= 1 ? `${totalPct}%` : null,
    economia_total: totalSaving > 0 ? fmt(totalSaving) : null,
    link: text(p.link),
    todos: "@todos",
  };
}

const PARES_SEM_CUPOM = [["preco_com_cupom", "preco"], ["desconto_total", "desconto"], ["economia_total", "economia"]];

export function renderMessageTemplate(template, p) {
  const tpl = String(template || "");
  const item = p || {};
  const values = templateValues(item, { modeloTemPreco: tpl.includes("{preco}") });
  const known = k => Object.prototype.hasOwnProperty.call(values, k);
  const hasEmpty = line => [...line.matchAll(TEMPLATE_TOKEN_RE)].some(m => known(m[1]) && values[m[1]] == null);
  let lines = tpl.split("\n").filter(line => !hasEmpty(line));
  if (!(Number(item.priceWithCoupon) > 0)) {
    for (const [total, comum] of PARES_SEM_CUPOM) {
      const isTotalLine = l => l.includes(`{${total}}`);
      if (lines.some(l => l.includes(`{${comum}}`) && !isTotalLine(l))) lines = lines.filter(l => !isTotalLine(l));
    }
  }
  return lines.join("\n")
    .replace(TEMPLATE_TOKEN_RE, (all, k) => (known(k) ? values[k] : all))
    .replace(/\n\s*\n(\s*\n)+/g, "\n\n")
    .trim();
}

// Item de exemplo da prévia — no mesmo formato do item que o envio recebe
// (números crus; quem formata é o renderizador). O cupom é o GALAXY10: 10% sobre
// o preço.
export const PREVIEW_ITEM = {
  name: "Smartphone Samsung Galaxy A55 256GB",
  price: 1899,
  originalPrice: 2499,
  discount: 24,
  store: "Mercado Livre",
  soldCount: 1200,
  rating: 4.8,
  freeShipping: true,
  coupon: "GALAXY10",
  priceWithCoupon: 1709.1,
  couponLabel: "10% OFF",
  couponSaving: 189.9,
  link: "https://merc.li/abc123",
};

// O item de exemplo com ou sem promoção / cupom — os dois toggles da prévia.
export function previewItem({ promo = true, cupom = true } = {}) {
  let item = { ...PREVIEW_ITEM };
  if (!promo) item = { ...item, originalPrice: null, discount: null };
  if (!cupom) item = { ...item, coupon: null, priceWithCoupon: null, couponLabel: null, couponSaving: null };
  return item;
}
