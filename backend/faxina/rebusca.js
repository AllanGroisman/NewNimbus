// Re-busca do catálogo (aba Admin › Faxina): visita cada produto de novo na loja,
// atualiza o que mudou (preço, foto, nome) e apaga o que a loja diz que sumiu.
//
// Não usa o scrapeSingleProduct (scraper.js) de propósito: ele cai no PRÓPRIO
// catálogo quando a loja não responde (o produto "se confirmaria sozinho") e abre
// um Chrome por produto como plano B — numa VPS de 1 vCPU, com 13 mil produtos,
// isso não termina. Aqui cada loja vai pelo caminho mais leve que já existe:
//   Shopee — API de afiliados com a conta do sistema (sem navegador);
//   ML     — landing de afiliado gerada com a conta do sistema e lida por HTTP;
//   Amazon — o conferidor de preço do scraping (enrichAmazonProducts), um Chrome
//            só pra rodada inteira, uma aba.
//
// A regra que manda em tudo: na dúvida, NÃO apaga. CAPTCHA, login, rede, resposta
// estranha — tudo isso vira "pulado". E mesmo o "sumiu" passa por um disjuntor por
// loja: se sumir gente demais de uma loja só, o mais provável é a loja ter mudado
// o site, não metade do catálogo ter saído de venda — nada daquela loja é apagado.

const DISJUNTOR_MIN_CHECADOS = 20;
const DISJUNTOR_MAX_FRACAO = 0.4;
const BLOQUEIOS_SEGUIDOS_MAX = 5;
const PAGINA = 50;

const LOJAS = { "Mercado Livre": "ml", "Amazon": "amazon", "Shopee": "shopee" };

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Classificação por loja ────────────────────────────────────────────────
// Cada checagem devolve { estado, produto?, motivo? }, estado ∈
//   ok      — a loja confirmou: `produto` traz os campos a gravar;
//   sumiu   — a loja respondeu que o produto não existe / não está à venda;
//   pulado  — não deu pra saber (passageiro), fica como está;
//   parar   — a loja inteira não vai responder nesta rodada (sem conta, cookie
//             vencido): para de visitar essa loja.

async function checarShopee(row, deps) {
  const ids = deps.extractShopeeIds(row.link);
  if (!ids) return { estado: "pulado", motivo: "link da Shopee sem ids" };
  const r = await deps.consultarShopeeItem(ids.itemId, ids.shopId);
  if (!r.ok) {
    if (/não configurada/i.test(r.reason || "")) return { estado: "parar", motivo: r.reason };
    return { estado: "pulado", motivo: r.reason };
  }
  if (!r.node) return { estado: "sumiu", motivo: "a Shopee não tem mais o item no programa de afiliados" };
  const p = deps.shopeeNodeToProduct(r.node, null);
  if (!p?.name || p.price == null) return { estado: "pulado", motivo: "item da Shopee sem nome ou preço" };
  return {
    estado: "ok",
    produto: {
      name: p.name, img: p.img, price: p.price,
      originalPrice: p.originalPrice ?? null, discount: p.discount ?? null,
      rating: p.rating ?? null, soldCount: p.soldCount ?? null,
    },
  };
}

async function checarML(row, deps) {
  const link = await deps.criarLinkAfiliadoMLSistema(row.link);
  if (!link.shortUrl) {
    const K = deps.ML_LINK_KIND;
    if (link.kind === K.SEM_CONFIG || link.kind === K.COOKIE) return { estado: "parar", motivo: link.reason };
    // Testado ao vivo (31/10/2026): produto que não existe mais volta como link
    // recusado — o produto de catálogo já tinha sido aceito antes. Erro genérico
    // (HTTP, rede) não diz nada.
    if (link.kind === K.LINK_RECUSADO) return { estado: "sumiu", motivo: "o ML não aceita mais o produto no programa de afiliados" };
    return { estado: "pulado", motivo: link.reason };
  }
  let lido;
  try {
    lido = await deps.fetchSocialLanding(link.shortUrl);
  } catch (err) {
    return { estado: "pulado", motivo: `rede: ${err.message}` };
  }
  if (!lido.ok) {
    if (lido.kind === "captcha" || lido.kind === "login") return { estado: "pulado", bloqueio: true, motivo: lido.reason };
    return { estado: "sumiu", motivo: lido.reason };
  }
  const p = lido.product;
  // A landing mostra UM produto em destaque. Se não é o desta linha (o ML trocou
  // por um parecido), não serve nem pra atualizar nem pra apagar.
  // Compara pelo LINK do produto da landing, na mesma numeração: o `mlItemId` do
  // card é o do anúncio mesmo quando a linha é de catálogo (/p/MLB…).
  const esperado = deps.mlItemIdFromUrl(row.link);
  const veio = deps.mlItemIdFromUrl(p.link);
  if (esperado && veio && deps.mlUrlSpace(row.link) === deps.mlUrlSpace(p.link) && esperado !== veio) {
    return { estado: "pulado", motivo: `a landing trouxe outro produto (${veio})` };
  }
  return {
    estado: "ok",
    produto: {
      name: p.name, img: p.img, price: p.price,
      originalPrice: p.originalPrice ?? null, discount: p.discount ?? null,
      rating: p.rating ?? null, sold: p.sold ?? null,
    },
  };
}

// A Amazon vai em lote pelo conferidor do scraping, que marca cada item:
// `priceVerified` (preço lido) ou `_semOferta` (a página abriu sem oferta). O que
// não tem nenhuma das duas marcas foi CAPTCHA, timeout ou ficou na fila quando a
// conferência parou — pulado.
async function checarAmazonLote(rows, deps, ctx) {
  const itens = rows.map(r => ({ key: r.key, link: r.link, price: r.price }));
  if (!ctx.amazonBrowser) ctx.amazonBrowser = await deps.launchAmazonBrowser();
  const resumo = await deps.enrichAmazonProducts(itens, ctx.amazonBrowser, "faxina", { concurrency: 1 });
  const out = itens.map(p => {
    if (p.priceVerified) {
      return {
        key: p.key, estado: "ok",
        produto: { price: p.price, originalPrice: p.originalPrice ?? null, discount: p.discount ?? null, rating: p.rating ?? null, sold: p.sold ?? null },
      };
    }
    // `pdp-unscoped`: há preço na página mas fora dos blocos conhecidos — é layout
    // novo, não produto parado.
    if (p._semOferta && p._semOferta !== "pdp-unscoped") return { key: p.key, estado: "sumiu", motivo: "a Amazon não está vendendo (indisponível ou sem oferta)" };
    return { key: p.key, estado: "pulado", bloqueio: !!p._attempts, motivo: "não deu pra conferir (CAPTCHA ou página não carregou)" };
  });
  return { out, parou: !!resumo?.stopped };
}

// ── Disjuntor ─────────────────────────────────────────────────────────────
// Segura os "sumiu" de cada loja e só apaga quando a proporção é crível. Abaixo de
// DISJUNTOR_MIN_CHECADOS não há base pra julgar, então acumula; no fim da rodada,
// com pouca amostra, poucos sumidos (< 5) passam e muitos ficam.
function novoDisjuntor() {
  const lojas = {};
  const da = (loja) => (lojas[loja] ||= { checados: 0, sumiram: 0, pendentes: [], aberto: null });
  return {
    contar(loja, estado, key) {
      const l = da(loja);
      if (estado === "pulado" || estado === "parar") return;
      l.checados++;
      if (estado === "sumiu") { l.sumiram++; l.pendentes.push(key); }
    },
    // Devolve as keys que podem ser apagadas agora; abre o disjuntor da loja
    // quando a proporção passa do teto.
    liberar(loja, { fim = false } = {}) {
      const l = da(loja);
      if (l.aberto || !l.pendentes.length) return [];
      const fracao = l.checados ? l.sumiram / l.checados : 0;
      const julgavel = l.checados >= DISJUNTOR_MIN_CHECADOS;
      if (julgavel && fracao > DISJUNTOR_MAX_FRACAO) {
        l.aberto = `${Math.round(fracao * 100)}% dos produtos conferidos aparecem como fora de venda — parece mudança no site da loja, nada dela foi apagado.`;
        l.pendentes = [];
        return [];
      }
      if (!julgavel && !(fim && (fracao <= DISJUNTOR_MAX_FRACAO || l.sumiram < 5))) return [];
      const keys = l.pendentes;
      l.pendentes = [];
      return keys;
    },
    aberto(loja) { return da(loja).aberto; },
    lojas,
  };
}

// ── A rodada ──────────────────────────────────────────────────────────────

function depsReais() {
  const scraper = require("../scraping/scraper");
  const affiliate = require("../scraping/affiliate");
  const mlSocial = require("../scraping/ml-social");
  const { mlItemIdFromUrl, mlUrlSpace } = require("../catalog/product-key");
  return {
    catalog: require("../catalog"),
    extractShopeeIds: scraper.extractShopeeIds,
    shopeeNodeToProduct: scraper.shopeeNodeToProduct,
    consultarShopeeItem: affiliate.consultarShopeeItem,
    criarLinkAfiliadoMLSistema: affiliate.criarLinkAfiliadoMLSistema,
    ML_LINK_KIND: affiliate.ML_LINK_KIND,
    fetchSocialLanding: mlSocial.fetchSocialLanding,
    mlItemIdFromUrl,
    mlUrlSpace,
    launchAmazonBrowser: scraper.launchAmazonBrowser,
    enrichAmazonProducts: scraper.enrichAmazonProducts,
    sleep,
  };
}

// `ctl`: { deveParar(), aguardarVez(), progresso(p) } — quem chama (faxina/index.js)
// decide cancelamento e se a vez é do scraping do admin.
async function rodar({ pausaMs = 2000, ctl = {}, deps = depsReais() } = {}) {
  const { catalog } = deps;
  const deveParar = ctl.deveParar || (() => false);
  const ate = new Date();
  const total = await catalog.contarParaRebusca(ate);
  const prog = {
    total, done: 0, atualizados: 0, apagados: 0, pulados: 0, current: null,
    porLoja: {}, lojasParadas: {},
  };
  const porLoja = (loja) => (prog.porLoja[loja] ||= { atualizados: 0, apagados: 0, pulados: 0 });
  const disjuntor = novoDisjuntor();
  const seguidos = {};
  const ctx = { amazonBrowser: null };
  const avisar = () => ctl.progresso && ctl.progresso(prog);

  const registrar = async (loja, key, r) => {
    prog.done++;
    disjuntor.contar(loja, r.estado, key);
    if (r.estado === "ok") {
      await catalog.atualizarDaRebusca(key, r.produto);
      prog.atualizados++; porLoja(loja).atualizados++;
    } else if (r.estado !== "sumiu") {
      prog.pulados++; porLoja(loja).pulados++;
    }
    // Bloqueio seguido (CAPTCHA, login) numa loja: insistir só piora.
    seguidos[loja] = r.bloqueio ? (seguidos[loja] || 0) + 1 : 0;
    if (r.estado === "parar") prog.lojasParadas[loja] = r.motivo;
    else if (seguidos[loja] >= BLOQUEIOS_SEGUIDOS_MAX) {
      prog.lojasParadas[loja] = `${BLOQUEIOS_SEGUIDOS_MAX} bloqueios seguidos (${r.motivo}) — tente mais tarde.`;
    }
  };

  const apagarLiberados = async (loja, opts) => {
    const keys = disjuntor.liberar(loja, opts);
    if (disjuntor.aberto(loja)) prog.lojasParadas[loja] = disjuntor.aberto(loja);
    if (!keys.length) return;
    const n = await catalog.apagarPorKeys(keys);
    prog.apagados += n; porLoja(loja).apagados += n;
  };

  let cursor = null;
  let cancelado = false;
  try {
    while (!cancelado) {
      const pagina = await catalog.listarParaRebusca({ ate, depois: cursor, limite: PAGINA });
      if (!pagina.length) break;
      cursor = pagina[pagina.length - 1];

      const amazon = [];
      for (const row of pagina) {
        if (deveParar()) { cancelado = true; break; }
        const loja = row.store;
        if (!LOJAS[loja] || prog.lojasParadas[loja]) {
          // Loja desconhecida ou parada nesta rodada: conta como visto, sem mexer.
          prog.done++; prog.pulados++; porLoja(loja || "?").pulados++;
          continue;
        }
        if (loja === "Amazon") { amazon.push(row); continue; }
        if (ctl.aguardarVez) await ctl.aguardarVez();
        prog.current = row.name || row.link;
        avisar();
        let r;
        try {
          r = loja === "Shopee" ? await checarShopee(row, deps) : await checarML(row, deps);
        } catch (err) {
          r = { estado: "pulado", motivo: err.message };
        }
        await registrar(loja, row.key, r);
        await deps.sleep(pausaMs);
      }

      if (amazon.length && !cancelado && !prog.lojasParadas.Amazon) {
        if (ctl.aguardarVez) await ctl.aguardarVez();
        prog.current = `Amazon: ${amazon.length} produtos`;
        avisar();
        try {
          const { out, parou } = await checarAmazonLote(amazon, deps, ctx);
          for (const r of out) await registrar("Amazon", r.key, r);
          if (parou) prog.lojasParadas.Amazon = "a conferência da Amazon parou por CAPTCHA/erros seguidos — tente mais tarde.";
        } catch (err) {
          for (const row of amazon) await registrar("Amazon", row.key, { estado: "pulado", motivo: err.message });
          prog.lojasParadas.Amazon = `não deu pra abrir o navegador: ${err.message}`;
        }
      } else if (amazon.length) {
        for (const row of amazon) { prog.done++; prog.pulados++; porLoja("Amazon").pulados++; }
      }

      for (const loja of Object.keys(LOJAS)) await apagarLiberados(loja);
      avisar();
    }
    if (!cancelado) for (const loja of Object.keys(LOJAS)) await apagarLiberados(loja, { fim: true });
  } finally {
    if (ctx.amazonBrowser) { try { await ctx.amazonBrowser.close(); } catch {} }
  }

  prog.current = null;
  avisar();
  return { ...prog, cancelado };
}

module.exports = {
  rodar,
  checarShopee,
  checarML,
  checarAmazonLote,
  novoDisjuntor,
  DISJUNTOR_MIN_CHECADOS,
  DISJUNTOR_MAX_FRACAO,
  BLOQUEIOS_SEGUIDOS_MAX,
};
