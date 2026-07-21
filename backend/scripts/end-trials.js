// One-shot: encerra os trials de 7 dias existentes.
//
// Contexto: removemos o trial gratuito de 7 dias (plano Pro) das contas novas.
// Este script converte os trials JÁ EXISTENTES em free/inactive — ou seja, contas
// que estavam usando o app de graça param de ter acesso até assinar.
//
// Só toca trials INTERNOS (status="trialing" AND stripeSubscriptionId IS NULL).
// Assinaturas pagas (status="active") e qualquer trial vindo do Stripe (com
// stripeSubscriptionId) NÃO são afetados. Admins também não — o bypass em
// limits.effectivePlanId dá Business independente do row.
//
// USO (rodar no host, backend):
//   node scripts/end-trials.js            # dry-run (só mostra quantos/quais)
//   node scripts/end-trials.js --apply    # executa de fato
//
// É idempotente: rodar duas vezes não faz nada na segunda (não há mais trialing).

const { prisma, disconnect } = require("../db");

const APPLY = process.argv.includes("--apply");

async function main() {
  const db = prisma();
  const where = { status: "trialing", stripeSubscriptionId: null };

  const rows = await db.subscription.findMany({
    where,
    select: { userId: true, planId: true, currentPeriodEnd: true },
  });

  console.log(`Trials internos encontrados: ${rows.length}`);
  for (const r of rows) {
    console.log(`  user=${r.userId} plano=${r.planId} fim=${r.currentPeriodEnd?.toISOString?.() || r.currentPeriodEnd}`);
  }

  if (!rows.length) {
    console.log("Nada a fazer.");
    return;
  }

  if (!APPLY) {
    console.log("\n[dry-run] Rode com --apply pra converter em free/inactive.");
    return;
  }

  const res = await db.subscription.updateMany({
    where,
    data: { planId: "free", status: "inactive", currentPeriodEnd: null },
  });
  console.log(`\n[apply] ${res.count} assinatura(s) convertida(s) em free/inactive.`);
}

main()
  .catch((err) => {
    console.error("Falhou:", err);
    process.exitCode = 1;
  })
  .finally(() => disconnect());
