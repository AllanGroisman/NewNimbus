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
const { prisma } = require("../db");
const whatsnimbus = require("./whatsnimbus");

const TAG = "*[WhatsNimbus]*";

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
async function onSessionStatus(userId, numberId, status) {
  try {
    // WhatsNimbus não é usuário: ignora a própria sessão do remetente.
    if (String(userId) === whatsnimbus.WHATSNIMBUS_USER_ID) return;
    const key = `${userId}:wa:${numberId}`;
    const isDown = status === "disconnected" || status === "logged_out";

    if (status === "connected") {
      connectedOnce.add(key);
      transition(key, false);            // reset: uma próxima queda volta a notificar
      transition(`${key}:stuck`, false); // reset: um próximo episódio "preso" volta a avisar
      return;
    }
    if (!isDown) return;              // connecting/awaiting_qr: ignora
    if (!connectedOnce.has(key)) return; // nunca subiu: não é "desconexão"
    if (!transition(key, true)) return;

    const label = await labelOfNumber(userId, numberId);
    await deliver(userId, "whatsappDisconnected",
      `${TAG} ⚠️\nSeu WhatsApp *${label}* desconectou.\nReconecte no painel pra não interromper os envios.`);
  } catch (err) {
    console.error(`[user-notifier] onSessionStatus: ${err.message}`);
  }
}

// Reconexão em background presa há muito tempo (status segue "connecting", então
// onSessionStatus a ignora). Aqui avisamos o dono UMA vez por episódio pra ele
// reconectar no painel — o reset acontece quando o número volta a "connected".
// Reusa a preferência "whatsappDisconnected" (do ponto de vista dele, é o mesmo
// problema). Só avisa números que JÁ subiram (evita alarme no QR inicial).
async function onSessionStuck(userId, numberId) {
  try {
    if (String(userId) === whatsnimbus.WHATSNIMBUS_USER_ID) return;
    const key = `${userId}:wa:${numberId}`;
    if (!connectedOnce.has(key)) return;
    if (!transition(`${key}:stuck`, true)) return;

    const label = await labelOfNumber(userId, numberId);
    await deliver(userId, "whatsappDisconnected",
      `${TAG} ⚠️\nSeu WhatsApp *${label}* está com dificuldade para reconectar.\nReconecte no painel pra não interromper os envios.`);
  } catch (err) {
    console.error(`[user-notifier] onSessionStuck: ${err.message}`);
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

// stopped: true = gate bloqueando o envio agora. Chamar SEMPRE (true e false)
// pra o edge-trigger resetar e voltar a notificar numa próxima parada.
async function onCampaignStopped(userId, groupId, groupName, reason, stopped) {
  const key = `${userId}:stopped:${groupId}`;
  if (!transition(key, stopped)) return;
  await deliver(userId, "campaignStopped",
    `${TAG} 🛑\nA campanha *${groupName}* foi *parada*.\nMotivo: ${reason}`);
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
  onSessionStatus,
  onSessionStuck,
  onCampaignDeactivated,
  onCampaignReactivated,
  onCampaignStopped,
  onProductSearch,
  onQueueEmpty,
};
