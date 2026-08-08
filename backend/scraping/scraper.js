const puppeteer = require("puppeteer");
const urlGuard = require("./urlGuard");
const { pickBestImage } = require("./image-quality");
const { canonicalAmazonUrl } = require("./amazon-url");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Amazon — confiabilidade contra CAPTCHA/anti-bot (intermitente).
// A página de ofertas é re-tentada com backoff; a conferência de preço na página
// de cada produto (1 aba por produto) é limitada pra não disparar bloqueio em massa.
const AMZ_MAX_ATTEMPTS = 3;
const AMZ_BACKOFF_MS = [3000, 8000, 20000];   // por tentativa (1-based) + jitter
const AMZ_VERIFY_DEFAULT = 60;                // fallback do enrichLimit do admin
const AMZ_VERIFY_MAX = 120;                   // teto da folga quando há filtro de nota/avaliações

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

// Toda foto de produto do ML carrega um id no nome do arquivo:
// "https://http2.mlstatic.com/D_NQ_NP_2X_682596-MLB112404223609_052026-F.webp"
//                                        └──────── id ────────────┘└ tamanho
const ML_PICTURE_ID = /(\d{5,7}-[A-Z]{2,4}\d+_\d+)/;

// URLs de imagem do ML (mlstatic.com) codificam o TAMANHO no nome do arquivo:
// prefixo ("D_NQ_NP_", "D_Q_NP_2X_"…) + id da foto + sufixo ("-O", "-R", "-T",
// "-OO"…). São dezenas de combinações, e a página serve uma diferente em cada
// lugar — o og:image dá "-O" (~500px), a tira de miniaturas da galeria da PDP dá
// "-R" (70×70). Em vez de adivinhar o formato que veio, a gente REMONTA a URL a
// partir do id, sempre na maior versão que a CDN oferece ("D_NQ_NP_2X_…-F",
// lado maior 1200px, sem recorte quadrado). Funciona pra qualquer variante,
// inclusive as sem extensão. Quem confere se a remontagem melhorou mesmo é o
// pickBestImage — em foto de banner, por exemplo, o "-F" é menor que a original.
function upgradeMLImageUrl(url) {
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
    } catch { /* URL malformada — cai na troca de sufixo abaixo */ }
  }
  // Sem id reconhecível (asset do site, CDN nova): troca só o sufixo de tamanho.
  // Ele é sempre MAIÚSCULO — casar minúscula faria a última letra do título
  // saneado ("...-notebook-i.webp") virar sufixo e quebrar a URL.
  return url.replace(/-[A-Z]{1,2}(?=\.(?:jpg|jpeg|png|webp)(?:\?|$))/, "-F");
}

// A Shopee serve as fotos da CDN com sufixo de miniatura no fim do caminho
// (`_tn`, às vezes com extensão junto). Sem o sufixo a CDN devolve a imagem
// original — a mesma foto que aparece na página do produto.
function upgradeShopeeImageUrl(url) {
  if (!url || typeof url !== "string") return url;
  if (!/(susercontent\.com|shopee\.com\.br)/i.test(url)) return url;
  return url.replace(/_tn(?=(\.(?:jpg|jpeg|png|webp))?(?:\?|$))/i, "");
}

// Ponto único: aplica a regra da loja certa olhando o domínio da imagem. Usado
// onde a origem do produto não é conhecida na hora (repasse de link único, itens
// que já estavam no catálogo/fila).
function upgradeImageUrl(url) {
  if (!url || typeof url !== "string") return url;
  return upgradeShopeeImageUrl(upgradeMLImageUrl(upgradeAmazonImageUrl(url)));
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

// Quais destes produtos ainda não estão na coleta. Deduplica pela CHAVE DO
// CATÁLOGO (o MLB do produto), não pelo link: o mesmo item aparece na vitrine e
// no Hub com URLs diferentes. Pura → testável sem navegador.
function mergeNewProducts(existentes, candidatos) {
  const { productKey } = require("../catalog/product-key");
  const keys = new Set((existentes || []).map(productKey));
  const novos = [];
  for (const p of candidatos || []) {
    if (!p || !p.link) continue;
    const k = productKey(p);
    if (keys.has(k)) continue;
    keys.add(k);
    novos.push(p);
  }
  return novos;
}

// Vitrine pública de ofertas (mercadolivre.com.br/ofertas) — a fonte de sempre.
// A página mostra ~48 cards; paginamos via &page=N (1-indexed; sem o param =
// página 1) acumulando e DEDUPLICANDO por link até bater o limite, esgotar as
// páginas ou atingir o teto de segurança.
async function harvestMLVitrine(browser, { category, limit }) {
  const cat = CATEGORIES[category];
  const baseUrl = cat
    ? `https://www.mercadolivre.com.br/ofertas?category=${cat.mlCode}`
    : "https://www.mercadolivre.com.br/ofertas";

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
  return raw;
}

// Duas fontes: a vitrine pública e o Hub de Afiliados (só existe logado, com a
// conta do sistema). O admin liga/desliga cada uma e escolhe qual vem primeiro:
// a prioritária enche a cota, a outra completa o que faltar — e nem chega a abrir
// navegador se já não faltar nada.
async function scrapeML({ category, limit = 200 } = {}) {
  const tag = category || "geral";
  // Lazy require evita ciclo no boot. Filtros default (tudo 0) = passa tudo.
  const affiliate = require("./affiliate");
  const filters = affiliate.readMLScraperFilters();

  const fontes = affiliate.orderedMLSources().filter(src => src !== "hub" || affiliate.mlHubEnabled());
  if (fontes.length === 0) {
    console.warn(`[scraper ML] ${tag}: nenhuma fonte de ofertas ativa — nada a coletar`);
    return [];
  }

  let browser = null;   // só sobe o Chrome se a vitrine for realmente usada
  try {
    const aprovados = [];
    for (const fonte of fontes) {
      const faltam = limit - aprovados.length;
      if (faltam <= 0) break;

      let vistos = [];
      try {
        if (fonte === "vitrine") {
          if (!browser) {
            browser = await puppeteer.launch({
              headless: true,
              args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
            });
          }
          vistos = await harvestMLVitrine(browser, { category, limit: faltam });
        } else {
          vistos = await require("./ml-hub").scrapeHub({ category, limit: faltam });
        }
      } catch (err) {
        // Uma fonte fora do ar (sessão expirada, layout mudado) não derruba a outra.
        console.error(`[scraper ML] ${tag}: fonte "${fonte}" falhou — ${err.message}`);
        continue;
      }

      // Os filtros de qualidade cortam parte do que foi visto, então a segunda
      // fonte pode entregar menos que `faltam` — igual acontecia antes da 57.
      const passaram = vistos.filter(p => affiliate.passesMLFilters(p, filters));
      passaram.sort((a, b) => (b.discount || 0) - (a.discount || 0));
      const novos = mergeNewProducts(aprovados, passaram).slice(0, faltam);
      aprovados.push(...novos);
      console.log(`[scraper ML] ${tag}: ${fonte} — ${vistos.length} vistos, ${passaram.length} aprovados, +${novos.length} (faltavam ${faltam})`);
    }

    return aprovados.slice(0, limit);
  } finally {
    if (browser) await browser.close();
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
    // Devolve TEXTO CRU (igual ao resto do scraper): quem interpreta são as funções
    // puras no Node (parseBrlPrice/parseDiscountLabel/reconcilePricing), testáveis
    // sem browser. O preço daqui é provisório — serve pra ordenar e pré-filtrar; o
    // valor definitivo vem conferido na página do produto (enrichAmazonProducts).
    return await page.evaluate(async (targetLimit) => {
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
          // vem com prefixo ("Preço da Oferta: R$ ..."), tratado no parseBrlPrice.
          const priceText = card.querySelector('.a-price[data-a-color="base"] .a-offscreen')?.textContent || null;
          const originalText = card.querySelector('.a-price[data-a-strike="true"] .a-offscreen')?.textContent || null;

          // Desconto: SÓ do selo. Antes lia o textContent do card inteiro, o que
          // pegava "10% off" de cupom/leve-2-pague-1 como se fosse o desconto do item.
          const badgeEl = card.querySelector('[data-testid="deal-badge"]')
                       || card.querySelector('[class*="percentOff"]')
                       || card.querySelector('[class*="dealBadge"]')
                       || card.querySelector(".a-badge-text");
          const discountText = badgeEl?.textContent || null;

          if (!name || !href || !priceText) continue;

          seen.set(asin, {
            asin,
            name,
            link: href,
            img: imgEl?.getAttribute("src") || null,
            priceText,
            originalText,
            discountText,
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

// Escolhe o que de fato vai pro catálogo, DEPOIS da conferência de preço na página
// do produto. Regra dura: item sem preço confirmado não entra — melhor catálogo
// menor do que anunciar no grupo um valor que não é o que a Amazon cobra.
// Pura → testável.
function selectVerifiedAmazonProducts(pool, cfg, limit, passes) {
  const verified = (pool || []).filter(p => p && p.priceVerified === true);
  const kept = verified.filter(p => passes(p, cfg));
  kept.sort((a, b) => (b.discount || 0) - (a.discount || 0));
  return {
    kept: kept.slice(0, limit).map(({ _cardPrice, _attempts, ...rest }) => rest),
    discardedUnverified: (pool || []).length - verified.length,
    discardedByFilter: verified.length - kept.length,
  };
}

async function scrapeAmazon({ category, limit = 100, stats } = {}) {
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
      // Devolver [] escondia bloqueio: o admin registrava "0 produtos" como se fosse
      // filtro restritivo. Erro tipado → scrapeOfertas empilha em `errors` e o alerta
      // do WhatsApp diz o que aconteceu de verdade.
      if (last) throw Object.assign(new Error(`vitrine de ofertas inacessível após ${AMZ_MAX_ATTEMPTS} tentativas (${err.message})`), { blocked: true });
      await sleep(amzBackoffMs(attempt));
    }
  }
  if (!raw.length) return [];

  // Card → produto. Preço/desconto daqui são PROVISÓRIOS: servem pra ordenar e
  // pré-filtrar; o valor que vai pro catálogo é o conferido na página do produto.
  for (const p of raw) {
    p.img = upgradeAmazonImageUrl(p.img);
    p.category = category || null;
    // Link canônico /dp/ASIN: sem slug nem /ref= de campanha (que às vezes força
    // uma oferta específica). É a página que será conferida e o link do catálogo.
    p.link = canonicalAmazonUrl(p.asin) || p.link;
    const cardPricing = reconcilePricing({
      price: parseBrlPrice(p.priceText),
      originalPrice: parseBrlPrice(p.originalText),
      discount: parseDiscountLabel(p.discountText),
    });
    p.price = cardPricing.price;
    p.originalPrice = cardPricing.originalPrice;
    p.discount = cardPricing.discount;
    delete p.priceText; delete p.originalText; delete p.discountText;
    // Todos preenchidos na conferência (a vitrine não expõe nenhum).
    p.rating = null;
    p.reviewsCount = null;
    p.seller = null;
    p.freeShipping = false;
    p.sold = null;
    p.priceVerified = false;
    p.store = "Amazon";
    p.scrapedAt = new Date().toISOString();
  }

  const affiliate = require("./affiliate");
  const cfg = affiliate.readAmazonScraperFilters();

  // 1) Pré-filtro barato com o preço do card, só pra priorizar a fila de conferência
  //    (o filtro definitivo roda depois, sobre o preço real).
  let pool = raw.filter(p => p.price != null && affiliate.passesAmazonFilters(p, cfg));
  pool.sort((a, b) => (b.discount || 0) - (a.discount || 0));

  // 2) Confere o preço de cada produto na PÁGINA DO PRODUTO — e de quebra colhe
  //    nota, avaliações, vendas, vendedor e frete. É o passo caro (~4s por produto),
  //    então tem teto: `enrichLimit` do admin. Como só entra no catálogo quem for
  //    conferido, esse teto é também o tamanho máximo do catálogo por categoria.
  //    pool vem ordenado por desconto → confere os mais relevantes primeiro.
  const needsRatingData = cfg.minRating > 0 || cfg.minReviews > 0;
  const configured = Number.isFinite(Number(cfg.enrichLimit)) ? Number(cfg.enrichLimit) : AMZ_VERIFY_DEFAULT;
  // Com filtro de nota/avaliações, parte do que for conferido morre no filtro —
  // confere uma folga pra não esvaziar a categoria.
  const verifyCap = needsRatingData ? Math.min(AMZ_VERIFY_MAX, Math.ceil(configured * 1.5)) : configured;
  const toVerify = pool.slice(0, Math.min(pool.length, verifyCap));
  let summary = { attempted: 0, verified: 0, failed: 0, captchaHits: 0, divergent: 0, stopped: false };
  if (toVerify.length) {
    const eBrowser = await launchAmazonBrowser();
    try {
      summary = await enrichAmazonProducts(toVerify, eBrowser, category);
    } finally {
      try { await eBrowser.close(); } catch {}
    }
  }

  // 3) Bloqueio no meio da conferência não pode virar "0 produtos, deve ser o filtro".
  if (summary.attempted > 0 && (summary.stopped || summary.verified / summary.attempted < 0.5)) {
    const causa = summary.captchaHits > 0 ? "CAPTCHA/bloqueio" : "sem preço na página (layout mudou?)";
    throw Object.assign(
      new Error(`conferência de preço falhou em mais da metade dos produtos — ${causa}: ${summary.verified}/${summary.attempted} conferidos`),
      { blocked: true },
    );
  }

  // 4) Só entra quem teve o preço confirmado, e os filtros valem sobre o preço real.
  const sel = selectVerifiedAmazonProducts(pool, cfg, limit, affiliate.passesAmazonFilters);
  console.log(
    `[scraper Amazon] ${tag}: ${raw.length} na vitrine → ${summary.verified} conferidos ` +
    `(${summary.divergent} com preço diferente do card) → ${sel.kept.length} aprovados; ` +
    `descartados: ${sel.discardedUnverified} sem conferência, ${sel.discardedByFilter} por filtro`
  );
  if (Array.isArray(stats)) {
    stats.push({
      source: "amazon",
      harvested: raw.length,
      verified: summary.verified,
      divergent: summary.divergent,
      discardedUnverified: sel.discardedUnverified,
      discardedByFilter: sel.discardedByFilter,
      kept: sel.kept.length,
    });
  }
  return sel.kept;
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

// "R$ 1.234,56" → 1234.56. Aceita prefixo ("Preço da Oferta: R$ 99,90") e ausência
// de centavos ("R$199"). Ponto é separador de milhar, vírgula é decimal — é assim
// que a Amazon/ML escrevem no .a-offscreen. Pura → testável.
function parseBrlPrice(text) {
  if (!text) return null;
  const m = String(text).replace(/\s+/g, "").match(/R\$([\d.]+)(?:,(\d{1,2}))?/i);
  if (!m) return null;
  const v = parseFloat(`${m[1].replace(/\./g, "")}.${m[2] || "00"}`);
  return isNaN(v) ? null : v;
}

// Percentual de desconto a partir do TEXTO DO SELO (não do texto da página/card
// inteiro — senão "Economize 10% com cupom" ou "Compre 2, ganhe 5% off" viravam o
// desconto do produto). Aceita "57% off", "-57%", "57% de desconto".
// Fora de 1..95 → null. Pura → testável.
function parseDiscountLabel(text) {
  const s = String(text || "");
  if (!s.trim()) return null;
  // Defesa a mais, caso o seletor pegue um selo vizinho: percentual de cupom,
  // leve-mais-pague-menos ou assinatura NÃO é o desconto do produto.
  if (/cupom|coupon|leve\s|compre\s|ganhe\s|assinatura|assine|parcel/i.test(s)) return null;
  const m = s.match(/-?\s*(\d{1,3})\s*%/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return n >= 1 && n <= 95 ? n : null;
}

// Deixa preço / preço original / desconto coerentes entre si. Rede de segurança pra
// quando um seletor pega valor de outro bloco da página (recomendações, "outras
// opções de compra"): melhor sair sem promoção do que anunciar um "de R$" falso.
//   - original só vale se for maior que o preço e menor que 20x ele; desconto, de 1 a 95
//   - sobrou só um dos dois → calcula o outro
//   - os dois brigando (mais de 3 pontos de diferença) → o rótulo vence, porque fica
//     colado no preço; o riscado é o que costuma vir de fora
//   - não sobrou nenhum → produto sem promoção (os dois nulos)
// Pura → testável.
function reconcilePricing({ price, originalPrice, discount } = {}) {
  const p = Number.isFinite(price) ? price : null;
  let orig = Number.isFinite(originalPrice) ? originalPrice : null;
  let disc = Number.isFinite(discount) ? Math.round(discount) : null;

  if (p == null || p <= 0) return { price: p, originalPrice: null, discount: null };
  if (orig == null || !(orig > p && orig < p * 20)) orig = null;
  if (disc == null || !(disc >= 1 && disc <= 95)) disc = null;

  const fromPair = orig != null ? Math.round((1 - p / orig) * 100) : null;
  const origFromDisc = (d) => Math.round((p / (1 - d / 100)) * 100) / 100;

  if (orig != null && disc != null) {
    if (Math.abs(fromPair - disc) > 3) orig = origFromDisc(disc);
  } else if (orig != null) {
    disc = fromPair >= 1 ? fromPair : null;
    if (disc == null) orig = null;
  } else if (disc != null) {
    orig = origFromDisc(disc);
  }

  return { price: p, originalPrice: orig, discount: disc };
}

// Lê o preço na PÁGINA DO PRODUTO da Amazon, ESCOPADO no bloco de compra.
//
// Roda dentro do browser (page.evaluate) e devolve só TEXTO CRU — quem interpreta
// são as funções puras no Node. É a única leitura de preço da Amazon: serve tanto o
// link único quanto a conferência em massa da vitrine de ofertas.
//
// O escopo é o ponto principal. A PDP tem "Comprados juntos com frequência",
// "Produtos similares" e "Outras opções de compra", cada bloco com SEU .a-price —
// buscar no documento inteiro fazia o preço vir de outro produto. Mesmo problema já
// corrigido no ML com a .ui-pdp-price__main-container.
function readAmazonPdpPricing() {
  const CONTAINERS = [
    "#corePriceDisplay_desktop_feature_div",
    "#corePrice_feature_div",
    "#corePriceDisplay_mobile_feature_div",
    "#apex_desktop",
    "#price_inside_buybox",
    "#buybox",
    "#rightCol",
  ];

  let root = null, containerId = null;
  for (const sel of CONTAINERS) {
    const el = document.querySelector(sel);
    if (!el) continue;
    // #price_inside_buybox é o span solto do preço; o riscado/selo ficam no box em volta.
    const scope = sel === "#price_inside_buybox" ? (el.closest("#qualifiedBuybox") || el.closest(".a-box") || el) : el;
    if (scope.querySelector(".a-price")) { root = scope; containerId = sel; break; }
  }

  const pick = (scope, sels) => {
    for (const s of sels) {
      const el = scope.querySelector(s);
      const t = el?.textContent?.replace(/\s+/g, " ").trim();
      if (t) return t;
    }
    return null;
  };

  // O preço ATUAL não está mais no .a-offscreen: nas PDPs de hoje aquele span vem
  // vazio e o valor fica (a) no rótulo de acessibilidade do apex ou (b) partido em
  // .a-price-symbol/.a-price-whole/.a-price-fraction. Era exatamente isso que fazia
  // a leitura antiga escorregar pro último seletor e pegar o preço de OUTRO bloco
  // da página — o preço errado da task 68.
  const composePrice = (el) => {
    if (!el) return null;
    const off = el.querySelector(".a-offscreen")?.textContent?.replace(/\s+/g, " ").trim();
    if (off) return off;
    let whole = el.querySelector(".a-price-whole")?.textContent?.replace(/\s+/g, "") || "";
    if (!whole) {
      // Elemento que já É o texto do preço (rótulo de acessibilidade do apex).
      const own = el.textContent?.replace(/\s+/g, " ").trim();
      return own && /R\$/.test(own) ? own : null;
    }
    whole = whole.replace(/[.,]$/, "");
    const frac = el.querySelector(".a-price-fraction")?.textContent?.replace(/\s+/g, "") || "00";
    const sym = el.querySelector(".a-price-symbol")?.textContent?.replace(/\s+/g, "") || "R$";
    return `${sym}${whole},${frac}`;
  };
  const pickPrice = (scope, sels) => {
    for (const s of sels) {
      const t = composePrice(scope.querySelector(s));
      if (t) return t;
    }
    return null;
  };

  const PRICE_SELS = [
    "#apex-pricetopay-accessibility-label",   // "R$ 59,90 com 47 por cento de desconto"
    ".priceToPay",
    '.a-price[data-a-color="base"]:not(.a-text-price)',
    ".a-price:not(.a-text-price)",
  ];
  const ORIGINAL_SELS = [
    '.a-price.a-text-price[data-a-strike="true"]',
    ".basisPrice .a-price",
    ".basisPrice",
    '[data-a-strike="true"]',
  ];
  const DISCOUNT_SELS = [".savingsPercentage", ".savingPriceOverride"];

  const availabilityTxt = (document.querySelector("#availability")?.textContent || "").replace(/\s+/g, " ").trim();
  const unavailable = !!document.querySelector("#outOfStock")
                   || /indispon[íi]vel|currently unavailable|fora de estoque/i.test(availabilityTxt);

  // Sem nenhum container conhecido (layout novo): repete no documento inteiro, mas
  // avisa via container:null — o Node marca priceSource "pdp-unscoped" e o log
  // denuncia a mudança de layout antes de o preço errado chegar no cliente.
  const scope = root || document;
  return {
    container: containerId,
    priceText: pick(scope, PRICE_SELS),
    originalText: pick(scope, ORIGINAL_SELS),
    // Só o selo. Sem varrer o texto do bloco: "Economize 5% com cupom" e
    // "Compre 2, ganhe 10% off" não são o desconto do produto — quando não há selo,
    // o desconto sai calculado do preço riscado (reconcilePricing).
    discountText: pick(scope, DISCOUNT_SELS),
    unavailable,
  };
}

// Interpreta o retorno cru de readAmazonPdpPricing. Produto indisponível sai sem
// preço (não tem "o preço que o cliente paga"). Pura → testável.
function parseAmazonPdpPricing(raw = {}) {
  const priceSource = raw.container ? `pdp:${raw.container}` : "pdp-unscoped";
  if (raw.unavailable) return { price: null, originalPrice: null, discount: null, priceSource };
  const pricing = reconcilePricing({
    price: parseBrlPrice(raw.priceText),
    originalPrice: parseBrlPrice(raw.originalText),
    discount: parseDiscountLabel(raw.discountText),
  });
  return { ...pricing, priceSource };
}

// Tela "Continuar comprando" da Amazon: um interstitial que aparece no lugar da PDP.
// Clicar segue pro produto de verdade. Usado nos dois fluxos — sem isso a conferência
// de preço em massa descartaria produtos bons achando que a página não carregou.
async function dismissAmazonInterstitial(page) {
  const clicked = await page.evaluate(() => {
    const el = [...document.querySelectorAll("button, input[type=submit], a")]
      .find(e => /continuar comprando|continue shopping/i.test(e.textContent || e.value || ""));
    if (el) { el.click(); return true; }
    return false;
  }).catch(() => false);
  if (!clicked) return false;
  try { await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 }); } catch {}
  await sleep(1200);
  return true;
}

// Nota de uma página de produto, a partir do texto cru colhido no DOM. Aceita os
// formatos das três lojas: "4,8 de 5 estrelas" (Amazon), "Classificação 4.8 de 5
// estrelas" (ML acessível) e "4.8" solto. Fora de 0-5 → null (pegou outro número).
// Pura → testável.
function parseRatingText(text) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (!s) return null;
  // Sem o "de 5" só aceita a string que é SÓ o número — senão pegaria o "1.234"
  // de "1.234 avaliações" como se fosse nota.
  const m = s.match(/([\d]+[.,][\d]+|[\d]+)\s*(?:de|out of|\/)\s*5/i) || s.match(/^([\d]+[.,][\d]+|[\d]+)$/);
  if (!m) return null;
  const v = parseFloat(m[1].replace(",", "."));
  if (isNaN(v) || !(v > 0 && v <= 5)) return null;
  return v;
}

// Nº de avaliações: "1.234 avaliações" / "(89)" → "1234". String, igual ao que o
// enriquecimento da Amazon já grava. Pura → testável.
function parseReviewsCount(text) {
  const s = String(text || "");
  if (!s.trim()) return null;
  const digits = s.replace(/[^\d]/g, "");
  return digits || null;
}

// Abre a PÁGINA DE CADA PRODUTO (/dp/ASIN) num browser dedicado (passado pelo
// chamador) pra CONFERIR O PREÇO e colher nota, avaliações, vendas, vendedor e frete.
//
// A conferência de preço é a razão de existir da função: o preço do card da vitrine
// pode estar velho, ser de outra variação ou de outro vendedor — e era isso que fazia
// o cliente abrir o link e ver outro valor. Quem não for conferido não entra no
// catálogo (ver selectVerifiedAmazonProducts).
//
// Um fetch sem browser é bloqueado por CAPTCHA, então precisa do navegador real
// (~4s/produto). Uma aba por worker (reusada entre produtos) e concorrência baixa
// pra não parecer abuso. CAPTCHA devolve o produto pro fim da fila com backoff;
// só um bloqueio persistente (N falhas seguidas) interrompe a rodada.
// O nº de produtos já vem limitado por quem chama (scrapeAmazon).
async function enrichAmazonProducts(products, browser, category, { concurrency = 3, maxConsecutiveFails = 8, maxAttempts = 2 } = {}) {
  const summary = { attempted: products.length, verified: 0, failed: 0, captchaHits: 0, divergent: 0, unscoped: 0, stopped: false };
  if (!products.length) return summary;
  const queue = products.slice();
  let consecutiveFails = 0;
  let stopped = false;
  let enriched = 0;
  // Concorrência adaptativa: ao segundo CAPTCHA da rodada, os workers extras
  // encerram e sobra um só — pisar mais leve costuma destravar sem abortar tudo.
  let activeLimit = Math.min(concurrency, products.length);

  const worker = async (slot) => {
    let page = null;
    const freshPage = async () => {
      if (page && !page.isClosed()) return page;
      page = await browser.newPage();
      await applyAmazonStealth(page);
      return page;
    };
    try {
      while (queue.length && !stopped) {
        if (slot >= activeLimit) break;
        const p = queue.shift();
        if (!p.link) continue;
        // jitter pequeno pra dessincronizar as abas
        await new Promise(r => setTimeout(r, 150 + Math.floor(Math.random() * 350)));
        try {
          await freshPage();
          await page.goto(p.link, { waitUntil: "domcontentloaded", timeout: 20000 });
          await new Promise(r => setTimeout(r, 800));
          const data = await page.evaluate(() => {
            const txt = (s) => document.querySelector(s)?.textContent?.replace(/\s+/g, " ").trim() || null;
            const attr = (s, a) => document.querySelector(s)?.getAttribute(a) || null;
            const bodyTxt = document.body?.innerText || "";
            const captcha = /digite os caracteres|enter the characters|automated access|tipo de tr[áa]fego/i.test(bodyTxt);
            const interstitial = /continuar comprando|continue shopping/i.test(bodyTxt) && !document.querySelector("#productTitle");
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
            return { captcha, interstitial, ratingTxt, reviewTxt, soldTxt, sellerTxt, deliveryTxt };
          });

          if (data.captcha) {
            summary.captchaHits++;
            if (summary.captchaHits >= 2) activeLimit = 1;
            // CAPTCHA é intermitente: devolve pro fim da fila com backoff em vez de
            // descartar o produto. Só falha de vez quando insiste.
            p._attempts = (p._attempts || 0) + 1;
            if (p._attempts < maxAttempts) {
              queue.push(p);
              await sleep(amzBackoffMs(p._attempts));
            } else {
              summary.failed++;
            }
            if (++consecutiveFails >= maxConsecutiveFails) stopped = true;
            continue;
          }
          // Tela "Continuar comprando" no lugar da PDP: clica antes de ler o preço.
          if (data.interstitial) await dismissAmazonInterstitial(page);
          const pdp = parseAmazonPdpPricing(await page.evaluate(readAmazonPdpPricing));
          if (pdp.price == null) {
            // Sem preço na página (indisponível, sem buy box, layout mudou) → não entra.
            summary.failed++;
            consecutiveFails = 0;
            continue;
          }
          if (p.price != null && Math.abs(pdp.price - p.price) / p.price > 0.01) summary.divergent++;
          p._cardPrice = p.price;
          p.price = pdp.price;
          p.originalPrice = pdp.originalPrice;
          p.discount = pdp.discount;
          p.priceVerified = true;
          p.priceSource = pdp.priceSource;
          if (pdp.priceSource === "pdp-unscoped") summary.unscoped++;
          p.priceCheckedAt = new Date().toISOString();
          summary.verified++;

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
          // Timeout/aba morta: a aba pode ter ficado num estado ruim — descarta pra
          // que a próxima volta abra uma limpa.
          summary.failed++;
          if (page) { try { await page.close(); } catch {} page = null; }
          if (++consecutiveFails >= maxConsecutiveFails) stopped = true;
        }
      }
    } finally {
      if (page) { try { await page.close(); } catch {} }
    }
  };

  await Promise.all(Array.from({ length: activeLimit }, (_, i) => worker(i)));
  summary.stopped = stopped;
  const tag = category || "geral";
  if (stopped) {
    console.warn(`[scraper Amazon] ${tag}: conferência interrompida (CAPTCHA/erros seguidos) — ${summary.verified}/${summary.attempted} com preço confirmado`);
  } else {
    console.log(`[scraper Amazon] ${tag}: preço confirmado em ${summary.verified}/${summary.attempted} (${enriched} com nota/avaliações)`);
  }
  if (summary.unscoped > 0) {
    console.warn(`[scraper Amazon] ${tag}: ${summary.unscoped} produtos sem bloco de compra reconhecido — preço lido da página inteira (layout mudou?)`);
  }
  return summary;
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
    // A API de afiliados devolve a miniatura (`_tn`) — sobe pra original.
    img: upgradeShopeeImageUrl(node.imageUrl) || null,
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
// `errors` (opcional) é uma saída: recebe { source, label, error } de cada loja
// que falhou. Sem ele, uma loja fora do ar é indistinguível de "não tinha oferta
// hoje" — o retorno é [] nos dois casos. Quem monitora (scraping/admin.js) passa
// o array pra conseguir reportar a falha em vez de gravar sucesso com 0 produtos.
// `errors` e `stats` são out-params opcionais (arrays): o chamador passa e recebe,
// respectivamente, as falhas por loja e o resumo do que foi coletado/descartado —
// é o que permite ao admin dizer "a Amazon bloqueou" em vez de "0 produtos".
async function scrapeOfertas({ category, sources, limit = 200, errors, stats } = {}) {
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
      const data = await store.scrape({ category, limit, stats });
      console.log(`[scraper] ${store.label} / ${category || "geral"}: ${data.length} produtos em ${Date.now() - t0}ms`);
      return data;
    } catch (err) {
      console.error(`[scraper] ${store.label} / ${category || "geral"} falhou:`, err.message);
      if (Array.isArray(errors)) errors.push({ source: id, label: store.label, error: err.message });
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

// Delega pro urlGuard, que casa por sufixo de domínio. O critério antigo era
// `/amazon/.test(host)`, que aceitava qualquer host contendo o nome da loja —
// "amazon.evil.com" passava como Amazon.
const detectStore = urlGuard.detectStore;

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
  // Muro de CAPTCHA: a URL vira /captcha/wall e a página não tem nada do produto —
  // sem isso o retorno saía como sucesso, com nome "Seguridad — Mercado Libre".
  if (store === "Mercado Livre" && /\/captcha\/wall/i.test(page.url())) {
    return { blocked: true, captcha: true, reason: "Mercado Livre pediu verificação (CAPTCHA) — tente daqui a alguns minutos ou revise o cookie de afiliado." };
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
      // O muro de CAPTCHA às vezes vem sem trocar a URL — o título é "Seguridad".
      if (/seguridad|captcha|n[ãa]o sou um rob[ôo]|no soy un robot/i.test(hay) && !document.querySelector(".ui-pdp-title")) {
        return { blocked: true, captcha: true, reason: "Mercado Livre pediu verificação (CAPTCHA) — tente daqui a alguns minutos ou revise o cookie de afiliado." };
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
        // Se o botão não estava lá (landing renderizada por JS, forceInApp=true),
        // ficamos na landing: sem galeria da PDP, a foto sai do og:image — que é
        // a MINIATURA (~500px). O pickBestImage ainda sobe a resolução, mas o
        // aviso aqui é o que denuncia esse caminho no log de produção.
        if (/\/social\//i.test(page.url())) {
          console.warn(`[scraper ML] "Ir para o produto" não abriu a PDP — dados vindos da landing de afiliado (${page.url().slice(0, 120)})`);
        }
      }
      try { await page.waitForSelector(".ui-pdp-title, h1", { timeout: 5000 }); } catch {}
    } else if (store === "Amazon") {
      // Tela "Continuar comprando": clica no botão e segue pra PDP real.
      const pre = await detectBlockPage(page, store);
      if (pre.interstitial) await dismissAmazonInterstitial(page);
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

      // txt/attr: mesmos helpers do enriquecimento da Amazon — só TEXTO CRU daqui;
      // quem interpreta (nota, nº de avaliações, vendidos) são as funções puras no Node.
      const txt = (s) => document.querySelector(s)?.textContent?.replace(/\s+/g, " ").trim() || null;
      const attr = (s, a) => document.querySelector(s)?.getAttribute(a) || null;

      let name = null, price = null, originalPrice = null, discount = null, img = null, sold = null;
      let ratingTxt = null, reviewTxt = null;

      if (store === "Mercado Livre") {
        const titleEl = document.querySelector("h1.ui-pdp-title, .ui-pdp-title");
        name = titleEl?.textContent?.trim() || ogTitle;
        // A PDP tem carrossel de recomendações e "outras opções de compra", cada um
        // com SEU preço riscado e SEU "% OFF". Tudo aqui é lido só dentro da caixa de
        // preço do produto principal — buscar no documento inteiro fazia o preço
        // original vir de outro produto (ex: 194,20 "de" 499,99 com rótulo de 19%).
        const priceBox = document.querySelector(".ui-pdp-price__main-container")
                      || document.querySelector("#price_container")
                      || document.querySelector(".ui-pdp-container__row--price")
                      || document.querySelector(".ui-pdp-price");

        const moneyIn = (root, sel) => {
          if (!root) return null;
          const frac = root.querySelector(`${sel} .andes-money-amount__fraction`);
          if (!frac) return null;
          const cents = root.querySelector(`${sel} .andes-money-amount__cents`);
          const f = frac.textContent.trim().replace(/\./g, "");
          const c = cents ? cents.textContent.trim() : "00";
          const v = parseFloat(`${f}.${c}`);
          return isNaN(v) ? null : v;
        };

        // Preço atual: primeiro andes-money-amount NÃO marcado como previous.
        price = moneyIn(priceBox, ".andes-money-amount:not(.andes-money-amount--previous)");
        // Sem caixa de preço, os dados estruturados são mais confiáveis que varrer a página.
        if (price == null) {
          const metaPrice = meta('meta[itemprop="price"]');
          if (metaPrice) {
            const v = parseFloat(String(metaPrice).replace(",", "."));
            if (!isNaN(v)) price = v;
          }
        }
        if (price == null) {
          for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
            try {
              const json = JSON.parse(s.textContent);
              const offers = [].concat(json.offers || json["@graph"]?.flatMap(g => g.offers || []) || []);
              const v = parseFloat(offers.find(o => o && o.price != null)?.price);
              if (!isNaN(v)) { price = v; break; }
            } catch { /* JSON-LD malformado — segue pro próximo */ }
          }
        }
        if (price == null) price = moneyIn(document, ".andes-money-amount:not(.andes-money-amount--previous)");

        // Promoção só existe se o preço riscado / o "% OFF" estiverem DENTRO da caixa.
        originalPrice = moneyIn(priceBox, ".andes-money-amount--previous");
        const discEl = priceBox?.querySelector(".andes-money-amount__discount");
        if (discEl) {
          const m = discEl.textContent.match(/(\d+)%/);
          if (m) discount = parseInt(m[1], 10);
        }
        // Ordem importa. O `data-zoom` da galeria é a foto grande do produto
        // principal — é a melhor. Depois vem o og:image, que a página garante ser
        // do produto principal. O `src` do elemento fica por ÚLTIMO porque
        // ".ui-pdp-gallery__figure img" também casa a tira de miniaturas da
        // lateral, cujo src é um quadradinho de 70×70 (e nem sempre do mesmo
        // produto). Tamanho quem resolve é o upgradeMLImageUrl; aqui a briga é
        // por pegar a foto CERTA.
        const imgEl = document.querySelector(".ui-pdp-gallery__figure img, figure.ui-pdp-gallery__figure img, .ui-pdp-image");
        img = imgEl?.getAttribute("data-zoom") || ogImage || imgEl?.getAttribute("src");
        // Best-effort: não há seletor confirmado pra "vendidos" na PDP — tenta achar
        // o texto em qualquer lugar da página (ex. "+500 vendidos", "2 mil vendidos").
        // Devolve o TEXTO cru; quem normaliza é o normalizeSoldText lá no Node.
        const soldMatch = (document.body?.innerText || "").match(/\+?\s*[\d.,]+\s*(?:mil\s*|mi\s*)?vendid[oa]s?/i);
        if (soldMatch) sold = soldMatch[0];
        // Nota + nº de avaliações: o bloco de reviews fica logo abaixo do título.
        // O texto de acessibilidade ("Classificação 4.8 de 5 estrelas") é o mais estável.
        ratingTxt = txt(".ui-pdp-header__info .andes-visually-hidden")
                 || txt(".ui-pdp-review__rating")
                 || txt('[data-testid="rating"]')
                 || txt(".ui-pdp-reviews__rating__summary__average");
        reviewTxt = txt(".ui-pdp-review__amount")
                 || txt(".ui-pdp-review__label")
                 || txt(".ui-pdp-reviews__rating__summary__label");
      } else if (store === "Amazon") {
        const titleEl = document.querySelector("#productTitle, h1#title span, h1#title");
        name = titleEl?.textContent?.trim() || ogTitle;
        // Preço NÃO sai daqui: vem de readAmazonPdpPricing, num evaluate à parte,
        // escopado no bloco de compra (ver a chamada logo abaixo deste evaluate).
        const imgEl = document.querySelector("#landingImage, #imgBlkFront, #main-image");
        img = imgEl?.getAttribute("src") || imgEl?.getAttribute("data-old-hires") || ogImage;
        // Mesmos seletores do enriquecimento em massa (enrichAmazonProducts).
        ratingTxt = attr("#acrPopover", "title")
                 || txt('span[data-hook="rating-out-of-text"]')
                 || txt("#acrPopover .a-icon-alt")
                 || txt("i.a-icon-star .a-icon-alt");
        reviewTxt = txt("#acrCustomerReviewText");
        // A Amazon não tem "vendidos" — usa prova social de compras recentes.
        sold = txt("#social-proofing-faceout-title-tk_bought")
            || txt("#socialProofingAsinFaceout_feature_div .social-proofing-faceout-title-text")
            || txt(".social-proofing-faceout-title-text");
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

      return { name, price, originalPrice, discount, img, sold, ratingTxt, reviewTxt };
    }, store);

    // Shopee: a PDP é SPA vazia pra bot — sem nome via DOM/OG, usa o slug da URL.
    let name = data.name || null;
    if (!name && store === "Shopee") name = slugNameFromUrl(finalUrl);

    // Amazon fala em "compras no mês passado" — parseAmazonSold traduz pro formato
    // do ML ("+2 mil vendidos"); nas outras lojas o texto já vem nesse formato.
    const sold = store === "Amazon" ? parseAmazonSold(data.sold) : normalizeSoldText(data.sold);

    // Preço/original/desconto só saem daqui se fecharem entre si; produto fora de
    // promoção sai com original e desconto nulos (hasPromo=false), sem inventar nada.
    // Na Amazon a leitura é escopada no bloco de compra (readAmazonPdpPricing), num
    // evaluate próprio — é O MESMO caminho usado pela conferência em massa da vitrine.
    let pricing;
    let priceSource = null;
    if (store === "Amazon") {
      const parsed = parseAmazonPdpPricing(await page.evaluate(readAmazonPdpPricing));
      priceSource = parsed.priceSource;
      pricing = { price: parsed.price, originalPrice: parsed.originalPrice, discount: parsed.discount };
      if (priceSource === "pdp-unscoped") {
        console.warn(`[scraper Amazon] bloco de compra não encontrado em ${finalUrl.slice(0, 120)} — preço lido da página inteira (layout mudou?)`);
      }
    } else {
      pricing = reconcilePricing({ price: data.price, originalPrice: data.originalPrice, discount: data.discount });
    }

    // Shopee e lojas genéricas caem no og:image, que costuma ser miniatura —
    // upgradeImageUrl decide a regra pelo domínio da imagem. Aqui (link único,
    // 1 produto por chamada) dá pra pagar 2 requisições de 64 KB e CONFERIR que
    // a versão em alta existe mesmo, em vez de confiar na reescrita da URL.
    const upgradedImg = store === "Amazon" ? upgradeAmazonImageUrl(data.img)
                      : store === "Mercado Livre" ? upgradeMLImageUrl(data.img)
                      : (upgradeImageUrl(data.img) || null);
    const img = await pickBestImage(data.img || null, upgradedImg);

    return {
      name: name || null,
      link: cleanUrl,
      finalUrl,
      price: pricing.price,
      originalPrice: pricing.originalPrice,
      discount: pricing.discount,
      hasPromo: pricing.originalPrice != null || pricing.discount != null,
      sold,
      rating: parseRatingText(data.ratingTxt),
      reviewsCount: parseReviewsCount(data.reviewTxt),
      img: img || null,
      store: store || null,
      // Só na Amazon: o preço veio conferido na página do produto (e de qual bloco).
      ...(store === "Amazon" ? { priceVerified: pricing.price != null, priceSource } : {}),
      scrapedAt: new Date().toISOString(),
    };
  } finally {
    await browser.close();
  }
}

// Normaliza o texto de vendas colhido de UMA página de produto.
// "+1.000 vendidos" / "2 mil vendidos" / "Novo | +5mil vendidos" → texto limpo,
// PRESERVANDO o "+" e o "mil": é assim que a loja escreve e é assim que vai pro
// grupo (formatVendas em scheduler.js repassa a string inteira). Converter pra
// número aqui era o que fazia o "+1000 vendidos" virar "1000 vendidos" na mensagem.
// Pura → testável.
function normalizeSoldText(raw) {
  if (raw == null) return null;
  if (typeof raw === "number") {
    return Number.isFinite(raw) && raw > 0 ? `${raw} vendidos` : null;
  }
  const s = String(raw).replace(/\s+/g, " ").trim();
  if (!s) return null;
  // Pega só o pedaço "…vendidos", descartando o que vier grudado antes ("Novo | ").
  const m = s.match(/\+?\s*[\d.,]+\s*(?:mil|mi)?\s*vendid[oa]s?/i);
  if (!m) return null;
  const out = m[0].replace(/^\+\s*/, "+").replace(/\s+/g, " ").trim();
  return /[\d]/.test(out) ? out : null;
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
    hasPromo: mapped.originalPrice != null || mapped.discount != null,
    // A Shopee manda contagem exata — vai como soldCount pro formatVendas compactar
    // ("1,2 mil vendidos"), igual aos produtos de catálogo da loja.
    soldCount: mapped.soldCount || null,
    rating: mapped.rating ?? null,
    reviewsCount: null, // a API de afiliados não expõe a contagem de avaliações
    img: mapped.img,
    store: "Shopee",
    scrapedAt: new Date().toISOString(),
  };
}

async function scrapeSingleProduct(url, { userId } = {}) {
  if (!url || typeof url !== "string" || !url.trim()) {
    throw new Error("URL inválida");
  }
  // Valida ANTES de abrir o navegador: só http(s), só domínio de loja conhecida,
  // e o host tem que resolver pra IP público. Sem isso o Puppeteer navegaria pra
  // qualquer endereço passado pelo usuário, inclusive interno (ver urlGuard.js).
  const { url: cleanUrl, store } = await urlGuard.assertStoreUrl(url);

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

module.exports = { scrapeOfertas, scrapeML, scrapeAmazon, scrapeShopee, scrapeSingleProduct, detectStore, upgradeAmazonImageUrl, upgradeMLImageUrl, upgradeShopeeImageUrl, upgradeImageUrl, applyFilters, buildAmazonDealsUrl, normalizeSource, shopeeNodeToProduct, amzBackoffMs, slugNameFromUrl, extractShopeeIds, parseMLReviewCompacted, mergeNewProducts, parseAmazonSold, parseRatingText, parseReviewsCount, reconcilePricing, normalizeSoldText,
  parseBrlPrice, parseDiscountLabel, parseAmazonPdpPricing, selectVerifiedAmazonProducts, CATEGORIES, STORES,
  // Reusados por ml-hub.js (navegar logado em páginas do ML)
  launchAmazonBrowser, applyAmazonStealth, parseMLCookies, autoScroll, detectBlockPage, UA };
