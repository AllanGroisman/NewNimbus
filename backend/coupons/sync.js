// A rodada de cupons: puxa a lista do ML, raspa a vitrine de cada cupom e grava.
//
// Divisão de trabalho: `scraping/ml-cupons.js` sabe navegar e ler a página e não
// conhece banco; `coupons/pg.js` sabe gravar e não conhece navegador; este arquivo
// costura os dois e guarda o status da rodada — que é o que a tela do admin lê
// enquanto ela roda.
//
// A rodada demora minutos (uma página por cupom), então ela roda SOLTA: a rota do
// admin dispara e responde na hora, e o front acompanha pelo status. Segurar a
// conexão por 20 minutos é o caminho mais curto pro timeout do proxy.
const appConfig = require("../config");
const catalog = require("../catalog");
const coupons = require("./pg");
const mlCupons = require("../scraping/ml-cupons");
const { productKey } = require("../catalog/product-key");

const CONFIG_KEY = "ml-cupons-config";
const STATUS_KEY = "ml-cupons-status";

const DEFAULT_CONFIG = {
  // Chaves de categoria do ML (ce_vertical, tb_vertical…). Vazio = todos os cupons
  // da conta, que é muita coisa — por isso o limite abaixo existe.
  groupings: [],
  limitPerGrouping: 60,
  withProducts: true,
  maxProductsPerCoupon: 100,
  // Cupom de UMA loja é descartado já na leitura da lista: ele vale só pros
  // produtos daquele vendedor (a fila do repasse não usa) e é o mais caro da
  // rodada — é AUTOMATIC, então sempre ativado e sempre com vitrine pra abrir.
  // Desmarcar traz eles de volta, e a rodada fica bem mais longa.
  skipStoreCoupons: true,
};

// O override do POST /run não passa pelo writeConfig: o body chega cru. Um
// "false" em texto é o erro clássico — `!!"false"` é true.
function booleano(v, padrao) {
  if (v === undefined || v === null || v === "") return padrao;
  if (typeof v === "string") return !/^(false|0|nao|não|off)$/i.test(v.trim());
  return !!v;
}

let _status = {
  running: false,
  startedAt: null,
  progress: null,
  lastRun: null,
  lastDuration: null,
  lastResult: null,
  lastError: null,
};

let _promise = null;

// A busca de UMA campanha (o "buscar e adicionar" do teste de palavra). Estado
// separado do da rodada porque são coisas diferentes na tela, mas as duas disputam
// a mesma conta do ML — por isso uma recusa a outra.
let _import = {
  running: false,
  campaignId: null,
  startedAt: null,
  progress: null,
  result: null,
  error: null,
};

let _importPromise = null;

function loadPersistedStatus() {
  const saved = appConfig.get(STATUS_KEY);
  if (saved && typeof saved === "object") {
    _status.lastRun = saved.lastRun || null;
    _status.lastDuration = saved.lastDuration || null;
    _status.lastResult = saved.lastResult || null;
    _status.lastError = saved.lastError || null;
  }
}

function persistStatus() {
  appConfig.set(STATUS_KEY, {
    lastRun: _status.lastRun,
    lastDuration: _status.lastDuration,
    lastResult: _status.lastResult,
    lastError: _status.lastError,
  });
}

function readConfig() {
  const raw = appConfig.get(CONFIG_KEY);
  return raw && typeof raw === "object" ? { ...DEFAULT_CONFIG, ...raw } : { ...DEFAULT_CONFIG };
}

function writeConfig(cfg) {
  const merged = { ...readConfig(), ...cfg };
  merged.groupings = Array.isArray(merged.groupings)
    ? merged.groupings.map(g => String(g?.key ?? g)).filter(Boolean).slice(0, 20)
    : [];
  // Tetos com pé no chão: a conta tem milhares de cupons e cada vitrine é mais uma
  // página aberta com a MESMA sessão que o Hub usa.
  merged.limitPerGrouping = Math.min(600, Math.max(5, Number(merged.limitPerGrouping) || DEFAULT_CONFIG.limitPerGrouping));
  merged.maxProductsPerCoupon = Math.min(300, Math.max(10, Number(merged.maxProductsPerCoupon) || DEFAULT_CONFIG.maxProductsPerCoupon));
  merged.withProducts = !!merged.withProducts;
  merged.skipStoreCoupons = booleano(merged.skipStoreCoupons, DEFAULT_CONFIG.skipStoreCoupons);
  appConfig.set(CONFIG_KEY, merged);
  return merged;
}

function status() {
  return {
    config: readConfig(),
    ..._status,
    running: _status.running || mlCupons.isRunning(),
    // A rodada não pode começar com uma busca de campanha em andamento: é a mesma
    // conta do ML, e é a rota /run que lê isto pra recusar.
    importing: _import.running,
  };
}

// Grava o que a rodada colheu. Separado do scraping de propósito: dá pra testar a
// gravação com o JSON de um dump, sem abrir navegador.
//
// Os produtos da vitrine entram TAMBÉM no catálogo — são produtos de verdade do ML,
// e sem eles o vínculo apontaria pra uma chave que não existe em lugar nenhum.
async function persistRun(result) {
  const { novos, atualizados } = await coupons.upsertCoupons(result.cupons || []);

  let produtosNoCatalogo = 0;
  let vinculos = 0;
  for (const v of result.vitrines || []) {
    if (!v.ok) continue;
    const itens = (v.products || []).map(p => ({ ...p, key: productKey(p) }));
    if (itens.length) {
      const r = await catalog.upsertProducts(itens);
      produtosNoCatalogo += r.inserted + r.updated;
    }
    const r = await coupons.replaceCouponProducts(v.campaignId, itens.map(p => ({ productKey: p.key, productUrl: p.link })));
    vinculos += r.vinculados;
  }

  const carimbo = await coupons.syncCatalogCoupons();
  // Devolve aos cupons a palavra que já custou um teste no ML. Precisa rodar toda
  // rodada porque o cupom pode ter voltado zerado — depois do botão "apagar
  // todos", ou por ter vencido e reaparecido. A palavra em `ml_coupon_codes`
  // continua valendo; sem isto ela ficaria guardada e invisível.
  const palavras = await coupons.restampCodesFromChecks();
  // E o caminho inverso: palavra que perdeu a campanha num engasgo do ML volta a
  // apontar para o cupom que ainda carrega o carimbo dela.
  await coupons.recoverCodesFromCoupons();
  // Faxina: cupom vencido há mais de um mês não interessa a ninguém e os
  // vínculos dele vão junto (a FK é ON DELETE CASCADE). Sem isso a tabela de
  // vínculos só cresce — a rodada antiga já tinha deixado 1.122 linhas de 26
  // cupons, e a raspagem de verdade multiplica isso.
  const faxina = await coupons.pruneExpired(30);

  return {
    cupons: (result.cupons || []).length,
    novos,
    atualizados,
    cuponsComVitrine: result.cuponsComVitrine || 0,
    vinculos,
    produtosNoCatalogo,
    catalogoCarimbado: carimbo.carimbados,
    catalogoLimpo: carimbo.limpos,
    palavrasRecarimbadas: palavras.recarimbados,
    cuponsDeLojaIgnorados: result.ignoradosLoja || 0,
    cuponsVencidosRemovidos: faxina.removidos,
    avisos: result.avisos || [],
    cancelada: !!result.cancelada,
  };
}

// Roda uma vez. Devolve a promessa da rodada — quem chama pela rota do admin
// normalmente NÃO espera por ela (dispara e acompanha pelo status).
function runOnce(overrides = {}) {
  if (_promise) return _promise;

  const cfg = { ...readConfig(), ...overrides };
  const t0 = Date.now();
  _status.running = true;
  _status.startedAt = new Date().toISOString();
  _status.progress = null;
  _status.lastError = null;

  _promise = (async () => {
    try {
      const result = await mlCupons.runPull({
        groupings: cfg.groupings,
        limit: cfg.limitPerGrouping,
        withProducts: cfg.withProducts,
        maxProductsPerCoupon: cfg.maxProductsPerCoupon,
        skipStore: booleano(cfg.skipStoreCoupons, DEFAULT_CONFIG.skipStoreCoupons),
      }, {
        onProgress: (p) => { _status.progress = p; },
      });

      const resumo = await persistRun(result);
      _status.lastRun = result.at;
      _status.lastDuration = Date.now() - t0;
      _status.lastResult = { ...resumo, totalNoML: result.totalNoML, categoriasDoML: result.categoriasDoML };
      _status.lastError = resumo.avisos.length ? resumo.avisos.join(" ") : null;
      persistStatus();
      console.log(`[ml-cupons] rodada: ${resumo.cupons} cupons (${resumo.novos} novos), ${resumo.vinculos} vínculos, ${resumo.catalogoCarimbado} produtos carimbados, ${resumo.cuponsDeLojaIgnorados} de loja ignorados`);
      return _status.lastResult;
    } catch (err) {
      _status.lastRun = new Date().toISOString();
      _status.lastDuration = Date.now() - t0;
      _status.lastError = err.message;
      persistStatus();
      console.error("[ml-cupons] rodada falhou:", err.message);
      throw err;
    } finally {
      _status.running = false;
      _status.progress = null;
      _promise = null;
    }
  })();

  return _promise;
}

function cancel() {
  mlCupons.cancel();
  return { canceling: true };
}

// A vitrine de UM cupom, sob demanda (o botão "Sincronizar produtos" da linha).
async function syncOneCoupon(campaignId, { maxProducts = null } = {}) {
  const cupom = await coupons.getCoupon(campaignId);
  if (!cupom) throw new Error("Esse cupom não está no sistema — puxe os cupons primeiro.");

  const cfg = readConfig();
  const affiliate = require("../scraping/affiliate");
  const session = affiliate.getScraperMLSession();
  if (!session) throw new Error("Sem sessão do Mercado Livre do sistema — cole o cookie em Admin › Mercado Livre.");

  const res = await mlCupons.withCuponsPage(session.cookie, null);
  try {
    const r = await mlCupons.scrapeCouponProducts(res.browser, cupom, {
      maxProducts: maxProducts || cfg.maxProductsPerCoupon,
    });
    if (!r.ok) return { ok: false, reason: r.reason, produtos: 0 };

    const itens = (r.products || []).map(p => ({ ...p, key: productKey(p) }));
    if (itens.length) await catalog.upsertProducts(itens);
    const v = await coupons.replaceCouponProducts(campaignId, itens.map(p => ({ productKey: p.key, productUrl: p.link })));
    await coupons.syncCatalogCoupons();
    return { ok: true, produtos: itens.length, ...v };
  } finally {
    await res.browser.close().catch(() => {});
  }
}

// Traz para o sistema UMA campanha que ainda não está aqui — a que uma palavra
// testada apontou. É o outro lado do `checkWord`: ele descobre o id da campanha, e
// o `recordCodeCheck` não consegue fazer mais nada com ele porque só sabe CARIMBAR
// uma linha existente. Sem isto, a única saída era rodar a coleta inteira.
//
// Procura na lista de verdade em vez de montar a linha com o JSON da resposta
// porque digitar a palavra ATIVA o cupom na conta, e cupom ativado é o único que
// vem com `containerUrl` — sem ela não há vitrine para ler.
//
// Roda SOLTA, como a rodada: a varredura da lista pode passar de 90s, que é onde o
// nginx corta (deploy/nginx.conf) — a primeira versão disto era síncrona e morria
// no proxy com "não foi possível conectar", já com o Chrome trabalhando à toa.
async function importCampaign(campaignId, { withProducts = true, maxProducts = null, onProgress = null } = {}) {
  const id = String(campaignId || "").trim();
  if (!id) throw new Error("Sem campanha para buscar.");

  const affiliate = require("../scraping/affiliate");
  const session = affiliate.getScraperMLSession();
  if (!session) throw new Error("Sem sessão do Mercado Livre do sistema — cole o cookie em Admin › Mercado Livre.");

  const cfg = readConfig();
  const achado = await mlCupons.findCampaign(session.cookie, id, {
    withProducts,
    maxProducts: maxProducts || cfg.maxProductsPerCoupon,
    onProgress,
  });
  if (!achado.coupon) return { ok: false, reason: achado.reason };

  // A ordem é a da rodada (persistRun): cupom, palavra, produtos, carimbo. Fazer o
  // carimbo antes dos vínculos deixaria o catálogo apontando pra cupom sem produto.
  await coupons.upsertCoupons([achado.coupon], { origin: "code" });
  // Devolve a palavra à campanha: o `recordCodeCheck` tentou carimbar no momento do
  // teste e não achou linha nenhuma para carimbar.
  const palavras = await coupons.restampCodesFromChecks();
  await coupons.recoverCodesFromCoupons();

  let produtos = 0;
  let vinculos = 0;
  if (achado.products?.length) {
    const itens = achado.products.map(p => ({ ...p, key: productKey(p) }));
    await catalog.upsertProducts(itens);
    const v = await coupons.replaceCouponProducts(id, itens.map(p => ({ productKey: p.key, productUrl: p.link })));
    produtos = itens.length;
    vinculos = v.vinculados;
  }
  await coupons.syncCatalogCoupons();

  return {
    ok: true,
    coupon: await coupons.getCoupon(id),
    produtos,
    vinculos,
    palavrasRecarimbadas: palavras.recarimbados,
    avisoVitrine: achado.reasonVitrine || null,
  };
}

// Dispara a busca de uma campanha e devolve na hora. O desfecho fica no
// `importStatus()`, que é o que a tela lê enquanto acompanha — mesmo desenho do
// `runOnce`, e pelo mesmo motivo: quem espera por isso numa requisição bate no
// teto do proxy.
function importStatus() {
  return { ..._import };
}

async function startImport(campaignId, { withProducts = true } = {}) {
  const id = String(campaignId || "").trim();
  if (!id) throw new Error("Sem campanha para buscar.");

  // As recusas ficam aqui, ANTES de disparar: elas viram 400 com mensagem na tela.
  // Depois que a promessa larga não há mais para quem responder.
  //
  // Uma conta só: dois Chromes nela ao mesmo tempo dobram a chance de CAPTCHA, e o
  // CAPTCHA derruba o Hub junto. Mesmo motivo do DELETE /api/admin/ml-cupons.
  if (mlCupons.isRunning()) {
    throw new Error("Tem uma rodada de cupons rodando — espere ela terminar para buscar uma campanha.");
  }
  if (_import.running) {
    throw new Error(`Já estou buscando a campanha ${_import.campaignId} — espere essa terminar.`);
  }

  // Já está aqui: responde na hora, sem abrir Chrome nenhum.
  const existente = await coupons.getCoupon(id);
  if (existente) return { ok: true, already: true, coupon: existente, produtos: 0, vinculos: 0 };

  _import = {
    running: true,
    campaignId: id,
    startedAt: new Date().toISOString(),
    progress: null,
    result: null,
    error: null,
  };

  _importPromise = (async () => {
    try {
      const r = await importCampaign(id, {
        withProducts,
        onProgress: (p) => { _import.progress = p; },
      });
      _import.result = r;
      if (r.ok) {
        console.log(`[ml-cupons] campanha ${id} importada: ${r.produtos} produtos${r.avisoVitrine ? ` (vitrine: ${r.avisoVitrine})` : ""}`);
      } else {
        console.log(`[ml-cupons] campanha ${id} não veio: ${r.reason}`);
      }
    } catch (err) {
      // O erro não sobe: quem pediu já foi embora. Ele fica no status, que é onde
      // a tela procura.
      _import.error = err.message;
      console.error("[ml-cupons.importar]", err.message);
    } finally {
      _import.running = false;
      _import.progress = null;
      _importPromise = null;
    }
  })();

  return { started: true, ...importStatus() };
}

// Testa uma PALAVRA no campo "Inserir código do cupom" e guarda a resposta.
//
// `maxAgeHours` evita ir ao ML por algo testado há pouco: cada teste abre um
// Chrome com a conta do sistema, e a mesma palavra chega várias vezes pelo repasse.
async function checkWord(word, { source = "admin", maxAgeHours = 12, force = false } = {}) {
  const code = String(word || "").trim().toUpperCase().slice(0, 40);
  if (!code) throw new Error("Escreva a palavra do cupom.");

  if (!force) {
    const cache = await coupons.findCodeCheck(code, { maxAgeHours });
    if (cache) {
      return {
        word: code, verdict: cache.verdict, campaignId: cache.campaignId,
        message: cache.message, responseCode: cache.responseCode,
        cached: true, checkedAt: cache.checkedAt,
        coupon: cache.campaignId ? await coupons.getCoupon(cache.campaignId) : null,
      };
    }
  }

  const affiliate = require("../scraping/affiliate");
  const session = affiliate.getScraperMLSession();
  if (!session) throw new Error("Sem sessão do Mercado Livre do sistema — cole o cookie em Admin › Mercado Livre.");

  const r = await mlCupons.checkCouponWord(session.cookie, code);
  const linha = await coupons.recordCodeCheck({
    code, verdict: r.verdict, campaignId: r.campaignId || null,
    message: r.message || r.reason || null, responseCode: r.responseCode || null,
    source, raw: r.raw || {},
  });

  // O ML engasgou e não disse nada sobre a palavra. Antes de responder "não deu pra
  // saber", vale olhar o que já está aqui: se algum cupom carrega esse carimbo, a
  // campanha é conhecida — só não foi o ML que contou agora. `knownLocally` diz à
  // tela de onde veio, para ela não passar isso como resposta do ML.
  let campaignId = r.campaignId || linha?.campaignId || null;
  let knownLocally = false;
  if (!campaignId) {
    const daqui = await coupons.findCouponByCode(code);
    if (daqui) { campaignId = daqui.campaignId; knownLocally = true; }
  } else if (!r.campaignId) {
    knownLocally = true;
  }

  return {
    word: code, verdict: r.verdict, campaignId,
    message: r.message || null, responseCode: r.responseCode || null,
    reason: r.reason, cached: false, knownLocally,
    coupon: campaignId ? await coupons.getCoupon(campaignId) : null,
  };
}

module.exports = {
  runOnce,
  cancel,
  status,
  readConfig,
  writeConfig,
  persistRun,
  syncOneCoupon,
  importCampaign,
  startImport,
  importStatus,
  checkWord,
  loadPersistedStatus,
  CONFIG_KEY,
  STATUS_KEY,
  DEFAULT_CONFIG,
};
