// Registro dos envios de campanha por grupo (aba Grupos: envios por dia e
// "saídas até 1h depois de um envio").
//
// Chamado pelo scheduler.deliverItem, por onde passam todos os envios de
// campanha — agendado, fila do worker e "Enviar agora". Módulo à parte pelo mesmo
// motivo do repasse/capture-log.js: a única dependência é o db, e o scheduler não
// arrasta nada a mais pro próprio grafo.

const PRODUTO_MAX = 120;

// `enviados`: [{ jid, numberId, at }], um por grupo que recebeu. Best-effort e
// solto: o envio já aconteceu, e uma falha aqui só deixa um buraco na estatística.
function registrar(userId, campaignId, enviados, productName) {
  if (!Array.isArray(enviados) || !enviados.length) return Promise.resolve(0);
  const produto = productName ? String(productName).slice(0, PRODUTO_MAX) : null;
  return Promise.resolve().then(async () => {
    const { prisma } = require("../db");
    const r = await prisma().groupSendEvent.createMany({
      data: enviados.map(e => ({
        userId: String(userId),
        groupJid: e.jid,
        campaignId: BigInt(campaignId),
        numberId: e.numberId ? String(e.numberId) : null,
        productName: produto,
        at: e.at || new Date(),
      })),
    });
    return r.count;
  }).catch(err => {
    console.error(`[group-stats] falha ao registrar envio (campanha ${campaignId}): ${err.message}`);
    return 0;
  });
}

module.exports = { registrar };
