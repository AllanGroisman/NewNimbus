// Entrada e saída de participante, lidas da mensagem-stub que o WhatsApp manda ao
// grupo — a matéria-prima da aba Grupos (task 4).
//
// O aviso chega como notificação w:gp2. O Baileys (messages-recv.js,
// handleNotification) monta com ela uma mensagem-stub e a entrega num
// messages.upsert "append", inclusive os avisos guardados enquanto o número
// estava fora do ar. É por ela que lemos, e não pelo group-participants.update:
// a stub traz a hora do SERVIDOR (`messageTimestamp`), aquele evento não traz
// hora nenhuma — o aviso entregue na reconexão cairia na hora errada.
//
// O que cada stub vira:
//   ADD    (27) → join_link se quem fez a ação é o próprio participante (entrou
//                 pelo link), join_added se foi outra pessoa (admin adicionou),
//                 join_other sem autor conhecido
//   REMOVE (28) → removed (o Baileys já troca por LEAVE quando a pessoa removeu
//                 a si mesma)
//   LEAVE  (32) → left
//   INVITE/ADD_REQUEST_JOIN/ACCEPT/LINKED_GROUP_JOIN → join_other. O Baileys
//                 7.0.0-rc14 não produz nenhum desses no w:gp2 (o `reason` do
//                 <add> é descartado: entrada aprovada por admin vira "adicionado"),
//                 mas aceitar custa nada se uma versão nova passar a mapear.
//
// Puro e sem require do Baileys: roda a cada mensagem de grupo, e os números dos
// stubs são do WAProto (WebMessageInfo.StubType), estáveis.

const STUB = {
  ADD: 27,
  REMOVE: 28,
  INVITE: 31,
  LEAVE: 32,
  ADD_REQUEST_JOIN: 71,
  ACCEPT: 140,
  LINKED_GROUP_JOIN: 141,
};
const JOIN_OTHER = new Set([STUB.INVITE, STUB.ADD_REQUEST_JOIN, STUB.ACCEPT, STUB.LINKED_GROUP_JOIN]);
const DE_PARTICIPANTE = new Set([STUB.ADD, STUB.REMOVE, STUB.LEAVE, ...JOIN_OTHER]);

// "5511…:12@s.whatsapp.net" → "5511…@s.whatsapp.net". Sem o device, e com o
// "c.us" antigo trocado pelo servidor atual — é o suficiente pra dizer se dois
// jids são a mesma pessoa no mesmo endereçamento (PN com PN, LID com LID).
function normJid(jid) {
  if (!jid || typeof jid !== "string") return null;
  const at = jid.indexOf("@");
  if (at <= 0) return null;
  const user = jid.slice(0, at).split(":")[0];
  let server = jid.slice(at + 1);
  if (server === "c.us") server = "s.whatsapp.net";
  return user ? `${user}@${server}` : null;
}

// Long do protobuf, número ou string → segundos.
function segundos(t) {
  if (t == null) return 0;
  if (typeof t === "object") return Number(t.toNumber ? t.toNumber() : t.low) || 0;
  return Number(t) || 0;
}

// O parâmetro da stub é um JSON do participante ({ id, phoneNumber?, lid? });
// no formato antigo era só o jid.
function participanteDe(param) {
  if (param && typeof param === "object") return param;
  try {
    const p = JSON.parse(param);
    if (p && typeof p === "object") return p;
  } catch { /* formato antigo */ }
  return typeof param === "string" ? { id: param } : null;
}

function idsDe(p) {
  return [p?.id, p?.phoneNumber, p?.lid].map(normJid).filter(Boolean);
}

// Filtro barato e síncrono: o listener roda a cada mensagem de grupo, e quase
// nenhuma é stub de participante.
function temStubDeParticipante(messages) {
  if (!Array.isArray(messages)) return false;
  for (const m of messages) if (DE_PARTICIPANTE.has(m?.messageStubType)) return true;
  return false;
}

function kindDe(stub, participante, autor) {
  if (stub === STUB.LEAVE) return "left";
  if (stub === STUB.REMOVE) return "removed";
  if (stub !== STUB.ADD) return "join_other";
  if (!autor.size) return "join_other";
  return idsDe(participante).some(i => autor.has(i)) ? "join_link" : "join_added";
}

// `selfIds`: os jids do número que recebeu (PN e LID) — a entrada e saída dele
// mesmo não é movimento de membro.
// Devolve [{ groupJid, kind, at: Date, participante: { id, phoneNumber, lid } }].
function extrairEventos(messages, { selfIds = [] } = {}) {
  const self = new Set(selfIds.map(normJid).filter(Boolean));
  const out = [];
  for (const m of messages || []) {
    const stub = m?.messageStubType;
    if (!DE_PARTICIPANTE.has(stub)) continue;
    const groupJid = m?.key?.remoteJid;
    if (!groupJid || !groupJid.endsWith("@g.us")) continue;
    const t = segundos(m.messageTimestamp);
    if (!t) continue;
    const at = new Date(t * 1000);
    // Quem fez a ação. `fromMe` não é filtrado: o admin adicionando gente pelo
    // celular dele chega como fromMe, e é movimento de membro como outro qualquer.
    // O `participantAlt` quase nunca chega (o proto.WebMessageInfo.fromObject do
    // Baileys descarta da chave o que não é do proto); o `participant` vem no mesmo
    // endereçamento do grupo, e o participante traz o outro lado (lid/phoneNumber).
    const autor = new Set([m.key.participant, m.key.participantAlt, m.participant].map(normJid).filter(Boolean));
    for (const param of m.messageStubParameters || []) {
      const p = participanteDe(param);
      const ids = idsDe(p);
      if (!ids.length || ids.some(i => self.has(i))) continue;
      out.push({
        groupJid,
        kind: kindDe(stub, p, autor),
        at,
        participante: { id: p.id || null, phoneNumber: p.phoneNumber || null, lid: p.lid || null },
      });
    }
  }
  return out;
}

module.exports = { extrairEventos, temStubDeParticipante, normJid, STUB };
