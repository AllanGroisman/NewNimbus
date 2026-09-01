// Lembretes de cobrança — os avisos que o webhook não consegue mandar.
//
// O Stripe avisa quando algo ACONTECE. Estes três avisos são sobre algo que
// está PARA acontecer, e ninguém manda evento disso:
//   - o teste de 7 dias termina em 2 dias e vira cobrança;
//   - a carência de 3 dias por cartão recusado acaba amanhã;
//   - a carência acabou e o acesso foi pausado.
//
// Cadência: 4x por dia. Não é preciso mais que isso porque a dedupeKey é
// ancorada na data-alvo (fim do teste / fim da carência), então rodar de novo
// no mesmo dia não repete o e-mail — a segunda rodada só pega quem entrou na
// janela desde a anterior.

const store = require("./pg");
const limits = require("./limits");
const stripe = require("./stripe");
const emails = require("../notifications/email");
const logger = require("../infra/logger");

const CHECK_MS = 6 * 60 * 60 * 1000;  // 4x por dia
const FIRST_CHECK_MS = 3 * 60 * 1000; // 3 min após o boot — fora do pico de subida
const TRIAL_WARN_MS = 2 * 24 * 60 * 60 * 1000;
const GRACE_WARN_MS = 24 * 60 * 60 * 1000;

let timers = [];
const last = { lastRunAt: null, checked: 0, sent: 0, errors: 0 };

function iso(d) {
  if (!d) return "";
  const dt = d instanceof Date ? d : new Date(d);
  return Number.isNaN(dt.getTime()) ? "" : dt.toISOString();
}

function dias(ms) {
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}

// Mesma regra do billing/notify: conta suspensa já foi avisada da suspensão.
// Admin recebe como qualquer cliente.
function podeReceber(user) {
  return !!(user && user.email && !user.suspended);
}

// Decide o aviso de UMA assinatura. Pura — o runOnce só orquestra.
function decidirLembrete(sub, now = Date.now()) {
  const user = sub.user;
  const base = { to: user.email, name: user.name, userId: user.id, planLabel: limits.getPlan(sub.planId).label };

  if (sub.status === "trialing" && sub.currentPeriodEnd) {
    const falta = new Date(sub.currentPeriodEnd).getTime() - now;
    if (falta > 0 && falta <= TRIAL_WARN_MS) {
      return {
        kind: "trial_ending",
        payload: { ...base, periodEnd: sub.currentPeriodEnd, daysLeft: dias(falta) },
        dedupeKey: `trial_ending:${user.id}:${iso(sub.currentPeriodEnd)}`,
      };
    }
    return null;
  }

  const fimCarencia = limits.graceEndsAt(sub);
  if (!fimCarencia) return null;
  const falta = fimCarencia.getTime() - now;

  // Ainda dentro da carência, e o prazo é amanhã: último aviso antes do corte.
  if (falta > 0 && falta <= GRACE_WARN_MS) {
    return {
      kind: "grace_ending",
      payload: { ...base, deadline: fimCarencia },
      dedupeKey: `grace_ending:${user.id}:${iso(fimCarencia)}`,
    };
  }
  // Carência estourada: o acesso já caiu (effectivePlanId virou free).
  if (falta <= 0) {
    return {
      kind: "access_paused",
      payload: { ...base, deadline: fimCarencia },
      dedupeKey: `access_paused:${user.id}:${iso(fimCarencia)}`,
    };
  }
  return null;
}

// Uma varredura. Exportada pra os testes chamarem direto — em NODE_ENV=test o
// start() é no-op de propósito.
async function runOnce(now = Date.now()) {
  const stats = { checked: 0, sent: 0, errors: 0 };
  let rows = [];
  try {
    rows = await store.listForReminders();
  } catch (err) {
    logger.warn({ err: err.message }, "[billing-reminders] leitura falhou");
    last.lastRunAt = new Date().toISOString();
    last.errors += 1;
    return { ...stats, errors: 1 };
  }

  const modoAtivo = stripe.mode();
  for (const sub of rows) {
    // Uma conta com dado estranho não pode derrubar a varredura das outras.
    try {
      // Assinatura de outro modo do Stripe não vale agora (mesma regra da
      // máscara em pg.js) — avisar sobre ela seria mentira.
      if (sub.stripeMode && sub.stripeMode !== modoAtivo) continue;
      if (!podeReceber(sub.user)) continue;

      stats.checked += 1;
      const aviso = decidirLembrete(sub, now);
      if (!aviso) continue;

      // Aqui o send é AWAITED (e não sendAsync): é um job de fundo, ninguém
      // está esperando resposta, e o resultado alimenta o contador de status.
      const res = await emails.send(aviso.kind, aviso.payload, { dedupeKey: aviso.dedupeKey });
      if (res?.sent) stats.sent += 1;
    } catch (err) {
      stats.errors += 1;
      logger.warn({ err: err.message, userId: sub.userId }, "[billing-reminders] lembrete falhou");
    }
  }

  last.lastRunAt = new Date().toISOString();
  last.checked = stats.checked;
  last.sent = stats.sent;
  last.errors = stats.errors;
  return stats;
}

function start() {
  if (process.env.NODE_ENV === "test") return;
  if (timers.length) return;
  const first = setTimeout(() => { runOnce(); }, FIRST_CHECK_MS);
  const loop = setInterval(() => { runOnce(); }, CHECK_MS);
  for (const t of [first, loop]) t.unref?.();
  timers = [first, loop];
}

function stop() {
  for (const t of timers) clearTimeout(t);
  timers = [];
}

function status() {
  return { ...last, checkIntervalMs: CHECK_MS };
}

module.exports = { start, stop, status, runOnce, decidirLembrete };
