// user-notifier — o sistema falando com CADA usuário via WhatsNimbus.
//
// Lê as preferências do usuário (UserState.settings.notifications), resolve o
// telefone de destino (um dos números que ELE conectou) e manda a DM usando o
// remetente WhatsNimbus (ver whatsnimbus.js). Espelha o padrão do admin-notifier.
//
// Eventos de "estado" (whats caiu, campanha parada por gate, fila vazia) são
// edge-triggered: só disparam na TRANSIÇÃO pra o estado de alerta, evitando spam
// a cada tick do scheduler. O Map de estado é por processo — cada tipo de evento
// dispara sempre do mesmo processo (worker p/ scheduler+sessões), então basta.
//
// Quedas de conexão (WhatsApp caiu, campanha parada por gate) passam por um GRACE
// de tempo antes de virar aviso (ver stateAlert): se recuperar dentro da janela,
// nenhum aviso sai — mata o falso alarme de blips curtos e de deploys/reinícios do
// worker. Se o aviso de queda chegou a sair, a recuperação dispara um aviso de "voltou".
const { prisma } = require("../db");
const whatsnimbus = require("./whatsnimbus");

const TAG = "*[WhatsNimbus]*";

// Espera antes de considerar uma queda como "real" e avisar. Recuperou antes: silêncio.
const NOTIFY_GRACE_MS = Number(process.env.NOTIFY_GRACE_MS) || 60000;

const DEFAULT_EVENTS = {
  whatsappDisconnected: true,
  campaignDeactivated: true,
  campaignReactivated: true,
  campaignStopped: true,
  productSearch: true,
  queueEmpty: true,
};

// Lazy-require pra evitar dependência circular no boot (wa carrega Baileys/auth).
function getWa() { return require("../whatsapp"); }

async function readUserConfig(userId) {
  try {
    const st = await prisma().userState.findUnique({
      where: { userId: String(userId) },
      select: { settings: true },
    });
    const n = (st && st.settings && st.settings.notifications) || {};
    return {
      enabled: !!n.enabled,
      destinationNumberId: n.destinationNumberId || null,
      events: { ...DEFAULT_EVENTS, ...(n.events || {}) },
    };
  } catch {
    return { enabled: false, destinationNumberId: null, events: { ...DEFAULT_EVENTS } };
  }
}

// ── Edge-trigger ──────────────────────────────────────────────────────────
// transition(key, activeNow): true só quando entra no estado ativo (era !=true).
const lastState = new Map();
function transition(key, activeNow) {
  const prev = lastState.get(key);
  lastState.set(key, !!activeNow);
  return !!activeNow && prev !== true;
}

// ── Alerta de estado com grace + recuperação ──────────────────────────────────
// Para eventos de QUEDA (WhatsApp caiu, campanha parada). Estado por chave:
// { timer, notified }.
//   isDown=true:  se já notificou ou já tem timer correndo -> nada; senão arma um
//                 timer de graceMs — só ao disparar (ainda caído) marca notified e
//                 chama onDown. O timer é auto-consistente: se recuperasse antes,
//                 o isDown=false o teria cancelado.
//   isDown=false: timer pendente -> cancela em silêncio (FALSO ALARME); já
//                 notificou -> chama onRecover; nunca esteve caído -> nada.
const alertState = new Map();
function stateAlert(key, isDown, { graceMs = NOTIFY_GRACE_MS, onDown, onRecover } = {}) {
  const st = alertState.get(key);
  if (isDown) {
    if (st && (st.notified || st.timer)) return; // já alertou ou grace correndo
    const entry = { timer: null, notified: false };
    entry.timer = setTimeout(() => {
      entry.timer = null;
      entry.notified = true;
      Promise.resolve().then(onDown).catch(() => {});
    }, graceMs);
    if (entry.timer.unref) entry.timer.unref(); // não segura o processo vivo
    alertState.set(key, entry);
    return;
  }
  // isDown === false (voltou ao normal / conectado)
  if (!st) return;
  alertState.delete(key);
  if (st.timer) { clearTimeout(st.timer); return; } // recuperou dentro do grace: silêncio
  if (st.notified) Promise.resolve().then(onRecover).catch(() => {});
}

// ── Núcleo de envio ─────────────────────────────────────────────────────────
async function deliver(userId, eventType, text) {
  const cfg = await readUserConfig(userId);
  if (!cfg.enabled) return false;
  if (!cfg.events[eventType]) return false;
  if (!cfg.destinationNumberId) return false;

  // Telefone do número de destino escolhido pelo usuário.
  let phone = null;
  try {
    const num = await prisma().whatsappNumber.findFirst({
      where: { userId: String(userId), id: String(cfg.destinationNumberId) },
      select: { phone: true },
    });
    phone = num && num.phone;
  } catch { /* ignore */ }
  if (!phone) return false;

  const wn = whatsnimbus.readConfig();
  if (!wn.numberId) return false; // remetente não configurado

  const wa = getWa();
  const jid = wa.jidFromPhone(phone);
  try {
    await wa.sendText(whatsnimbus.WHATSNIMBUS_USER_ID, wn.numberId, jid, text);
    return true;
  } catch (err) {
    console.error(`[user-notifier] falha ao enviar (${eventType}) p/ ${userId}: ${err.message}`);
    return false;
  }
}

async function labelOfNumber(userId, numberId) {
  try {
    const num = await prisma().whatsappNumber.findFirst({
      where: { userId: String(userId), id: String(numberId) },
      select: { label: true, phone: true },
    });
    return (num && (num.label || (num.phone ? `+${num.phone}` : null))) || String(numberId);
  } catch {
    return String(numberId);
  }
}

// ── Eventos ─────────────────────────────────────────────────────────────────

// Só avisa quando um número que JÁ esteve conectado cai (evita alarme falso
// durante o fluxo inicial de QR de um número que nunca subiu).
const connectedOnce = new Set();

// Semeado pelo restoreSessions no boot do worker. O Set é POR PROCESSO: sem isto,
// uma sessão que NÃO volta depois de um restart nunca dispararia o aviso, porque
// ela não chegou a "connected" neste processo — justo o caso em que o usuário
// mais precisa ser avisado. Ter credenciais registradas já prova que conectou.
function markConnectedOnce(userId, numberId) {
  if (String(userId) === whatsnimbus.WHATSNIMBUS_USER_ID) return;
  connectedOnce.add(`${userId}:wa:${numberId}`);
}

async function onSessionStatus(userId, numberId, status) {
  try {
    // WhatsNimbus não é usuário: ignora a própria sessão do remetente.
    if (String(userId) === whatsnimbus.WHATSNIMBUS_USER_ID) return;
    const key = `${userId}:wa:${numberId}`;

    if (status === "connected") {
      connectedOnce.add(key);
      // Voltou a conectar: se um aviso de queda chegou a sair, avisa a recuperação.
      stateAlert(key, false, {
        onRecover: async () => {
          const label = await labelOfNumber(userId, numberId);
          await deliver(userId, "whatsappDisconnected",
            `${TAG} ✅\nSeu WhatsApp *${label}* voltou a conectar.`);
        },
      });
      return;
    }
    // Qualquer status != connected é "caído" (disconnected/logged_out/connecting/
    // awaiting_qr). Só conta pra número que JÁ subiu (evita alarme no QR inicial).
    // O grace do stateAlert absorve reconexões curtas: só avisa se seguir caído.
    if (!connectedOnce.has(key)) return;
    stateAlert(key, true, {
      onDown: async () => {
        const label = await labelOfNumber(userId, numberId);
        await deliver(userId, "whatsappDisconnected",
          `${TAG} ⚠️\nSeu WhatsApp *${label}* desconectou.\nReconecte no painel pra não interromper os envios.`);
      },
    });
  } catch (err) {
    console.error(`[user-notifier] onSessionStatus: ${err.message}`);
  }
}

async function onCampaignDeactivated(userId, groupName) {
  await deliver(userId, "campaignDeactivated",
    `${TAG} ⏸️\nA campanha *${groupName}* foi *desativada*.`);
}

async function onCampaignReactivated(userId, groupName) {
  await deliver(userId, "campaignReactivated",
    `${TAG} ▶️\nA campanha *${groupName}* foi *reativada*.`);
}

// stopped: true = gate bloqueando o envio agora. Chamar SEMPRE (true e false) a
// cada tick. O grace do stateAlert absorve paradas curtas (ex.: número reconectando
// entre dois ticks): só avisa se seguir parada. Ao voltar, avisa a recuperação.
async function onCampaignStopped(userId, groupId, groupName, reason, stopped) {
  const key = `${userId}:stopped:${groupId}`;
  stateAlert(key, stopped, {
    onDown: async () => {
      await deliver(userId, "campaignStopped",
        `${TAG} 🛑\nA campanha *${groupName}* foi *parada*.\nMotivo: ${reason}`);
    },
    onRecover: async () => {
      await deliver(userId, "campaignStopped",
        `${TAG} ✅\nA campanha *${groupName}* voltou a operar.`);
    },
  });
}

// Resultado de uma busca (refill). approved/pending já vêm calculados pelo caller.
async function onProductSearch(userId, groupName, { added, approved, pending }) {
  if (!added) return;
  const lines = [`${TAG} 🔎`, `Busca na campanha *${groupName}*: ${added} novo(s).`];
  if (approved) lines.push(`✅ ${approved} aprovado(s) automaticamente.`);
  if (pending) lines.push(`⏳ ${pending} aguardando sua confirmação.`);
  await deliver(userId, "productSearch", lines.join("\n"));
}

// isEmpty: fila vazia dentro de uma janela de envio. Chamar true e false (reset).
async function onQueueEmpty(userId, groupId, groupName, isEmpty) {
  const key = `${userId}:empty:${groupId}`;
  if (!transition(key, isEmpty)) return;
  await deliver(userId, "queueEmpty",
    `${TAG} 📭\nA fila da campanha *${groupName}* está *vazia* — não há produtos pra enviar.\nFaça uma busca ou aprove os pendentes.`);
}

module.exports = {
  readUserConfig,
  markConnectedOnce,
  onSessionStatus,
  onCampaignDeactivated,
  onCampaignReactivated,
  onCampaignStopped,
  onProductSearch,
  onQueueEmpty,
  // Exportado pra teste: núcleo do debounce/recuperação (sem IO).
  stateAlert,
  NOTIFY_GRACE_MS,
  __clearAlertState: () => alertState.clear(),
};
