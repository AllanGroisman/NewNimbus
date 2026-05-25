// Migração única: numberId volátil (Date.now do frontend) -> id canônico = telefone.
//
// Contexto: o id de cada número era gerado pelo frontend com Date.now(), então
// cada re-scan criava um id novo e deixava whatsapp_groups apontando pro id morto
// (erro "Sessão não encontrada" no envio). Agora o id canônico é o telefone, e o
// backend canonicaliza a sessão no connect (ver whatsapp/local.js + auth/baileys-pg.js).
// Este script alinha os DADOS JÁ GRAVADOS ao novo esquema.
//
// Renomeia, de forma consistente, em três lugares:
//   - baileys_auth.sessionId : "<userId>::<idVelho>"  -> "<userId>::<telefone>"
//   - whatsapp_groups.numberId : idVelho -> telefone
//   - whatsapp_numbers.id : idVelho -> telefone
//
// USO (rodar no host de produção, com o worker PARADO — ver passo a passo no fim):
//   node scripts/migrate-whatsapp-number-ids.js            # dry-run (só mostra o plano)
//   node scripts/migrate-whatsapp-number-ids.js --apply    # executa de fato
//
// É idempotente: números cujo id já é o telefone são pulados.

const { prisma, disconnect } = require("../db");

const APPLY = process.argv.includes("--apply");
const normalizePhone = (p) => String(p || "").replace(/\D/g, "");

async function main() {
  const db = prisma();
  const numbers = await db.whatsappNumber.findMany({
    select: { id: true, userId: true, phone: true, label: true },
  });

  console.log(`\n[migrate] ${numbers.length} número(s) encontrados. Modo: ${APPLY ? "APLICAR" : "DRY-RUN (nada será alterado)"}\n`);

  let migrated = 0, skipped = 0, conflicts = 0;

  for (const n of numbers) {
    const canonical = normalizePhone(n.phone);
    if (!canonical) {
      console.log(`  SKIP  id=${n.id} (sem telefone) label="${n.label || "-"}"`);
      skipped++;
      continue;
    }
    if (n.id === canonical) {
      console.log(`  OK    id=${n.id} (já canônico)`);
      skipped++;
      continue;
    }

    const oldSession = `${n.userId}::${n.id}`;
    const newSession = `${n.userId}::${canonical}`;

    // Conflito: já existe um número canônico pra esse telefone/usuário?
    const canonicalExists = numbers.some(
      (m) => m.userId === n.userId && m.id === canonical
    );

    const authRows = await db.baileysAuth.count({ where: { sessionId: oldSession } });
    const groupRows = await db.whatsappGroup.count({ where: { userId: n.userId, numberId: n.id } });

    console.log(
      `  MIGRAR id=${n.id} -> ${canonical}  (auth:${authRows} grupos:${groupRows}` +
      `${canonicalExists ? " | CONFLITO: canônico já existe -> mescla" : ""})`
    );

    if (canonicalExists) conflicts++;

    if (!APPLY) { migrated++; continue; }

    await db.$transaction(async (tx) => {
      // 1. baileys_auth: limpa o destino e move as linhas do id velho.
      await tx.baileysAuth.deleteMany({ where: { sessionId: newSession } });
      await tx.baileysAuth.updateMany({
        where: { sessionId: oldSession },
        data: { sessionId: newSession },
      });
      // 2. whatsapp_groups: re-aponta pro id canônico.
      await tx.whatsappGroup.updateMany({
        where: { userId: n.userId, numberId: n.id },
        data: { numberId: canonical },
      });
      // 3. whatsapp_numbers: se o canônico já existe, descarta o velho (mesclado);
      //    senão, renomeia o id do velho pro canônico.
      if (canonicalExists) {
        await tx.whatsappNumber.delete({ where: { id: n.id } });
      } else {
        await tx.whatsappNumber.update({
          where: { id: n.id },
          data: { id: canonical },
        });
      }
    });
    migrated++;
  }

  console.log(
    `\n[migrate] ${APPLY ? "Aplicado" : "Plano"}: ${migrated} migrar/migrado, ${skipped} pulado(s), ${conflicts} conflito(s).`
  );
  if (!APPLY) console.log("[migrate] Rode de novo com --apply pra executar.\n");
  else console.log("[migrate] Pronto. Reinicie o worker e recarregue o navegador.\n");
}

main()
  .catch((e) => { console.error("[migrate] erro:", e); process.exitCode = 1; })
  .finally(() => disconnect());
