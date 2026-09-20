// Os cupons que o CHECKOUT do Mercado Livre lista para um carrinho — lidos da
// captura da sonda (extension/checkout.js, modo "listar").
//
// O que a sonda de 19/09/2026 mostrou (porteiro Intelbras, campanha 14167118): o
// popup "Cupons (1/1 em uso)" do checkout de página única é um iframe
// `/cupons/cho?context_id=…`, e o HTML dele traz o modelo inteiro no mesmo formato
// nordic da aba /cupons (`_n.ctx.r=`):
//
//   appProps.pageProps.buyingFlowData.groupings[]          ← "Cupons do Mercado Livre", de loja…
//     .key                                                   "meli" | …
//     .rawCoupons[] { campaign_id, title.text, category, status.id,
//                     action { type: "apply", text: "Aplicado" }, expiration_date,
//                     amount { min_amount, cap_amount } (texto) }
//   appProps.pageProps.buyingFlowData.header.savingsSubtitle.amount   ← "economizando R$ 20"
//   …tracking.view.eventData.coupons_list[] { campaign_id, discount_type,
//                     discount_value, given_discount, min_amount, cap_amount, … }
//
// `given_discount` é o que o cupom descontou NESTE carrinho — a resposta que a
// ferramenta existe pra dar, vinda do próprio ML. Os números saem do `coupons_list`
// (já numéricos); título, categoria e "aplicado" saem do `rawCoupons`.
//
// Pura: HTML entra, lista sai. Testada com a captura real (fixture).
const { sliceBalancedJson } = require("../scraping/ml-social");

function numero(v) {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[^\d.,-]/g, "").replace(/\.(?=\d{3}\b)/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

// Devolve { ok, motivo, economia, cupons[] }. `ok: false` quando o HTML não tem o
// modelo (iframe não carregou, ML mudou o formato) — e aí NADA é gravado.
function parseCheckoutCupons(html) {
  const cru = sliceBalancedJson(String(html || ""), "_n.ctx.r=");
  let estado = null;
  try { estado = cru ? JSON.parse(cru) : null; } catch { estado = null; }
  const bf = estado?.appProps?.pageProps?.buyingFlowData;
  if (!bf || !Array.isArray(bf.groupings)) {
    return { ok: false, motivo: "O HTML do popup não tem o modelo dos cupons (o iframe pode não ter carregado).", economia: null, cupons: [] };
  }

  const numeros = new Map();
  for (const c of bf.tracking?.view?.eventData?.coupons_list || estado?.appProps?.pageProps?.buyingFlowData?.tracking?.view?.eventData?.coupons_list || []) {
    if (c?.campaign_id) numeros.set(String(c.campaign_id), c);
  }

  const cupons = [];
  for (const g of bf.groupings) {
    for (const r of g?.rawCoupons || []) {
      if (!r?.campaign_id) continue;
      const id = String(r.campaign_id);
      const n = numeros.get(id) || {};
      const tipo = String(n.discount_type || r.benefit_mode || "").toUpperCase();
      const acao = r.action || {};
      cupons.push({
        campaignId: id,
        titulo: n.title || [r.title?.text, r.category].filter(Boolean).join(" em ") || null,
        categoria: r.category || null,
        grupo: g.key || null,
        grupoTitulo: g.title || null,
        status: r.status?.id || n.status_id || null,
        // "Aplicado" = é o cupom que o ML pôs no carrinho. Os outros da lista são os
        // que o ML oferece pra este carrinho sem estar em uso.
        aplicado: /aplicad/i.test(acao.text || "") || /aplicad/i.test(acao.accessibility?.sr_label || ""),
        acao: acao.text || null,
        kind: tipo === "PERCENT" ? "percent" : (tipo ? "fixed" : "unknown"),
        value: numero(n.discount_value),
        descontoNoCarrinho: numero(n.given_discount),
        minPurchase: numero(n.min_amount) ?? numero(r.amount?.min_amount),
        maxDiscount: numero(n.cap_amount) ?? numero(r.amount?.cap_amount),
        expiresAt: n.expiration_date || r.expiration_date || null,
        code: r.code || n.code || null,
        iconUrl: r.icon || null,
      });
    }
  }

  const sav = bf.header?.savingsSubtitle?.amount;
  const economia = sav ? numero(`${sav.fractionalAmount || 0}.${sav.decimalAmount || "00"}`) : null;
  return { ok: true, motivo: null, economia, cupons };
}

// Os que VALEM neste produto, segundo o ML: o que está aplicado, ou o que o ML
// calculou desconto pra este carrinho. Um cupom listado sem nenhum dos dois pode ser
// só oferta da conta — não vira vínculo.
function cuponsQueValem(lista) {
  return (lista || []).filter(c => c.status !== "INACTIVE" && (c.aplicado || (c.descontoNoCarrinho || 0) > 0));
}

module.exports = { parseCheckoutCupons, cuponsQueValem };
