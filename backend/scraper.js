const puppeteer = require("puppeteer");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// Categorias disponíveis — adicione novas aqui
const CATEGORIES = {
  bebe: { code: "MLB1384", label: "Bebê" },
  gamer: { code: "MLB1144", label: "Gamer" },
};

function buildUrl(category) {
  const cat = CATEGORIES[category];
  if (cat) return `https://www.mercadolivre.com.br/ofertas?category=${cat.code}`;
  return "https://www.mercadolivre.com.br/ofertas";
}

async function scrapeOfertas({ category, minDiscount = 0, maxPrice = Infinity, limit = 50 } = {}) {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  await page.setUserAgent(UA);

  const url = buildUrl(category);
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

  await browser.close();

  let filtered = raw;
  if (minDiscount > 0) {
    filtered = filtered.filter(p => p.discount && p.discount >= minDiscount);
  }
  if (maxPrice < Infinity) {
    filtered = filtered.filter(p => p.price <= maxPrice);
  }

  filtered.sort((a, b) => (b.discount || 0) - (a.discount || 0));
  return filtered.slice(0, limit);
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

module.exports = { scrapeOfertas, CATEGORIES };
