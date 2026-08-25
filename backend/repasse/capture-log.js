// Escrita do log de captura do repasse — uma linha por (link, campanha) tentado.
//
// Mora num módulo à parte, e não dentro do capture.js, porque o scheduler também
// precisa gravar (o descarte que acontece lá no envio). O capture.js requer o
// scheduler; se o scheduler requeresse o capture.js de volta, além do ciclo ele
// arrastaria scraper/storage/affiliate/notifier pro próprio grafo à toa. Aqui a
// única dependência é o db.

const affiliate = require("../scraping/affiliate");

// Best-effort: nunca deve quebrar nem atrasar o pipeline — qualquer falha é
// engolida (o log é observabilidade, não parte do fluxo).
async function logCapture(fields) {
  try {
    const { prisma } = require("../db");
    await prisma().repasseCaptureLog.create({
      data: {
        groupId: BigInt(fields.groupId),
        userId: String(fields.userId),
        waJid: fields.waJid || "",
        rawUrl: fields.rawUrl,
        resolvedUrl: fields.resolvedUrl || null,
        store: fields.store || null,
        sourceAllowed: fields.sourceAllowed ?? null,
        affiliateConfigured: fields.affiliateConfigured ?? null,
        scrapeOk: fields.scrapeOk ?? null,
        productName: fields.productName || null,
        productImg: fields.productImg || null,
        price: fields.price ?? null,
        originalPrice: fields.originalPrice ?? null,
        discount: fields.discount ?? null,
        // A coluna é Int; o produto carrega o TEXTO das vendas ("+1.000 vendidos")
        // pra mensagem preservar o "+". Converte só aqui, pro log.
        sold: fields.sold != null ? affiliate.parseSoldText(fields.sold) : null,
        // Cupom que veio na legenda do grupo líder. Null = a mensagem não trazia
        // nenhum — o log precisa mostrar os dois casos, não só quando pescou algo.
        coupon: fields.coupon || null,
        outcome: fields.outcome,
        // Motivo em lista fechada (error-kinds.js) + o texto humano ao lado. Os
        // dois juntos: um dá pra contar e filtrar, o outro dá pra ler.
        errorKind: fields.errorKind || null,
        stage: fields.stage || null,
        reason: fields.reason || null,
      },
    });
  } catch (err) {
    console.error(`[repasse] falha ao gravar log de captura: ${err.message}`);
  }
}

module.exports = { logCapture };
