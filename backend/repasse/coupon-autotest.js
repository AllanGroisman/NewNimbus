// O robô que testa no Mercado Livre os cupons que a captura pescou nas legendas
// dos grupos líderes, e traz pro sistema a campanha de quem passou.
//
// Até aqui esse cupom seguia até a mensagem do cliente sem ninguém nunca perguntar
// ao ML se o código existia: testar a palavra e trazer a campanha eram o botão da
// linha em Admin › Cupom › Repasse, e o filtro padrão da aba era "nunca testados"
// justamente porque era o estado de quase todas as linhas.
//
// O motivo de ter ficado manual não desapareceu: cada teste abre um Chrome inteiro
// com a sessão do ML (15 a 50s por palavra) e rajada de Chrome é o que acorda o
// anti-robô. Este módulo não resolve isso testando menos — resolve testando em
// RODADAS ESPAÇADAS e desistindo na primeira parede:
//
//   - roda no processo do SERVER, não no worker onde o cupom nasce. A fila de
//     trabalho já é uma consulta ao banco (repasse/coupons.js:aggregate), então o
//     job não precisa estar perto do evento — e os mutex do coupons/sync.js são
//     variáveis de módulo, por PROCESSO: no server o job os respeita e aparece no
//     mesmo status() que a tela lê; no worker ele abriria um segundo Chrome na
//     mesma conta do ML no meio de uma rodada do admin, sem ninguém ver.
//   - uma palavra por vez, com pausa entre elas (não existe rate limit nenhum
//     dentro do checkWord: as pausas do ml-cupons.js são internas a uma vitrine).
//   - CAPTCHA/muro de login ABORTA a rodada e arma um breaker. Insistir em
//     bloqueio é o caminho mais curto pra queimar a conta do sistema.
//
// O que ele NÃO faz: mexer no que a captura envia. Cupom que o ML recusa continua
// indo na mensagem — o veredito aparece no log e na tela, e a decisão de segurar
// ou não é humana.
const cfgStore = require("./coupon-autotest-config");
const { logAutotest, ACTION } = require("./coupon-autotest-log");
const repasseCoupons = require("./coupons");
const { classifyFromText, BLOCK_KINDS, KIND } = require("./error-kinds");

const HORA_MS = 3600_000;

// Quanto esperar pela importação disparada pelo startImport. Ela roda solta (a
// tela acompanha pelo status), mas aqui a rodada precisa saber o desfecho pra
// logar — e precisa de um teto, senão uma importação travada segura o job pra
// sempre. `findCampaign` varre até 40 páginas com pausa: minutos, não segundos.
const IMPORT_TIMEOUT_MS = 10 * 60_000;
const IMPORT_POLL_MS = 3_000;

// Não dispara no pico da subida: o boot já tem Baileys, scheduler e scraper
// acordando juntos, e esta rodada abre Chrome.
const FIRST_RUN_MS = 4 * 60_000;

const SLEEP_REAL = process.env.NODE_ENV !== "test";
const sleep = (ms) => new Promise(r => setTimeout(r, SLEEP_REAL ? ms : 0));

let timers = [];
let _running = false;
// O que a tela mostra da última rodada. `bloqueadoAte` é o breaker, e ele é de
// propósito o único estado que sobrevive entre rodadas.
const _status = {
  lastRunAt: null,
  lastDuration: null,
  testados: 0,
  importados: 0,
  vitrines: 0,
  // O motivo por que a ÚLTIMA rodada não fez nada. Um contador cumulativo aqui
  // diria "12 puladas" sem dizer por quê, que é a única coisa que se quer saber.
  pulada: null,
  bloqueadoAte: null,
  lastError: null,
  nextRunAt: null,
};

// ── A decisão ────────────────────────────────────────────────────────────
// Pura, e é aqui que mora a regra que custa Chrome — mesma razão do
// coupons/quick-check.js:decide ser pura: precisa ser testável sem banco e sem
// rede, porque errar aqui é abrir navegador à toa na conta do sistema.
//
// Recebe as linhas do repasse/coupons.js:aggregate (código + o que o sistema já
// sabe dele) e devolve a lista de trabalho, já ordenada e cortada pelos tetos.
function selecionar(linhas, cfg, agora = Date.now()) {
  const testes = [];
  const importacoes = [];
  const vitrines = [];

  for (const l of Array.isArray(linhas) ? linhas : []) {
    if (!l || !l.code) continue;

    // Palavra que apareceu pouco raramente paga o Chrome que custa.
    if ((l.capturas || 0) < cfg.minCapturas) continue;

    if (l.verdict == null) {
      testes.push({ code: l.code, motivo: "nunca-testado", linha: l });
      continue;
    }

    // O ML não CHEGOU a avaliar (engasgo, CAPTCHA, muro). Diferente de "não
    // existe" — e o único veredito que volta pra fila.
    //
    // A espera é obrigatória, não cosmética: coupons/pg.js:findCodeCheck devolve
    // null pra indeterminado, ou seja isto NÃO entra no cache de 12h do checkWord.
    // Sem a espera o job reabriria Chrome na mesma palavra a cada rodada.
    if (l.verdict === "indeterminado") {
      const idade = l.checkedAt ? agora - new Date(l.checkedAt).getTime() : Infinity;
      if ((l.checkCount || 0) < cfg.maxTentativas && idade >= cfg.esperaAposIndeterminadoHoras * HORA_MS) {
        testes.push({ code: l.code, motivo: "indeterminado", linha: l });
      }
      continue;
    }

    // Resposta fechada: o ML não reconheceu a palavra. Não há checkout que mude
    // isso, e mandar o Chrome atrás seria só queimar a conta à toa.
    if (l.verdict === "invalid") continue;

    // Daqui pra baixo a palavra é uma campanha de verdade. O que falta é trazê-la.
    if (!l.campaignId) continue;

    if (!l.inSystem) {
      if (cfg.importarCampanha) importacoes.push({ code: l.code, campaignId: l.campaignId, linha: l });
      continue;
    }
    // A campanha está aqui mas a vitrine nunca foi raspada. Isso é FALTA DE DADO,
    // não "o cupom não vale nada": sem os vínculos o quick-check fica em
    // "sem-vitrine" pra sempre e o desconto nunca entra na conta do envio.
    if ((l.produtos || 0) === 0 && cfg.rasparVitrine) {
      vitrines.push({ code: l.code, campaignId: l.campaignId, linha: l });
    }
  }

  // Cupom que de fato chegou à fila vale mais Chrome que cupom de link descartado;
  // entre dois iguais, o visto mais recentemente.
  const porValor = (a, b) =>
    (b.linha.aproveitados || 0) - (a.linha.aproveitados || 0) ||
    new Date(b.linha.ultima || 0) - new Date(a.linha.ultima || 0);

  testes.sort((a, b) => {
    // Nunca testado antes de reteste: a primeira resposta vale mais que a segunda
    // opinião sobre um engasgo.
    if (a.motivo !== b.motivo) return a.motivo === "nunca-testado" ? -1 : 1;
    return porValor(a, b);
  });
  importacoes.sort(porValor);
  vitrines.sort(porValor);

  // Importação e vitrine dividem o mesmo teto: as duas são minutos de Chrome, e a
  // importação ainda por cima ESCREVE na conta do ML (o clique em "Eu quero").
  const trabalhoPesado = [
    ...importacoes.map(x => ({ ...x, action: ACTION.IMPORT })),
    ...vitrines.map(x => ({ ...x, action: ACTION.VITRINE })),
  ].slice(0, cfg.maxImportsPorRodada);

  return {
    testes: testes.slice(0, cfg.maxPorRodada),
    pesado: trabalhoPesado,
  };
}

// O ML barrou? `checkWord` não devolve o `kind` que o checkCouponWord classificou
// — só `verdict: "indeterminado"` e um texto. Reaproveita o classificador do
// próprio repasse (error-kinds.js) em vez de uma regex nova aqui: os dois lados
// têm que concordar sobre o que é CAPTCHA, e há teste garantindo isso.
function kindDoBloqueio(texto) {
  const kind = classifyFromText(texto);
  return BLOCK_KINDS.has(kind) ? kind : null;
}

// ── A rodada ─────────────────────────────────────────────────────────────
async function runOnce({ manual = false } = {}) {
  if (_running) return { skipped: "ja-rodando" };
  const cfg = cfgStore.readConfig();
  // O "Rodar agora" da tela passa por cima do desligado: é um pedido explícito.
  if (!cfg.enabled && !manual) return { skipped: "desligado" };

  const sync = require("../coupons/sync");
  const affiliate = require("../scraping/affiliate");

  const resumo = { testados: 0, importados: 0, vitrines: 0, bloqueado: false, pulada: null };
  const pular = async (motivo, message) => {
    resumo.pulada = message;
    await logAutotest({ code: "-", action: ACTION.SKIP, ok: false, message });
    return { skipped: motivo };
  };

  _running = true;
  const t0 = Date.now();
  try {
    // O mesmo cuidado do sync.startImport: rodada do admin em curso e este job são
    // dois Chromes na mesma conta. Funciona porque os dois vivem neste processo.
    const st = sync.status();
    if (st.running) return await pular("rodada-em-curso", "Tem uma rodada de cupons do admin rodando — a rodada automática ficou pra próxima.");
    if (st.importing) return await pular("import-em-curso", "Tem uma busca de campanha em curso — a rodada automática ficou pra próxima.");

    // O breaker segura a AGENDA, não a pessoa: "Rodar agora" é um pedido explícito
    // de quem está olhando a tela e vê o aviso de bloqueio — mesmo espírito do
    // `force: true` do botão Testar da linha. Sem essa saída, um CAPTCHA às 9h
    // deixaria o admin sem nenhum jeito de tentar antes das 10h.
    if (_status.bloqueadoAte && Date.now() < new Date(_status.bloqueadoAte).getTime()) {
      if (!manual) {
        return await pular("bloqueado", `O ML barrou o teste automático; ele volta a tentar em ${new Date(_status.bloqueadoAte).toLocaleString("pt-BR")}.`);
      }
      _status.bloqueadoAte = null;
    }

    // Sem cookie o checkWord lançaria em cada palavra. Uma linha de log explicando
    // vale mais que cinco exceções iguais.
    const session = affiliate.getScraperMLSession();
    if (!session?.cookie) {
      return await pular("sem-sessao", "Sem sessão do Mercado Livre do sistema — cole o cookie em Admin › Mercado Livre.");
    }

    const linhas = await repasseCoupons.aggregate({ days: cfg.diasDeBusca });
    const { pesado } = selecionar(linhas, cfg);

    // As palavras NÃO são mais testadas aqui. O teste de palavra solta em /cupons,
    // neste Chrome do servidor, voltava "o ML não respondeu" para todo cupom (o ML
    // barra o Puppeteer). O teste agora é no checkout do produto, na aba do admin
    // pela extensão — a fila dele é o `pendentesCheckout` abaixo.
    // ── A campanha e a vitrine ──
    // Só se a rodada não bateu numa parede: importar é mais Chrome, e mais longo.
    if (!resumo.bloqueado) {
      for (const alvo of pesado) {
        try {
          if (alvo.action === ACTION.IMPORT) {
            const r = await importarEsperando(sync, alvo.campaignId, cfg);
            await logAutotest({
              code: alvo.code, action: ACTION.IMPORT,
              ok: !!r.ok, campaignId: alvo.campaignId,
              produtos: r.produtos ?? null,
              message: r.message || null,
            });
            if (r.ok) resumo.importados += 1;
          } else {
            // A vitrine da página do cupom, no Chrome do servidor.
            const r = await sync.syncOneCoupon(alvo.campaignId);
            const produtos = r?.produtos ?? r?.vinculos ?? null;
            await logAutotest({
              code: alvo.code, action: ACTION.VITRINE,
              ok: !!produtos, campaignId: alvo.campaignId, produtos,
              message: produtos ? null : "O ML não devolveu produto nenhum pra essa campanha.",
            });
            if (produtos) resumo.vitrines += 1;
          }
        } catch (err) {
          await logAutotest({
            code: alvo.code, action: alvo.action, ok: false,
            campaignId: alvo.campaignId,
            errorKind: classifyFromText(err.message),
            message: err.message,
          });
        }
      }
    }

    _status.lastError = null;
    return resumo;
  } catch (err) {
    _status.lastError = err.message;
    console.error(`[repasse] teste automático de cupom falhou: ${err.message}`);
    return { error: err.message };
  } finally {
    _running = false;
    _status.lastRunAt = new Date().toISOString();
    _status.lastDuration = Date.now() - t0;
    _status.importados = resumo.importados;
    _status.vitrines = resumo.vitrines;
    _status.pulada = resumo.pulada;
  }
}

// `startImport` e não `importCampaign` direto: é ele que pega o mutex `_import` e
// alimenta o status que a tela do admin já mostra — a importação do robô aparece
// no mesmo lugar que a do botão. Em troca ela roda solta, e a rodada tem que
// esperar o desfecho pra saber o que logar.
async function importarEsperando(sync, campaignId, cfg) {
  const r = await sync.startImport(campaignId, { withProducts: cfg.rasparVitrine });
  if (r?.already) return { ok: true, produtos: null, message: "A campanha já estava no sistema." };

  // O teto é em NÚMERO de espiadas, não em Date.now(): sob teste o sleep é
  // instantâneo, e um limite de relógio viraria dez minutos de giro em vazio.
  const espiadas = Math.ceil(IMPORT_TIMEOUT_MS / IMPORT_POLL_MS);
  for (let i = 0; i < espiadas; i++) {
    await sleep(IMPORT_POLL_MS);
    const st = sync.importStatus();
    if (st.running) continue;
    if (st.error) return { ok: false, message: st.error };
    const res = st.result || {};
    return { ok: !!res.ok, produtos: res.produtos ?? null, message: res.reason || res.avisoVitrine || null };
  }
  return { ok: false, message: "A busca da campanha passou do tempo — veja Admin › Cupom › Cupons do ML." };
}

// ── O teste no checkout (task 7) ─────────────────────────────────────────
// Quem testa é a aba Admin › Cupom › Repasse, pela extensão: ela pergunta o que
// está pendente, reivindica um código, roda o comando `cupom-no-checkout` no link
// do produto e manda o material cru de volta. Mesmo modelo da agenda das etapas
// (coupons/agenda.js): o servidor sabe O QUE falta, o Chrome do admin FAZ.

// Quanto tempo uma aba segura um código reivindicado. O teste leva de 20s a 1min;
// com um muro, a extensão espera o humano até 5 min. Passado isso, a aba morreu.
const RESERVA_MS = 10 * 60_000;
const _reservas = new Map();   // code → expira em (ms)

function reservado(code, agora = Date.now()) {
  const ate = _reservas.get(code);
  if (ate && ate > agora) return true;
  _reservas.delete(code);
  return false;
}

// O teste de palavra do robô antigo não conta como tentativa: aquele
// "indeterminado" era o Chrome do servidor barrado, não uma resposta sobre o
// cupom. Sem isto, os cupons que ele já tentou 3 vezes nunca entrariam na fila.
const FONTES_DO_CHECKOUT = new Set(["repasse-checkout", "repasse-checkout-auto"]);
function paraAFila(l) {
  if (l?.verdict === "indeterminado" && !FONTES_DO_CHECKOUT.has(l.source)) {
    return { ...l, verdict: null, checkCount: 0 };
  }
  return l;
}

// A fila inteira, para a tela ver e para a aba consumir. Sempre devolve a lista —
// desligar o automático não esconde o que está pendente; quem obedece o `auto` é o
// laço da aba. Os pedidos manuais vêm primeiro: alguém escolheu aquele link.
async function pendentesCheckout({ limit = 50 } = {}) {
  const { prisma } = require("../db");
  const cfg = cfgStore.readConfig();
  const teto = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
  const bloqueado = !!(_status.bloqueadoAte && Date.now() < new Date(_status.bloqueadoAte).getTime());

  const manuais = await prisma().repasseCupomManual.findMany({
    where: { testedAt: null },
    orderBy: { createdAt: "asc" },
    take: 200,
  });
  const itens = [];
  const vistos = new Set();
  for (const m of manuais) {
    if (vistos.has(m.code)) continue;
    vistos.add(m.code);
    itens.push({
      origem: "manual", manualId: String(m.id), code: m.code, url: m.url,
      criadoEm: m.createdAt, motivo: "manual", reservado: reservado(m.code),
    });
  }

  const linhas = (await repasseCoupons.aggregate({ days: cfg.diasDeBusca })).map(paraAFila);
  const { testes } = selecionar(linhas.filter(l => l.link), { ...cfg, maxPorRodada: Infinity });
  for (const t of testes) {
    if (vistos.has(t.code)) continue;
    vistos.add(t.code);
    itens.push({
      origem: "repasse", code: t.code, url: t.linha.link, motivo: t.motivo,
      capturas: t.linha.capturas, criadoEm: t.linha.primeira, ultima: t.linha.ultima,
      reservado: reservado(t.code),
    });
  }

  return {
    itens: itens.slice(0, teto),
    total: itens.length,
    auto: cfg.checkoutAuto && !bloqueado,
    checkoutAuto: cfg.checkoutAuto,
    bloqueadoAte: bloqueado ? _status.bloqueadoAte : null,
  };
}

// Um teste pedido à mão: link do produto + código. Valida aqui, e não só na tela,
// porque esse link vai ser aberto no Chrome do admin com a conta do ML.
const CODIGO_RE = /^[A-Z0-9-]{3,30}$/;
async function adicionarManual({ code, url, userId = null }) {
  const { prisma } = require("../db");
  const { detectStore } = require("../scraping/urlGuard");
  const c = String(code || "").trim().toUpperCase();
  const u = String(url || "").trim();
  if (!CODIGO_RE.test(c)) throw Object.assign(new Error("Código inválido: use de 3 a 30 letras, números ou hífen."), { status: 400 });
  let valida = false;
  try { valida = /^https?:$/.test(new URL(u).protocol); } catch { valida = false; }
  if (!valida || detectStore(u) !== "Mercado Livre") {
    throw Object.assign(new Error("O link precisa ser de um produto do Mercado Livre."), { status: 400 });
  }
  const m = await prisma().repasseCupomManual.create({ data: { code: c, url: u, userId } });
  return { origem: "manual", manualId: String(m.id), code: m.code, url: m.url, criadoEm: m.createdAt, motivo: "manual", reservado: false };
}

async function removerManual(id) {
  const { prisma } = require("../db");
  let chave;
  try { chave = BigInt(id); } catch { return { removido: 0 }; }
  const r = await prisma().repasseCupomManual.deleteMany({ where: { id: chave, testedAt: null } });
  return { removido: r.count };
}

function reivindicarCheckout(code) {
  const c = String(code || "").trim().toUpperCase();
  if (!c) return { ok: false };
  if (reservado(c)) return { ok: false };
  _reservas.set(c, Date.now() + RESERVA_MS);
  return { ok: true, code: c };
}

// O material que a extensão colheu vira veredito, entra no dicionário de palavras
// (`ml_coupon_codes`) e no diário do robô. `source` diz se foi o botão Testar ou a
// fila automática.
async function registrarCheckout({ code, url = null, material, source = "repasse-checkout", durationMs = null, manualId = null }) {
  const { interpretar, verdictDe, mensagemDe } = require("./checkout-cupom");
  const pg = require("../coupons/pg");
  const c = String(code || "").trim().toUpperCase();
  if (!c) throw new Error("Código vazio.");
  const fonte = FONTES_DO_CHECKOUT.has(source) ? source : "repasse-checkout";

  const resultado = interpretar(material, c);
  const verdict = verdictDe(resultado);
  const message = mensagemDe(resultado);
  const linha = await pg.recordCodeCheck({
    code: c, verdict, campaignId: resultado.campaignId, message, source: fonte,
    raw: { ...resultado, url, via: "checkout" },
  });
  _reservas.delete(c);

  // O pedido manual sai da fila com o desfecho dele.
  if (manualId != null) {
    try {
      await require("../db").prisma().repasseCupomManual.updateMany({
        where: { id: BigInt(manualId), testedAt: null },
        data: { testedAt: new Date(), verdict, message },
      });
    } catch (err) {
      console.error(`[repasse] pedido manual ${manualId}: ${err.message}`);
    }
  }

  const bloqueio = resultado.bloqueio ? (kindDoBloqueio(resultado.bloqueio) || KIND.CAPTCHA) : null;
  await logAutotest({
    code: c, action: ACTION.TEST, ok: verdict === "valid", verdict,
    campaignId: resultado.campaignId, errorKind: bloqueio, message, durationMs,
  });
  _status.testados += 1;
  _status.lastRunAt = new Date().toISOString();

  // Muro na aba do admin: a fila automática para por um tempo, e o grupo de admin
  // fica sabendo — a extensão já trouxe a aba pra frente e esperou alguém resolver.
  if (bloqueio && fonte === "repasse-checkout-auto") {
    const cfg = cfgStore.readConfig();
    _status.bloqueadoAte = new Date(Date.now() + cfg.pausaAposBloqueioMin * 60_000).toISOString();
    require("../notifications/admin-notifier").notifyBlockDetected({
      alvo: "Cupons do repasse · teste no checkout",
      motivo: resultado.bloqueio,
      o_que: `O Mercado Livre pediu verificação ao testar o cupom ${c} na aba do admin, e ninguém resolveu a tempo.`,
      falhas: 1,
      desde: new Date().toLocaleString("pt-BR"),
      clientes: "",
      o_que_fazer: `Abra o Chrome com a extensão, resolva a verificação no Mercado Livre e aperte "Testar" num cupom. A fila automática volta sozinha em ${cfg.pausaAposBloqueioMin} min.`,
    }).catch(() => {});
  }

  return { resultado, verdict, message, linha };
}

// ── Agenda ───────────────────────────────────────────────────────────────
function agendar(cfg) {
  _status.nextRunAt = new Date(Date.now() + cfg.intervaloMs).toISOString();
}

function start() {
  if (process.env.NODE_ENV === "test") return;
  if (timers.length) return;
  const cfg = cfgStore.readConfig();
  const first = setTimeout(() => { runOnce().finally(() => agendar(cfgStore.readConfig())); }, FIRST_RUN_MS);
  const loop = setInterval(() => { runOnce().finally(() => agendar(cfgStore.readConfig())); }, cfg.intervaloMs);
  for (const t of [first, loop]) t.unref?.();
  timers = [first, loop];
  agendar(cfg);
}

function stop() {
  for (const t of timers) clearTimeout(t);
  timers = [];
  _status.nextRunAt = null;
}

function status() {
  const cfg = cfgStore.readConfig();
  return {
    ..._status,
    enabled: cfg.enabled,
    running: _running,
    agendado: timers.length > 0,
    intervaloMs: cfg.intervaloMs,
  };
}

// O estado de módulo (breaker inclusive) sobrevive entre rodadas de propósito —
// é isso que faz o bloqueio valer. Num arquivo de teste isso vaza de um caso pro
// outro, então há como zerá-lo. Exportado p/ testes.
function _resetEstado() {
  _running = false;
  _reservas.clear();
  Object.assign(_status, {
    lastRunAt: null, lastDuration: null, testados: 0, importados: 0,
    vitrines: 0, pulada: null, bloqueadoAte: null, lastError: null, nextRunAt: null,
  });
}

module.exports = {
  start, stop, status, runOnce, selecionar, kindDoBloqueio, ACTION, _resetEstado,
  pendentesCheckout, reivindicarCheckout, registrarCheckout, adicionarManual, removerManual,
};
