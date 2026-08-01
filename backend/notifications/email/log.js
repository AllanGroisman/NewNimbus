// Log de e-mails enviados — é ele que impede o mesmo aviso de sair duas vezes.
//
// O webhook do Stripe reentrega eventos e o job de lembretes roda 4x por dia,
// então a garantia não pode depender de "quem chama toma cuidado". A chave é a
// coluna `dedupeKey` UNIQUE: quem consegue inserir manda o e-mail, quem bate em
// conflito descobre que outro já mandou. Mesmo truque de markWebhookProcessed.

const { prisma } = require("../../db");

// Reserva o direito de enviar. Devolve a linha criada, ou null se a dedupeKey
// já existe (alguém já enviou este e-mail).
async function claim({ kind, userId, to, dedupeKey }) {
  try {
    return await prisma().emailLog.create({
      data: { kind, userId: userId || null, to, dedupeKey },
    });
  } catch (err) {
    if (err.code === "P2002") return null; // unique violation = já enviado
    throw err;
  }
}

// Fecha a linha reservada com o desfecho real do envio.
async function finish(id, status, error) {
  if (!id) return;
  await prisma().emailLog.update({
    where: { id },
    data: {
      status,
      error: error ? String(error).slice(0, 500) : null,
      sentAt: status === "sent" ? new Date() : null,
    },
  });
}

// Janela de silêncio por (usuário, tipo) — usada nos avisos de segurança, que
// não têm um "âncora" natural pra dedupeKey (trocar a senha 3x em um minuto
// não deve render 3 e-mails iguais).
async function recentlySent(userId, kind, windowMs) {
  if (!userId || !windowMs) return false;
  const row = await prisma().emailLog.findFirst({
    where: { userId, kind, createdAt: { gte: new Date(Date.now() - windowMs) } },
    select: { id: true },
  });
  return !!row;
}

async function listByUser(userId, limit = 50) {
  return prisma().emailLog.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(1, Number(limit) || 50), 200),
  });
}

module.exports = { claim, finish, recentlySent, listByUser };
