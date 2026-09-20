// A varredura em lote dos cupons pela landing de afiliado — sem navegador.
//
// O problema que ela resolve (task 12, medido em 19/09/2026): o sistema tinha ~2.800
// cupons guardados e 4.035 produtos no catálogo, e UM produto com cupom. Não faltava
// código: o vínculo cupom ↔ produto, o carimbo no catálogo, o selo no card e o
// filtro "só com cupom" existiam todos. Faltava DADO — os produtos dos cupons não
// estavam no catálogo, e o universo dos dois quase não se cruzava.
//
// Ir do produto pro cupom ("que cupom vale aqui?") bate no muro anti-bot: a página
// do produto e a vitrine (`lista.mercadolivre.com.br`) dão CAPTCHA ao navegador
// automatizado. O caminho que funciona é o inverso — trazer os produtos DE CADA
// CUPOM para o catálogo, já carimbados. A leitura sem navegador disso existia
// (scraping/ml-vitrine-landing.js, ~1,5 s por cupom), mas só no botão de UM cupom.
//
// O que isto é: um laço espaçado sobre `coupons/pg.js:alvosDaLanding`, gravando pelo
// MESMO `sync.gravarVitrine` do botão, com `origem: "landing"` — prova POSITIVA de
// cobertura (3 a 8 produtos por cupom), nunca a lista fechada. Ao fim da leva, as
// amostras dos cupons viram produto de catálogo (coupons/enrich-samples.js).
//
// O que isto NÃO é: nunca abre Chrome e nunca cai no caminho do navegador — é por
// isso que não passa pelo `syncOneCoupon`, que cai. E nunca ativa cupom ("Eu quero"
// é escrita na conta): cupom sem `containerUrl` fica pra rodada do admin.
//
// Roda no processo do SERVER, pelo mesmo motivo do repasse/coupon-autotest.js: os
// mutex do coupons/sync.js são por processo, e só aqui dá pra respeitá-los.
const cfgStore = require("./landing-sweep-config");
const coupons = require("./pg");

// Muro: parar a rodada e armar o breaker. `desafio` entra porque, na landing, ele
// é a página inteira e não o cupom — o próximo levaria o mesmo.
const MUROS = new Set(["captcha", "verificacao", "desafio", "login", "login-wall"]);
// Falta de configuração: nenhum cupom vai passar, e não é bloqueio do ML.
const SEM_CONFIG = new Set(["afiliado-ausente"]);

// Não dispara no pico da subida (Baileys, scheduler e scraper acordando juntos).
const FIRST_RUN_MS = 5 * 60_000;

const SLEEP_REAL = process.env.NODE_ENV !== "test";
const sleep = (ms) => new Promise(r => setTimeout(r, SLEEP_REAL ? ms : 0));

let timers = [];
let _running = false;
const _status = {
  lastRunAt: null,
  lastDuration: null,
  // O que a ÚLTIMA rodada fez. Contador cumulativo aqui diria "3.000 lidos" sem
  // dizer se a rodada de agora funcionou, que é a pergunta de quem abre o card.
  lidos: 0,
  comPrevia: 0,
  semPrevia: 0,
  produtos: 0,
  amostras: null,
  pulada: null,
  bloqueadoAte: null,
  lastError: null,
  nextRunAt: null,
  // Andamento da rodada em curso, pra tela não ficar muda durante minutos.
  progresso: null,
};

// Pura: o que fazer com a resposta da landing de um cupom.
//   "gravar" — trouxe produto;
//   "muro"   — o ML barrou: para a rodada, arma o breaker;
//   "parar"  — falta configuração (sem tag/cookie): para, sem breaker;
//   "seguir" — resposta sobre ESTE cupom (sem prévia, outra vitrine): carimba e segue.
function decidirLanding(r) {
  if (r?.ok && (r.products || []).length) return "gravar";
  const kind = r?.kind || null;
  if (MUROS.has(kind)) return "muro";
  if (SEM_CONFIG.has(kind)) return "parar";
  return "seguir";
}

function bloqueado() {
  return !!(_status.bloqueadoAte && Date.now() < new Date(_status.bloqueadoAte).getTime());
}

async function runOnce({ manual = false } = {}) {
  if (_running) return { skipped: "ja-rodando" };
  const cfg = cfgStore.readConfig();
  // O "Rodar agora" passa por cima do desligado: é um pedido explícito.
  if (!cfg.enabled && !manual) return { skipped: "desligado" };

  const sync = require("./sync");
  const mlCupons = require("../scraping/ml-cupons");
  const affiliate = require("../scraping/affiliate");

  const resumo = { lidos: 0, comPrevia: 0, semPrevia: 0, produtos: 0, amostras: null, bloqueado: false, pulada: null };
  const pular = (motivo, mensagem) => { resumo.pulada = mensagem; return { skipped: motivo, mensagem }; };

  _running = true;
  const t0 = Date.now();
  let gravouAlgo = false;
  try {
    // A rodada do admin e a busca de campanha usam a MESMA conta do ML; quando uma
    // delas está andando, esta espera a próxima em vez de disputar a sessão.
    const st = sync.status();
    if (st.running || st.local) return pular("rodada-em-curso", "Tem uma rodada de cupons do admin rodando — a varredura ficou pra próxima.");
    if (st.importing) return pular("import-em-curso", "Tem uma busca de campanha em curso — a varredura ficou pra próxima.");

    // O breaker segura a AGENDA, não a pessoa — mesmo espírito do coupon-autotest.
    if (bloqueado()) {
      if (!manual) return pular("bloqueado", `O ML barrou a varredura; ela volta a tentar em ${new Date(_status.bloqueadoAte).toLocaleString("pt-BR")}.`);
      _status.bloqueadoAte = null;
    }

    const session = affiliate.getScraperMLSession();
    if (!session?.cookie) return pular("sem-sessao", "Sem sessão do Mercado Livre do sistema — cole o cookie em Admin › Mercado Livre.");
    if (!session.tag) return pular("sem-tag", "Sem a tag de afiliado da conta do sistema — preencha em Admin › Mercado Livre.");

    const teto = Number(sync.readConfig().maxProductsPerCoupon) || 100;
    const alvos = await coupons.alvosDaLanding({ limit: cfg.maxPorRodada, refazerHoras: cfg.refazerHoras });

    for (let i = 0; i < alvos.length; i++) {
      // A rodada do admin pode começar no meio desta: cede a vez.
      const agora = sync.status();
      if (agora.running || agora.local || agora.importing) { resumo.pulada = "Uma rodada do admin começou — a varredura parou no meio e continua na próxima."; break; }
      if (i > 0) await sleep(cfg.pausaMs + Math.random() * cfg.pausaMs);

      const cupom = alvos[i];
      _status.progresso = { i: i + 1, de: alvos.length, title: cupom.title };
      const r = await mlCupons.vitrinePelaLanding(cupom);
      const acao = decidirLanding(r);

      if (acao === "muro") {
        resumo.bloqueado = true;
        _status.bloqueadoAte = new Date(Date.now() + cfg.pausaAposBloqueioMin * 60_000).toISOString();
        resumo.pulada = `O ML barrou a leitura (${r.kind}): ${r.reason || ""} Volta depois de ${cfg.pausaAposBloqueioMin} min.`;
        break;
      }
      if (acao === "parar") { resumo.pulada = r.reason || "Falta configuração do Mercado Livre do sistema."; break; }

      resumo.lidos += 1;
      if (acao === "gravar") {
        const g = await sync.gravarVitrine(cupom.campaignId, cupom, r.products.slice(0, teto), { parcial: true, carimbar: false });
        gravouAlgo = true;
        resumo.comPrevia += 1;
        resumo.produtos += g.produtos || 0;
        await coupons.marcarLanding(cupom.campaignId, { ok: true, message: r.reason });
      } else {
        resumo.semPrevia += 1;
        await coupons.marcarLanding(cupom.campaignId, { ok: false, message: r?.reason || r?.kind || "A landing não trouxe produto." });
      }
    }

    // As amostras, com o que sobrou da rodada — só se o ML não barrou: é a mesma
    // API de link curto, e o próximo pedido levaria a mesma parede.
    if (cfg.enriquecerAmostras && cfg.maxAmostrasPorRodada > 0 && !resumo.bloqueado) {
      _status.progresso = { i: 0, de: 0, title: "amostras dos cupons" };
      const { enriquecerLote } = require("./enrich-samples");
      const a = await enriquecerLote({
        limit: cfg.maxAmostrasPorRodada,
        refazerDias: cfg.refazerAmostraDias,
        pausaMs: cfg.pausaMs,
        deveParar: () => { const s = sync.status(); return s.running || s.local || s.importing; },
      });
      resumo.amostras = a;
      if (a.trazidas) gravouAlgo = true;
      if (a.muro && a.muro !== "afiliado-ausente") {
        resumo.bloqueado = true;
        _status.bloqueadoAte = new Date(Date.now() + cfg.pausaAposBloqueioMin * 60_000).toISOString();
        resumo.pulada = `O ML barrou a busca das amostras (${a.muro}): ${a.mensagem || ""}`;
      }
    }

    _status.lastError = null;
    return resumo;
  } catch (err) {
    _status.lastError = err.message;
    console.error(`[cupons] varredura pela landing falhou: ${err.message}`);
    return { error: err.message };
  } finally {
    // Um carimbo só, no fim: é ele que faz o produto aparecer com cupom na busca.
    if (gravouAlgo) {
      await coupons.syncCatalogCoupons().catch(err =>
        console.error(`[cupons] carimbo do catálogo depois da varredura: ${err.message}`));
    }
    _running = false;
    _status.progresso = null;
    _status.lastRunAt = new Date().toISOString();
    _status.lastDuration = Date.now() - t0;
    Object.assign(_status, {
      lidos: resumo.lidos, comPrevia: resumo.comPrevia, semPrevia: resumo.semPrevia,
      produtos: resumo.produtos, amostras: resumo.amostras, pulada: resumo.pulada,
    });
  }
}

// ── Agenda ───────────────────────────────────────────────────────────────
function agendar(cfg) {
  _status.nextRunAt = new Date(Date.now() + cfg.intervaloMs).toISOString();
}

function start() {
  if (process.env.NODE_ENV === "test") return;
  if (timers.length) return;
  const cfg = cfgStore.readConfig();
  const rodar = () => { runOnce().finally(() => agendar(cfgStore.readConfig())); };
  const first = setTimeout(rodar, FIRST_RUN_MS);
  const loop = setInterval(rodar, cfg.intervaloMs);
  for (const t of [first, loop]) t.unref?.();
  timers = [first, loop];
  agendar(cfg);
}

function stop() {
  for (const t of timers) { clearTimeout(t); clearInterval(t); }
  timers = [];
  _status.nextRunAt = null;
}

function status() {
  const cfg = cfgStore.readConfig();
  return { ..._status, enabled: cfg.enabled, running: _running, agendado: timers.length > 0, intervaloMs: cfg.intervaloMs };
}

// O breaker sobrevive entre rodadas de propósito; num arquivo de teste isso vazaria
// de um caso pro outro. Exportado p/ testes.
function _resetEstado() {
  _running = false;
  Object.assign(_status, {
    lastRunAt: null, lastDuration: null, lidos: 0, comPrevia: 0, semPrevia: 0, produtos: 0,
    amostras: null, pulada: null, bloqueadoAte: null, lastError: null, nextRunAt: null, progresso: null,
  });
}

module.exports = { start, stop, status, runOnce, decidirLanding, MUROS, _resetEstado };
