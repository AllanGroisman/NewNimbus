const puppeteer = require("puppeteer");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// URLs de imagem da Amazon vêm com "size descriptor" tipo `._AC_UY218_QL90_.jpg`
// que serve thumbnails minúsculos. Removendo o descriptor, a CDN serve a imagem
// em resolução nativa (geralmente quadrada 1500×1500) — fica nítida no WhatsApp
// e enquadra direito na prévia. Funciona pra m.media-amazon.com e ssl-images-amazon.com.
function upgradeAmazonImageUrl(url) {
  if (!url || typeof url !== "string") return url;
  if (!/(media-amazon|ssl-images-amazon)\.com/i.test(url)) return url;
  return url.replace(/\._[A-Za-z0-9_,]+_(?=\.(?:jpg|jpeg|png|webp|gif)(?:\?|$))/i, "");
}

// Categorias suportadas. Cada categoria mapeia pra um identificador por loja.
// - mlCode: ID da categoria do Mercado Livre (na URL de ofertas)
// - amzKeyword: termo de busca usado no Amazon BR (porque a Amazon não tem
//   "ofertas por categoria" como o ML — busca por keyword é o caminho viável)
const CATEGORIES = {
  bebe:        { label: "Bebê",        mlCode: "MLB1384", amzKeyword: "bebê" },
  gamer:       { label: "Gamer",       mlCode: "MLB1144", amzKeyword: "videogame" },
  eletronicos: { label: "Eletrônicos", mlCode: "MLB1051", amzKeyword: "celular smartphone" },
  casa:        { label: "Casa",        mlCode: "MLB1574", amzKeyword: "casa decoração" },
  beleza:      { label: "Beleza",      mlCode: "MLB1246", amzKeyword: "beleza" },
};

// Lojas suportadas. id é o que vai em group.scraping.sources (após normalize).
const STORES = {
  ml:     { id: "ml",     label: "Mercado Livre", scrape: scrapeML },
  amazon: { id: "amazon", label: "Amazon",        scrape: scrapeAmazon },
};

// Aceita "Mercado Livre" / "ml" / "MercadoLivre" e devolve "ml". Idem Amazon.
function normalizeSource(s) {
  const k = String(s || "").toLowerCase().replace(/\s+/g, "");
  if (k === "ml" || k === "mercadolivre") return "ml";
  if (k === "amazon" || k === "amz") return "amazon";
  return null;
}

// ────────────────────────────────────────────────────────────────────────
// Mercado Livre
// ────────────────────────────────────────────────────────────────────────

async function scrapeML({ category, limit = 200 } = {}) {
  const cat = CATEGORIES[category];
  const url = cat
    ? `https://www.mercadolivre.com.br/ofertas?category=${cat.mlCode}`
    : "https://www.mercadolivre.com.br/ofertas";

  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
    await autoScroll(page);

    const raw = await page.evaluate((cat) => {
      const cards = document.querySelectorAll(".poly-card");
      const results = [];
      for (const card of cards) {
        const titleEl = card.querySelector(".poly-component__title");
        const imgEl = card.querySelector(".poly-component__picture");
        const discountEl = card.querySelector(".poly-price__disc--pill, .poly-price__disc_label");
        const originalPriceEl = card.querySelector(".andes-money-amount--previous .andes-money-amount__fraction");
        const originalPriceCents = card.querySelector(".andes-money-amount--previous .andes-money-amount__cents");
        const fractionEl = card.querySelector(".poly-price__current .andes-money-amount__fraction");
        const centsEl = card.querySelector(".poly-price__current .andes-money-amount__cents");
        const ratingEl = card.querySelector(".poly-reviews__rating");
        const reviewsCountEl = card.querySelector(".poly-reviews__total");
        const sellerEl = card.querySelector(".poly-component__seller");
        const shippingEl = card.querySelector(".poly-component__shipping");
        const soldEl = card.querySelector(".poly-component__sold");

        if (!titleEl || !fractionEl) continue;

        const fraction = fractionEl.textContent.trim().replace(/\./g, "");
        const cents = centsEl ? centsEl.textContent.trim() : "00";
        const price = parseFloat(`${fraction}.${cents}`);

        let originalPrice = null;
        if (originalPriceEl) {
          const origFrac = originalPriceEl.textContent.trim().replace(/\./g, "");
          const origCents = originalPriceCents ? originalPriceCents.textContent.trim() : "00";
          originalPrice = parseFloat(`${origFrac}.${origCents}`);
        }

        let discountPct = null;
        if (discountEl) {
          const match = discountEl.textContent.match(/(\d+)%/);
          if (match) discountPct = parseInt(match[1]);
        }

        results.push({
          name: titleEl.textContent.trim(),
          link: titleEl.href,
          img: imgEl?.src || null,
          price,
          originalPrice,
          discount: discountPct,
          category: cat || null,
          rating: ratingEl ? parseFloat(ratingEl.textContent.trim()) : null,
          reviewsCount: reviewsCountEl ? reviewsCountEl.textContent.trim().replace(/[()]/g, "") : null,
          seller: sellerEl ? sellerEl.textContent.trim().replace(/^Por\s+/, "") : null,
          freeShipping: shippingEl ? shippingEl.textContent.toLowerCase().includes("grátis") : false,
          sold: soldEl ? soldEl.textContent.trim() : null,
          store: "Mercado Livre",
          scrapedAt: new Date().toISOString(),
        });
      }
      return results;
    }, category || null);

    raw.sort((a, b) => (b.discount || 0) - (a.discount || 0));
    return raw.slice(0, limit);
  } finally {
    await browser.close();
  }
}

// ────────────────────────────────────────────────────────────────────────
// Amazon BR
// ────────────────────────────────────────────────────────────────────────

async function scrapeAmazon({ category, limit = 100 } = {}) {
  const cat = CATEGORIES[category];
  const keyword = cat?.amzKeyword || "ofertas";
  // i= força departamento (ajuda a manter relevância). rh=p_n_pct-off-with-tax filtra desconto
  // mas é frágil entre regiões — usamos só keyword e deixamos os filtros pro scheduler.
  const url = `https://www.amazon.com.br/s?k=${encodeURIComponent(keyword)}&s=exact-aware-popularity-rank`;

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
  });
  try {
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.setExtraHTTPHeaders({ "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8" });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

    // Espera os cards carregarem; se Amazon servir CAPTCHA, o seletor não vai aparecer
    try {
      await page.waitForSelector('[data-component-type="s-search-result"]', { timeout: 10000 });
    } catch {
      const isCaptcha = await page.evaluate(() => /enter the characters|captcha|robot/i.test(document.body?.innerText || ""));
      if (isCaptcha) throw new Error("Amazon retornou CAPTCHA — tente mais tarde ou rode menos vezes.");
      throw new Error("Cards de produto Amazon não apareceram (layout pode ter mudado).");
    }

    await autoScroll(page);

    const raw = await page.evaluate((cat) => {
      const parsePrice = (s) => {
        if (!s) return null;
        const m = String(s).replace(/\s+/g, "").match(/R\$([\d.]+)(?:,(\d{1,2}))?/i);
        if (!m) return null;
        const integer = m[1].replace(/\./g, "");
        const cents = m[2] || "00";
        const v = parseFloat(`${integer}.${cents}`);
        return isNaN(v) ? null : v;
      };

      const cards = document.querySelectorAll('[data-component-type="s-search-result"]');
      const results = [];
      for (const card of cards) {
        // Patrocinados frequentemente não têm preço/oferta consistente
        const sponsored = card.querySelector('[data-component-type="sp-sponsored-result"]');

        const linkEl = card.querySelector('h2 a, a.a-link-normal.s-no-outline, a.s-line-clamp-2');
        const titleEl = card.querySelector('h2 a span, h2 span') || linkEl;
        const imgEl = card.querySelector('img.s-image');
        // Preço atual: a-price principal (data-a-color="base"), excluindo a-text-price
        // (que cobre preço por unidade R$/mL e preço riscado).
        const priceCurrentEl = card.querySelector('.a-price[data-a-color="base"]:not(.a-text-price) .a-offscreen')
                            || card.querySelector('.a-price:not(.a-text-price) .a-offscreen');
        // Preço original: SÓ o riscado (data-a-strike="true"), nunca preço unitário.
        const priceOriginalEl = card.querySelector('.a-price.a-text-price[data-a-strike="true"] .a-offscreen');
        // Rating: tenta múltiplos seletores que a Amazon usa em diferentes layouts.
        // O texto pode estar dentro do <i> ou no aria-label do container pai.
        const ratingEl = card.querySelector('i.a-icon-star-small .a-icon-alt')
                      || card.querySelector('i.a-icon-star .a-icon-alt')
                      || card.querySelector('.a-icon-star-small .a-icon-alt')
                      || card.querySelector('.a-icon-star .a-icon-alt')
                      || card.querySelector('[aria-label*="de 5"]');
        // reviewsCount: aparece num link/span ao lado do rating
        const reviewsEl = card.querySelector('.a-row.a-size-small a span.a-size-base')
                       || card.querySelector('a[href*="customerReviews"] span')
                       || card.querySelector('.s-link-style .s-underline-text');

        if (!titleEl || !linkEl || !priceCurrentEl) continue;

        const price = parsePrice(priceCurrentEl.textContent);
        const originalPrice = priceOriginalEl ? parsePrice(priceOriginalEl.textContent) : null;
        if (!price || price < 0.5) continue; // ignora preços absurdamente baixos (provavelmente preço unitário)

        let discount = null;
        if (originalPrice && originalPrice > price && originalPrice < price * 20) {
          // sanity check: descarta cálculo se proporção é absurda (preço unitário virou original)
          discount = Math.round((1 - price / originalPrice) * 100);
        }

        // Rating "4,5 de 5 estrelas" — tenta textContent e aria-label
        let rating = null;
        if (ratingEl) {
          const text = ratingEl.textContent || ratingEl.getAttribute("aria-label") || "";
          const m = text.match(/([\d,.]+)\s*de\s*5/i);
          if (m) rating = parseFloat(m[1].replace(",", "."));
        }
        // reviewsCount: número entre parênteses ou número puro ao lado do rating
        let reviewsCount = null;
        if (reviewsEl) {
          const t = (reviewsEl.textContent || "").trim().replace(/[^\d]/g, "");
          if (t) reviewsCount = t;
        }

        const href = linkEl.getAttribute("href") || "";
        const link = href.startsWith("http") ? href : `https://www.amazon.com.br${href}`;

        results.push({
          name: titleEl.textContent.trim(),
          link,
          img: imgEl?.src || null,
          price,
          originalPrice,
          discount,
          category: cat || null,
          rating,
          reviewsCount,
          seller: null,
          freeShipping: false,
          sold: null,
          store: "Amazon",
          sponsored: !!sponsored,
          scrapedAt: new Date().toISOString(),
        });
      }
      return results;
    }, category || null);

    // Remove patrocinados — costumam não ser as melhores ofertas
    const cleaned = raw.filter(p => !p.sponsored);
    // Sobe a resolução das imagens (Amazon serve thumb minúsculo no card)
    for (const p of cleaned) p.img = upgradeAmazonImageUrl(p.img);
    cleaned.sort((a, b) => (b.discount || 0) - (a.discount || 0));
    return cleaned.slice(0, limit);
  } finally {
    await browser.close();
  }
}

// ────────────────────────────────────────────────────────────────────────
// Agregador
// ────────────────────────────────────────────────────────────────────────

// Roda os scrapers das `sources` informadas em paralelo e devolve a lista
// concatenada. Falha em uma loja não derruba as outras — apenas loga.
async function scrapeOfertas({ category, sources, limit = 200 } = {}) {
  const ids = (sources && sources.length ? sources : ["ml"])
    .map(normalizeSource)
    .filter(Boolean);
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];

  const results = await Promise.all(unique.map(async (id) => {
    const store = STORES[id];
    if (!store) return [];
    try {
      console.log(`[scraper] ${store.label} / ${category || "geral"}: iniciando...`);
      const t0 = Date.now();
      const data = await store.scrape({ category, limit });
      console.log(`[scraper] ${store.label} / ${category || "geral"}: ${data.length} produtos em ${Date.now() - t0}ms`);
      return data;
    } catch (err) {
      console.error(`[scraper] ${store.label} / ${category || "geral"} falhou:`, err.message);
      return [];
    }
  }));

  const all = [].concat(...results);
  all.sort((a, b) => (b.discount || 0) - (a.discount || 0));
  return all.slice(0, limit);
}

// Reaplica filtros num conjunto já scrapeado — usado pelo scheduler
// para reusar cache compartilhado por categoria.
function applyFilters(products, { minDiscount = 0, minPrice = 0, maxPrice = Infinity, minRating = 0, minSales = 0, keywords = "" } = {}) {
  let out = products;
  if (minDiscount > 0) out = out.filter(p => p.discount && p.discount >= minDiscount);
  // null/undefined coerce p/ 0 em comparações, então produtos sem preço passariam
  // pelo filtro de maxPrice (null <= 5000 === true). Tem que checar explicitamente.
  if (minPrice > 0) out = out.filter(p => p.price != null && p.price >= minPrice);
  if (maxPrice < Infinity) out = out.filter(p => p.price != null && p.price <= maxPrice);
  if (minRating > 0) out = out.filter(p => (p.rating || 0) >= minRating);
  if (minSales > 0) out = out.filter(p => parseSold(p.sold) >= minSales);
  if (keywords && String(keywords).trim()) {
    const terms = String(keywords).toLowerCase().split(/[,\s]+/).filter(Boolean);
    if (terms.length) {
      out = out.filter(p => {
        const name = (p.name || "").toLowerCase();
        return terms.some(t => name.includes(t));
      });
    }
  }
  return out;
}

// "+50 vendidos" / "1 mil vendidos" → número aproximado
function parseSold(s) {
  if (!s) return 0;
  const m = String(s).toLowerCase().match(/([\d.,]+)\s*(mil|mi)?/);
  if (!m) return 0;
  let n = parseFloat(m[1].replace(/\./g, "").replace(",", "."));
  if (m[2] === "mil") n *= 1000;
  if (m[2] === "mi") n *= 1000000;
  return Math.round(n);
}

// ────────────────────────────────────────────────────────────────────────
// Scraping de UMA página — usado pelo "Adicionar link manualmente" da fila.
// Tenta seletores conhecidos por loja; cai pra OG tags em casos genéricos.
// ────────────────────────────────────────────────────────────────────────

function detectStore(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (/mercadolivre|mercadolibre/.test(host) || /merc\.li|mlb\.li/.test(host)) return "Mercado Livre";
    if (/amazon|amzn/.test(host)) return "Amazon";
    if (/shopee/.test(host)) return "Shopee";
    if (/americanas/.test(host)) return "Americanas";
    if (/magazineluiza|magalu/.test(host)) return "Magazine Luiza";
    return null;
  } catch {
    return null;
  }
}

async function scrapeSingleProduct(url) {
  if (!url || typeof url !== "string" || !url.trim()) {
    throw new Error("URL inválida");
  }
  const cleanUrl = url.trim();
  const store = detectStore(cleanUrl);

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
  });
  try {
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.setExtraHTTPHeaders({ "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8" });
    await page.goto(cleanUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    // Pequena espera pra conteúdo dinâmico (preço por JS é comum)
    await new Promise(r => setTimeout(r, 1500));

    // Em ML/Amazon, espera o seletor principal aparecer (com timeout curto)
    if (store === "Mercado Livre") {
      try { await page.waitForSelector(".ui-pdp-title, h1", { timeout: 5000 }); } catch {}
    } else if (store === "Amazon") {
      try { await page.waitForSelector("#productTitle, h1#title", { timeout: 5000 }); } catch {}
      const isCaptcha = await page.evaluate(() => /enter the characters|captcha|robot check/i.test(document.body?.innerText || ""));
      if (isCaptcha) throw new Error("Amazon retornou CAPTCHA — tente daqui a alguns minutos.");
    }

    const data = await page.evaluate((store) => {
      const meta = (sel) => document.querySelector(sel)?.getAttribute("content")?.trim() || null;
      const ogTitle = meta('meta[property="og:title"]') || meta('meta[name="og:title"]') || document.title?.trim() || null;
      const ogImage = meta('meta[property="og:image"]') || meta('meta[name="og:image"]') || null;
      const ogPrice = meta('meta[property="product:price:amount"]') || meta('meta[property="og:price:amount"]') || null;

      const parsePrice = (s) => {
        if (!s) return null;
        const m = String(s).replace(/\s+/g, "").match(/R\$([\d.]+)(?:,(\d{1,2}))?/i);
        if (!m) return null;
        const integer = m[1].replace(/\./g, "");
        const cents = m[2] || "00";
        const v = parseFloat(`${integer}.${cents}`);
        return isNaN(v) ? null : v;
      };

      let name = null, price = null, originalPrice = null, discount = null, img = null;

      if (store === "Mercado Livre") {
        const titleEl = document.querySelector("h1.ui-pdp-title, .ui-pdp-title");
        name = titleEl?.textContent?.trim() || ogTitle;
        // Preço atual: primeiro andes-money-amount NÃO marcado como previous
        const curWrap = document.querySelector(".ui-pdp-price__main-container") || document;
        const curFrac = curWrap.querySelector(".andes-money-amount:not(.andes-money-amount--previous) .andes-money-amount__fraction");
        const curCents = curWrap.querySelector(".andes-money-amount:not(.andes-money-amount--previous) .andes-money-amount__cents");
        if (curFrac) {
          const f = curFrac.textContent.trim().replace(/\./g, "");
          const c = curCents ? curCents.textContent.trim() : "00";
          price = parseFloat(`${f}.${c}`);
        }
        const prevFrac = document.querySelector(".andes-money-amount--previous .andes-money-amount__fraction");
        const prevCents = document.querySelector(".andes-money-amount--previous .andes-money-amount__cents");
        if (prevFrac) {
          const f = prevFrac.textContent.trim().replace(/\./g, "");
          const c = prevCents ? prevCents.textContent.trim() : "00";
          originalPrice = parseFloat(`${f}.${c}`);
        }
        const discEl = document.querySelector(".andes-money-amount__discount, .ui-pdp-price__second-line .andes-money-amount__discount");
        if (discEl) {
          const m = discEl.textContent.match(/(\d+)%/);
          if (m) discount = parseInt(m[1], 10);
        }
        const imgEl = document.querySelector(".ui-pdp-gallery__figure img, figure.ui-pdp-gallery__figure img, .ui-pdp-image");
        img = imgEl?.getAttribute("src") || imgEl?.getAttribute("data-zoom") || ogImage;
      } else if (store === "Amazon") {
        const titleEl = document.querySelector("#productTitle, h1#title span, h1#title");
        name = titleEl?.textContent?.trim() || ogTitle;
        const priceCurrentEl = document.querySelector(".a-price[data-a-color='base']:not(.a-text-price) .a-offscreen")
                            || document.querySelector(".priceToPay .a-offscreen")
                            || document.querySelector("#corePrice_feature_div .a-offscreen")
                            || document.querySelector(".a-price:not(.a-text-price) .a-offscreen");
        if (priceCurrentEl) price = parsePrice(priceCurrentEl.textContent);
        const priceOriginalEl = document.querySelector(".a-price.a-text-price[data-a-strike='true'] .a-offscreen")
                             || document.querySelector(".basisPrice .a-offscreen");
        if (priceOriginalEl) originalPrice = parsePrice(priceOriginalEl.textContent);
        if (originalPrice && price && originalPrice > price && originalPrice < price * 20) {
          discount = Math.round((1 - price / originalPrice) * 100);
        }
        const imgEl = document.querySelector("#landingImage, #imgBlkFront, #main-image");
        img = imgEl?.getAttribute("src") || imgEl?.getAttribute("data-old-hires") || ogImage;
      } else {
        // Genérico (Shopee/Americanas/etc) — só OG + busca por R$ no texto
        name = ogTitle;
        img = ogImage;
        if (ogPrice) {
          const v = parseFloat(String(ogPrice).replace(",", "."));
          if (!isNaN(v)) price = v;
        }
        if (price == null) {
          const text = document.body?.innerText || "";
          const m = text.match(/R\$\s*([\d.]+)(?:,(\d{1,2}))?/);
          if (m) {
            const integer = m[1].replace(/\./g, "");
            const cents = m[2] || "00";
            const v = parseFloat(`${integer}.${cents}`);
            if (!isNaN(v)) price = v;
          }
        }
      }

      return { name, price, originalPrice, discount, img };
    }, store);

    return {
      name: data.name || null,
      link: cleanUrl,
      price: data.price ?? null,
      originalPrice: data.originalPrice ?? null,
      discount: data.discount ?? null,
      img: store === "Amazon" ? upgradeAmazonImageUrl(data.img) : (data.img || null),
      store: store || null,
      scrapedAt: new Date().toISOString(),
    };
  } finally {
    await browser.close();
  }
}

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance = 400;
      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        totalHeight += distance;
        if (totalHeight >= document.body.scrollHeight - window.innerHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 150);
      setTimeout(() => { clearInterval(timer); resolve(); }, 5000);
    });
  });
  await new Promise(r => setTimeout(r, 1000));
}

module.exports = { scrapeOfertas, scrapeML, scrapeAmazon, scrapeSingleProduct, detectStore, upgradeAmazonImageUrl, applyFilters, normalizeSource, CATEGORIES, STORES };
