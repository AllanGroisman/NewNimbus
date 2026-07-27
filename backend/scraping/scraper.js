const puppeteer = require("puppeteer");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Amazon — confiabilidade contra CAPTCHA/anti-bot (intermitente).
// A página de ofertas é re-tentada com backoff; o enriquecimento de rating
// (abre 1 aba por produto) é limitado pra não disparar bloqueio em massa.
const AMZ_MAX_ATTEMPTS = 3;
const AMZ_BACKOFF_MS = [3000, 8000, 20000];   // por tentativa (1-based) + jitter
const AMZ_ENRICH_DISPLAY = 40;                // sem filtro de rating/reviews: só p/ exibir
const AMZ_ENRICH_MAX = 120;                   // com filtro de rating/reviews

// Backoff com jitter ±30% pra a tentativa N (1-based). Pura → testável.
function amzBackoffMs(attempt) {
  const base = AMZ_BACKOFF_MS[Math.min(attempt - 1, AMZ_BACKOFF_MS.length - 1)];
  const jitter = Math.floor(base * 0.3 * (Math.random() * 2 - 1));
  return Math.max(0, base + jitter);
}

// Browser + page com stealth leve: reduz o fingerprint de automação que a Amazon
// usa pra servir CAPTCHA. Reusado pela página de ofertas e pelo enriquecimento.
function launchAmazonBrowser() {
  return puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
    ],
  });
}

async function applyAmazonStealth(page) {
  await page.setUserAgent(UA);
  await page.setExtraHTTPHeaders({ "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8" });
  await page.setViewport({ width: 1366, height: 900 });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
}

// URLs de imagem da Amazon vêm com "size descriptor" tipo `._AC_UY218_QL90_.jpg`
// que serve thumbnails minúsculos. Removendo o descriptor, a CDN serve a imagem
// em resolução nativa (geralmente quadrada 1500×1500) — fica nítida no WhatsApp
// e enquadra direito na prévia. Funciona pra m.media-amazon.com e ssl-images-amazon.com.
function upgradeAmazonImageUrl(url) {
  if (!url || typeof url !== "string") return url;
  if (!/(media-amazon|ssl-images-amazon)\.com/i.test(url)) return url;
  return url.replace(/\._[A-Za-z0-9_,]+_(?=\.(?:jpg|jpeg|png|webp|gif)(?:\?|$))/i, "");
}

// URLs de imagem do ML (mlstatic.com) terminam com um sufixo de tamanho antes
// da extensão: "-O" (~500x280, usado nos cards de listagem e como thumbnail
// da galeria da PDP) e "-F" (1920x1076, resolução alta). Trocando o sufixo
// pra "-F" a CDN serve a versão em alta — fica nítida no WhatsApp.
function upgradeMLImageUrl(url) {
  if (!url || typeof url !== "string") return url;
  if (!/mlstatic\.com/i.test(url)) return url;
  return url.replace(/-[A-Z](?=\.(?:jpg|jpeg|png|webp)(?:\?|$))/i, "-F");
}

// Categorias suportadas. Cada categoria mapeia pra um identificador por loja.
// - mlCode: ID da categoria do Mercado Livre (na URL de ofertas)
// - amzDept: ID do departamento na página de ofertas da Amazon (/deals). Usado no
//   filtro "Departamento" da barra lateral (refinementFilters.departments).
// - shopeeCatIds: IDs de categoria (Level 1) reais da Shopee BR, usados no
//   parâmetro `productCatId` do productOfferV2 — traz produtos GERAIS da categoria
//   (não busca por palavra). Vários IDs = categoria ampla (ex.: eletrônicos =
//   celulares + computador + áudio + eletrodomésticos). Descobertos via API.
// - shopeeKeyword: fallback por palavra-chave caso shopeeCatIds esteja ausente.
const CATEGORIES = {
  bebe:        { label: "Bebê",        mlCode: "MLB1384", amzDept: "17242604011", shopeeKeyword: "bebê",            shopeeCatIds: [100632] },
  gamer:       { label: "Gamer",       mlCode: "MLB1144", amzDept: "7791986011",  shopeeKeyword: "gamer",           shopeeCatIds: [100634, 100644] },
  eletronicos: { label: "Eletrônicos", mlCode: "MLB1051", amzDept: "16209063011", shopeeKeyword: "celular",         shopeeCatIds: [100013, 100644, 100535, 100010] },
  casa:        { label: "Casa",        mlCode: "MLB1574", amzDept: "16191001011", shopeeKeyword: "casa decoração",  shopeeCatIds: [100636] },
  beleza:      { label: "Beleza",      mlCode: "MLB1246", amzDept: "16194415011", shopeeKeyword: "beleza",          shopeeCatIds: [100630] },
  brinquedos:  { label: "Brinquedos",  mlCode: "MLB1132", amzDept: "16194299011", shopeeKeyword: "brinquedo infantil" },
  roupas:      { label: "Roupas",      mlCode: "MLB1430", amzDept: "17365812011", shopeeKeyword: "roupa",            shopeeCatIds: [100017, 100011] },
  esportes:    { label: "Esportes e Fitness", mlCode: "MLB1276", amzDept: "17349396011", shopeeKeyword: "esporte fitness", shopeeCatIds: [100637] },
  informatica: { label: "Informática", mlCode: "MLB1648", amzDept: "16339927011", shopeeKeyword: "notebook computador", shopeeCatIds: [100644] },
  pet:         { label: "Pet Shop",    mlCode: "MLB1071", amzDept: "18991137011", shopeeKeyword: "pet cachorro gato", shopeeCatIds: [100631] },
};

// Lojas suportadas. id é o que vai em group.scraping.sources (após normalize).
const STORES = {
  ml:     { id: "ml",     label: "Mercado Livre", scrape: scrapeML },
  amazon: { id: "amazon", label: "Amazon",        scrape: scrapeAmazon },
  shopee: { id: "shopee", label: "Shopee",        scrape: scrapeShopee },
};

// Aceita "Mercado Livre" / "ml" / "MercadoLivre" e devolve "ml". Idem Amazon e Shopee.
function normalizeSource(s) {
  const k = String(s || "").toLowerCase().replace(/\s+/g, "");
  if (k === "ml" || k === "mercadolivre") return "ml";
  if (k === "amazon" || k === "amz") return "amazon";
  if (k === "shopee") return "shopee";
  return null;
}

// ────────────────────────────────────────────────────────────────────────
// Mercado Livre
// ────────────────────────────────────────────────────────────────────────

// Teto de segurança de páginas do ML (cada página de ofertas tem ~48 cards).
const ML_MAX_PAGES = 25;

// Nota + nº de vendas do card do ML. Desde 2026 o ML juntou os dois num único
// bloco compacto (`.poly-component__review-compacted`) e removeu o nº de avaliações
// — antes eram `.poly-reviews__rating` / `.poly-reviews__total` / `.poly-component__sold`,
// que não existem mais. Duas fontes, nesta ordem:
//   alt     = <span class="andes-visually-hidden"> irmão, texto de acessibilidade:
//             "Classificação 4.9 de 5 estrelas. Mais de 10mil produtos vendidos."
//   visible = texto do próprio bloco compacto: "4.9 | +10mil vendidos"
// O `sold` sai como string ("+10mil vendidos"), formato que formatVendas
// (scheduler.js) e parseSold (abaixo) já sabem ler. Pura → testável.
function parseMLReviewCompacted(alt, visible) {
  const out = { rating: null, sold: null };
  const altTxt = String(alt || "");
  const visTxt = String(visible || "");

  const ratingAlt = altTxt.match(/classifica[çc][ãa]o\s+([\d.,]+)\s+de\s+5/i);
  if (ratingAlt) out.rating = parseFloat(ratingAlt[1].replace(",", "."));
  if (out.rating == null) {
    // No texto visível a nota é o primeiro número solto, antes do "|".
    const ratingVis = visTxt.split("|")[0].match(/([\d]+[.,][\d]+|[\d]+)/);
    if (ratingVis) out.rating = parseFloat(ratingVis[1].replace(",", "."));
  }
  if (out.rating != null && !(out.rating > 0 && out.rating <= 5)) out.rating = null;

  const soldAlt = altTxt.match(/(mais de\s+)?([\d.,]+\s*(?:mil|mi)?)\s*produtos?\s+vendid/i);
  if (soldAlt) out.sold = `${soldAlt[1] ? "+" : ""}${soldAlt[2].trim()} vendidos`;
  if (!out.sold && /vendid/i.test(visTxt)) {
    // "| +10mil vendidos" → tira o pipe da frente e normaliza os espaços.
    const s = visTxt.split("|").pop().replace(/\s+/g, " ").trim();
    if (s) out.sold = s;
  }
  return out;
}

// Colhe os .poly-card da página de ofertas já carregada/rolada → array de produtos.
// O page.evaluate só extrai TEXTO CRU do DOM; a interpretação fica em funções puras
// aqui no Node (parseMLReviewCompacted), que dá pra testar sem navegador.
async function harvestMLCards(page, category) {
  const raw = await page.evaluate(() => {
    const txt = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : null);
    const cards = document.querySelectorAll(".poly-card");
    const results = [];
    for (const card of cards) {
      const titleEl = card.querySelector(".poly-component__title");
      const imgEl = card.querySelector(".poly-component__picture");
      const originalPriceEl = card.querySelector(".andes-money-amount--previous .andes-money-amount__fraction");
      const originalPriceCents = card.querySelector(".andes-money-amount--previous .andes-money-amount__cents");
      const fractionEl = card.querySelector(".poly-price__current .andes-money-amount__fraction");
      const centsEl = card.querySelector(".poly-price__current .andes-money-amount__cents");
      const sellerEl = card.querySelector(".poly-component__seller");

      if (!titleEl || !fractionEl) continue;

      // Bloco compacto de nota/vendas + o span de acessibilidade que vem logo depois.
      const reviewEl = card.querySelector(".poly-component__review-compacted");
      const altEl = reviewEl?.nextElementSibling?.classList?.contains("andes-visually-hidden")
        ? reviewEl.nextElementSibling
        : card.querySelector(".andes-visually-hidden");

      // Layout antigo (mantido como alternativa caso o ML sirva a versão anterior).
      const legacyRatingEl = card.querySelector(".poly-reviews__rating");
      const legacyReviewsEl = card.querySelector(".poly-reviews__total");
      const legacySoldEl = card.querySelector(".poly-component__sold");

      // Desconto: pill "42% OFF" nos rótulos de preço (novo) ou os seletores antigos.
      const discountEl = card.querySelector(".poly-price__disc--pill, .poly-price__disc_label");
      const priceLabelsEl = card.querySelector(".poly-price__labels");

      // Frete: o container virou shipping-v2; aceitamos os dois.
      const shippingEl = card.querySelector(".poly-component__shipping-v2, .poly-component__shipping");

      results.push({
        name: titleEl.textContent.trim(),
        link: titleEl.href,
        img: imgEl?.src || null,
        priceFraction: fractionEl.textContent.trim(),
        priceCents: centsEl ? centsEl.textContent.trim() : null,
        originalFraction: originalPriceEl ? originalPriceEl.textContent.trim() : null,
        originalCents: originalPriceCents ? originalPriceCents.textContent.trim() : null,
        discountText: txt(discountEl),
        priceLabelsText: txt(priceLabelsEl),
        reviewVisible: txt(reviewEl),
        reviewAlt: txt(altEl),
        legacyRating: txt(legacyRatingEl),
        legacyReviews: txt(legacyReviewsEl),
        legacySold: txt(legacySoldEl),
        sellerText: txt(sellerEl),
        shippingText: txt(shippingEl),
      });
    }
    return results;
  });

  return raw.map((c) => {
    const price = parseFloat(`${c.priceFraction.replace(/\./g, "")}.${c.priceCents || "00"}`);
    const originalPrice = c.originalFraction
      ? parseFloat(`${c.originalFraction.replace(/\./g, "")}.${c.originalCents || "00"}`)
      : null;

    // Desconto: rótulo antigo → pill "42% OFF" → cálculo a partir do preço anterior.
    let discount = null;
    const fromLabel = (c.discountText || "").match(/(\d+)\s*%/);
    if (fromLabel) discount = parseInt(fromLabel[1], 10);
    if (discount == null) {
      const fromPill = (c.priceLabelsText || "").match(/(\d+)\s*%\s*OFF/i);
      if (fromPill) discount = parseInt(fromPill[1], 10);
    }
    if (discount == null && originalPrice && price && originalPrice > price) {
      discount = Math.round((1 - price / originalPrice) * 100);
    }

    const compact = parseMLReviewCompacted(c.reviewAlt, c.reviewVisible);
    const rating = compact.rating ?? (c.legacyRating ? parseFloat(c.legacyRating) : null);
    const sold = compact.sold ?? (c.legacySold || null);

    return {
      name: c.name,
      link: c.link,
      img: c.img,
      price,
      originalPrice,
      discount,
      category: category || null,
      rating: Number.isFinite(rating) ? rating : null,
      // O ML tirou o nº de avaliações do card de ofertas — só o layout antigo tinha.
      reviewsCount: c.legacyReviews ? c.legacyReviews.replace(/[()]/g, "") : null,
      seller: c.sellerText ? c.sellerText.replace(/^Por\s+/i, "") : null,
      freeShipping: c.shippingText ? c.shippingText.toLowerCase().includes("grátis") : false,
      sold,
      store: "Mercado Livre",
      scrapedAt: new Date().toISOString(),
    };
  });
}

async function scrapeML({ category, limit = 200 } = {}) {
  const cat = CATEGORIES[category];
  const baseUrl = cat
    ? `https://www.mercadolivre.com.br/ofertas?category=${cat.mlCode}`
    : "https://www.mercadolivre.com.br/ofertas";
  const tag = category || "geral";

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
  });
  try {
    // A página de ofertas mostra ~48 cards por página; paginamos via &page=N
    // (1-indexed; sem o param = página 1) acumulando e DEDUPLICANDO por link até
    // bater o limite, esgotar as páginas ou atingir o teto de segurança.
    const seen = new Set();
    const raw = [];
    for (let pageNum = 1; pageNum <= ML_MAX_PAGES && raw.length < limit; pageNum++) {
      const url = pageNum === 1 ? baseUrl : `${baseUrl}&page=${pageNum}`;
      const page = await browser.newPage();
      try {
        await page.setUserAgent(UA);
        await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
        await autoScroll(page);
        const cards = await harvestMLCards(page, category);
        if (cards.length === 0) break;   // passou da última página
        let added = 0;
        for (const p of cards) {
          if (!p.link || seen.has(p.link)) continue;
          seen.add(p.link);
          p.img = upgradeMLImageUrl(p.img);
          raw.push(p);
          added++;
        }
        // Nenhum item novo nesta página → o ML começou a repetir, encerra.
        if (added === 0) break;
      } finally {
        await page.close();
      }
      await sleep(300 + Math.floor(Math.random() * 400));   // educado entre páginas
    }
    console.log(`[scraper ML] ${tag}: ${raw.length} produtos coletados em até ${ML_MAX_PAGES} páginas`);

    // Filtros de qualidade do admin (rating/vendas/preço/desconto máximo).
    // Lazy require evita ciclo no boot. Defaults (tudo 0) = passa tudo.
    const affiliate = require("./affiliate");
    const filters = affiliate.readMLScraperFilters();
    const filtered = raw.filter(p => affiliate.passesMLFilters(p, filters));
    if (filtered.length < raw.length) {
      console.log(`[scraper ML] ${tag}: ${raw.length} vistos, ${raw.length - filtered.length} filtrados, ${filtered.length} aprovados`);
    }

    filtered.sort((a, b) => (b.discount || 0) - (a.discount || 0));
    return filtered.slice(0, limit);
  } finally {
    await browser.close();
  }
}

// ────────────────────────────────────────────────────────────────────────
// Amazon BR
// ────────────────────────────────────────────────────────────────────────

// Monta a URL da página de ofertas (/deals) filtrada por departamento.
// O filtro "Departamento" da barra lateral codifica o estado num parâmetro
// `discounts-widget` que é o JSON do estado serializado DUAS vezes (JSON.stringify
// aninhado) e então URL-encodado DUAS vezes — replicamos exatamente isso.
// deptId null/"all" → página de ofertas geral, sem filtro.
function buildAmazonDealsUrl(deptId) {
  const base = "https://www.amazon.com.br/deals";
  if (!deptId || deptId === "all") return base;
  const state = { state: { refinementFilters: { departments: [String(deptId)] } }, version: 1 };
  const widget = encodeURIComponent(encodeURIComponent(JSON.stringify(JSON.stringify(state))));
  return `${base}?discounts-widget=${widget}`;
}

// Coleta UMA vez a página de ofertas da Amazon (launch → goto → harvest), com
// browser próprio que é sempre fechado. Lança erro (CAPTCHA/layout) pra quem
// chama decidir re-tentar. Não enriquece — isso roda depois, em browser à parte.
async function harvestAmazonDeals(url, limit) {
  const browser = await launchAmazonBrowser();
  try {
    const page = await browser.newPage();
    await applyAmazonStealth(page);
    await page.goto(url, { waitUntil: "networkidle2", timeout: 40000 });

    // Espera os cards de oferta aparecerem; se a Amazon servir CAPTCHA, não aparecem.
    try {
      await page.waitForSelector('[data-testid="product-card"]', { timeout: 12000 });
    } catch {
      const isCaptcha = await page.evaluate(() => /enter the characters|captcha|robot|digite os caracteres/i.test(document.body?.innerText || ""));
      if (isCaptcha) throw new Error("Amazon retornou CAPTCHA");
      throw new Error("Cards de oferta Amazon não apareceram (layout pode ter mudado)");
    }

    // A grade de ofertas é VIRTUALIZADA: cards saem do DOM ao rolar. Por isso
    // colhemos incrementalmente — a cada scroll, recolhemos os cards visíveis num
    // Map (dedup por ASIN) até bater o limite ou a página parar de crescer.
    return await page.evaluate(async (targetLimit) => {
      const parsePrice = (s) => {
        if (!s) return null;
        const m = String(s).replace(/\s+/g, "").match(/R\$([\d.]+)(?:,(\d{1,2}))?/i);
        if (!m) return null;
        const v = parseFloat(`${m[1].replace(/\./g, "")}.${m[2] || "00"}`);
        return isNaN(v) ? null : v;
      };

      const seen = new Map();
      const harvest = () => {
        for (const card of document.querySelectorAll('[data-testid="product-card"]')) {
          const asin = card.getAttribute("data-asin");
          if (!asin || seen.has(asin)) continue;

          const linkEl = card.querySelector('a[data-testid="product-card-link"]');
          const href = (linkEl?.href || "").split("?")[0]; // tira tracking
          const imgEl = card.querySelector("img");
          const name = imgEl?.getAttribute("alt")?.trim() || null;

          // Preço atual: a-price base. Original: a-price riscado. O .a-offscreen
          // vem com prefixo ("Preço da Oferta: R$ ..."), mas o parsePrice extrai o R$.
          const price = parsePrice(card.querySelector('.a-price[data-a-color="base"] .a-offscreen')?.textContent);
          const originalPrice = parsePrice(card.querySelector('.a-price[data-a-strike="true"] .a-offscreen')?.textContent);

          let discount = null;
          const dm = (card.textContent || "").match(/(\d+)%\s*off/i);
          if (dm) discount = parseInt(dm[1], 10);
          else if (originalPrice && price && originalPrice > price) discount = Math.round((1 - price / originalPrice) * 100);

          if (!name || !href || !price) continue;

          seen.set(asin, {
            name,
            link: href,
            img: imgEl?.getAttribute("src") || null,
            price,
            originalPrice,
            discount,
          });
        }
      };

      let stale = 0;
      for (let i = 0; i < 80 && seen.size < targetLimit; i++) {
        harvest();
        const prevSize = seen.size;
        window.scrollBy(0, Math.round(window.innerHeight * 0.85));
        await new Promise(r => setTimeout(r, 450));
        const atBottom = (window.scrollY + window.innerHeight) >= document.body.scrollHeight - 5;
        // Sem itens novos e já no fim → conta como "parado"; 3 seguidas = encerra.
        if (seen.size === prevSize && atBottom) { if (++stale >= 3) break; }
        else stale = 0;
      }
      harvest();
      return [...seen.values()];
    }, limit);
  } finally {
    await browser.close();
  }
}

async function scrapeAmazon({ category, limit = 100 } = {}) {
  const cat = CATEGORIES[category];
  const url = buildAmazonDealsUrl(cat?.amzDept);
  const tag = category || "geral";

  // Jitter inicial: ML/Shopee/Amazon disparam em paralelo (scrapeOfertas). Um
  // pequeno atraso desincroniza a batida na Amazon e reduz a chance de CAPTCHA.
  await sleep(500 + Math.floor(Math.random() * 2500));

  // 1) Coleta a página de ofertas com retry + backoff — um CAPTCHA não zera mais
  //    a categoria inteira: tenta de novo com browser novo após esperar.
  let raw = [];
  for (let attempt = 1; attempt <= AMZ_MAX_ATTEMPTS; attempt++) {
    try {
      raw = await harvestAmazonDeals(url, limit);
      break;
    } catch (err) {
      const last = attempt >= AMZ_MAX_ATTEMPTS;
      console.warn(`[scraper Amazon] ${tag}: tentativa ${attempt}/${AMZ_MAX_ATTEMPTS} falhou (${err.message})${last ? " — desistindo" : ", aguardando backoff"}`);
      if (last) return [];
      await sleep(amzBackoffMs(attempt));
    }
  }
  if (!raw.length) return [];

  // Sobe a resolução das imagens (a Amazon serve thumbnail minúsculo no card).
  for (const p of raw) {
    p.img = upgradeAmazonImageUrl(p.img);
    p.category = category || null;
    // Todos preenchidos no enriquecimento (a página de ofertas não expõe nenhum) —
    // ficam nestes defaults nos produtos que não forem enriquecidos.
    p.rating = null;
    p.reviewsCount = null;
    p.seller = null;
    p.freeShipping = false;
    p.sold = null;
    p.store = "Amazon";
    p.scrapedAt = new Date().toISOString();
  }

  const affiliate = require("./affiliate");
  const cfg = affiliate.readAmazonScraperFilters();

  // 1) Filtro barato com dados do próprio card (preço/desconto). rating/reviews
  //    ainda ausentes → passesAmazonFilters não corta por eles aqui.
  let pool = raw.filter(p => affiliate.passesAmazonFilters(p, cfg));
  pool.sort((a, b) => (b.discount || 0) - (a.discount || 0));

  // 2) Enriquece rating/reviews abrindo a página de cada produto — em browser
  //    PRÓPRIO (fresco) e LIMITADO: abrir centenas de páginas é o que mais dispara
  //    CAPTCHA. Só vale a pena quando há filtro de rating/reviews; sem filtro,
  //    enriquece poucos só pra exibição. pool já vem ordenado por desconto, então
  //    os enriquecidos são os mais relevantes (os que de fato vão pra fila).
  const needsRatingData = cfg.minRating > 0 || cfg.minReviews > 0;
  const configured = Number.isFinite(Number(cfg.enrichLimit)) ? Number(cfg.enrichLimit) : AMZ_ENRICH_DISPLAY;
  const enrichCap = needsRatingData ? Math.max(configured, AMZ_ENRICH_MAX) : configured;
  const toEnrich = pool.slice(0, Math.min(pool.length, enrichCap));
  if (toEnrich.length) {
    const eBrowser = await launchAmazonBrowser();
    try {
      await enrichAmazonRatings(toEnrich, eBrowser, category);
    } finally {
      try { await eBrowser.close(); } catch {}
    }
  }

  // 3) Reaplica os filtros — agora minRating/minReviews valem pra quem foi enriquecido.
  const kept = pool.filter(p => affiliate.passesAmazonFilters(p, cfg));
  if (kept.length < pool.length) {
    console.log(`[scraper Amazon] ${tag}: ${pool.length} ofertas, ${pool.length - kept.length} cortadas por rating/reviews, ${kept.length} aprovadas`);
  }

  kept.sort((a, b) => (b.discount || 0) - (a.discount || 0));
  return kept.slice(0, limit);
}

// A Amazon não mostra "vendidos" — mostra prova social de compras recentes, tipo
// "Mais de 2 mil compras no mês passado" ou "500+ compras no mês passado".
// Normalizamos pro MESMO formato de string do ML ("+2 mil vendidos"), pra
// formatVendas (scheduler.js) e parseSold (abaixo) funcionarem sem mudança.
// Pura → testável.
function parseAmazonSold(text) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (!s || !/compra|comprad|bought/i.test(s)) return null;
  const m = s.match(/([\d.,]+)\s*(mil|mi|k)?\s*\+?\s*(?:compras|compradas?|bought)/i);
  if (!m) return null;
  const plus = /mais de/i.test(s) || /\+/.test(s);
  const unit = (m[2] || "").toLowerCase();
  const suffix = unit === "k" ? " mil" : unit ? ` ${unit}` : "";
  return `${plus ? "+" : ""}${m[1]}${suffix} vendidos`;
}

// Enriquece produtos da Amazon com rating + reviewsCount abrindo a página de cada um
// (/dp/ASIN) num browser dedicado (passado pelo chamador). A página de ofertas não
// traz esses dados; um fetch sem browser é bloqueado por CAPTCHA, então precisa do
// navegador real (~5s/produto). Concorrência baixa pra não parecer abuso. Disjuntor:
// após N CAPTCHAs/erros seguidos, para de enriquecer o resto (ficam com rating null
// e seguem no catálogo). O nº de produtos já vem limitado por quem chama (scrapeAmazon).
async function enrichAmazonRatings(products, browser, category, { concurrency = 3, maxConsecutiveFails = 6 } = {}) {
  if (!products.length) return;
  const queue = products.slice();
  let consecutiveFails = 0;
  let stopped = false;
  let enriched = 0;

  const worker = async () => {
    while (queue.length && !stopped) {
      const p = queue.shift();
      if (!p.link) continue;
      // jitter pequeno pra dessincronizar as abas
      await new Promise(r => setTimeout(r, 150 + Math.floor(Math.random() * 350)));
      let page;
      try {
        page = await browser.newPage();
        await applyAmazonStealth(page);
        await page.goto(p.link, { waitUntil: "domcontentloaded", timeout: 20000 });
        await new Promise(r => setTimeout(r, 800));
        const data = await page.evaluate(() => {
          const txt = (s) => document.querySelector(s)?.textContent?.replace(/\s+/g, " ").trim() || null;
          const attr = (s, a) => document.querySelector(s)?.getAttribute(a) || null;
          const captcha = /digite os caracteres|enter the characters|automated access|tipo de tr[áa]fego/i.test(document.body?.innerText || "");
          const ratingTxt = attr("#acrPopover", "title")
                         || txt('span[data-hook="rating-out-of-text"]')
                         || txt("#acrPopover .a-icon-alt")
                         || txt("i.a-icon-star .a-icon-alt");
          const reviewTxt = txt("#acrCustomerReviewText");
          // "Mais de 2 mil compras no mês passado" — prova social logo abaixo do título.
          const soldTxt = txt("#social-proofing-faceout-title-tk_bought")
                       || txt("#socialProofingAsinFaceout_feature_div .social-proofing-faceout-title-text")
                       || txt(".social-proofing-faceout-title-text");
          // Vendedor: link do lojista no bloco de compra ("Vendido por X").
          const sellerTxt = txt("#sellerProfileTriggerId")
                         || txt("#merchant-info a")
                         || txt('[offer-display-feature-name="desktop-merchant-info"] a');
          const deliveryTxt = txt("#mir-layout-DELIVERY_BLOCK")
                           || txt("#deliveryBlockMessage")
                           || txt("#amazonGlobal_feature_div");
          return { captcha, ratingTxt, reviewTxt, soldTxt, sellerTxt, deliveryTxt };
        });

        if (data.captcha) {
          if (++consecutiveFails >= maxConsecutiveFails) stopped = true;
          continue;
        }
        consecutiveFails = 0;
        if (data.ratingTxt) {
          const m = data.ratingTxt.match(/([\d,.]+)\s*de\s*5/i);
          if (m) p.rating = parseFloat(m[1].replace(",", "."));
        }
        if (data.reviewTxt) {
          const n = data.reviewTxt.replace(/[^\d]/g, "");
          if (n) p.reviewsCount = n;
        }
        const sold = parseAmazonSold(data.soldTxt);
        if (sold) p.sold = sold;
        if (data.sellerTxt) p.seller = data.sellerTxt.replace(/^vendido por\s+/i, "").trim() || null;
        if (data.deliveryTxt) p.freeShipping = /gr[áa]tis|free/i.test(data.deliveryTxt);
        if (p.rating != null || p.reviewsCount != null) enriched++;
      } catch {
        if (++consecutiveFails >= maxConsecutiveFails) stopped = true;
      } finally {
        if (page) { try { await page.close(); } catch {} }
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, products.length) }, worker));
  const tag = category || "geral";
  if (stopped) {
    console.warn(`[scraper Amazon] ${tag}: enriquecimento interrompido (CAPTCHA/erros seguidos) — ${enriched}/${products.length} com rating`);
  } else {
    console.log(`[scraper Amazon] ${tag}: rating/reviews enriquecidos ${enriched}/${products.length}`);
  }
}

// ────────────────────────────────────────────────────────────────────────
// Shopee (via Affiliate Open API — GraphQL, sem browser)
// ────────────────────────────────────────────────────────────────────────

// Cache em memória para reviews count (Shopee não expõe via Affiliate API,
// então enriquecemos via endpoint público v4/item/get). TTL 6h.
const shopeeReviewCache = new Map();
const SHOPEE_REVIEW_TTL_MS = 6 * 60 * 60 * 1000;

// DISJUNTOR: o v4/item/get devolve 403 (anti-bot, error 90309999) para muitos IPs
// — confirmado em teste ao vivo, e o mesmo bloqueio já estava documentado em
// scrapeShopeeSingleViaApi. Quando isso acontece, cada rodada de scraping fazia N
// requisições que nunca dão em nada. Após SHOPEE_REVIEW_MAX_FAILS falhas seguidas
// o enriquecimento se desliga sozinho pelo resto do processo (volta no próximo
// restart, caso o IP saia do bloqueio).
const SHOPEE_REVIEW_MAX_FAILS = 8;
let shopeeReviewFails = 0;
let shopeeReviewDisabled = false;

function noteShopeeReviewFailure(reason) {
  if (++shopeeReviewFails < SHOPEE_REVIEW_MAX_FAILS) return;
  shopeeReviewDisabled = true;
  console.warn(`[scraper Shopee] reviewsCount desligado: ${SHOPEE_REVIEW_MAX_FAILS} falhas seguidas no v4/item/get (${reason}). O endpoint está bloqueando este IP — os produtos seguem sem nº de avaliações.`);
}

async function fetchShopeeReviewCount(itemId, shopId) {
  if (!itemId || !shopId || shopeeReviewDisabled) return null;
  const key = `${shopId}:${itemId}`;
  const cached = shopeeReviewCache.get(key);
  if (cached && Date.now() - cached.ts < SHOPEE_REVIEW_TTL_MS) return cached.value;

  const url = `https://shopee.com.br/api/v4/item/get?itemid=${encodeURIComponent(itemId)}&shopid=${encodeURIComponent(shopId)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        "Accept": "application/json",
        "Accept-Language": "pt-BR,pt;q=0.9",
        "X-Requested-With": "XMLHttpRequest",
        "Referer": "https://shopee.com.br/",
      },
      signal: controller.signal,
    });
    if (!res.ok) { noteShopeeReviewFailure(`HTTP ${res.status}`); return null; }
    const data = await res.json();
    // cmt_count = total de comentários/avaliações; some-times está em data.data.cmt_count
    const cmt = data?.data?.cmt_count ?? data?.item?.cmt_count ?? null;
    const value = Number.isFinite(Number(cmt)) ? Number(cmt) : null;
    if (value == null) { noteShopeeReviewFailure("resposta sem cmt_count"); return null; }
    shopeeReviewFails = 0;
    shopeeReviewCache.set(key, { value, ts: Date.now() });
    return value;
  } catch (err) {
    noteShopeeReviewFailure(err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Mapeia um node da API pro formato Nimbus.
// Preços vêm em centavos como string ("1990" = R$19,90) na maioria dos casos,
// mas alguns retornam decimal. Normalizamos pra Number aceitando ambos.
function shopeeNodeToProduct(node, category) {
  // Preço atual: prefere `price`, fallback pra `priceMin`
  const priceRaw = node.price ?? node.priceMin ?? null;
  // priceBeforeDiscount não vem direto no schema padrão; calculamos do desconto
  const price = parsePrice(priceRaw);
  const discount = Number(node.priceDiscountRate) || 0;
  const originalPrice = (price && discount > 0 && discount < 100)
    ? Math.round((price / (1 - discount / 100)) * 100) / 100
    : null;

  return {
    name: String(node.productName || "").trim(),
    link: String(node.offerLink || node.productLink || ""),
    img: node.imageUrl || null,
    store: "Shopee",
    category: category || null,
    price,
    originalPrice,
    discount,
    rating: Number(node.ratingStar) || null,
    reviewsCount: null,
    seller: (typeof node.shopName === "string" && node.shopName.trim()) ? node.shopName.trim() : null,
    // A Affiliate Open API não expõe frete — não dá pra saber daqui.
    freeShipping: false,
    soldCount: Number(node.sales) || 0,
    commissionRate: Number(node.commissionRate) || null,
    // Guardados temporariamente pro enriquecimento via v4/item/get;
    // removidos antes de persistir no catálogo (não vão pro payload).
    _shopeeItemId: node.itemId || null,
    _shopeeShopId: node.shopId || null,
    scrapedAt: new Date().toISOString(),
  };
}

// Aceita "1990" (centavos como string), 19.9 (real decimal), "19.90" — normaliza.
// Heurística: se o número é inteiro e >= 1000, assume centavos e divide por 100.
function parsePrice(raw) {
  if (raw == null) return null;
  const n = Number(raw);
  if (!isFinite(n) || n <= 0) return null;
  if (Number.isInteger(n) && n >= 1000) return n / 100;
  return n;
}

async function scrapeShopee({ category, limit = 50 } = {}) {
  // Lazy require pra não criar dependência circular no boot
  const affiliate = require("./affiliate");

  const cat = CATEGORIES[category];
  const filters = affiliate.readShopeeScraperFilters();

  // Preferimos buscar por categoria REAL da Shopee (productCatId) → produtos gerais
  // da categoria, sem viés de palavra-chave. Fallback pra keyword se não houver IDs.
  const catIds = Array.isArray(cat?.shopeeCatIds) ? cat.shopeeCatIds : [];
  const keyword = cat?.shopeeKeyword || cat?.label || category;
  if (!catIds.length && !keyword) {
    console.warn("[scraper Shopee] sem categoria/keyword — pulando");
    return [];
  }

  // API limita ~50 por página. Paginação simples se limit > 50.
  const pageSize = Math.min(50, limit);
  const products = [];
  const seenItems = new Set();
  let totalSeen = 0;
  let totalRejected = 0;

  // Cada "fonte" é um productCatId (categoria ampla = vários) ou, no fallback, a keyword.
  const sources = catIds.length ? catIds.map(id => ({ productCatId: id })) : [{ keyword }];
  const perSource = Math.ceil(limit / sources.length);

  for (const src of sources) {
    let collected = 0;
    let page = 1;
    // Filtros de qualidade descartam muito → safety alto (até 12 páginas por fonte)
    let safety = 12;
    while (collected < perSource && products.length < limit && safety-- > 0) {
      const { nodes, pageInfo } = await affiliate.fetchShopeeOffers({
        ...src,
        page,
        limit: pageSize,
        sortType: filters.sortType,  // 2 = mais vendidos (melhores produtos) por padrão
        listType: filters.listType,  // pré-seleção Shopee (Recomendados/Top performance/Maior comissão)
      });
      if (!nodes.length) break;
      for (const n of nodes) {
        totalSeen++;
        const key = `${n.shopId}_${n.itemId}`;
        if (seenItems.has(key)) continue;  // dedup entre fontes/páginas
        if (!affiliate.passesShopeeFilters(n, filters)) {
          totalRejected++;
          continue;
        }
        seenItems.add(key);
        const p = shopeeNodeToProduct(n, category);
        if (p.name && p.link) { products.push(p); collected++; }
        if (products.length >= limit || collected >= perSource) break;
      }
      if (!pageInfo?.hasNextPage) break;
      page++;
    }
  }

  const tag = catIds.length ? `cat[${catIds.join(",")}]` : keyword;
  if (totalRejected > 0) {
    console.log(`[scraper Shopee] ${tag}: ${totalSeen} vistos, ${totalRejected} filtrados (rating/vendas/preço/comissão/desconto), ${products.length} aprovados`);
  }

  products.sort((a, b) => (b.discount || 0) - (a.discount || 0));
  const final = products.slice(0, limit);

  // Enriquece com reviewsCount via endpoint público v4/item/get (paralelo, falhas silenciosas).
  // Concorrência limitada pra não saturar / parecer abuso.
  const CONCURRENCY = 5;
  let enriched = 0;
  for (let i = 0; i < final.length; i += CONCURRENCY) {
    const slice = final.slice(i, i + CONCURRENCY);
    await Promise.all(slice.map(async (p) => {
      const cmt = await fetchShopeeReviewCount(p._shopeeItemId, p._shopeeShopId);
      if (cmt != null) {
        p.reviewsCount = cmt;
        enriched++;
      }
      delete p._shopeeItemId;
      delete p._shopeeShopId;
    }));
  }
  if (final.length > 0) {
    console.log(`[scraper Shopee] reviewsCount: ${enriched}/${final.length} enriquecidos`);
  }

  return final;
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
    if (/mercadolivre|mercadolibre/.test(host) || /merc\.li|mlb\.li|meli\.la/.test(host)) return "Mercado Livre";
    if (/amazon|amzn/.test(host)) return "Amazon";
    if (/shopee/.test(host)) return "Shopee";
    if (/americanas/.test(host)) return "Americanas";
    if (/magazineluiza|magalu/.test(host)) return "Magazine Luiza";
    return null;
  } catch {
    return null;
  }
}

// Deriva um nome aproximado do slug da URL (fallback p/ Shopee, cuja PDP é uma
// SPA que não renderiza pra bot). Ex.: ".../Fone-Bluetooth-i12-i.123.456" →
// "Fone Bluetooth i12". Pura → testável.
function slugNameFromUrl(url) {
  try {
    const u = new URL(url);
    let seg = u.pathname.split("/").filter(Boolean).pop() || "";
    seg = seg.replace(/-i\.\d+\.\d+$/i, "");   // sufixo Shopee i.SHOPID.ITEMID
    seg = seg.replace(/\.\w{2,5}$/, "");        // extensão eventual (.html)
    const name = decodeURIComponent(seg).replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
    return name || null;
  } catch {
    return null;
  }
}

// Converte a string de cookie de sessão do afiliado ML (formato header
// "k=v; k2=v2") em pares pro page.setCookie do domínio mercadolivre.com.br.
function parseMLCookies(cookieStr) {
  if (!cookieStr || typeof cookieStr !== "string") return [];
  return cookieStr.split(";").map(s => s.trim()).filter(Boolean).map(pair => {
    const i = pair.indexOf("=");
    if (i < 0) return null;
    return { name: pair.slice(0, i).trim(), value: pair.slice(i + 1).trim(), domain: ".mercadolivre.com.br", path: "/" };
  }).filter(c => c && c.name);
}

// Detecta páginas de bloqueio anti-bot: login wall do ML (/gz/account-verification),
// interstitial "Continuar comprando" e CAPTCHA da Amazon, e produto inexistente.
// Retorna { blocked, reason, captcha?, interstitial? }.
async function detectBlockPage(page, store) {
  if (store === "Mercado Livre" && /\/gz\/account-verification/i.test(page.url())) {
    return { blocked: true, reason: "Mercado Livre pediu login — verifique o cookie de afiliado nas Configurações." };
  }
  return page.evaluate((store) => {
    const body = document.body?.innerText || "";
    // O texto do muro às vezes vem no <title>/og:title (não no body) — junta tudo.
    const title = document.title || "";
    const og = document.querySelector('meta[property="og:title"]')?.content || "";
    const hay = `${body}\n${title}\n${og}`;
    if (store === "Amazon") {
      if (/enter the characters|captcha|robot check|digite os caracteres/i.test(hay)) {
        return { blocked: true, captcha: true, reason: "Amazon retornou CAPTCHA — tente daqui a alguns minutos." };
      }
      if (/continuar comprando|continue shopping/i.test(body) && !document.querySelector("#productTitle")) {
        return { blocked: true, interstitial: true, reason: "Amazon mostrou tela intermediária (Continuar comprando)." };
      }
      if (/n[aã]o foi poss[ií]vel encontrar|couldn.t find that page|page not found/i.test(hay) && !document.querySelector("#productTitle")) {
        return { blocked: true, reason: "Produto não encontrado na Amazon (o link pode estar quebrado)." };
      }
    }
    if (store === "Mercado Livre") {
      if (/acesse sua conta|para continuar, acesse/i.test(body) && !document.querySelector(".ui-pdp-title")) {
        return { blocked: true, reason: "Mercado Livre pediu login — verifique o cookie de afiliado nas Configurações." };
      }
    }
    return { blocked: false };
  }, store);
}

// Clica no botão "Ir para o produto" da landing de afiliado do ML
// (mercadolivre.com.br/social/...). A navegação pode acontecer na mesma aba
// ou abrir uma aba nova (target="_blank") — trata os dois casos e devolve a
// page de trabalho correta (a nova aba, se for o caso). Best-effort: se não
// achar o botão ou a navegação não acontecer a tempo, devolve a page original
// e deixa o waitForSelector/detectBlockPage seguintes reportarem a falha.
async function clickGoToProductML(browser, page) {
  const clicked = await page.evaluate(() => {
    const el = [...document.querySelectorAll("a, button")]
      .find(e => /ir\s+para\s+o?\s*produto|ver\s+produto/i.test((e.textContent || "").trim()));
    if (el) { el.click(); return true; }
    return false;
  });
  if (!clicked) return page;

  const newTabPromise = new Promise((resolve) => {
    browser.once("targetcreated", async (target) => {
      try { resolve(await target.page()); } catch { resolve(null); }
    });
  });
  const [navigated, newPage] = await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 10000 }).then(() => true).catch(() => false),
    Promise.race([newTabPromise, sleep(10000).then(() => null)]),
  ]);

  if (newPage) {
    try { await newPage.waitForSelector("body", { timeout: 10000 }); } catch {}
    try { await page.close(); } catch {}
    return newPage;
  }
  if (navigated) return page;
  return page;
}

// Uma tentativa de coleta: abre browser próprio (com stealth), navega, contorna
// interstitials e extrai. Lança erro tipado (err.blocked/err.captcha) em bloqueio.
async function harvestSingleProduct(cleanUrl, store, userId) {
  const browser = await launchAmazonBrowser();
  try {
    let page = await browser.newPage();
    await applyAmazonStealth(page);

    // ML: injeta o cookie de sessão do afiliado pra furar o /gz/account-verification.
    if (store === "Mercado Livre" && userId != null) {
      try {
        const affiliate = require("./affiliate");
        const { cookie } = affiliate.readMLConfig(userId);
        const cookies = parseMLCookies(cookie);
        if (cookies.length) await page.setCookie(...cookies);
      } catch { /* segue sem cookie — detectBlockPage avisa se cair no login */ }
    }

    await page.goto(cleanUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    // Pequena espera pra conteúdo dinâmico (preço por JS é comum)
    await sleep(1500);

    // Em ML/Amazon, espera o seletor principal aparecer (com timeout curto)
    if (store === "Mercado Livre") {
      // Link de afiliado (mercadolivre.com.br/social/...): é uma landing com o
      // produto + dados do afiliado, com um botão "Ir para o produto" que precisa
      // ser clicado pra chegar na PDP real (nome/preço só existem lá).
      if (/\/social\//i.test(page.url())) {
        page = await clickGoToProductML(browser, page);
      }
      try { await page.waitForSelector(".ui-pdp-title, h1", { timeout: 5000 }); } catch {}
    } else if (store === "Amazon") {
      // Tela "Continuar comprando": clica no botão e segue pra PDP real.
      const pre = await detectBlockPage(page, store);
      if (pre.interstitial) {
        const clicked = await page.evaluate(() => {
          const el = [...document.querySelectorAll("button, input[type=submit], a")]
            .find(e => /continuar comprando|continue shopping/i.test(e.textContent || e.value || ""));
          if (el) { el.click(); return true; }
          return false;
        });
        if (clicked) {
          try { await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 }); } catch {}
          await sleep(1200);
        }
      }
      try { await page.waitForSelector("#productTitle, h1#title", { timeout: 5000 }); } catch {}
    }

    // Muro anti-bot (login/CAPTCHA/404) → erro claro em vez de devolver lixo.
    const block = await detectBlockPage(page, store);
    if (block.blocked) {
      const err = new Error(block.reason);
      err.blocked = true;
      err.captcha = !!block.captcha;
      throw err;
    }

    // URL pós-navegação/redirects — o Puppeteer já contornou o muro (cookie de
    // sessão do afiliado) pra chegar aqui, diferente de um fetch cru sem cookie
    // (que costuma travar no captcha do ML). É o link confiável pra guardar/afiliar.
    const finalUrl = page.url();

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

      let name = null, price = null, originalPrice = null, discount = null, img = null, sold = null;

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
        // Fallback: sem o rótulo de desconto, mas com preço atual e original, calcula.
        if (discount == null && originalPrice && price && originalPrice > price && originalPrice < price * 20) {
          discount = Math.round((1 - price / originalPrice) * 100);
        }
        const imgEl = document.querySelector(".ui-pdp-gallery__figure img, figure.ui-pdp-gallery__figure img, .ui-pdp-image");
        img = imgEl?.getAttribute("data-zoom") || imgEl?.getAttribute("src") || ogImage;
        // Best-effort: não há seletor confirmado pra "vendidos" na PDP — tenta achar
        // o texto em qualquer lugar da página (ex. "500 vendidos", "2 mil vendidos").
        const soldMatch = (document.body?.innerText || "").match(/([\d.,]+)\s*(mil\s*)?vendid[oa]s?/i);
        if (soldMatch) {
          let n = parseFloat(soldMatch[1].replace(/\./g, "").replace(",", "."));
          if (soldMatch[2]) n *= 1000;
          if (!isNaN(n)) sold = Math.round(n);
        }
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

      return { name, price, originalPrice, discount, img, sold };
    }, store);

    // Shopee: a PDP é SPA vazia pra bot — sem nome via DOM/OG, usa o slug da URL.
    let name = data.name || null;
    if (!name && store === "Shopee") name = slugNameFromUrl(finalUrl);

    return {
      name: name || null,
      link: cleanUrl,
      finalUrl,
      price: data.price ?? null,
      originalPrice: data.originalPrice ?? null,
      discount: data.discount ?? null,
      sold: data.sold ?? null,
      img: store === "Amazon" ? upgradeAmazonImageUrl(data.img)
         : store === "Mercado Livre" ? upgradeMLImageUrl(data.img)
         : (data.img || null),
      store: store || null,
      scrapedAt: new Date().toISOString(),
    };
  } finally {
    await browser.close();
  }
}

// Extrai shopId/itemId do formato padrão de URL de produto Shopee
// (".../<slug>-i.<shopId>.<itemId>", com ou sem query string atrás).
function extractShopeeIds(url) {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/-i\.(\d+)\.(\d+)$/i);
    if (!m) return null;
    return { shopId: m[1], itemId: m[2] };
  } catch {
    return null;
  }
}

// Segue redirect HTTP puro (sem Puppeteer) — suficiente pra Shopee, que (ao
// contrário do ML) não costuma jogar link curto num muro anti-bot.
async function resolveShopeeUrl(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, { method: "GET", redirect: "follow", headers: { "User-Agent": UA }, signal: controller.signal });
    const finalUrl = res.url || url;
    try { await res.body?.cancel?.(); } catch { /* ignore */ }
    return finalUrl;
  } catch {
    return url;
  } finally {
    clearTimeout(timer);
  }
}

// Caminho primário pra Shopee: API OFICIAL de afiliados (Affiliate Open API,
// GraphQL — mesma usada no scraping em massa), filtrando por itemId/shopId em
// vez de keyword/categoria. Descartado o plano original de bater na API
// pública `v4/item/get` — ela devolve 403 (anti-bot, error 90309999) mesmo
// vindo de dentro do próprio Puppeteer (testado ao vivo), então não dá pra
// confiar nela. A API de afiliados exige as credenciais (appId/appSecret) DO
// PRÓPRIO USUÁRIO — ok porque a captura já garantiu que ele tem afiliado
// Shopee configurado antes de chegar aqui.
async function scrapeShopeeSingleViaApi(cleanUrl, userId) {
  const affiliate = require("./affiliate");
  let ids = extractShopeeIds(cleanUrl);
  let finalUrl = cleanUrl;
  if (!ids) {
    finalUrl = await resolveShopeeUrl(cleanUrl);
    ids = extractShopeeIds(finalUrl);
  }
  if (!ids) return null;
  const node = await affiliate.fetchShopeeItemByIds(userId, ids.itemId, ids.shopId).catch(() => null);
  if (!node) return null;
  const mapped = shopeeNodeToProduct(node, null);
  if (!mapped.name) return null;
  return {
    name: mapped.name,
    link: finalUrl,
    finalUrl,
    price: mapped.price,
    originalPrice: mapped.originalPrice,
    discount: mapped.discount,
    sold: mapped.soldCount || null,
    img: mapped.img,
    store: "Shopee",
    scrapedAt: new Date().toISOString(),
  };
}

async function scrapeSingleProduct(url, { userId } = {}) {
  if (!url || typeof url !== "string" || !url.trim()) {
    throw new Error("URL inválida");
  }
  const cleanUrl = url.trim();
  const store = detectStore(cleanUrl);

  if (store === "Shopee") {
    const viaApi = await scrapeShopeeSingleViaApi(cleanUrl, userId).catch(() => null);
    if (viaApi) return viaApi;
    // API falhou (IDs não encontrados, endpoint fora) — cai no fallback abaixo.
  }

  // Amazon serve CAPTCHA/interstitial de forma intermitente → re-tenta com backoff
  // (browser novo a cada vez). ML/Shopee são determinísticos: 1 tentativa só.
  const maxAttempts = store === "Amazon" ? AMZ_MAX_ATTEMPTS : 1;
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await harvestSingleProduct(cleanUrl, store, userId);
    } catch (err) {
      lastErr = err;
      if (attempt >= maxAttempts) break;
      await sleep(amzBackoffMs(attempt));
    }
  }
  throw lastErr;
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

module.exports = { scrapeOfertas, scrapeML, scrapeAmazon, scrapeShopee, scrapeSingleProduct, detectStore, upgradeAmazonImageUrl, upgradeMLImageUrl, applyFilters, buildAmazonDealsUrl, normalizeSource, shopeeNodeToProduct, amzBackoffMs, slugNameFromUrl, extractShopeeIds, parseMLReviewCompacted, parseAmazonSold, CATEGORIES, STORES };
