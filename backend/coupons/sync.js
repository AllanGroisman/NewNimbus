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
  // ── Etapa 1: a lista ────────────────────────────────────────────────────
  //
  // A varredura começa pela lista GERAL (`/cupons/filter?all=true`), que traz
  // TODOS os cupons da conta, 30 por página. É leitura pura: nenhum clique, nada
  // escrito na conta do ML.
  maxPaginasLista: 40,          // 40 × 30 = 1.200 cupons
  limiteCupons: 0,              // 0 = sem teto; o que segura é o de páginas
  // Depois da lista geral, uma passada rápida por vertical só para CARIMBAR a
  // categoria. Ela é necessária porque o ML não diz a que vertical o cupom
  // pertence: a categoria que o sistema grava é o filtro que foi pedido na URL
  // (ver parseFilterProps, scraping/ml-cupons.js). Sem isso, "puxar de tudo"
  // traz tudo sem categoria nenhuma e a coluna Categoria fica vazia.
  carimbarCategorias: true,
  // 40 × 30 = 1.200, o mesmo fôlego da lista geral. Era 5, na ideia de que "as
  // primeiras páginas bastam" — só que a vertical maior da conta tem ~1.170
  // cupons, e 5 páginas carimbavam 150 deles: o resto ficava com Categoria "—"
  // (task 14). Quem encerra uma vertical antes disso é o `pages` do próprio ML.
  maxPaginasPorCategoria: 40,
  // [] = todas as verticais que o ML mostrar. A lista não é fixa nem vem da config:
  // a rodada aprende as chaves na primeira página (ver `aprenderCategorias`).
  categorias: [],
  // Cupom de UMA loja ("Em produtos de Agrotrator"). Ele agora ENTRA por padrão e
  // é separado na tela — descartá-lo escondia metade da lista do ML. Ligar isto
  // volta ao comportamento antigo.
  skipStoreCoupons: false,
  // Quantas páginas da lista a etapa 1 abre AO MESMO TEMPO no Chrome do admin
  // (task 21). As URLs da lista são endereçáveis por offset e o ML declara quantas
  // páginas existem, então nada do lado dele obriga a ir uma por vez.
  //
  // Nasce em 1, e não em 2 como o `vitrinesEmParalelo`, por três motivos que se
  // somam: esta é a PRIMEIRA coisa que roda numa conta, não tem pausa entre
  // páginas como as vitrines têm, e é o endpoint mais fichado do ML. E o muro vale
  // para a CONTA, que é a mesma do Hub de Afiliados — um CAPTCHA aqui derruba os
  // dois. Quem quiser acelerar sobe o número na tela e olha o que acontece.
  paginasDeListaEmParalelo: 1,

  // ── Etapa 2: os produtos ────────────────────────────────────────────────
  //
  // Botão separado de propósito: é aqui que a conta do ML é escrita.
  maxProductsPerCoupon: 500,
  maxPaginasVitrine: 11,        // 48 por página → 528, o suficiente pro teto de 500
  pausaEntreVitrinesMs: 4000,   // rajada de abas é o que acorda o anti-robô
  // Clicar em "Eu quero" nos cupons não ativados. É a única ESCRITA que o sistema
  // faz na conta do ML — e é o que faz a vitrine existir: sem ativar, o ML não dá
  // a URL dela e o cupom fica sem lista de produtos.
  //
  // Os dois knobs são ortogonais, e isso é de propósito: `activateCoupons` liga e
  // desliga, `maxActivationsPerRun` limita quantos por rodada. Por isso **0 aqui é
  // SEM TETO**, e não "nenhum" — "nenhum" já é `activateCoupons: false`, e ter duas
  // formas de dizer a mesma coisa só dá chance de as duas discordarem.
  //
  // O default é sem teto porque foi o que se pediu do "buscar TUDO": um cupom não
  // ativado é um cupom sem vitrine, e sem vitrine ele não tem produto nenhum. O
  // preço é conhecido — cliques em sequência é o padrão que acorda o anti-robô, e a
  // conta é a MESMA do Hub de Afiliados, então verificação aqui derruba o Hub
  // junto. Quem quiser o freio de volta põe um número.
  activateCoupons: true,
  maxActivationsPerRun: 0,

  // O "buscar TUDO": a etapa 2 repetida em ciclos até a fila esvaziar. A pausa é
  // entre CICLOS (a `pausaEntreVitrinesMs` é entre vitrines do mesmo ciclo) e é
  // maior de propósito: é o intervalo em que a conta fica quieta.
  //
  // O `maxCiclos` não é um teto de colheita, é rede de segurança: o laço já para
  // sozinho quando a fila esvazia, quando bate no muro e quando um ciclo inteiro
  // não move nada. Ele existe para o estado que ninguém previu.
  pausaEntreCiclosMs: 60000,
  maxCiclos: 20,
  // A etapa 2 anda em LOTES: ativa N cupons, colhe as vitrines deles, grava, e só
  // então vai para os próximos N. Antes era uma passada de ativação pela lista
  // inteira e só DEPOIS a colheita — um Parar no meio da ativação jogava tudo fora
  // e nenhuma vitrine chegava a ser aberta. Com lote, parar perde no máximo o lote
  // em andamento.
  tamanhoLoteProdutos: 20,
  // Quantas vitrines a etapa 2 abre AO MESMO TEMPO no Chrome do admin (task 14).
  // Era uma por vez, de propósito: várias abas batendo no ML com a mesma conta é o
  // padrão que acorda o anti-robô, e o muro vale para a CONTA — que é a do Hub. O
  // teto de 4 é esse freio; se uma aba bater no muro, nenhuma outra começa.
  vitrinesEmParalelo: 2,
};

// Um "false" em TEXTO é o erro clássico — `!!"false"` é true —, e ele chega de
// verdade: o body de uma rota e um checkbox serializado passam string.
function booleano(v, padrao) {
  if (v === undefined || v === null || v === "") return padrao;
  if (typeof v === "string") return !/^(false|0|nao|não|off)$/i.test(v.trim());
  return !!v;
}

// `Infinity` para fora do processo é sempre `null`: é o que o JSON faz com ele de
// qualquer jeito, e escrever isso uma vez evita cada chamador reinventar a regra.
function semTeto(n) {
  return Number.isFinite(n) ? n : null;
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
  // O balanço da última vez de CADA botão da tela (task 17). Eram quatro campos
  // soltos (`lastRun`…) que qualquer passada pela lista sobrescrevia — inclusive a
  // ativação de um lote do botão 2 —, e os botões 2 e 3 nem gravavam o deles.
  // Cada slot é `{ at, duracaoMs, resultado, erro, interrompida }`.
  ultimas: { lista: null, produtos: null, tudo: null },
};

// Os botões cujo laço roda no navegador e que mandam o balanço pronto para cá
// (`registrarRodada`). O `lista` fica de fora: quem o escreve é o `resumoDoFim`.
const BOTOES_DO_NAVEGADOR = new Set(["produtos", "tudo"]);
// O que o navegador pode gravar num balanço. Só números: é o que a tela mostra, e
// aceitar objeto qualquer seria deixar a tela encher o app_config.
const CHAVES_DO_BALANCO = [
  "ativados", "tentados", "colhidos", "produtos", "parciais", "vazias", "falharam",
  "lotes", "ciclos", "cuponsNaLista", "ficaramDeFora",
];

// Teto do log. Uma rodada grande emite um evento por cupom, e guardar tudo é
// segurar megabytes na memória do processo da API pra mostrar 20 linhas na tela.
const MAX_LOG = 200;

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
  if (!saved || typeof saved !== "object") return;
  if (saved.ultimas && typeof saved.ultimas === "object") {
    for (const k of Object.keys(_status.ultimas)) _status.ultimas[k] = saved.ultimas[k] || null;
  } else if (saved.lastRun) {
    // O formato de antes da task 17: um slot só. O melhor palpite é que ele seja
    // do botão 1, e a próxima rodada dele o substitui de qualquer jeito.
    _status.ultimas.lista = {
      at: saved.lastRun,
      duracaoMs: saved.lastDuration || null,
      resultado: saved.lastResult || null,
      erro: saved.lastError || null,
      interrompida: !!saved.lastResult?.cancelada,
    };
  }
}

function persistStatus() {
  appConfig.set(STATUS_KEY, { ultimas: _status.ultimas });
}

// O balanço dos botões 2 e 3, que rodam no navegador — o servidor só vê as
// vitrines chegando, uma a uma, e não sabe quando o botão acabou.
function registrarRodada(botao, { duracaoMs = null, resultado = {}, erro = null, interrompida = false } = {}) {
  if (!BOTOES_DO_NAVEGADOR.has(botao)) throw new Error(`Botão desconhecido: ${botao}`);
  const limpo = {};
  for (const k of CHAVES_DO_BALANCO) {
    const v = Number(resultado?.[k]);
    if (resultado?.[k] != null && Number.isFinite(v)) limpo[k] = v;
  }
  const ms = Number(duracaoMs);
  _status.ultimas[botao] = {
    at: new Date().toISOString(),
    duracaoMs: Number.isFinite(ms) && ms >= 0 ? ms : null,
    resultado: limpo,
    erro: erro ? String(erro).slice(0, 500) : null,
    interrompida: !!interrompida,
  };
  persistStatus();
  return _status.ultimas[botao];
}

// { chave: nome } do que já se viu em alguma rodada. Só leitura — quem escreve é
// o mergeGroupingLabels().
function readGroupingLabels() {
  const raw = appConfig.get(GROUPINGS_KEY);
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

// Aceita os três formatos em que a chave de uma categoria chega do ML, porque as
// três fontes são diferentes e nenhuma sozinha basta:
//
//   "hi_vertical"                 — `availableGroupingsKeys` da /cupons/filter:
//                                   a lista COMPLETA, e sem nome nenhum.
//   { key, title }                — `appliedFilters` da /cupons/filter e os
//                                   `groupings` da aba /cupons: uma por vez, com nome.
//   { value, text }               — o seletor de categorias da aba /cupons.
//
// Chave SEM nome entra com `null` de propósito (task 14). Antes ela era descartada
// (`if (!chave || !nome) continue`), e como a rodada local só abre a /cupons/filter
// — onde o nome só vem da categoria que está sendo filtrada —, as verticais que
// ainda não tinham sido visitadas nunca entravam no dicionário. Sem entrar no
// dicionário elas não entram na fila da rodada (`verticaisConhecidas`), e sem
// entrar na fila nunca seriam visitadas: o dicionário ficou congelado em três
// categorias. O nome chega depois, na passada que filtra por ela.
//
// O que um nome já conhecido NUNCA pode sofrer é ser apagado por uma chave crua
// que veio depois — daí o `nome === null` não sobrescrever.
function mergeGroupingLabels(grupos) {
  if (!Array.isArray(grupos) || !grupos.length) return readGroupingLabels();
  const mapa = readGroupingLabels();
  let mudou = false;
  for (const g of grupos) {
    const chave = typeof g === "string" ? g : (g?.key ?? g?.value);
    const cru = typeof g === "string" ? null : (g?.title ?? g?.text);
    if (!chave) continue;
    const nome = cru ? String(cru).slice(0, 80) : null;
    // Chave nova sem nome: registra para a fila poder vê-la. Com nome: grava.
    if (!(chave in mapa)) { mapa[chave] = nome; mudou = true; continue; }
    if (!nome || mapa[chave] === nome) continue;
    mapa[chave] = nome;
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
// A COLETA é a lista geral (`null`), sempre, e é ela que traz TODOS os cupons da
// conta. As verticais vêm depois e servem a outra coisa: CARIMBAR a categoria.
// Elas são necessárias porque a lista do ML não diz a que vertical cada cupom
// pertence — a categoria que o sistema grava é o filtro que a gente pediu na URL
// (ver parseFilterProps, scraping/ml-cupons.js). Sem elas a coluna Categoria da
// tabela fica "—" para todo mundo; sem a geral antes, cupom que não está em
// vertical nenhuma nunca entra.
function categoriasDaRodada(cfg = {}, { procurar = null, labels = null } = {}) {
  // Buscar UMA campanha é outra pergunta: a lista geral já contém tudo, e varrer
  // dez verticais atrás dela seria dez vezes mais navegação com a conta do sistema
  // para achar o mesmo cupom. Ver o `procurar` do startLocalRun.
  if (procurar) return [null];
  if (!booleano(cfg.carimbarCategorias, DEFAULT_CONFIG.carimbarCategorias)) return [null];

  const escolhidas = (cfg.categorias || []).map(g => g?.key ?? g).filter(Boolean);
  // Instalação que nunca leu a aba do ML não tem dicionário nenhum, e esta função é
  // chamada ANTES de qualquer página ter sido aberta: aqui a fila sai com o que já
  // se sabia. Quem a completa com o que o ML mostrar é o `aprenderCategorias`, na
  // primeira página da lista geral — por isso um dicionário curto (ou vazio) não
  // condena a rodada a carimbar pouco, como condenou por meses (task 14).
  return [null, ...(escolhidas.length ? escolhidas : verticaisConhecidas(labels))];
}

// Como a rodada anuncia o que vai varrer. Ela já dizia "todas as categorias" sem
// dizer QUAIS — que era exatamente a informação que faltava para perceber que a
// config estava presa numa vertical só (task 26).
function textoDasCategorias(categorias, labels = null) {
  const mapa = labels || readGroupingLabels();
  const verticais = categorias.filter(Boolean);
  if (!verticais.length) return "a lista geral (sem carimbo de categoria)";
  const nomes = verticais.map(k => mapa[k] || k);
  return `a lista geral + carimbo de ${verticais.length} categoria${verticais.length === 1 ? "" : "s"} (${nomes.join(", ")})`;
}

// Só as chaves que o DEFAULT_CONFIG conhece sobrevivem à leitura.
//
// É a lição da task 26: um `groupings: ["tb_vertical"]` gravado uma vez segurou a
// rodada em Brinquedos por MESES, porque `{...DEFAULT, ...raw}` faz o valor salvo
// vencer sempre e não havia tela que o reescrevesse. Uma chave que o código não
// usa mais é exatamente esse tipo de bomba dormindo no banco, então ela some na
// leitura em vez de ficar esperando.
function readConfig() {
  const raw = appConfig.get(CONFIG_KEY);
  const cfg = { ...DEFAULT_CONFIG };
  if (raw && typeof raw === "object") {
    for (const k of Object.keys(DEFAULT_CONFIG)) if (raw[k] !== undefined) cfg[k] = raw[k];
  }
  return cfg;
}

// Tetos com pé no chão: a conta tem milhares de cupons e cada vitrine é mais uma
// página aberta com a MESMA sessão que o Hub usa.
function inteiro(v, { min, max, padrao }) {
  // Zero é valor legítimo aqui — no `maxActivationsPerRun` ele quer dizer "sem
  // teto" —, então `||` não serve de rede: ele trocaria o 0 pelo padrão. Quem
  // decide é o Number.isFinite, porque `Number(undefined)` é NaN e NaN passa por `??`.
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : padrao;
}

function writeConfig(cfg) {
  const merged = { ...readConfig(), ...cfg };
  merged.categorias = Array.isArray(merged.categorias)
    ? merged.categorias.map(g => String(g?.key ?? g)).filter(Boolean).slice(0, 20)
    : [];
  merged.maxPaginasLista = inteiro(merged.maxPaginasLista, { min: 1, max: 200, padrao: DEFAULT_CONFIG.maxPaginasLista });
  merged.limiteCupons = inteiro(merged.limiteCupons, { min: 0, max: 20000, padrao: DEFAULT_CONFIG.limiteCupons });
  merged.maxPaginasPorCategoria = inteiro(merged.maxPaginasPorCategoria, { min: 1, max: 200, padrao: DEFAULT_CONFIG.maxPaginasPorCategoria });
  merged.maxProductsPerCoupon = inteiro(merged.maxProductsPerCoupon, { min: 10, max: 500, padrao: DEFAULT_CONFIG.maxProductsPerCoupon });
  merged.maxPaginasVitrine = inteiro(merged.maxPaginasVitrine, { min: 1, max: 20, padrao: DEFAULT_CONFIG.maxPaginasVitrine });
  merged.pausaEntreVitrinesMs = inteiro(merged.pausaEntreVitrinesMs, { min: 500, max: 30000, padrao: DEFAULT_CONFIG.pausaEntreVitrinesMs });
  // 0 = sem teto (ver DEFAULT_CONFIG), por isso o min é 0 e não 1.
  merged.maxActivationsPerRun = inteiro(merged.maxActivationsPerRun, { min: 0, max: 500, padrao: DEFAULT_CONFIG.maxActivationsPerRun });
  merged.pausaEntreCiclosMs = inteiro(merged.pausaEntreCiclosMs, { min: 5000, max: 600000, padrao: DEFAULT_CONFIG.pausaEntreCiclosMs });
  merged.maxCiclos = inteiro(merged.maxCiclos, { min: 1, max: 200, padrao: DEFAULT_CONFIG.maxCiclos });
  merged.tamanhoLoteProdutos = inteiro(merged.tamanhoLoteProdutos, { min: 1, max: 200, padrao: DEFAULT_CONFIG.tamanhoLoteProdutos });
  merged.vitrinesEmParalelo = inteiro(merged.vitrinesEmParalelo, { min: 1, max: 4, padrao: DEFAULT_CONFIG.vitrinesEmParalelo });
  merged.carimbarCategorias = booleano(merged.carimbarCategorias, DEFAULT_CONFIG.carimbarCategorias);
  merged.skipStoreCoupons = booleano(merged.skipStoreCoupons, DEFAULT_CONFIG.skipStoreCoupons);
  // Teto 8. É mais alto que o das vitrines (4) porque aqui a página é só leitura —
  // nenhum clique, nada escrito na conta —, mas continua sendo um teto: o que
  // acorda o anti-robô é a rajada, e rajada não tem a ver com o que se lê.
  merged.paginasDeListaEmParalelo = inteiro(merged.paginasDeListaEmParalelo, { min: 1, max: 8, padrao: DEFAULT_CONFIG.paginasDeListaEmParalelo });
  merged.activateCoupons = booleano(merged.activateCoupons, DEFAULT_CONFIG.activateCoupons);
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
    // "página X de N" só é progresso com uma aba: com várias, a última a voltar
    // não é a mais adiantada e a frase pulava 9 → 7 → 11. `p.pagina` passou a ser
    // quantas já VOLTARAM desta entrada, que é monotônico.
    const abas = p.emVoo > 1 ? `, ${p.emVoo} abas abertas` : "";
    return `lendo a lista ${onde} — ${p.pagina}/${p.de} páginas, ${p.cupons} cupons${loja}${abas}`;
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
    running: _status.running,
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
  const t0 = Date.now();
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
  //
  // Numa chamada só, e não um cupom por vez: cada cupom custava ~6 idas ao banco
  // (4 amostras, o apagamento do que saiu, o carimbo), e com milhares de cupons
  // guardados a fila indiana passava dos 90s que o nginx espera — a tela recebia
  // o 503 de "Nimbus indisponível" no meio da etapa 2. Medido com os 2.871 cupons
  // de hoje: 171s cupom a cupom, 1,1s em massa.
  const comAmostra = (result.cupons || []).filter(c => c?.campaignId && (c.sampleItemIds || []).length);
  const { vinculados: amostras } = await coupons.replaceCouponSamplesMany(comAmostra);

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

  // A duração fica no log da rodada de propósito. Foi ela que faltou quando esta
  // gravação cresceu até estourar o `proxy_read_timeout` do nginx: a tela só dizia
  // "Nimbus indisponível", sem nada que apontasse para o tempo daqui.
  logar("info", `gravação: ${((Date.now() - t0) / 1000).toFixed(1)}s para ${(result.cupons || []).length} cupom(ns)`);

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
  // Sem `await`: quem chama é síncrono (`status`, `startLocalRun`). O `fimLocalRun`
  // solta o `_local` ANTES da gravação, então a próxima rodada já pode começar.
  fimLocalRun({ cancelada: true }).catch(err => logar("erro", `não consegui gravar a rodada pendurada: ${err.message}`));
}

// ── A fila de trabalho da varredura (task 21) ───────────────────────────────
//
// Era um CURSOR: `iCategoria` + `pagina`, e uma função que devolvia "a próxima
// página". Um cursor só pode responder a uma pergunta por vez, e era ele — não o
// Mercado Livre — que obrigava a etapa 1 a abrir uma página de cada vez: as URLs
// da lista são endereçáveis por offset (`filterUrl`), e o próprio ML declara
// quantas páginas existem.
//
// Agora cada entrada da fila (a lista geral e cada vertical) guarda o próprio
// avanço, e o despachante entrega até K páginas de uma vez.

// Uma entrada da fila. `grouping` null é a lista geral.
function novaEntrada(grouping) {
  return {
    grouping,
    proxima: 1,             // a próxima página AINDA NÃO entregue
    paginas: null,          // o `pages` que o ML declarou; null = a página 1 não voltou
    lidas: 0,               // páginas concluídas — monotônico, é o que a barra usa
    ultimaComNovidade: 0,   // ver `semNovidadeDemais`
    fechada: false,
    gravada: false,         // já disparou a gravação parcial de quando ficou quieta
  };
}

const chaveDaPagina = (grouping, pagina) => `${grouping ?? ""}#${pagina}`;

function entradaDe(grouping) {
  return _local.entradas.find(e => e.grouping === grouping) || null;
}

function emVooDe(grouping) {
  let n = 0;
  for (const v of _local.emVoo.values()) if (v.grouping === grouping) n++;
  return n;
}

// QUIETA é diferente de FECHADA: fechada fala da entrega ("não peça mais páginas
// daqui"), quieta fala do resultado ("e nenhuma ainda está voltando"). Confundir
// as duas é o que faria o carimbo abrir com a coleta pela metade.
const quieta = (e) => e.fechada && emVooDe(e.grouping) === 0;

function fecharEntrada(e, motivo) {
  if (motivo) _local.motivos.push(motivo);
  e.fechada = true;
}

// A varredura inteira para de entregar. As páginas em voo TERMINAM: os cupons
// delas são cupons de verdade, e descartá-los seria jogar fora navegação que já
// foi paga na conta do ML.
function fecharTudo(motivo) {
  if (motivo) _local.motivos.push(motivo);
  for (const e of _local.entradas) e.fechada = true;
}

// A rodada acabou mesmo. `proximasPaginas` devolvendo `[]` NÃO quer dizer isto —
// logo depois da semente o servidor legitimamente não tem página para as outras
// abas, e uma que lesse `[]` como "acabou" sairia, devolvendo o paralelismo para
// o serial no primeiro instante.
function fimDaRodada() {
  return !!_local && _local.entradas.every(e => e.fechada) && _local.emVoo.size === 0;
}

// O teto de páginas da fase. São dois porque as fases são duas: a lista geral é a
// coleta, a vertical é a volta por cima para carimbar categoria.
//
// O `|| PADRÃO` é também o caminho do "sem teto": `Infinity` é truthy e atravessa
// intacto, então não existe um segundo caminho para manter em dia. `0` continua
// NÃO querendo dizer "sem teto" aqui — quem diz isso é o flag do `startLocalRun`,
// e o `writeConfig` nem deixa gravar 0 nestes dois.
function tetoDePaginas(carimbo) {
  return carimbo
    ? Number(_local.cfg.maxPaginasPorCategoria) || DEFAULT_CONFIG.maxPaginasPorCategoria
    : Number(_local.cfg.maxPaginasLista) || DEFAULT_CONFIG.maxPaginasLista;
}

// Esta entrada ainda tem página para entregar? Fechar acontece AQUI, na entrega, e
// não na volta da página: é o que permite soltar de uma vez as páginas 2..N de uma
// entrada assim que se sabe quantas ela tem.
//
// A ordem das duas guardas importa e é a de antes: quem acabou porque o ML disse
// que acabou não ganha o aviso de teto. Invertê-las poria "parei no teto de 5
// páginas" numa lista que tem exatamente 5.
function podeEntregar(e) {
  if (e.fechada) return false;
  if (e.paginas !== null && e.proxima > e.paginas) { fecharEntrada(e, null); return false; }
  const teto = tetoDePaginas(e.grouping !== null);
  if (e.proxima > teto) {
    fecharEntrada(e, e.grouping !== null
      ? `Parei no teto de ${teto} páginas em ${e.grouping} — os cupons além dele ficam sem categoria.`
      : `Parei no teto de ${teto} páginas da lista geral — suba o limite se faltou cupom.`);
    return false;
  }
  return true;
}

// Uma aba que morre segurando uma página deixaria a entrada eternamente "com algo
// em voo": a rodada não terminaria e ficaria pendurada até o watchdog de 5 min.
// Passado tempo demais, a página volta para a fila — nominalmente, e não mexendo
// no `proxima` da entrada, que redespacharia junto tudo o que veio depois dela.
const PAGINA_PERDIDA_MS = 3 * 45000;   // 3× o que a extensão espera uma página carregar

function reclamarPerdidas() {
  const agora = Date.now();
  for (const [k, v] of _local.emVoo) {
    if (agora - v.desde < PAGINA_PERDIDA_MS) continue;
    _local.emVoo.delete(k);
    const e = entradaDe(v.grouping);
    if (!e || e.fechada) continue;
    _local.refazer.push(v);
    logar("aviso", `a página ${v.pagina}${v.grouping ? ` de ${v.grouping}` : " da lista geral"} não voltou — vou pedir de novo`);
  }
}

function despachar(grouping, pagina) {
  _local.emVoo.set(chaveDaPagina(grouping, pagina), { grouping, pagina, desde: Date.now() });
  return { grouping, pagina, url: mlCupons.filterUrl({ grouping, page: pagina }) };
}

// Quantas abas estão livres agora. O despachante entrega no máximo isto, e não
// `paralelo` a cada página que volta: entregar K por conclusão fazia a fila em voo
// CRESCER — quatro abas viravam oito, depois doze —, e a tela abria muito mais
// páginas ao mesmo tempo do que o número que quem opera escolheu.
function vagas() {
  return Math.max(0, _local.paralelo - _local.emVoo.size);
}

// Até `quanto` páginas para abrir agora — nunca mais que as abas livres. É o
// coração do laço, e o que os testes cobrem.
function proximasPaginas(quanto = 1) {
  if (!_local) return [];
  // ANTES de contar as vagas: uma aba morta ocupa uma vaga para sempre, e o pool
  // pareceria cheio justamente quando está com um lugar vago e uma página perdida.
  reclamarPerdidas();
  quanto = Math.min(quanto, vagas());
  if (quanto < 1) return [];
  const fora = [];

  // As que voltaram para a fila vêm na frente: são buraco no meio do que já foi
  // varrido, e quanto mais tarde forem refeitas maior a chance de a rodada
  // terminar sem elas.
  while (fora.length < quanto && _local.refazer.length) {
    const v = _local.refazer.shift();
    const e = entradaDe(v.grouping);
    if (!e || e.fechada) continue;
    fora.push(despachar(v.grouping, v.pagina));
  }

  // A BARREIRA entre a coleta e o carimbo: enquanto a lista geral não estiver
  // QUIETA, nenhuma vertical é entregue. O `abrirCarimbo` decide quais cupons
  // ainda precisam de categoria olhando o `porId` inteiro — abrir uma vertical
  // antes disso é decidir com a coleta pela metade.
  const geral = _local.entradas[0];
  const soAGeral = !!geral && !quieta(geral);

  for (const e of _local.entradas) {
    if (fora.length >= quanto) break;
    if (e.fechada) continue;
    if (soAGeral && e.grouping !== null) continue;
    // A página 1 de cada entrada vai SOZINHA. É ela que revela quantas páginas a
    // entrada tem, e na lista geral é também ela que faz a fila de verticais
    // crescer (`aprenderCategorias`). Entregar a 2 antes de a 1 voltar é entregar
    // sem saber até onde ir — e, na geral, sem saber quantas entradas existem.
    if (e.paginas === null && (e.proxima > 1 || emVooDe(e.grouping) > 0)) continue;
    while (fora.length < quanto && podeEntregar(e)) {
      fora.push(despachar(e.grouping, e.proxima++));
      if (e.paginas === null) break;   // a semente é uma só; o resto espera ela voltar
    }
  }
  return fora;
}

// O que a rota `/local/proximas` entrega: páginas para uma aba que ficou livre.
// `fim` vai junto de propósito — ver o comentário de `fimDaRodada`.
function pedirProximas(n = 1) {
  if (!_local) return { proximas: [], fim: true, emVoo: 0 };
  tocarLocal();
  const proximas = proximasPaginas(Math.min(8, Math.max(1, Number(n) || 1)));
  return { proximas, fim: fimDaRodada(), emVoo: _local.emVoo.size };
}

// O contrato antigo, derivado do novo: UMA página. Os testes da rodada afirmam
// sobre ele em quase trinta casos, e com uma aba só ele é exatamente o mesmo
// objeto — manter é barato e é o que prova que o desenho novo não mudou o
// comportamento de quem não ligou o paralelismo.
const umaSo = (proximas) => proximas[0] ?? null;

// Começa a varredura pela extensão — a ETAPA 1 do fluxo de cupons.
//
// Ela é LEITURA PURA: abre a lista geral (`/cupons/filter?all=true&page=N`), lê o
// modelo de cada página e grava os cupons com suas condições. Nenhum clique em
// "Eu quero", nada escrito na conta do ML. Foi separada da etapa 2 justamente por
// isso: dá para rodá-la à vontade, e a escrita ficou toda no botão dos produtos.
//
// Duas exceções que continuam ativando aqui, e as duas de propósito:
//   - `procurar`: o "trazer campanha" do teste de palavra. Sem ativar aquele
//     cupom o ML não revela a vitrine dele, e a busca voltaria de mãos vazias
//     justo para a campanha que se foi buscar.
//   - `ativarApenas`: a etapa 2 chamando esta mesma varredura para ativar uma
//     lista de alvos. Os "Aplicar" só existem na lista, então não há outro lugar
//     de onde clicar.
//
// A regra de PARADA mora aqui, nunca na extensão: a extensão só abre a URL que
// este arquivo mandar e pede a próxima. É o que evita uma segunda varredura, com
// outros tetos, dentro da extensão.
function startLocalRun(overrides = {}) {
  expirarLocalSeSumiu();
  if (_status.running) throw new Error("Já tem uma rodada de cupons rodando — espere ela terminar.");
  if (_import.running) throw new Error("Tem uma busca de campanha rodando — espere ela terminar.");

  const procurar = overrides.procurar ? String(overrides.procurar).trim() : null;
  const ativarApenas = Array.isArray(overrides.ativarApenas)
    ? [...new Set(overrides.ativarApenas.map(String).filter(Boolean))]
    : null;
  const cfg = { ...readConfig(), ...overrides };

  // Os `overrides` entram CRUS: quem chama é a rota `/local/start` com o body da
  // tela (backend/server.js), e quem clampa a config — o `writeConfig` — não passa
  // por aqui. Até agora só o teto da lista tinha rede (o `= 200` que havia logo
  // abaixo); os outros dois viajavam do jeito que chegassem. Agora que "sem teto" é
  // um FLAG e não um número, dá pra fechar o buraco: número nenhum vindo de fora
  // vira `Infinity`, e limite de fora fica na mesma faixa que a tela de config
  // aceita.
  if (overrides.maxPaginasLista !== undefined)
    cfg.maxPaginasLista = inteiro(overrides.maxPaginasLista, { min: 1, max: 200, padrao: DEFAULT_CONFIG.maxPaginasLista });
  if (overrides.maxPaginasPorCategoria !== undefined)
    cfg.maxPaginasPorCategoria = inteiro(overrides.maxPaginasPorCategoria, { min: 1, max: 200, padrao: DEFAULT_CONFIG.maxPaginasPorCategoria });
  if (overrides.limiteCupons !== undefined)
    cfg.limiteCupons = inteiro(overrides.limiteCupons, { min: 0, max: 20000, padrao: DEFAULT_CONFIG.limiteCupons });

  // Buscar UMA campanha não é colher: o que segura a varredura passa a ser só o
  // teto de páginas, e os filtros de colheita saem da frente. A campanha
  // procurada PODE ser de loja, e descartá-la aqui é descartar o que se foi
  // buscar; estreitar as categorias esconderia a vertical em que ela está — e
  // quem testou a palavra não faz ideia de qual é.
  if (procurar) {
    cfg.limiteCupons = 0;
    cfg.carimbarCategorias = false;
    cfg.skipStoreCoupons = false;
  }
  // Ativar uma lista de alvos é a mesma coisa: quem chamou já sabe quem quer, e
  // varrer as verticais atrás deles seria dez vezes mais navegação com a conta do
  // sistema para achar cupom que a lista geral já mostra.
  if (ativarApenas) {
    cfg.limiteCupons = 0;
    cfg.carimbarCategorias = false;
    cfg.skipStoreCoupons = false;
  }
  // "Sem teto": o que segura a lista geral passa a ser o `pages` que o PRÓPRIO ML
  // declara, não um número nosso. É o que o botão 1 manda quando quem opera escolhe
  // "tudo o que o ML tiver" (task 20), e é o que o "Buscar TUDO" sempre quis dizer
  // — por isso o `tudo` implica isto, e não o contrário. Os dois continuam sendo
  // coisas diferentes: `tudo` quer dizer "esta passada é a do botão 3", que é o que
  // o `resumoDoFim` lê para NÃO sobrescrever o balanço do botão 1. Juntá-los faria
  // o botão 1, no modo sem teto, parar de gravar o próprio "última vez".
  //
  // São TRÊS tetos, e antes só um saía da frente. Os outros dois seguravam a mesma
  // promessa por baixo: o `limiteCupons` corta a colheita por número de cupons, e o
  // `maxPaginasPorCategoria` corta o CARIMBO — o cupom além dele entra sem
  // categoria, que é "veio pela metade" com outro nome.
  //
  // `Infinity`, e não 200: é o idioma que este arquivo já usa para não-teto (ver o
  // `restantes.n` mais abaixo), ele atravessa o `Number(x) || PADRÃO` do
  // `tetoDePaginas` intacto, e o `semTeto()` o devolve como `null` quando precisa
  // sair em JSON. 200 era um teto disfarçado de "sem teto": 200 × 30 = 6.000
  // cupons, e a conta pode ter mais.
  //
  // `semLimites` e não `semTeto`: `semTeto` já é o nome da função lá em cima.
  const semLimites = booleano(overrides.tudo, false) || booleano(overrides.semTeto, false);
  if (semLimites) {
    cfg.maxPaginasLista = Infinity;
    cfg.maxPaginasPorCategoria = Infinity;
    cfg.limiteCupons = 0;   // 0 aqui já quer dizer "sem teto" (ver `paginaLocal`)
  }
  // O carimbo é INCREMENTAL por padrão: só vai às verticais atrás do cupom que
  // ainda não tem categoria no banco, e para quando o último for achado (ver
  // `abrirCarimbo`). "Buscar TUDO" refaz a passada inteira — é o jeito de pegar
  // o cupom que mudou de vertical ou que está em mais de uma.
  const carimboCompleto = booleano(overrides.tudo, false) || booleano(overrides.carimboCompleto, false);

  // Quem pode receber "Aplicar" nesta varredura. `null` = ninguém — é a etapa 1
  // no seu modo normal, e é o que a torna segura de repetir.
  const alvos = procurar ? new Set([procurar]) : (ativarApenas ? new Set(ativarApenas) : null);
  const ativa = !!alvos && booleano(cfg.activateCoupons, DEFAULT_CONFIG.activateCoupons);

  _local = {
    t0: Date.now(),
    // O que esta passada É. Só a do botão 1 (`lista`, sem `tudo`) vira o balanço
    // dele: a ativação de um lote e a busca de uma campanha também passam pela
    // lista, e antes sobrescreviam o "última varredura" com os números delas.
    tipo: procurar ? "procurar" : (ativarApenas ? "ativacao" : "lista"),
    tudo: booleano(overrides.tudo, false),
    cfg,
    categorias: categoriasDaRodada(cfg, { procurar }),
    // A fila de trabalho, alinhada com `categorias` (ver `novaEntrada`). São duas
    // listas da mesma coisa de propósito: `categorias` é o que a rodada ANUNCIA
    // (a tela nomeia as verticais), `entradas` é como ela ANDA.
    entradas: [],
    // As páginas abertas agora, por "grouping#pagina". A rodada só acaba com ele
    // vazio — é o que distingue "não tenho página agora" de "acabou".
    emVoo: new Map(),
    // Páginas que voltaram para a fila porque a aba morreu com elas.
    refazer: [],
    // As chaves já processadas. Uma aba que refaz o POST depois de um timeout não
    // pode debitar o orçamento de ativação nem contar página duas vezes.
    paginasVistas: new Set(),
    // Quantas páginas a tela pode abrir ao mesmo tempo. `alvos ? 1` é a linha que
    // segura a escrita: `procurar` e `ativarApenas` CLICAM em "Eu quero" na conta
    // do ML, e a etapa 2 depende de essa passada ser serial. Mora aqui, e não na
    // tela, porque quem sabe o que a rodada é são estas linhas.
    paralelo: alvos ? 1 : Math.min(8, Math.max(1, Number(cfg.paginasDeListaEmParalelo) || 1)),
    // Quantas páginas já foram abertas na varredura inteira (todas as categorias
    // somadas). O `pagina` acima zera a cada categoria; este não — é ele que a
    // tela usa pra dizer o que foi varrido quando a busca não acha nada.
    paginasLidas: 0,
    porId: new Map(),
    ignoradosLoja: 0,
    ativados: 0,
    semBotao: 0,
    motivos: [],
    // Teto de ativações da VARREDURA inteira, não por categoria: o que se limita é
    // quantas escritas a conta do ML recebe de uma vez. `0` na config é SEM TETO
    // (ver DEFAULT_CONFIG), e aqui isso vira `Infinity` para o resto do arquivo
    // poder tratar teto e não-teto pela mesma conta — `n -= ativados` e `n <= 0`
    // funcionam igual nos dois casos.
    restantes: { n: ativa ? (Number(cfg.maxActivationsPerRun) > 0 ? Number(cfg.maxActivationsPerRun) : Infinity) : 0 },
    alvos,
    // Os alvos da ativação que já apareceram em alguma página, e quantos deles
    // já foram gravados pelo caminho. Quando todos os alvos foram vistos, a
    // varredura acaba — sem isto cada LOTE da etapa 2 varreria a lista inteira.
    vistos: new Set(),
    salvosTotal: 0,
    // O que o `porId` já recebeu, e o que dele já foi pro banco. É como o
    // `fimLocalRun` sabe se precisa gravar antes de soltar a rodada.
    //
    // Era um booleano `sujo`, e ele PERDIA cupom lido: o `false` era escrito
    // depois do `await persistRun`, então o cupom que chegasse durante a gravação
    // marcava "sujo" e tinha o rastro apagado logo em seguida — e o `fimLocalRun`,
    // que só grava quando há rastro, pulava a gravação final. Nunca aparecia como
    // erro: o cupom simplesmente não estava no banco. Com contador não existe o
    // que apagar — grava-se a versão que FOI gravada, e o que chegou depois segue
    // pendente por construção.
    versao: 0,
    gravado: 0,
    // Uma gravação por vez (ver `gravarCuponsLocais`).
    gravando: null,
    gravarDeNovo: false,
    persistido: null,
    ultimoContato: Date.now(),
    procurar,
    achou: false,
    carimboCompleto,
    // Os cupons que a passada de carimbo ainda precisa achar. `null` = carimbo
    // completo (ou ainda na lista geral); é montado no `abrirCarimbo`.
    semCategoria: null,
    // A promessa do `abrirCarimbo`, que roda uma vez só (ver `abrirCarimboUmaVezSo`).
    carimboPromessa: null,
    // Quantos eram no começo do carimbo — o "de N" da barra da tela (task 18).
    semCategoriaTotal: 0,
  };

  _status.running = true;
  _status.startedAt = new Date().toISOString();
  _status.progress = null;
  _status.log = [];
  logar("info", procurar
    ? `procurando a campanha ${procurar} no seu Chrome`
    : ativarApenas
      ? `ativando ${ativarApenas.length} cupom(ns) no seu Chrome${Number.isFinite(_local.restantes.n) ? `, até ${_local.restantes.n} nesta rodada` : " (sem teto por rodada)"}`
      : `começando no seu Chrome: ${textoDasCategorias(_local.categorias)}${semLimites
          ? ", sem teto de páginas (vai até o ML dizer que a lista acabou)"
          : `, até ${cfg.maxPaginasLista} páginas${cfg.limiteCupons ? ` ou ${cfg.limiteCupons} cupons` : ""}`}`);

  // `categorias` vai junto porque a tela precisa DIZER quais são: "todas as
  // categorias" sem nomeá-las foi o que escondeu por meses uma config presa em
  // Brinquedos (task 26).
  _local.entradas = _local.categorias.map(novaEntrada);
  // `paralelo` vai junto porque é a tela que dimensiona o pool de abas, e ela tem
  // de dimensioná-lo pelo que o SERVIDOR decidiu — não pela config que ela leu.
  const proximas = proximasPaginas(_local.paralelo);
  return { config: cfg, ativa, procurar, categorias: _local.categorias, paralelo: _local.paralelo, proximas, proxima: umaSo(proximas) };
}

// Quem ativar nesta página. A extensão manda o modelo cru, este lado devolve os
// rótulos exatos dos botões — e só os que o `aAtivar` aprovou.
function ativacoesLocais({ grouping = null, props = null } = {}) {
  if (!_local) throw new Error("Não tem rodada no Chrome em andamento.");
  tocarLocal();
  if (_local.restantes.n <= 0 || !_local.alvos) return { labels: [], restantes: 0 };
  const { coupons } = mlCupons.parseFilterProps(props, grouping);
  // Ativar é escrita irreversível na conta do ML, então só os ALVOS entram: quem
  // pediu a etapa 2 nomeou os cupons que quer, e gastar o teto nos vizinhos
  // deixaria justamente os alvos sem o "Eu quero" — que é o único jeito de o ML
  // revelar a vitrine deles.
  const candidatos = coupons.filter(c => _local.alvos.has(c.campaignId));
  // O `aAtivar` continua sendo quem decide: ele recusa cupom vencido, já ativado e
  // rótulo ambíguo — e só ativa `scope === "campaign"`.
  const escolhidos = mlCupons.aAtivar(candidatos, { max: _local.restantes.n });
  // `Infinity` não sobrevive ao JSON (vira `null` no meio do caminho), então quem
  // devolve o null é este lado, de propósito: a tela lê "null = sem teto" em vez de
  // mostrar "restam null" e parecer defeito.
  return { labels: escolhidos.map(c => c.activationLabel), restantes: semTeto(_local.restantes.n) };
}

// Uma página lida. Devolve o que a tela mostra e a próxima URL — ou o resumo,
// quando a varredura acabou e os cupons já foram gravados.
async function paginaLocal({ grouping = null, pagina = null, props = null, ativados = 0, semBotao = 0 } = {}) {
  // Com várias abas, uma página que volta depois de a rodada ter sido solta é
  // normal — a última a fechar não é a última a voltar. Isto lançava, e a tela
  // recebia um 400 no fim de toda rodada paralela.
  if (!_local) return { fim: true, proximas: [], proxima: null, cupons: 0, novos: 0, carimbados: 0, emVoo: 0 };
  tocarLocal();

  const entrada = entradaDe(grouping);
  // Sem `pagina` no corpo — a tela antiga, e os testes que dirigem a rodada à mão.
  // Com uma aba só existe no máximo uma página em voo por entrada, então ela é
  // identificável sem ambiguidade.
  const emVooDaEntrada = [..._local.emVoo.values()].filter(v => v.grouping === grouping);
  const nPagina = Number(pagina) || emVooDaEntrada[0]?.pagina || (entrada ? entrada.proxima : 1);
  const chave = chaveDaPagina(grouping, nPagina);
  // SEMPRE, e em todo caminho: uma chave que fica para trás é uma entrada que
  // nunca fica quieta, e uma rodada que só termina no watchdog de 5 minutos.
  _local.emVoo.delete(chave);
  // Repetida = esta página já foi processada. Uma aba que refaz o POST depois de
  // um timeout juntaria os cupons de novo (inofensivo, o merge é idempotente) mas
  // debitaria o orçamento de ativação duas vezes — e ativar é escrita na conta.
  const repetida = _local.paginasVistas.has(chave);
  _local.paginasVistas.add(chave);

  if (!repetida) {
    _local.ativados += Number(ativados) || 0;
    _local.semBotao += Number(semBotao) || 0;
    _local.restantes.n = Math.max(0, _local.restantes.n - (Number(ativados) || 0));
    _local.paginasLidas++;
    if (entrada) entrada.lidas++;
  }

  const parsed = mlCupons.parseFilterProps(props, grouping);
  const limite = Number(_local.cfg.limiteCupons) || 0;   // 0 = sem teto
  const pulaLoja = booleano(_local.cfg.skipStoreCoupons, DEFAULT_CONFIG.skipStoreCoupons);
  const paginas = parsed.pages || 1;
  // A passada por vertical não é coleta: ela existe para CARIMBAR a categoria nos
  // cupons que a lista geral já trouxe. O cupom novo que aparecer nela entra do
  // mesmo jeito (é cupom de verdade), mas ele não conta pro teto — o teto é sobre
  // o tamanho da colheita, e a colheita já aconteceu.
  const carimbo = grouping !== null;
  // A página 1 é quem revela o tamanho da entrada — e é por isso que ela vai
  // sozinha (ver `proximasPaginas`).
  if (entrada && entrada.paginas === null) entrada.paginas = paginas;

  // O que o ML disse sobre as categorias NESTA página. Vem antes de tudo porque é
  // o que faz a fila desta rodada crescer (task 14).
  aprenderCategorias(parsed, grouping, nPagina);

  let novos = 0;
  let carimbados = 0;
  for (const c of parsed.coupons) {
    // A campanha procurada é olhada ANTES de qualquer filtro. Ela é o motivo da
    // varredura existir: escopo de loja, teto e "já vi esse" são regras de
    // COLHEITA, e aplicá-las aqui responderia "não achei" para um cupom que
    // estava na página. Achar é o fim — as páginas seguintes só custariam
    // navegação com a conta do sistema.
    if (_local.procurar && c.campaignId === _local.procurar) {
      juntarCupom(c);
      novos++;
      _local.achou = true;
      break;
    }
    // Cupom de loja: por padrão ele ENTRA (é metade da lista do ML e a tela o
    // separa por `scope`). A config só existe para quem quiser a lista antiga.
    if (pulaLoja && c.scope === "store") { _local.ignoradosLoja++; continue; }
    const r = juntarCupom(c);
    if (r.carimbado) carimbados++;
    if (r.novo) {
      novos++;
      if (!carimbo && limite && _local.porId.size >= limite) break;
    }
  }

  const ondeEstou = carimbo ? ` de ${grouping}` : " da lista geral";
  const jaLidas = entrada ? entrada.lidas : nPagina;
  logar("info", `cupons: página ${nPagina}/${paginas}${ondeEstou} · ${_local.porId.size} cupons${carimbados ? `, ${carimbados} carimbados` : ""}${_local.ignoradosLoja ? `, ${_local.ignoradosLoja} de loja ignorados` : ""}`, { dedup: true });
  // `pagina` aqui é quantas páginas desta entrada já VOLTARAM, e não qual acabou
  // de voltar: com várias abas a última a voltar não é a mais adiantada, e a
  // frase do /status ficava pulando 9 → 7 → 11.
  _status.progress = { etapa: "cupons", pagina: jaLidas, de: paginas, cupons: _local.porId.size, ignoradosLoja: _local.ignoradosLoja, grouping, emVoo: _local.emVoo.size };

  const teto = tetoDePaginas(carimbo);
  // Carimbar também é novidade: ver `juntarCupom`. Sem isto a passada por vertical
  // morria na quinta página, porque nela nenhum cupom é novo por definição.
  if (entrada && (novos || carimbados)) entrada.ultimaComNovidade = Math.max(entrada.ultimaComNovidade, nPagina);
  // Modo ativação (etapa 2): grava AGORA os alvos que esta página mostrou. Eles
  // são o motivo da varredura, e o `containerUrl` que o "Eu quero" revela só vale
  // se chegar ao banco — antes ele só era gravado na última página, e um Parar no
  // meio perdia a ativação inteira (o clique já feito na conta, e nada no sistema).
  // Grava só os alvos, não o `porId` inteiro: é uma escrita pequena por página.
  let salvosNestaPagina = 0;
  if (_local.alvos && !_local.procurar) {
    const daPagina = parsed.coupons
      .filter(c => _local.alvos.has(c.campaignId))
      .map(c => _local.porId.get(c.campaignId) || c);
    for (const c of daPagina) _local.vistos.add(c.campaignId);
    if (daPagina.length) {
      await coupons.upsertCoupons(daPagina);
      salvosNestaPagina = daPagina.length;
      _local.salvosTotal += daPagina.length;
      logar("ok", `💾 gravei ${daPagina.length} cupom(ns) do lote nesta página (${_local.salvosTotal} de ${_local.alvos.size})`);
    }
  }

  // As paradas. Elas fecham a ENTREGA — de uma entrada ou de todas —, nunca a
  // rodada: o que já está em voo termina e os cupons daquelas páginas entram.
  //
  // As duas que sumiram desta lista não sumiram do comportamento: "o ML disse que
  // acabou" e "bateu no teto de páginas" viraram condição de ENTREGA
  // (`podeEntregar`), que é o que permite soltar as páginas 2..N de uma vez.
  if (_local.achou) fecharTudo(null);
  // Todos os alvos já passaram por uma página (ativados ou recusados pelo
  // `aAtivar`), ou o teto de ativações acabou: o resto da lista não tem mais nada
  // para esta varredura.
  else if (_local.alvos && !_local.procurar && (_local.vistos.size >= _local.alvos.size || _local.restantes.n <= 0)) fecharTudo(null);
  else if (entrada && !parsed.coupons.length) fecharEntrada(entrada, carimbo ? null : `A lista geral não devolveu cupom nenhum — pode ser a página do ML ter mudado.`);
  else if (entrada && !carimbo && limite && _local.porId.size >= limite) fecharEntrada(entrada, null);
  else if (entrada && semNovidadeDemais(entrada)) fecharEntrada(entrada, null);

  if (carimbo && _local.semCategoria) {
    for (const c of parsed.coupons) if (c.groupings.length) _local.semCategoria.delete(c.campaignId);
    if (!_local.semCategoria.size && !fimDaRodada()) {
      fecharTudo(null);
      logar("ok", `todos os cupons sem categoria já foram carimbados — pulei o resto das verticais`);
    }
  }
  // "Esta entrada ainda tem página?" — e `podeEntregar` FECHA a entrada quando a
  // resposta é não, carimbando o motivo. Perguntar aqui, e não só na hora de
  // despachar, é o que faz a pergunta seguinte ter resposta: a lista geral só é
  // reconhecida como terminada se alguém perguntar antes da barreira.
  if (entrada) podeEntregar(entrada);

  // A lista geral ficou QUIETA e a fila segue para as verticais: é a hora — e a
  // única — de decidir quais cupons ainda precisam de categoria. Quieta, e não
  // apenas fechada: com páginas ainda voltando, o `porId` está pela metade e o
  // carimbo decidiria de menos.
  if (_local.entradas.length > 1 && quieta(_local.entradas[0])) await abrirCarimboUmaVezSo();

  const proximas = proximasPaginas(vagas());
  const base = {
    cupons: _local.porId.size, novos, carimbados, ignoradosLoja: _local.ignoradosLoja, de: paginas, paginasLidas: _local.paginasLidas,
    achou: _local.achou, salvosNestaPagina, salvosTotal: _local.salvosTotal,
    emVoo: _local.emVoo.size,
    progresso: progressoDaLista({ entrada, paginas, teto }),
  };
  if (fimDaRodada()) return { ...base, proximas: [], proxima: null, fim: true, ...(await gravarCuponsLocais()) };
  // Uma entrada terminou e a fila segue: grava o que já tem. A fila passou de
  // quatro entradas para onze (task 14), e antes NADA ia pro banco antes da última
  // página da última vertical — um muro do ML, uma aba fechada ou o watchdog no
  // meio jogavam a rodada inteira fora. `persistRun` é upsert sobre o mesmo mapa
  // acumulado, então repetir é idempotente.
  if (entrada && !entrada.gravada && quieta(entrada)) {
    entrada.gravada = true;
    await gravarCuponsLocais({ parcial: true });
  }
  return { ...base, proximas, proxima: umaSo(proximas), fim: false, alvos: null };
}

// "A lista secou a partir daqui." Era um contador de páginas CONSECUTIVAS sem
// novidade, e "consecutivas" deixa de querer dizer alguma coisa quando várias
// páginas estão em voo: a 12 estéril volta antes da 8 rica, e um trecho seco
// enche o contador numa ida-e-volta só — cortando a lista muito antes das cinco
// páginas que a regra promete.
//
// Vira PROFUNDIDADE: a entrada fecha quando a página mais rasa que ainda falta já
// está mais de cinco páginas além da última que rendeu alguma coisa. Independe da
// ordem em que as páginas voltam, e com uma aba só dá exatamente o mesmo ponto de
// corte de antes.
function semNovidadeDemais(e) {
  let maisRasa = e.proxima;
  for (const v of _local.emVoo.values()) {
    if (v.grouping === e.grouping && v.pagina < maisRasa) maisRasa = v.pagina;
  }
  return maisRasa - e.ultimaComNovidade > mlCupons.MAX_PAGINAS_SEM_NOVIDADE;
}

// Onde a passada pela lista está, para as barras da tela (task 18). As três
// perguntas que o "página 4 de Casa" sozinho não respondia: quanto falta DESTA
// entrada da fila (`de` já com o teto, senão a barra nunca enche numa lista geral
// de 90 páginas cortada em 40), quantas entradas faltam, e — no carimbo e na
// ativação — quantos dos cupons procurados já apareceram, que é o que de fato
// encerra a varredura antes do fim das páginas.
function progressoDaLista({ entrada, paginas, teto }) {
  const labels = readGroupingLabels();
  const grouping = entrada ? entrada.grouping : null;
  // Quantas páginas desta entrada já voltaram — não qual acabou de voltar. Com
  // várias abas a última a voltar não é a mais adiantada, e uma barra alimentada
  // pelo número da página andava para trás.
  const lidas = entrada ? entrada.lidas : 1;
  return {
    grouping,
    nome: grouping ? (labels[grouping] || grouping) : null,
    pagina: lidas,
    de: Math.max(lidas, Math.min(paginas, teto)),
    categoria: entrada ? _local.entradas.indexOf(entrada) + 1 : 1,
    categorias: _local.entradas.length,
    // Quantas abas estão com página aberta agora. É o que deixa a tela dizer
    // "3 abas abertas" em vez de fingir um cursor que não existe mais.
    emVoo: _local.emVoo.size,
    carimbo: _local.semCategoria
      ? { total: _local.semCategoriaTotal, feitos: _local.semCategoriaTotal - _local.semCategoria.size }
      : null,
    alvos: _local.alvos && !_local.procurar ? { total: _local.alvos.size, vistos: _local.vistos.size } : null,
  };
}

// A lista geral acabou e a fila segue para as verticais. Elas existem só para
// carimbar categoria, e o banco já sabe a de quase todo cupom de uma rodada
// anterior — o `upsertCoupons` nunca apaga `groupings`. Sem isto, toda rodada
// relia a conta inteira uma vez por vertical, e era aí que ia quase todo o tempo.
// UMA vez por rodada, e a trava é escrita antes de qualquer await de propósito:
// o `campanhasComCategoria()` abaixo é um SELECT, e duas chamadas concorrentes
// passariam as duas pelo guard antes de qualquer uma escrever `semCategoria` —
// `semCategoriaTotal` seria sobrescrito, a barra da task 18 pularia para trás e o
// banco levaria a consulta em dobro. Quem chega depois espera a mesma promessa.
async function abrirCarimboUmaVezSo() {
  if (_local.carimboPromessa) return _local.carimboPromessa;
  _local.carimboPromessa = abrirCarimbo();
  return _local.carimboPromessa;
}

async function abrirCarimbo() {
  if (_local.carimboCompleto || _local.procurar || _local.alvos) return;
  const jaTem = await coupons.campanhasComCategoria();
  // Cupom vencido fica de fora: a faxina do `persistRun` o apaga do banco, então
  // ele nunca constaria como carimbado e seguraria o carimbo aberto toda rodada.
  const agora = Date.now();
  const faltam = [..._local.porId.values()]
    .filter(c => !c.groupings.length && !jaTem.has(c.campaignId))
    .filter(c => !c.expiresAt || new Date(c.expiresAt).getTime() > agora)
    .map(c => c.campaignId);
  if (!faltam.length) {
    fecharTudo(null);
    logar("ok", `todos os ${_local.porId.size} cupons já têm categoria no banco — pulei o carimbo por vertical`);
    return;
  }
  _local.semCategoria = new Set(faltam);
  _local.semCategoriaTotal = faltam.length;
  logar("info", `${faltam.length} cupom(ns) sem categoria — as verticais param assim que o último for achado`);
}

// O que esta página ensinou sobre as categorias do ML, e o que fazer com isso.
//
// Duas coisas, e as duas vêm de graça na resposta que a extensão já manda:
//
//   1. O DICIONÁRIO de nomes. `appliedFilters` traz `{ key, title }` da vertical
//      filtrada, e `availableGroupings` traz a lista completa de chaves (sem nome).
//      Juntas, elas são a única fonte de categoria que a rodada local tem — ela
//      nunca abre a aba /cupons, que era de onde isso vinha antes (commit 37a81d0).
//
//   2. A FILA desta rodada. Ela é montada no `startLocalRun`, ANTES de qualquer
//      página ter sido lida, a partir do que o dicionário já sabia. Se ele estava
//      congelado em três verticais, a rodada carimbava três — e como só se aprende
//      uma vertical visitando-a, ela nunca sairia dali sozinha. Por isso a fila
//      cresce aqui, na primeira página da lista geral, e não só na rodada seguinte.
//
// Quem escolheu categorias na tela (`cfg.categorias`) manda: descoberta não
// atropela escolha.
function aprenderCategorias(parsed, grouping, pagina = 1) {
  const chaves = [...(parsed.availableGroupings || []), ...(parsed.appliedFilters || [])];
  if (!chaves.length) return;
  const labels = mergeGroupingLabels(chaves);

  const naPrimeiraPaginaDaGeral = grouping === null && pagina === 1;
  const escolhidas = (_local.cfg.categorias || []).map(g => g?.key ?? g).filter(Boolean);
  if (!naPrimeiraPaginaDaGeral || escolhidas.length) return;
  if (!booleano(_local.cfg.carimbarCategorias, DEFAULT_CONFIG.carimbarCategorias)) return;
  if (_local.procurar || _local.alvos) return;

  // `verticaisConhecidas` é quem separa categoria de filtro: `price` e `percentage`
  // vêm na mesma lista do ML e carimbariam na coluna Categoria algo que não é
  // categoria ("Mais de 10%").
  const novas = verticaisConhecidas(labels).filter(k => !_local.categorias.includes(k));
  if (!novas.length) return;
  _local.categorias.push(...novas);
  // A fila de trabalho cresce junto: `categorias` é o que se anuncia, `entradas` é
  // por onde se anda, e as duas descrevendo a mesma rodada não podem divergir.
  _local.entradas.push(...novas.map(novaEntrada));
  logar("info", `o ML mostrou ${novas.length} categoria(s) que ainda não estavam na fila — agora a rodada é ${textoDasCategorias(_local.categorias, labels)}`);
}

// Junta um cupom ao que a varredura já tem. Devolve `{ novo, carimbado }`.
//
// O merge é o que faz o carimbo de categoria funcionar: o mesmo cupom aparece na
// lista geral (sem `groupings`) e depois na vertical dele (com), e o que precisa
// sobreviver é a união dos dois. Fica também a versão que TEM vitrine — é a única
// que serve pra raspar produto, e o ML repete o card em estados diferentes.
//
// `carimbado` é separado de `novo` porque as duas coisas são PROGRESSO, e antes só
// a primeira contava (task 14): numa passada de carimbo todo cupom já é conhecido,
// então `novo` era falso em toda página, o contador de "páginas sem novidade"
// enchia em cinco e a vertical era cortada aí — independente do
// `maxPaginasPorCategoria`. Ganhar uma categoria É novidade.
function juntarCupom(c) {
  const anterior = _local.porId.get(c.campaignId);
  if (!anterior) { _local.porId.set(c.campaignId, c); _local.versao++; return { novo: true, carimbado: false }; }
  let carimbado = false;
  for (const g of c.groupings) {
    if (anterior.groupings.includes(g)) continue;
    anterior.groupings.push(g);
    carimbado = true;
  }
  const ganhouVitrine = !anterior.containerUrl && !!c.containerUrl;
  if (ganhouVitrine) Object.assign(anterior, c, { groupings: anterior.groupings });
  if (carimbado || ganhouVitrine) _local.versao++;
  return { novo: false, carimbado };
}

// A lista acabou: grava os cupons e diz quais vitrines valem a pena abrir.
//
// Grava ANTES das vitrines porque o `gravarVitrineLocal` exige o cupom no banco —
// e porque cupom guardado sem vitrine já é melhor que nada se o Chrome fechar no
// meio da colheita.
// UMA gravação por vez. `persistRun` é um upsert multi-linha
// (`coupons/pg.js:41-109`), e duas transações tocando o mesmo conjunto em ordens
// diferentes deadlockam no Postgres. Hoje a ordem sai sempre do mesmo Map e
// coincide por acaso — acaso que a primeira página em voo a mais desfaz.
//
// Quem chega durante uma gravação não espera na fila: marca que ficou coisa nova
// para trás e a própria gravação em curso repete. É o `gravado` que diz se
// sobrou — não um "quem chegou por último ganha".
async function gravarCuponsLocais({ parcial = false } = {}) {
  const local = _local;
  if (local.gravando) { local.gravarDeNovo = true; return local.gravando; }
  local.gravando = (async () => {
    let r;
    do {
      local.gravarDeNovo = false;
      r = await gravarAgora(local, { parcial });
    } while (local.gravarDeNovo);
    return r;
  })();
  try { return await local.gravando; }
  finally { local.gravando = null; }
}

// `local` vem por argumento e não do módulo: o `fimLocalRun` solta o `_local`
// antes de gravar, e esta função continua precisando falar da rodada que a
// chamou.
async function gravarAgora(local, { parcial = false } = {}) {
  // Os dois lidos no MESMO instante, antes de qualquer await: é o que faz o
  // cupom que chegar durante a gravação continuar pendente em vez de ser dado
  // como salvo.
  const versao = local.versao;
  const cupons = [...local.porId.values()];
  // `vitrines: []` de propósito: quem grava produto na rodada local é o
  // `gravarVitrineLocal`, cupom a cupom, com o que a extensão colheu.
  const resumo = await persistRun({ cupons, vitrines: [], ativados: local.ativados, ignoradosLoja: local.ignoradosLoja, avisos: local.motivos });
  local.persistido = resumo;
  local.gravado = versao;
  logar("ok", parcial
    ? `gravei o que já tem: ${resumo.cupons} cupons — faltam ${local.entradas.filter(e => !e.fechada).length} categoria(s)`
    : `lista pronta: ${resumo.cupons} cupons (${resumo.novos} novos)${local.ativados ? `, ${local.ativados} ativados` : ""}`);
  // `alvos` só sai numa BUSCA. Na etapa 1 normal ele seria a lista inteira, e a
  // tela sairia raspando vitrine atrás de vitrine — que é exatamente o que a
  // separação em dois botões desfez: os produtos são a etapa 2, e quem decide
  // quando ela roda é o Allan, porque ela escreve na conta do ML.
  const alvos = local.procurar
    ? cupons
      .filter(c => c.containerUrl && c.campaignId === local.procurar)
      .map(c => ({ campaignId: c.campaignId, title: c.title, containerUrl: c.containerUrl }))
    : null;
  return { alvos, resumo, achou: local.achou };
}

// Fim da rodada. `vitrines` é o que a tela conseguiu colher depois — só contagem,
// porque os produtos já foram gravados um a um pelo `vitrine-local`.
//
// Interrompida ou não, o que a varredura já leu VAI pro banco. Antes o cancelamento
// só soltava o `_local`, e numa rodada de categoria única (a ativação da etapa 2 é
// sempre assim) isso era perder tudo: a gravação só acontecia na última página.
// A rodada é solta ANTES de gravar, para o watchdog (que chama isto de dentro do
// `startLocalRun`) não travar a próxima rodada esperando o banco.
async function fimLocalRun({ vitrines = [], produtos = 0, cancelada = false } = {}) {
  if (!_local) return { ok: false, reason: "Não tinha rodada no Chrome em andamento." };
  const local = _local;
  const resumo = resumoDoFim(local, { vitrines, produtos, cancelada });
  _local = null;
  _status.running = false;
  _status.progress = null;

  let salvos = 0;
  // Uma gravação em curso é esperada antes desta: duas transações sobre as mesmas
  // linhas é o deadlock que o single-flight do `gravarCuponsLocais` existe para
  // evitar, e o `gravado` que ela deixar pode tornar esta aqui desnecessária.
  if (local.gravando) await local.gravando.catch(() => {});
  if (local.versao > local.gravado && local.porId.size) {
    try {
      const r = await persistRun({ cupons: [...local.porId.values()], vitrines: [], ativados: local.ativados, ignoradosLoja: local.ignoradosLoja, avisos: local.motivos });
      salvos = r.cupons;
      logar("ok", `💾 gravei o que já tinha antes de ${cancelada ? "parar" : "fechar"}: ${r.cupons} cupons (${r.novos} novos)`);
    } catch (err) {
      logar("erro", `não consegui gravar o que a rodada tinha lido: ${err.message}`);
    }
  }
  persistStatus();
  return { ok: true, resumo: { ...resumo, salvos } };
}

// O resumo que a tela e o `/status` mostram do fim da rodada.
function resumoDoFim(local, { vitrines, produtos, cancelada }) {
  const base = local.persistido || { cupons: local.porId.size, novos: 0, atualizados: 0, avisos: [] };
  const resumo = {
    ...base,
    ativados: local.ativados,
    cuponsComVitrine: Number(vitrines) || 0,
    vinculos: Number(produtos) || 0,
    cuponsDeLojaIgnorados: local.ignoradosLoja,
    avisos: [...(base.avisos || []), ...local.motivos].filter(Boolean),
    cancelada: !!cancelada,
    origem: "extensao",
  };
  if (local.tipo === "lista" && !local.tudo) {
    _status.ultimas.lista = {
      at: new Date().toISOString(),
      duracaoMs: Date.now() - local.t0,
      resultado: resumo,
      erro: resumo.avisos.length ? resumo.avisos.join(" ") : null,
      interrompida: !!cancelada,
    };
  }
  logar(cancelada ? "aviso" : "ok", cancelada
    ? "rodada no seu Chrome interrompida"
    : `terminou em ${Math.round((Date.now() - local.t0) / 1000)}s: ${resumo.cupons} cupons (${resumo.novos} novos), ${resumo.ativados} ativados, ${resumo.cuponsComVitrine} vitrines`);
  return resumo;
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
//
// `carimbar: false` é de quem grava em lote: o `syncCatalogCoupons` varre a tabela
// de vínculos inteira, e fazê-lo a cada cupom seria a mesma conta repetida. Quem
// passa isso carimba uma vez no fim.
async function gravarVitrine(campaignId, cupom, produtos, { parcial, carimbar = true }) {
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
  if (carimbar) await coupons.syncCatalogCoupons();
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

// Teto de SANIDADE do payload, não a regra de negócio: quem decide quantos produtos
// um cupom guarda é `maxProductsPerCoupon`, e o `gravarVitrineLocal` corta nele
// marcando `parcial`. Quando os dois números eram o mesmo, um lote acima do teto
// era RECUSADO inteiro em vez de cortado — foi o que aconteceu com uma vitrine de
// 1040 produtos: 22 abas abertas na conta do ML e nada gravado. Este número só
// existe para barrar payload absurdo chegando na rota.
const MAX_PRODUTOS_DA_VITRINE = 2000;

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
//
// `carimbar: false` é da etapa 2 com vitrines em paralelo: o `syncCatalogCoupons`
// varre a tabela de vínculos inteira, e rodá-lo a cada vitrine era a mesma conta
// repetida — com gravações concorrentes, disputando o banco. A tela carimba uma
// vez por lote (`carimbarCatalogo`).
async function gravarVitrineLocal(campaignId, lista, { parcial = false, carimbar = true } = {}) {
  const cupom = await coupons.getCoupon(campaignId);
  if (!cupom) throw new Error("Esse cupom não está no sistema — puxe os cupons primeiro.");

  const { produtos, descartados } = validarProdutosDaVitrine(lista);

  // O teto de produtos por cupom é da config, e cortar aqui torna a lista PARCIAL
  // — obrigatoriamente. Uma vitrine truncada gravada como lista fechada faria o
  // quick-check responder "fora da vitrine" para produto que o cupom cobre, que é
  // o prejuízo que este arquivo inteiro existe pra evitar.
  const teto = Number(readConfig().maxProductsPerCoupon) || DEFAULT_CONFIG.maxProductsPerCoupon;
  const cortou = produtos.length > teto;
  const r = await gravarVitrine(campaignId, cupom, cortou ? produtos.slice(0, teto) : produtos, {
    parcial: !!parcial || cortou,
    carimbar,
  });
  return { ...r, descartados: descartados.length, cortadosPeloTeto: cortou ? produtos.length - teto : 0 };
}

// O carimbo adiado do `gravarVitrineLocal({ carimbar: false })`: uma vez por lote.
async function carimbarCatalogo() {
  const r = await coupons.syncCatalogCoupons();
  return { carimbados: r.carimbados, limpos: r.limpos };
}

// Quem ainda precisa de produtos — a fila da ETAPA 2.
//
// Devolve os dois grupos separados porque eles custam coisas diferentes:
// `prontos` é abrir a vitrine e ler (leitura pura), `precisamAtivar` exige um
// clique em "Aplicar" na lista do ML, que é ESCRITA irreversível na conta do
// sistema. A tela mostra os dois números antes de o Allan apertar o botão, e a
// config decide se o segundo grupo entra.
async function alvosDeProdutos({ limit = 500, campaignIds = null, soSemProdutos = false } = {}) {
  const cfg = readConfig();
  const r = await coupons.couponsSemVitrine({ limit, campaignIds, soSemProdutos });
  const ativa = booleano(cfg.activateCoupons, DEFAULT_CONFIG.activateCoupons);
  return {
    ...r,
    // Os knobs que a tela precisa para conduzir o laço. Vêm daqui e não da tela
    // pelo mesmo motivo de sempre: um teto escrito em dois lugares diverge.
    config: {
      // A extensão corta a colheita aqui. Sem isto ela só sabia contar páginas, e
      // página não prevê quantidade: 11 páginas de uma vitrine grande vieram com
      // 1040 produtos, acima do teto do `import`, que recusava o lote inteiro.
      maxProductsPerCoupon: Number(cfg.maxProductsPerCoupon) || DEFAULT_CONFIG.maxProductsPerCoupon,
      maxPaginasVitrine: Number(cfg.maxPaginasVitrine) || DEFAULT_CONFIG.maxPaginasVitrine,
      pausaEntreVitrinesMs: Number(cfg.pausaEntreVitrinesMs) || DEFAULT_CONFIG.pausaEntreVitrinesMs,
      pausaEntreCiclosMs: Number(cfg.pausaEntreCiclosMs) || DEFAULT_CONFIG.pausaEntreCiclosMs,
      maxCiclos: Number(cfg.maxCiclos) || DEFAULT_CONFIG.maxCiclos,
      tamanhoLoteProdutos: Number(cfg.tamanhoLoteProdutos) || DEFAULT_CONFIG.tamanhoLoteProdutos,
      vitrinesEmParalelo: Math.min(4, Math.max(1, Number(cfg.vitrinesEmParalelo) || DEFAULT_CONFIG.vitrinesEmParalelo)),
      activateCoupons: ativa,
      // Três valores distintos, e a tela precisa dos três separados: `0` é
      // "ativação desligada", `null` é "ligada, sem teto", número é o teto. Antes
      // daqui os dois primeiros eram o mesmo 0 — o que só não enganava ninguém
      // porque não existia jeito de pedir "sem teto".
      maxActivationsPerRun: ativa ? (Number(cfg.maxActivationsPerRun) > 0 ? Number(cfg.maxActivationsPerRun) : null) : 0,
    },
  };
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
// `importStatus()`, que é o que a tela lê enquanto acompanha: quem espera por isso
// dentro da requisição bate no teto do proxy.
function importStatus() {
  return { ..._import };
}

async function startImport(campaignId, { withProducts = true } = {}) {
  const id = String(campaignId || "").trim();
  if (!id) throw new Error("Sem campanha para buscar.");
  // O id da campanha é sempre numérico. A guarda passou a valer a pena quando a aba
  // "Cupons do ML" ganhou a caixa de digitar o número: um typo aqui não erra rápido —
  // ele faz o `findCampaign` varrer as 40 páginas da lista de cupons navegando com a
  // conta do sistema, para não achar nada. Custa minutos e uma chance de CAPTCHA.
  if (!/^\d+$/.test(id)) {
    throw new Error(`"${id}" não é um número de campanha — o id do cupom só tem dígitos.`);
  }

  // As recusas ficam aqui, ANTES de disparar: elas viram 400 com mensagem na tela.
  // Depois que a promessa larga não há mais para quem responder.
  //
  // Uma conta só: dois Chromes nela ao mesmo tempo dobram a chance de CAPTCHA, e o
  // CAPTCHA derruba o Hub junto. Mesmo motivo do DELETE /api/admin/ml-cupons.
  if (_status.running) {
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
  startLocalRun,
  ativacoesLocais,
  paginaLocal,
  pedirProximas,
  fimLocalRun,
  registrarRodada,
  localAtivo,
  status,
  readConfig,
  writeConfig,
  persistRun,
  syncOneCoupon,
  gravarVitrine,
  gravarVitrineLocal,
  carimbarCatalogo,
  alvosDeProdutos,
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
