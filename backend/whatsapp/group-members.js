// Para quem mandar no privado, a partir dos participantes de um grupo (task 4).
//
// No Baileys 7 o participante vem em uma de duas formas:
//   { id: "5511…@s.whatsapp.net", lid: "123…@lid" }        grupo endereçado por PN
//   { id: "123…@lid", phoneNumber: "5511…@s.whatsapp.net" } grupo endereçado por LID
// e o lado que falta pode vir vazio. O destino preferido é o PN (é o "número" da
// pessoa, e é o que dedupe entre grupos de endereçamentos diferentes); sem PN, o
// mapeamento LID→PN que o Baileys guarda; sem ele, o próprio @lid, que o
// Baileys 7 aceita como destino.
//
// Puro (o mapeamento entra como função) para o teste não precisar de socket.
const { jidNormalizedUser, isPnUser, isLidUser } = require("@whiskeysockets/baileys");

function norm(jid) {
  try { return jid ? jidNormalizedUser(jid) : null; } catch { return null; }
}

function idsDe(p) {
  return [p?.id, p?.phoneNumber, p?.lid].map(norm).filter(Boolean);
}

// O jid que identifica a pessoa, na ordem de preferência acima. Também é a
// identidade do participante nas estatísticas da aba Grupos (group-stats/capture.js):
// a entrada e a saída da mesma pessoa precisam cair no mesmo jid.
async function canonico(p, pnForLid = async () => null) {
  const ids = idsDe(p);
  const pn = ids.find(i => isPnUser(i));
  if (pn) return pn;
  const lid = ids.find(i => isLidUser(i)) || null;
  if (!lid) return null;
  let mapeado = null;
  try { mapeado = norm(await pnForLid(lid)); } catch { mapeado = null; }
  return mapeado || lid;
}

// `selfIds`: os jids do próprio número (PN e LID) — quem manda não recebe.
// `pnForLid(lid)`: devolve o PN de um LID, ou null.
// Devolve [{ jid }] sem repetição, na ordem dos participantes.
async function memberJids(participants, { selfIds = [], pnForLid = async () => null } = {}) {
  const self = new Set(selfIds.map(norm).filter(Boolean));
  const seen = new Set();
  const out = [];
  for (const p of participants || []) {
    if (idsDe(p).some(i => self.has(i))) continue;
    const alvo = await canonico(p, pnForLid);
    if (!alvo || self.has(alvo) || seen.has(alvo)) continue;
    seen.add(alvo);
    out.push({ jid: alvo });
  }
  return out;
}

module.exports = { memberJids, canonico };
