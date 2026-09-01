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
// O dicionário `chave da categoria do ML → nome que aparece na aba` (ce_vertical →
// "Eletrônicos"). O cupom guarda só a chave (`ml_coupons.groupings`); o nome só o
// ML diz, e só na leitura da aba. Fica MESCLADO a cada rodada em vez de
// sobrescrito: uma rodada por categoria não lista as outras, e sobrescrever
// deixaria a tela do admin mostrando `tb_vertical` cru pro resto.
const GROUPINGS_KEY = "ml-cupons-groupings";

const DEFAULT_CONFIG = {
  // Chaves de categoria do ML (ce_vertical, tb_vertical…). Vazio = TODAS as
  // categorias, uma de cada vez (ver categoriasDaRodada) — e não uma passada só na
  // lista geral, que é o que era antes: a lista geral traz cupom de tudo, mas o ML
  // não diz a vertical de cada um, então tudo entrava sem categoria nenhuma.
  groupings: [],
  // Por CATEGORIA. Com ~10 verticais isso é ~1.000 cupons e ~40 páginas abertas na
  // conta do ML por rodada — a conta é a mesma do Hub, e é ela que paga o preço de
  // uma varredura grande demais.
  limitPerGrouping: 100,
  withProducts: true,
  maxProductsPerCoupon: 100,
  // Cupom de UMA loja é descartado já na leitura da lista: ele vale só pros
  // produtos daquele vendedor (a fila do repasse não usa) e é o mais caro da
  // rodada — é AUTOMATIC, então sempre ativado e sempre com vitrine pra abrir.
  // Desmarcar traz eles de volta, e a rodada fica bem mais longa.
  skipStoreCoupons: true,
  // Clicar em "Eu quero" nos cupons não ativados. É a única ESCRITA que a rodada
  // faz na conta do ML — e é o que faz a vitrine existir: sem ativar, o ML não dá
  // a URL dela e o cupom entra no sistema sem lista de produtos.
  //
  // O teto é por rodada e existe pela conta, não pelo tempo: dezenas de cliques
  // em sequência é o padrão que acorda o anti-robô, e a conta é a MESMA do Hub de
  // Afiliados — verificação aqui derruba o Hub junto.
  activateCoupons: true,
  maxActivationsPerRun: 20,
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
  // O passo a passo da rodada, pra tela do admin conseguir mostrar o que está
  // acontecendo em vez de uma linha que se sobrescreve. Vive só em memória e de
  // propósito: são centenas de linhas por rodada, o valor delas é enquanto a
  // rodada corre, e o que precisa sobreviver a um restart é o RESUMO — que
  // continua indo pro app_config no persistStatus().
  log: [],
  lastRun: null,
  lastDuration: null,
  lastResult: null,
  lastError: null,
};

// Teto do log. Uma rodada grande emite um evento por cupom, e guardar tudo é
// segurar megabytes na memória do processo da API pra mostrar 20 linhas na tela.
const MAX_LOG = 200;

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

// { chave: nome } do que já se viu em alguma rodada. Só leitura — quem escreve é
// o mergeGroupingLabels().
function readGroupingLabels() {
  const raw = appConfig.get(GROUPINGS_KEY);
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

// `grupos` é o `groupings` do parseLanding: [{ key, title, count, more }].
function mergeGroupingLabels(grupos) {
  if (!Array.isArray(grupos) || !grupos.length) return readGroupingLabels();
  const mapa = readGroupingLabels();
  let mudou = false;
  for (const g of grupos) {
    const chave = typeof g === "string" ? g : g?.key;
    const nome = typeof g === "string" ? null : g?.title;
    if (!chave || !nome || mapa[chave] === nome) continue;
    mapa[chave] = String(nome).slice(0, 80);
    mudou = true;
  }
  if (mudou) appConfig.set(GROUPINGS_KEY, mapa);
  return mapa;
}

// As chaves do dicionário que são CATEGORIA de verdade.
//
// O ML mistura filtro com categoria na mesma lista de `groupings`: junto de
// `ce_vertical` e `fa_vertical` vêm `price` ("Mais de R$100"), `percentage`
// ("Mais de 10%") e `recommended` ("Recomendados"). Varrer por esses três traria
// cupom repetido e carimbaria neles uma "categoria" que não existe — a coluna
// Categoria da tabela passaria a mostrar "Mais de 10%". O sufixo `_vertical` é o
// que o próprio ML usa para separar os dois tipos.
function verticaisConhecidas(labels = null) {
  return Object.keys(labels || readGroupingLabels()).filter(k => /_vertical$/.test(k)).sort();
}

// As categorias que ESTA rodada vai varrer, em ordem. `null` na lista quer dizer
// "a lista geral, sem filtro de categoria".
//
// Pura sobre a config e o dicionário — é aqui que mora a resposta para "puxe de
// tudo", e é por isso que ela é testável sem banco e sem Chrome.
//
// Uma passada POR VERTICAL em vez de uma passada geral porque a lista do ML não
// diz a que vertical cada cupom pertence: a categoria que o sistema grava é o
// filtro que a gente pediu na URL (ver parseFilterProps, scraping/ml-cupons.js).
// Sem isso "puxar de tudo" traz tudo sem categoria nenhuma, e a visão por
// categoria da tabela fica mostrando "—" para o cupom inteiro.
function categoriasDaRodada(cfg = {}, { procurar = null, labels = null } = {}) {
  // Buscar UMA campanha é outra pergunta: a lista geral já contém tudo, e varrer
  // dez verticais atrás dela seria dez vezes mais navegação com a conta do sistema
  // para achar o mesmo cupom. Ver o `procurar` do startLocalRun.
  if (procurar) return [null];

  const escolhidas = (cfg.groupings || []).map(g => g?.key ?? g).filter(Boolean);
  if (escolhidas.length) return escolhidas;

  const todas = verticaisConhecidas(labels);
  // Instalação que nunca leu a aba do ML não tem dicionário nenhum — e sem esse
  // fallback a primeira rodada da vida não varreria categoria alguma.
  return todas.length ? todas : [null];
}

// Como a rodada anuncia o que vai varrer. As duas rodadas (servidor e Chrome) já
// escreviam essa linha, cada uma do seu jeito e as duas dizendo "todas as
// categorias" sem dizer QUAIS — que era exatamente a informação que faltava para
// perceber que a config estava presa numa vertical só.
function textoDasCategorias(categorias, labels = null) {
  const mapa = labels || readGroupingLabels();
  if (!categorias.length || (categorias.length === 1 && !categorias[0])) return "a lista geral (sem categoria)";
  const nomes = categorias.map(k => mapa[k] || k);
  return `${categorias.length} categoria${categorias.length === 1 ? "" : "s"} (${nomes.join(", ")})`;
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
  merged.activateCoupons = booleano(merged.activateCoupons, DEFAULT_CONFIG.activateCoupons);
  // Zero é um valor legítimo ("ativar ligado, mas nenhum nesta rodada"), então o
  // `||` não serve de rede aqui — ele trocaria o 0 pelo padrão. Quem decide é o
  // Number.isFinite, porque `Number(undefined)` é NaN e NaN passa por `??`.
  const teto = Number(merged.maxActivationsPerRun);
  merged.maxActivationsPerRun = Number.isFinite(teto)
    ? Math.min(100, Math.max(0, Math.trunc(teto)))
    : DEFAULT_CONFIG.maxActivationsPerRun;
  appConfig.set(CONFIG_KEY, merged);
  return merged;
}

// O evento cru do scraping virando frase. Puro de propósito: é o que o teste
// consegue checar sem subir rodada nenhuma, e é a MESMA tradução que a tela
// mostrava antes numa linha só (AdminCupomML).
function textoDoProgresso(p) {
  if (!p || typeof p !== "object") return null;
  if (p.etapa === "cupons") {
    const onde = p.grouping ? `de ${p.grouping}` : "geral";
    const loja = p.ignoradosLoja ? ` (${p.ignoradosLoja} de loja ignorados)` : "";
    return `lendo a lista ${onde} — página ${p.pagina}/${p.de}, ${p.cupons} cupons${loja}`;
  }
  if (p.etapa === "abrindo") return "abrindo a aba de cupons do Mercado Livre";
  if (p.etapa === "ativando") return `ativando "${p.title || p.campaignId}"`;
  if (p.etapa === "vitrine") return `abrindo a vitrine de "${p.title || p.campaignId}"`;
  if (p.etapa === "vitrines") {
    // O `title` chega desde a mudança em ml-cupons.js; sem ele a frase ainda faz
    // sentido, só fica sem o nome do cupom.
    const qual = p.title ? ` · "${p.title}"${p.ok === false ? ` — ${p.reason || "vitrine não veio"}` : ""}` : "";
    return `vitrines: ${p.vitrines}/${p.cupons} cupons, ${p.produtos} produtos${qual}`;
  }
  return null;
}

// Anexa uma linha ao log da rodada. `dedup` descarta a repetição da MESMA frase:
// o crawler emite um evento por página e vários saem idênticos, e 40 linhas
// iguais escondem as que importam.
function logar(tipo, texto, { dedup = false } = {}) {
  if (!texto) return;
  const ultimo = _status.log[_status.log.length - 1];
  if (dedup && ultimo && ultimo.texto === texto) return;
  _status.log.push({ at: new Date().toISOString(), tipo, texto });
  if (_status.log.length > MAX_LOG) _status.log.splice(0, _status.log.length - MAX_LOG);
}

function status() {
  expirarLocalSeSumiu();
  return {
    config: readConfig(),
    groupingLabels: readGroupingLabels(),
    ..._status,
    running: _status.running || mlCupons.isRunning(),
    // A rodada não pode começar com uma busca de campanha em andamento: é a mesma
    // conta do ML, e é a rota /run que lê isto pra recusar.
    importing: _import.running,
    // Quem está tocando a rodada: o servidor (Puppeteer) ou o Chrome do admin.
    // A tela precisa saber para não oferecer "cancelar" de um laço que é dela.
    local: !!_local,
  };
}

// Grava o que a rodada colheu. Separado do scraping de propósito: dá pra testar a
// gravação com o JSON de um dump, sem abrir navegador.
//
// Os produtos da vitrine entram TAMBÉM no catálogo — são produtos de verdade do ML,
// e sem eles o vínculo apontaria pra uma chave que não existe em lugar nenhum.
async function persistRun(result) {
  const { novos, atualizados } = await coupons.upsertCoupons(result.cupons || []);

  // As amostras do card entram para TODO cupom, antes das vitrines.
  //
  // Vêm de graça no modelo que a rodada já leu, e são o ÚNICO vínculo possível
  // para o cupom não ativado — que não tem vitrine pra raspar sem ativar o cupom
  // na conta do sistema. Vão marcadas como `amostra`, então não se misturam com a
  // vitrine nem autorizam um "fora da vitrine" lá no quick-check.
  //
  // Ao contrário da vitrine, aqui NÃO se escreve no catálogo: o ML dá só o id, sem
  // nome nem preço, e um produto de catálogo sem nada disso é lixo que a fila do
  // repasse teria que aprender a ignorar. O vínculo aponta para a chave e espera o
  // scraping normal trazer o produto.
  let amostras = 0;
  for (const c of result.cupons || []) {
    if (!c?.campaignId || !(c.sampleItemIds || []).length) continue;
    const r = await coupons.replaceCouponSamples(c.campaignId, c.sampleItemIds);
    amostras += r.vinculados;
  }

  let produtosNoCatalogo = 0;
  let vinculos = 0;
  for (const v of result.vitrines || []) {
    if (!v.ok) continue;
    const itens = (v.products || []).map(p => ({ ...p, key: productKey(p) }));
    if (itens.length) {
      const r = await catalog.upsertProducts(itens);
      produtosNoCatalogo += r.inserted + r.updated;
    }
    // `parcial` = veio da landing de afiliado, que entrega uma PRÉVIA de 3-8
    // produtos, não a vitrine inteira. Gravar isso como vitrine autorizaria o
    // quick-check a dizer "este produto não está no cupom" olhando 5 de 50 —
    // o mesmo erro caro da amostra, por outra porta.
    const r = await coupons.replaceCouponProducts(
      v.campaignId,
      itens.map(p => ({ productKey: p.key, productUrl: p.link })),
      { origem: v.parcial ? "landing" : "vitrine" },
    );
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
    amostras,
    produtosNoCatalogo,
    catalogoCarimbado: carimbo.carimbados,
    catalogoLimpo: carimbo.limpos,
    palavrasRecarimbadas: palavras.recarimbados,
    cuponsDeLojaIgnorados: result.ignoradosLoja || 0,
    // Ativação CONFIRMADA pelo modelo do ML, não cliques dados: se o botão mudar,
    // este número vai a zero em vez de mentir.
    ativados: result.ativados || 0,
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
  _status.log = [];
  // A lista de categorias é resolvida AQUI e passada pronta: o `runPull` já sabe
  // varrer uma lista, e deixar a regra num lugar só é o que mantém a rodada do
  // servidor e a do Chrome varrendo exatamente as mesmas categorias.
  const categorias = categoriasDaRodada(cfg);
  logar("info", `começando: ${textoDasCategorias(categorias)}, até ${cfg.limitPerGrouping} cupons por categoria${cfg.withProducts ? ", com as vitrines" : ", sem abrir vitrine"}`);

  _promise = (async () => {
    try {
      const result = await mlCupons.runPull({
        groupings: categorias.filter(Boolean),
        limit: cfg.limitPerGrouping,
        withProducts: cfg.withProducts,
        maxProductsPerCoupon: cfg.maxProductsPerCoupon,
        skipStore: booleano(cfg.skipStoreCoupons, DEFAULT_CONFIG.skipStoreCoupons),
        activateCoupons: booleano(cfg.activateCoupons, DEFAULT_CONFIG.activateCoupons),
        maxActivations: Number.isFinite(Number(cfg.maxActivationsPerRun))
          ? Number(cfg.maxActivationsPerRun)
          : DEFAULT_CONFIG.maxActivationsPerRun,
      }, {
        onProgress: (p) => {
          _status.progress = p;
          logar("info", textoDoProgresso(p), { dedup: true });
        },
      });

      const resumo = await persistRun(result);
      _status.lastRun = result.at;
      _status.lastDuration = Date.now() - t0;
      _status.lastResult = { ...resumo, totalNoML: result.totalNoML, categoriasDoML: result.categoriasDoML };
      // O nome das categorias só passa por aqui: guarda antes que a próxima rodada
      // (que pode ler uma categoria só) apague o resto do lastResult.
      mergeGroupingLabels(result.categoriasDoML);
      _status.lastError = resumo.avisos.length ? resumo.avisos.join(" ") : null;
      logar("ok", `terminou em ${Math.round((Date.now() - t0) / 1000)}s: ${resumo.cupons} cupons (${resumo.novos} novos), ${resumo.ativados} ativados, ${resumo.vinculos} vínculos, ${resumo.catalogoCarimbado} produtos do catálogo carimbados`);
      for (const aviso of resumo.avisos) logar("aviso", aviso);
      persistStatus();
      console.log(`[ml-cupons] rodada: ${resumo.cupons} cupons (${resumo.novos} novos), ${resumo.ativados} ativados, ${resumo.vinculos} vínculos, ${resumo.catalogoCarimbado} produtos carimbados, ${resumo.cuponsDeLojaIgnorados} de loja ignorados`);
      return _status.lastResult;
    } catch (err) {
      _status.lastRun = new Date().toISOString();
      _status.lastDuration = Date.now() - t0;
      _status.lastError = err.message;
      logar("erro", `a rodada parou: ${err.message}`);
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
  // A rodada pela extensão não tem laço deste lado: quem percorre é a tela. Marcar
  // `encerrada` faz a `proximaPagina` devolver null, e ela para na próxima página.
  if (_local) { _local.encerrada = true; logar("aviso", "cancelamento pedido — a rodada no seu Chrome para na próxima página"); }
  // O cancelamento é cooperativo: a rodada só para no próximo ponto de checagem.
  // Sem esta linha o log fica mudo entre o clique e a parada, e parece travamento.
  logar("aviso", "cancelamento pedido — parando no próximo cupom");
  return { canceling: true };
}

// ────────────────────────────────────────────────────────────────────────
// A mesma rodada, no Chrome do admin (a extensão)
// ────────────────────────────────────────────────────────────────────────
//
// Por que existe: o ML responde CAPTCHA para navegador automatizado, e a sonda de
// 27/08 mostrou que não é o IP da VPS — é o Puppeteer subindo Chrome. Numa aba do
// Chrome do admin, com a sessão dele, a lista de cupons é só uma página.
//
// A divisão é a mesma do `gravarVitrineLocal`, que já existia: a extensão COLHE o
// modelo cru da página e manda pra cá; quem interpreta é o `parseFilterProps` — o
// mesmo que a rodada do servidor usa. E quem decide QUEM ativar é o `aAtivar`,
// aqui, nunca na extensão: o rótulo "Aplicar" repetido entre dois cupons diferentes
// é o erro que custa uma escrita irreversível na conta errada, e essa regra não
// pode viver em dois lugares.
//
// A regra de PARADA da varredura também mora aqui (limite, teto de páginas, páginas
// sem novidade): a extensão só abre a URL que este arquivo mandar e pede a próxima.
// É o que evita uma segunda varredura, com outros tetos, dentro da extensão.

let _local = null;

function localAtivo() { return !!_local; }

// Quanto tempo a rodada pela extensão pode ficar sem dar notícia antes de ser
// considerada perdida. Quem percorre as páginas é a TELA — se o admin fechar a aba
// no meio, ninguém chama o `fimLocalRun` e a rodada ficaria "rodando" para sempre,
// travando o /run e o "Apagar todos" até o processo reiniciar.
const LOCAL_SEM_NOTICIA_MS = 5 * 60 * 1000;

function tocarLocal() { if (_local) _local.ultimoContato = Date.now(); }

function expirarLocalSeSumiu() {
  if (!_local) return;
  if (Date.now() - (_local.ultimoContato || _local.t0) < LOCAL_SEM_NOTICIA_MS) return;
  logar("aviso", "a rodada no seu Chrome parou de dar notícia — encerrando o que ficou pendurado");
  fimLocalRun({ cancelada: true });
}

// A URL da próxima página a abrir, ou null quando a varredura acabou. Puro sobre
// o estado da rodada — é o coração do laço, e é ele que o teste cobre.
function proximaPagina() {
  if (!_local || _local.encerrada) return null;
  const cat = _local.categorias[_local.iCategoria];
  if (cat === undefined) return null;
  return {
    grouping: cat,
    pagina: _local.pagina,
    url: mlCupons.filterUrl({ grouping: cat, page: _local.pagina }),
  };
}

// Passa para a próxima categoria (ou encerra). O contador de páginas sem novidade
// é por categoria, como no crawlFilter.
function proximaCategoria(motivo) {
  if (motivo) _local.motivos.push(motivo);
  _local.iCategoria++;
  _local.pagina = 1;
  _local.semNovidade = 0;
  _local.daCategoria = 0;
}

// Começa a rodada pela extensão. Recusa junto com a do servidor: as duas mexem na
// MESMA conta do ML, e duas varreduras simultâneas é o padrão que acorda o
// anti-robô — o mesmo motivo do 409 do /run.
// `procurar` transforma a rodada numa BUSCA: ela para na página em que aquela
// campanha aparecer, em vez de ir até o limite. É o "trazer campanha" do teste de
// palavra — sem isso, achar um cupom que está na página 2 custaria as 40 páginas
// do teto, cada uma delas uma navegação com a conta do sistema.
function startLocalRun(overrides = {}) {
  expirarLocalSeSumiu();
  if (_status.running || mlCupons.isRunning()) throw new Error("Já tem uma rodada de cupons rodando — espere ela terminar.");
  if (_import.running) throw new Error("Tem uma busca de campanha rodando — espere ela terminar.");

  const procurar = overrides.procurar ? String(overrides.procurar).trim() : null;
  const cfg = { ...readConfig(), ...overrides };
  // Numa busca o limite por categoria não serve de nada: ele existe para segurar
  // quantas vitrines a rodada abre, e aqui só uma vai ser aberta. O que segura é
  // o teto de páginas, que continua valendo.
  //
  // E a busca NÃO herda o resto da config da rodada, porque a config da rodada é
  // sobre o que vale a pena COLHER e a busca é sobre onde a campanha PODE estar —
  // são perguntas diferentes, e responder a segunda com a primeira faz a busca
  // dizer "não achei" para um cupom que estava na lista. É o mesmo par de decisões
  // que o findCampaign do servidor já toma (scraping/ml-cupons.js): grouping null
  // e skipStore false.
  if (procurar) {
    cfg.limitPerGrouping = mlCupons.MAX_FILTER_PAGES * 30;
    // Categorias estreitadas na config esconderiam a campanha que está em outra
    // vertical — e quem testou a palavra não faz ideia de qual é a vertical dela.
    // Quem transforma isso em "a lista geral, uma passada só" é o
    // `categoriasDaRodada`, que trata `procurar` antes de olhar a config.
    cfg.groupings = [];
    // A campanha procurada PODE ser de loja. Descartá-la aqui é descartar o que se
    // foi buscar.
    cfg.skipStoreCoupons = false;
  }
  const ativa = booleano(cfg.activateCoupons, DEFAULT_CONFIG.activateCoupons);

  _local = {
    t0: Date.now(),
    cfg,
    categorias: categoriasDaRodada(cfg, { procurar }),
    iCategoria: 0,
    pagina: 1,
    // Quantas páginas da lista já foram abertas na rodada inteira (todas as
    // categorias somadas). O `pagina` acima zera a cada categoria; este não — é
    // ele que a tela usa pra dizer o que foi varrido quando a busca não acha nada.
    paginasLidas: 0,
    semNovidade: 0,
    daCategoria: 0,          // quantos cupons esta categoria já rendeu (o `limit` é por categoria)
    porId: new Map(),
    ignoradosLoja: 0,
    ativados: 0,
    semBotao: 0,
    motivos: [],
    // Teto de ativações da RODADA inteira, não por categoria: o que se limita é
    // quantas escritas a conta do ML recebe de uma vez.
    restantes: { n: ativa ? Math.max(0, Number(cfg.maxActivationsPerRun) || 0) : 0 },
    encerrada: false,
    persistido: null,
    ultimoContato: Date.now(),
    procurar,
    achou: false,
  };

  _status.running = true;
  _status.startedAt = new Date().toISOString();
  _status.progress = null;
  _status.lastError = null;
  _status.log = [];
  logar("info", procurar
    ? `procurando a campanha ${procurar} no seu Chrome`
    : `começando no seu Chrome: ${textoDasCategorias(_local.categorias)}, até ${cfg.limitPerGrouping} cupons por categoria`);

  // `categorias` vai junto porque a tela precisa DIZER quais são: "todas as
  // categorias" sem nomeá-las foi o que escondeu por meses uma config presa em
  // Brinquedos (task 26).
  return { config: cfg, ativa, procurar, categorias: _local.categorias, proxima: proximaPagina() };
}

// Quem ativar nesta página. A extensão manda o modelo cru, este lado devolve os
// rótulos exatos dos botões — e só os que o `aAtivar` aprovou.
function ativacoesLocais({ grouping = null, props = null } = {}) {
  if (!_local) throw new Error("Não tem rodada no Chrome em andamento.");
  tocarLocal();
  if (_local.restantes.n <= 0) return { labels: [], restantes: 0 };
  const { coupons } = mlCupons.parseFilterProps(props, grouping);
  // Numa busca só o alvo pode ser ativado. Ativar é escrita irreversível na conta
  // do ML, e quem pediu a busca pediu UMA campanha — gastar o teto de ativações
  // nos vizinhos dela deixaria justamente o alvo sem o "Eu quero", que é o único
  // jeito de o ML revelar a vitrine dele.
  const candidatos = _local.procurar
    ? coupons.filter(c => c.campaignId === _local.procurar)
    : coupons;
  // O `aAtivar` continua sendo quem decide: ele recusa cupom vencido, já ativado e
  // rótulo ambíguo — e só ativa `scope === "campaign"`, então cupom de LOJA entra
  // no sistema sem vitrine mesmo depois desta mudança. Entrar já é o ganho.
  const escolhidos = mlCupons.aAtivar(candidatos, { max: _local.restantes.n });
  return { labels: escolhidos.map(c => c.activationLabel), restantes: _local.restantes.n };
}

// Uma página lida. Devolve o que a tela mostra e a próxima URL — ou `alvos`, quando
// a varredura acabou e os cupons já foram gravados.
async function paginaLocal({ grouping = null, props = null, ativados = 0, semBotao = 0 } = {}) {
  if (!_local) throw new Error("Não tem rodada no Chrome em andamento.");
  tocarLocal();

  _local.ativados += Number(ativados) || 0;
  _local.semBotao += Number(semBotao) || 0;
  _local.restantes.n = Math.max(0, _local.restantes.n - (Number(ativados) || 0));
  _local.paginasLidas++;

  const parsed = mlCupons.parseFilterProps(props, grouping);
  const limite = Number(_local.cfg.limitPerGrouping) || DEFAULT_CONFIG.limitPerGrouping;
  const pulaLoja = booleano(_local.cfg.skipStoreCoupons, DEFAULT_CONFIG.skipStoreCoupons);
  const paginas = parsed.pages || 1;

  let novos = 0;
  for (const c of parsed.coupons) {
    // A campanha procurada é olhada ANTES de qualquer filtro. Ela é o motivo da
    // varredura existir: escopo de loja, limite de categoria e "já vi esse" são
    // regras de COLHEITA, e aplicá-las aqui responderia "não achei" para um cupom
    // que estava na página. Achar é o fim — as páginas seguintes só custariam
    // navegação com a conta do sistema.
    if (_local.procurar && c.campaignId === _local.procurar) {
      const anterior = _local.porId.get(c.campaignId);
      // Fica a versão que TEM vitrine: é a única que serve pra raspar produto.
      if (anterior) {
        for (const g of c.groupings) if (!anterior.groupings.includes(g)) anterior.groupings.push(g);
        if (!anterior.containerUrl && c.containerUrl) Object.assign(anterior, c, { groupings: anterior.groupings });
      } else {
        _local.porId.set(c.campaignId, c);
        _local.daCategoria++;
        novos++;
      }
      _local.achou = true;
      break;
    }
    // Cupom de loja fora ANTES de entrar na lista: ele não serve pra fila do
    // repasse e é o mais caro da rodada. Também não conta pro limite.
    if (pulaLoja && c.scope === "store") { _local.ignoradosLoja++; continue; }
    const anterior = _local.porId.get(c.campaignId);
    if (anterior) {
      for (const g of c.groupings) if (!anterior.groupings.includes(g)) anterior.groupings.push(g);
      // Fica a versão que TEM vitrine: é a única que serve pra raspar produto.
      if (!anterior.containerUrl && c.containerUrl) Object.assign(anterior, c, { groupings: anterior.groupings });
      continue;
    }
    _local.porId.set(c.campaignId, c);
    _local.daCategoria++;
    novos++;
    if (_local.daCategoria >= limite) break;
  }

  logar("info", `cupons: página ${_local.pagina}/${paginas}${grouping ? ` de ${grouping}` : ""} · ${_local.porId.size} cupons${_local.ignoradosLoja ? `, ${_local.ignoradosLoja} de loja ignorados` : ""}`, { dedup: true });
  _status.progress = { etapa: "cupons", pagina: _local.pagina, de: paginas, cupons: _local.porId.size, ignoradosLoja: _local.ignoradosLoja, grouping };

  // As paradas, na mesma ordem do crawlFilter.
  _local.semNovidade = novos ? 0 : _local.semNovidade + 1;
  if (_local.achou) _local.encerrada = true;
  else if (!parsed.coupons.length) proximaCategoria(`A lista de "${grouping || "todos"}" não devolveu cupom nenhum — pode ser categoria vazia ou a página ter mudado.`);
  else if (_local.daCategoria >= limite) proximaCategoria(null);
  else if (_local.semNovidade >= mlCupons.MAX_PAGINAS_SEM_NOVIDADE) proximaCategoria(null);
  else if (_local.pagina >= paginas) proximaCategoria(null);
  else if (_local.pagina >= mlCupons.MAX_FILTER_PAGES) proximaCategoria(`Parei no teto de ${mlCupons.MAX_FILTER_PAGES} páginas em "${grouping || "todos"}".`);
  else _local.pagina++;

  const proxima = proximaPagina();
  const base = { cupons: _local.porId.size, novos, ignoradosLoja: _local.ignoradosLoja, de: paginas, paginasLidas: _local.paginasLidas, achou: _local.achou };
  if (proxima) return { ...base, proxima, alvos: null };
  return { ...base, proxima: null, ...(await gravarCuponsLocais()) };
}

// A lista acabou: grava os cupons e diz quais vitrines valem a pena abrir.
//
// Grava ANTES das vitrines porque o `gravarVitrineLocal` exige o cupom no banco —
// e porque cupom guardado sem vitrine já é melhor que nada se o Chrome fechar no
// meio da colheita.
async function gravarCuponsLocais() {
  const cupons = [..._local.porId.values()];
  // `vitrines: []` de propósito: quem grava produto na rodada local é o
  // `gravarVitrineLocal`, cupom a cupom, com o que a extensão colheu.
  const resumo = await persistRun({ cupons, vitrines: [], ativados: _local.ativados, ignoradosLoja: _local.ignoradosLoja, avisos: _local.motivos });
  _local.persistido = resumo;
  logar("ok", `lista pronta: ${resumo.cupons} cupons (${resumo.novos} novos), ${_local.ativados} ativados`);
  // Numa busca, a única vitrine que interessa é a da campanha procurada.
  const alvos = cupons
    .filter(c => c.containerUrl && (!_local.procurar || c.campaignId === _local.procurar))
    .map(c => ({ campaignId: c.campaignId, title: c.title, containerUrl: c.containerUrl }));
  return { alvos, resumo, achou: _local.achou };
}

// Fim da rodada. `vitrines` é o que a tela conseguiu colher depois — só contagem,
// porque os produtos já foram gravados um a um pelo `vitrine-local`.
function fimLocalRun({ vitrines = [], produtos = 0, cancelada = false } = {}) {
  if (!_local) return { ok: false, reason: "Não tinha rodada no Chrome em andamento." };
  const base = _local.persistido || { cupons: _local.porId.size, novos: 0, atualizados: 0, avisos: [] };
  const resumo = {
    ...base,
    ativados: _local.ativados,
    cuponsComVitrine: Number(vitrines) || 0,
    vinculos: Number(produtos) || 0,
    cuponsDeLojaIgnorados: _local.ignoradosLoja,
    avisos: [...(base.avisos || []), ..._local.motivos].filter(Boolean),
    cancelada: !!cancelada,
    origem: "extensao",
  };
  _status.lastRun = new Date().toISOString();
  _status.lastDuration = Date.now() - _local.t0;
  _status.lastResult = resumo;
  _status.lastError = resumo.avisos.length ? resumo.avisos.join(" ") : null;
  logar(cancelada ? "aviso" : "ok", cancelada
    ? "rodada no seu Chrome interrompida"
    : `terminou em ${Math.round((Date.now() - _local.t0) / 1000)}s: ${resumo.cupons} cupons (${resumo.novos} novos), ${resumo.ativados} ativados, ${resumo.cuponsComVitrine} vitrines`);
  persistStatus();
  _local = null;
  _status.running = false;
  _status.progress = null;
  return { ok: true, resumo };
}

// A vitrine de UM cupom, sob demanda (o botão "Sincronizar produtos" da linha).
async function syncOneCoupon(campaignId, { maxProducts = null } = {}) {
  const cupom = await coupons.getCoupon(campaignId);
  if (!cupom) throw new Error("Esse cupom não está no sistema — puxe os cupons primeiro.");

  const cfg = readConfig();
  const affiliate = require("../scraping/affiliate");
  const session = affiliate.getScraperMLSession();
  if (!session) throw new Error("Sem sessão do Mercado Livre do sistema — cole o cookie em Admin › Mercado Livre.");

  const maxProdutos = maxProducts || cfg.maxProductsPerCoupon;

  // A landing de afiliado ANTES de abrir Chrome nenhum. São duas chamadas HTTP e
  // resolvem a maioria dos casos hoje; abrir o navegador pra descobrir isso
  // custaria ~30s e uma passada a mais na conta do sistema, que é a mesma do Hub.
  const pelaLanding = await mlCupons.vitrinePelaLanding(cupom);
  if (pelaLanding?.ok) {
    return gravarVitrine(campaignId, cupom, pelaLanding.products.slice(0, maxProdutos), { parcial: true });
  }

  const res = await mlCupons.withCuponsPage(session.cookie, null);
  try {
    const r = await mlCupons.scrapeCouponProducts(res.browser, cupom, { maxProducts: maxProdutos });
    // Vitrine barrada não pode sair de mãos vazias: as amostras do card já estão
    // guardadas no cupom e regravá-las custa uma consulta, sem rede nenhuma.
    if (!r.ok) {
      const a = await coupons.replaceCouponSamples(campaignId, cupom.sampleItemIds || []);
      await coupons.syncCatalogCoupons();
      return { ok: false, reason: pelaLanding?.reason ? `${r.reason} (a landing também não veio: ${pelaLanding.reason})` : r.reason, produtos: 0, amostras: a.vinculados };
    }
    return gravarVitrine(campaignId, cupom, r.products || [], { parcial: !!r.parcial });
  } finally {
    await res.browser.close().catch(() => {});
  }
}

// Grava os produtos de uma vitrine (venha ela do navegador ou da landing) e
// carimba o catálogo. Vive fora do syncOneCoupon porque os dois caminhos de lá
// terminam aqui, e duplicar isso é como as duas pontas passam a divergir.
async function gravarVitrine(campaignId, cupom, produtos, { parcial }) {
  const itens = produtos.map(p => ({ ...p, key: productKey(p) }));
  if (itens.length) await catalog.upsertProducts(itens);
  const v = await coupons.replaceCouponProducts(
    campaignId,
    itens.map(p => ({ productKey: p.key, productUrl: p.link })),
    { origem: parcial ? "landing" : "vitrine" },
  );
  // As amostras seguem gravadas ao lado: elas são outra coleção, e a prévia da
  // landing não as substitui (podem ser produtos diferentes do mesmo cupom).
  if ((cupom?.sampleItemIds || []).length) {
    await coupons.replaceCouponSamples(campaignId, cupom.sampleItemIds);
  }
  await coupons.syncCatalogCoupons();
  return { ok: true, produtos: itens.length, parcial, ...v };
}

// ────────────────────────────────────────────────────────────────────────
// A vitrine trazida de fora: o agente que roda no Chrome do admin
// ────────────────────────────────────────────────────────────────────────

// Por que existe: a vitrine do cupom está atrás do muro anti-bot do ML, e a
// sonda de 27/08 provou que o CAPTCHA aparece MESMO fora da VPS — o que o ML
// barra é o navegador automatizado, não a máquina (o mesmo diagnóstico de
// scraping/ml-social.js). Então quem percorre a vitrine é um Chrome de verdade,
// aberto pelo admin: a extensão em `extension/` só colhe e a tela manda pra cá.
//
// Isso muda a natureza do dado: o que vem do agente é a LISTA FECHADA (`origem:
// "vitrine"`), não a prova positiva da landing. É por isso que a validação abaixo
// é dura — um payload torto viraria "este cupom NÃO cobre seu produto" para um
// cupom que cobre, que é o prejuízo que coupons/quick-check.js existe pra evitar.

const MAX_PRODUTOS_DA_VITRINE = 500;

// Confere o lote que chegou de fora. PURA: sem banco, sem rede, sem DNS — é o
// que permite testá-la, e é o motivo de usar `detectStore` (síncrono) em vez do
// `assertStoreUrl` (que resolve o host). O host público não importa aqui: nada
// nesta rota faz o servidor buscar a URL, ela só vira vínculo no banco.
//
// Devolve { produtos, descartados } em vez de lançar: um card ilegível no meio de
// 50 não pode derrubar a vitrine inteira, mas some do resultado e é contado.
function validarProdutosDaVitrine(lista) {
  if (!Array.isArray(lista)) throw new Error("Esperava uma lista de produtos.");
  if (lista.length > MAX_PRODUTOS_DA_VITRINE) {
    throw new Error(`Lote grande demais: ${lista.length} produtos (o teto é ${MAX_PRODUTOS_DA_VITRINE}).`);
  }

  const { detectStore } = require("../scraping/urlGuard");
  const produtos = [];
  const descartados = [];
  const vistos = new Set();

  for (const bruto of lista) {
    const p = bruto && typeof bruto === "object" ? bruto : {};
    const name = typeof p.name === "string" ? p.name.trim() : "";
    const link = typeof p.link === "string" ? p.link.trim() : "";
    const price = typeof p.price === "number" ? p.price : null;

    if (!name) { descartados.push({ link, motivo: "sem nome" }); continue; }
    if (!Number.isFinite(price) || price <= 0) { descartados.push({ link, motivo: "sem preço" }); continue; }
    if (detectStore(link) !== "Mercado Livre") { descartados.push({ link, motivo: "link não é do Mercado Livre" }); continue; }
    if (vistos.has(link)) { descartados.push({ link, motivo: "repetido" }); continue; }
    vistos.add(link);

    // Só os campos do catálogo entram. Aceitar o objeto inteiro deixaria o
    // payload de fora escrever coluna que ele não tem por que escrever.
    produtos.push({
      name, link, price,
      img: typeof p.img === "string" ? p.img : null,
      originalPrice: typeof p.originalPrice === "number" ? p.originalPrice : null,
      discount: Number.isFinite(p.discount) ? p.discount : null,
      rating: Number.isFinite(p.rating) ? p.rating : null,
      reviewsCount: Number.isFinite(p.reviewsCount) ? p.reviewsCount : null,
      seller: typeof p.seller === "string" ? p.seller : null,
      freeShipping: !!p.freeShipping,
      sold: Number.isFinite(p.sold) ? p.sold : null,
      store: "Mercado Livre",
    });
  }

  return { produtos, descartados };
}

// A porta do agente. `parcial` NUNCA pode ser esquecido: o laço que parou no muro
// ou no teto de páginas viu um pedaço da vitrine, e gravar isso como lista fechada
// autorizaria o sistema a dizer "fora da vitrine" para produto que está nela.
async function gravarVitrineLocal(campaignId, lista, { parcial = false } = {}) {
  const cupom = await coupons.getCoupon(campaignId);
  if (!cupom) throw new Error("Esse cupom não está no sistema — puxe os cupons primeiro.");

  const { produtos, descartados } = validarProdutosDaVitrine(lista);
  const r = await gravarVitrine(campaignId, cupom, produtos, { parcial: !!parcial });
  return { ...r, descartados: descartados.length };
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
    // Um cupom só, escolhido a dedo por quem testou a palavra — e sem ativar ele
    // a busca traz a campanha sem produto nenhum, que é metade do que se pediu.
    activate: booleano(cfg.activateCoupons, DEFAULT_CONFIG.activateCoupons),
  });
  if (!achado.coupon) return { ok: false, reason: achado.reason };

  // A ordem é a da rodada (persistRun): cupom, palavra, produtos, carimbo. Fazer o
  // carimbo antes dos vínculos deixaria o catálogo apontando pra cupom sem produto.
  await coupons.upsertCoupons([achado.coupon], { origin: "code" });
  // Devolve a palavra à campanha: o `recordCodeCheck` tentou carimbar no momento do
  // teste e não achou linha nenhuma para carimbar.
  const palavras = await coupons.restampCodesFromChecks();
  await coupons.recoverCodesFromCoupons();

  // As amostras do card vêm no próprio cupom que a busca achou, e são o que salva
  // o caso comum aqui: a campanha que a palavra apontou quase sempre está NÃO
  // ativada, e cupom não ativado não tem vitrine nenhuma pra ler.
  let amostras = 0;
  if ((achado.coupon.sampleItemIds || []).length) {
    const a = await coupons.replaceCouponSamples(id, achado.coupon.sampleItemIds);
    amostras = a.vinculados;
  }

  let produtos = 0;
  let vinculos = 0;
  if (achado.products?.length) {
    const itens = achado.products.map(p => ({ ...p, key: productKey(p) }));
    await catalog.upsertProducts(itens);
    const v = await coupons.replaceCouponProducts(
      id,
      itens.map(p => ({ productKey: p.key, productUrl: p.link })),
      { origem: achado.parcial ? "landing" : "vitrine" },
    );
    produtos = itens.length;
    vinculos = v.vinculados;
  }
  await coupons.syncCatalogCoupons();

  return {
    ok: true,
    coupon: await coupons.getCoupon(id),
    produtos,
    vinculos,
    amostras,
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
// Quanto tempo uma palavra testada continua valendo sem perguntar de novo ao ML.
// Cada teste é uma escrita na página de cupons da conta do sistema — e a mesma
// conta é a do Hub de Afiliados.
const MAX_AGE_PALAVRA_HORAS = 12;

async function respostaDoCache(code, cache) {
  return {
    word: code, verdict: cache.verdict, campaignId: cache.campaignId,
    message: cache.message, responseCode: cache.responseCode,
    cached: true, checkedAt: cache.checkedAt,
    coupon: cache.campaignId ? await coupons.getCoupon(cache.campaignId) : null,
  };
}

async function checkWord(word, { source = "admin", maxAgeHours = MAX_AGE_PALAVRA_HORAS, force = false } = {}) {
  const code = String(word || "").trim().toUpperCase().slice(0, 40);
  if (!code) throw new Error("Escreva a palavra do cupom.");

  if (!force) {
    const cache = await coupons.findCodeCheck(code, { maxAgeHours });
    if (cache) return respostaDoCache(code, cache);
  }

  const affiliate = require("../scraping/affiliate");
  const session = affiliate.getScraperMLSession();
  if (!session) throw new Error("Sem sessão do Mercado Livre do sistema — cole o cookie em Admin › Mercado Livre.");

  const r = await mlCupons.checkCouponWord(session.cookie, code);
  return registrarPalavra(code, r, { source });
}

// A palavra testada na aba do PRÓPRIO admin (a extensão).
//
// Chega o mesmo material que o Chrome do servidor juntaria: os corpos crus das
// respostas que a página buscou depois do "Aplicar". Quem interpreta continua
// sendo o `lerRespostaDeCodigo` + `vereditoDaPalavra`, que são puros e valem para
// os dois caminhos — se a leitura divergisse, a mesma palavra teria dois
// vereditos dependendo de quem abriu a página.
//
// O cache de 12h vale aqui também: cada teste, venha de onde vier, é uma escrita
// na página de cupons da conta do sistema.
async function checkWordLocal({ word, respostas = [], bodyText = "", source = "admin", maxAgeHours = MAX_AGE_PALAVRA_HORAS, force = false } = {}) {
  const code = String(word || "").trim().toUpperCase().slice(0, 40);
  if (!code) throw new Error("Escreva a palavra do cupom.");

  if (!force) {
    const cache = await coupons.findCodeCheck(code, { maxAgeHours });
    if (cache) return respostaDoCache(code, cache);
  }

  const escolhida = mlCupons.lerRespostaDeCodigo((respostas || []).map(r => (typeof r === "string" ? r : r?.body)));
  const r = mlCupons.vereditoDaPalavra(code, escolhida, { bodyText });
  return registrarPalavra(code, r, { source });
}

// Grava o que o ML respondeu e monta a resposta da tela. Comum aos dois caminhos.
async function registrarPalavra(code, r, { source = "admin" } = {}) {
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
  startLocalRun,
  ativacoesLocais,
  paginaLocal,
  fimLocalRun,
  localAtivo,
  status,
  readConfig,
  writeConfig,
  persistRun,
  syncOneCoupon,
  gravarVitrine,
  gravarVitrineLocal,
  validarProdutosDaVitrine,
  MAX_PRODUTOS_DA_VITRINE,
  importCampaign,
  startImport,
  importStatus,
  checkWord,
  checkWordLocal,
  loadPersistedStatus,
  readGroupingLabels,
  mergeGroupingLabels,
  verticaisConhecidas,
  categoriasDaRodada,
  textoDasCategorias,
  textoDoProgresso,
  CONFIG_KEY,
  STATUS_KEY,
  GROUPINGS_KEY,
  DEFAULT_CONFIG,
};
