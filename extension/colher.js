// Roda DENTRO da página do Mercado Livre e devolve os produtos daquela página.
//
// GÊMEO: `backend/scraping/scraper.js:harvestMLCards`. São os mesmos seletores, e
// não dá pra compartilhar o arquivo — lá é um módulo Node injetado por Puppeteer,
// aqui é um arquivo solto que a extensão injeta, sem build no meio. Quando o ML
// mudar o card, os DOIS precisam mudar. O teste sobre fixture é o que avisa.
//
// A divisão de trabalho é a mesma de lá: aqui só se lê TEXTO CRU do DOM, e a
// interpretação (preço, desconto, nota) fica em funções puras logo abaixo — é o
// que permite testar isso sem navegador.

(() => {
  const txt = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : null);

  // Gêmeo de scraper.js:parseMLReviewCompacted.
  function lerAvaliacao(alt, visible) {
    const out = { rating: null, sold: null };
    const altTxt = String(alt || "");
    const visTxt = String(visible || "");

    const ratingAlt = altTxt.match(/classifica[çc][ãa]o\s+([\d.,]+)\s+de\s+5/i);
    if (ratingAlt) out.rating = parseFloat(ratingAlt[1].replace(",", "."));
    if (out.rating == null) {
      const ratingVis = visTxt.split("|")[0].match(/([\d]+[.,][\d]+|[\d]+)/);
      if (ratingVis) out.rating = parseFloat(ratingVis[1].replace(",", "."));
    }
    if (out.rating != null && !(out.rating > 0 && out.rating <= 5)) out.rating = null;

    const soldAlt = altTxt.match(/(mais de\s+)?([\d.,]+\s*(?:mil|mi)?)\s*produtos?\s+vendid/i);
    if (soldAlt) out.sold = `${soldAlt[1] ? "+" : ""}${soldAlt[2].trim()} vendidos`;
    if (!out.sold && /vendid/i.test(visTxt)) {
      const s = visTxt.split("|").pop().replace(/\s+/g, " ").trim();
      if (s) out.sold = s;
    }
    return out;
  }

  // A miniatura vem pequena no card. Gêmeo de scraper.js:upgradeMLImageUrl.
  const ML_PICTURE_ID = /\/D_(?:NQ_)?(?:NP_)?(?:2X_)?([A-Z0-9]+_[A-Z0-9-]+)/i;
  function imagemGrande(url) {
    if (!url || typeof url !== "string") return url;
    if (!/mlstatic\.com/i.test(url)) return url;
    const m = ML_PICTURE_ID.exec(url);
    if (m) {
      try {
        const u = new URL(url);
        u.pathname = `/D_NQ_NP_2X_${m[1]}-F.webp`;
        u.search = "";
        u.hash = "";
        return u.toString();
      } catch { /* URL malformada — devolve como veio */ }
    }
    return url;
  }

  // Lê os cards de um documento. Recebe `doc` para servir tanto à página aberta
  // (`document`) quanto às páginas seguintes, que chegam por fetch + DOMParser.
  function colherDo(doc) {
    const produtos = [];
    for (const card of doc.querySelectorAll(".poly-card")) {
      const titleEl = card.querySelector(".poly-component__title");
      const fractionEl = card.querySelector(".poly-price__current .andes-money-amount__fraction");
      if (!titleEl || !fractionEl) continue;

      const centsEl = card.querySelector(".poly-price__current .andes-money-amount__cents");
      const origFrac = card.querySelector(".andes-money-amount--previous .andes-money-amount__fraction");
      const origCents = card.querySelector(".andes-money-amount--previous .andes-money-amount__cents");
      const imgEl = card.querySelector(".poly-component__picture");
      const sellerEl = card.querySelector(".poly-component__seller");
      const shippingEl = card.querySelector(".poly-component__shipping-v2, .poly-component__shipping");
      const discountEl = card.querySelector(".poly-price__disc--pill, .poly-price__disc_label");
      const priceLabelsEl = card.querySelector(".poly-price__labels");

      const reviewEl = card.querySelector(".poly-component__review-compacted");
      const altEl = reviewEl?.nextElementSibling?.classList?.contains("andes-visually-hidden")
        ? reviewEl.nextElementSibling
        : card.querySelector(".andes-visually-hidden");
      const legacyRatingEl = card.querySelector(".poly-reviews__rating");
      const legacyReviewsEl = card.querySelector(".poly-reviews__total");
      const legacySoldEl = card.querySelector(".poly-component__sold");

      const price = parseFloat(`${fractionEl.textContent.trim().replace(/\./g, "")}.${centsEl ? centsEl.textContent.trim() : "00"}`);
      const originalPrice = origFrac
        ? parseFloat(`${origFrac.textContent.trim().replace(/\./g, "")}.${origCents ? origCents.textContent.trim() : "00"}`)
        : null;

      let discount = null;
      const doRotulo = (txt(discountEl) || "").match(/(\d+)\s*%/);
      if (doRotulo) discount = parseInt(doRotulo[1], 10);
      if (discount == null) {
        const doPill = (txt(priceLabelsEl) || "").match(/(\d+)\s*%\s*OFF/i);
        if (doPill) discount = parseInt(doPill[1], 10);
      }
      if (discount == null && originalPrice && price && originalPrice > price) {
        discount = Math.round((1 - price / originalPrice) * 100);
      }

      const av = lerAvaliacao(txt(altEl), txt(reviewEl));
      const rating = av.rating ?? (legacyRatingEl ? parseFloat(txt(legacyRatingEl)) : null);
      const legacyReviews = txt(legacyReviewsEl);
      const shippingText = txt(shippingEl);
      const sellerText = txt(sellerEl);

      // `link` sai do href absoluto: num documento vindo de DOMParser o `.href`
      // do anchor não resolve sozinho, então a base entra na mão.
      let link = titleEl.getAttribute("href") || "";
      try { link = new URL(link, "https://www.mercadolivre.com.br").href; } catch { /* fica como veio */ }

      if (!Number.isFinite(price) || !link) continue;

      produtos.push({
        name: titleEl.textContent.trim(),
        link,
        img: imagemGrande(imgEl?.getAttribute("src") || null),
        price,
        originalPrice,
        discount,
        rating: Number.isFinite(rating) ? rating : null,
        reviewsCount: legacyReviews ? legacyReviews.replace(/[()]/g, "") : null,
        seller: sellerText ? sellerText.replace(/^Por\s+/i, "") : null,
        freeShipping: shippingText ? shippingText.toLowerCase().includes("grátis") : false,
        sold: av.sold ?? (txt(legacySoldEl) || null),
        store: "Mercado Livre",
      });
    }
    return produtos;
  }

  // O muro do ML. Só é consultado quando não veio card nenhum — um produto
  // chamado "captcha" não pode virar bloqueio falso (a mesma disciplina do
  // ml-social.js).
  function muro(doc, url) {
    const hay = `${url}\n${doc.body?.innerText || ""}\n${doc.title || ""}`;
    if (/\/captcha\/wall/i.test(url) || /n[ãa]o sou um rob[ôo]|por seguran[çc]a, complete/i.test(hay)) return "captcha";
    if (/\/gz\/account-verification/i.test(url)) return "verificacao";
    if (/\/gz\/login/i.test(url) || /acesse sua conta/i.test(hay)) return "login";
    return null;
  }

  // O que a extensão recebe de volta. `executeScript` pega o valor da última
  // expressão do arquivo — por isso o IIFE devolve o objeto direto.
  const produtos = colherDo(document);
  return {
    produtos,
    url: location.href,
    muro: produtos.length ? null : muro(document, location.href),
  };
})();
