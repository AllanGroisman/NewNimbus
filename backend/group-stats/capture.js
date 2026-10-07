// Grava entradas e saídas de participante nos grupos do usuário (aba Grupos).
//
// Roda dentro do worker, acionado por um listener messages.upsert próprio em
// whatsapp/local.js (o aviso chega como stub "append" — ver stubs.js). Best-effort:
// uma falha aqui perde um evento, nunca derruba a sessão nem atrasa o envio.
//
// Grava para todo grupo CADASTRADO do usuário (whatsapp_groups), não só os que
// hoje recebem campanha: o custo é o mesmo, e o grupo vinculado a uma campanha
// amanhã chega com o histórico de hoje. A tela é que lista só os destinos.
//
// O dono vem do índice, não da sessão que recebeu — o mesmo critério do repasse
// (repasse/capture.js): o WhatsNimbus pode estar conectado com o MESMO telefone
// do usuário, e qualquer uma das duas sessões que receba o aviso serve. As duas
// recebendo é o caso comum; o unique de group_member_events descarta a segunda.

const { extrairEventos, temStubDeParticipante } = require("./stubs");

// ────────────────────────────────────────────────────────────────────────
// Índice `${numberId}::${jid}` → [userId] dos grupos cadastrados. Evita uma
// consulta por aviso; 60s de atraso pra um grupo recém-cadastrado começar a
// contar não faz diferença numa estatística diária.
// ────────────────────────────────────────────────────────────────────────

const INDEX_TTL_MS = 60 * 1000;
let _index = new Map();
let _indexAt = 0;
// Uma reconstrução por vez: na reconexão chega uma rajada de avisos atrasados,
// e cada um esperaria a sua própria consulta.
let _rebuilding = null;

async function rebuildIndex() {
  const { prisma } = require("../db");
  const rows = await prisma().whatsappGroup.findMany({ select: { userId: true, numberId: true, jid: true, id: true } });
  const map = new Map();
  for (const r of rows) {
    const k = `${r.numberId}::${r.jid || r.id}`;
    const donos = map.get(k) || [];
    if (!donos.includes(r.userId)) donos.push(r.userId);
    map.set(k, donos);
  }
  _index = map;
  _indexAt = Date.now();
}

async function donosDe(numberId, jid) {
  if (Date.now() - _indexAt > INDEX_TTL_MS) {
    _rebuilding = _rebuilding || rebuildIndex()
      .catch(err => console.error(`[group-stats] falha ao reconstruir índice de grupos: ${err.message}`))
      .finally(() => { _rebuilding = null; });
    await _rebuilding;
  }
  return _index.get(`${numberId}::${jid}`) || [];
}

function _resetIndex() {
  _index = new Map();
  _indexAt = 0;
  _rebuilding = null;
}

// `selfIds` e `pnForLid` vêm do socket (local.js): o próprio número não conta, e o
// mapeamento LID→PN é o que faz a entrada e a saída da mesma pessoa caírem no
// mesmo jid. Devolve quantas linhas gravou (pros testes).
async function onUpsert(userId, numberId, messages, { selfIds = [], pnForLid } = {}) {
  if (!temStubDeParticipante(messages)) return 0;
  numberId = String(numberId);
  try {
    const { canonico } = require("../whatsapp/group-members");
    const data = [];
    for (const ev of extrairEventos(messages, { selfIds })) {
      const donos = await donosDe(numberId, ev.groupJid);
      if (!donos.length) continue;
      const participant = await canonico(ev.participante, pnForLid);
      if (!participant) continue;
      for (const dono of donos) {
        data.push({ userId: dono, groupJid: ev.groupJid, participant, kind: ev.kind, at: ev.at, numberId });
      }
    }
    if (!data.length) return 0;
    const { prisma } = require("../db");
    const r = await prisma().groupMemberEvent.createMany({ data, skipDuplicates: true });
    return r.count;
  } catch (err) {
    console.error(`[group-stats] falha ao gravar entrada/saída (sessão ${userId}::${numberId}): ${err.message}`);
    return 0;
  }
}

module.exports = { onUpsert, _resetIndex };
