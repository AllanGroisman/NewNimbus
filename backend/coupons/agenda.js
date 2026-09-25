// Agenda das etapas de cupons (1 · lista, 2 · produtos). O antigo 3 · tudo saiu.
//
// O servidor NÃO roda as etapas: elas moram no Chrome do admin, pela extensão,
// porque o ML responde ao Puppeteer com CAPTCHA (scraping/README.md). O que este
// arquivo faz é saber QUANDO cada etapa venceu e deixar isso marcado como
// "pendente". Quem executa é a aba Admin › Cupom › Cupons do ML: ela consulta as
// pendências, reivindica uma e aperta o mesmo botão que o admin apertaria.
//
// Se nenhuma aba reivindicar dentro da graça do scraping (GRACE_MIN), o horário
// é pulado e o grupo de admin fica sabendo — horário perdido em silêncio é
// exatamente o que o agendamento existe para evitar.
//
// Os horários são os mesmos do scraper global (scraping/schedule.js), e o "já rodei
// esse horário" sai do balanço persistido de cada botão (`ultimas[botao].at`): a
// rodada manual também conta, e isso sobrevive ao restart.
const schedule = require("../scraping/schedule");

// "tudo" (o antigo botão 3) saiu da tela; o rótulo fica para os balanços antigos.
const BOTOES = ["lista", "produtos"];
const ROTULOS = { lista: "Etapa 1 · Lista", produtos: "Etapa 2 · Produtos", tudo: "Etapa 3 · Buscar TUDO" };
// Mesmo teto do scraper global: timer de horas erra o alvo com drift de relógio
// ou máquina suspensa, e em horário fixo errar é perder o slot.
const MAX_TIMER_MS = 15 * 60 * 1000;
const GRACE_MS = schedule.GRACE_MIN * 60 * 1000;
// Uma rodada reivindicada que nunca manda o fim (aba fechada no meio) não pode
// deixar o próximo fim manual sair como "agendada".
const EM_CURSO_MAX_MS = 12 * 60 * 60 * 1000;

const _timers = {};
const _proximo = {};
// Quando o timer de cada botão venceu pela última vez. Sem isso o reagendamento
// logo após o disparo veria o mesmo horário ainda "vencido" (a rodada nem começou,
// o `ultimas.at` é o de antes) e dispararia em laço.
const _disparos = {};
const _pendentes = {};
const _emCurso = {};
let _varredor = null;

// Lazy: sync.js também exige este arquivo, e o notifier puxa o WhatsApp.
const sync = () => require("./sync");
const notifier = () => require("../notifications/admin-notifier");

function configDe(botao) {
  return sync().readConfig().agenda?.[botao] || null;
}

function maisRecente(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}

function agendar(botao) {
  if (_timers[botao]) { clearTimeout(_timers[botao]); _timers[botao] = null; }
  _proximo[botao] = null;
  const cfg = configDe(botao);
  if (!cfg?.enabled) return;
  const ultimo = maisRecente(sync().ultimas()[botao]?.at, _disparos[botao]);
  const plan = schedule.nextRun(cfg, ultimo, new Date());
  if (!plan) return;
  const delay = Math.max(0, plan.at.getTime() - Date.now());
  _proximo[botao] = plan.at.toISOString();
  _timers[botao] = setTimeout(
    delay > MAX_TIMER_MS ? () => agendar(botao) : () => disparar(botao, plan.slot),
    Math.min(delay, MAX_TIMER_MS),
  );
  _timers[botao].unref?.();
}

function horaAgora() {
  return new Date().toTimeString().slice(0, 5);
}

function disparar(botao, slot) {
  _timers[botao] = null;
  const agora = new Date().toISOString();
  _disparos[botao] = agora;
  // Uma pendência que ainda não foi reivindicada fica com o horário dela: são o
  // mesmo pedido, e o "não rodou" tem que dizer o horário que se perdeu primeiro.
  if (!_pendentes[botao]) _pendentes[botao] = { slot: slot || horaAgora(), desde: agora };
  agendar(botao);
}

function varrer(now = Date.now()) {
  for (const botao of BOTOES) {
    const p = _pendentes[botao];
    if (p && now - new Date(p.desde).getTime() > GRACE_MS) {
      delete _pendentes[botao];
      notifier().notifyCuponsAgendaPulada(botao, p.slot, "a aba de cupons do admin não estava aberta (ou ficou ocupada com outra rodada)")
        .catch(err => console.error("[cupons-agenda] aviso:", err.message));
    }
    const e = _emCurso[botao];
    if (e && now - new Date(e.desde).getTime() > EM_CURSO_MAX_MS) delete _emCurso[botao];
  }
}

// A fila que a aba lê, na ordem das etapas.
function pendentes() {
  return BOTOES.filter(b => _pendentes[b]).map(b => ({ botao: b, ..._pendentes[b] }));
}

// A aba avisa que vai rodar. Só uma leva: duas abas abertas não podem apertar o
// mesmo botão ao mesmo tempo, na mesma conta do ML.
function reivindicar(botao) {
  const p = _pendentes[botao];
  if (!p) return { ok: false };
  delete _pendentes[botao];
  _emCurso[botao] = { slot: p.slot, desde: new Date().toISOString() };
  return { ok: true, slot: p.slot };
}

// A aba estava aberta mas não pôde rodar (sem extensão, sem nada na fila…).
function falhou(botao, motivo) {
  const p = _pendentes[botao];
  if (!p) return { ok: false };
  delete _pendentes[botao];
  notifier().notifyCuponsAgendaPulada(botao, p.slot, String(motivo || "a aba não conseguiu rodar").slice(0, 300))
    .catch(err => console.error("[cupons-agenda] aviso:", err.message));
  return { ok: true };
}

// Chamado quando um botão fecha o balanço (manual ou agendado). Devolve o horário
// agendado da rodada, ou null quando ela foi manual. Uma pendência do mesmo botão
// cai junto: a rodada que acabou de fechar já cobriu o pedido.
function rodadaFechou(botao) {
  const e = _emCurso[botao];
  delete _emCurso[botao];
  delete _pendentes[botao];
  agendar(botao);
  return e ? e.slot : null;
}

function reagendar() {
  for (const b of BOTOES) agendar(b);
}

function status() {
  return {
    proximo: Object.fromEntries(BOTOES.map(b => [b, _proximo[b] || null])),
    pendentes: pendentes(),
  };
}

function start() {
  reagendar();
  if (!_varredor) {
    _varredor = setInterval(() => varrer(), 60 * 1000);
    _varredor.unref?.();
  }
}

function stop() {
  for (const b of BOTOES) { if (_timers[b]) clearTimeout(_timers[b]); _timers[b] = null; _proximo[b] = null; }
  if (_varredor) { clearInterval(_varredor); _varredor = null; }
}

// Só pros testes: estado limpo entre casos.
function _reset() {
  stop();
  for (const m of [_disparos, _pendentes, _emCurso]) for (const k of Object.keys(m)) delete m[k];
}

module.exports = {
  BOTOES, ROTULOS, GRACE_MS,
  start, stop, reagendar, status, pendentes, reivindicar, falhou, rodadaFechou, varrer,
  _reset,
};
