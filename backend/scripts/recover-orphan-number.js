// Ops pontual: recupera número que PAREOU no WhatsApp mas nunca foi gravado em
// `whatsapp_numbers` — o painel mostra "nenhum número" enquanto a sessão está
// viva e recebendo mensagens no worker.
//
// Uso:  node scripts/recover-orphan-number.js <userId> [--apply]
//       node scripts/recover-orphan-number.js --all      [--apply]
//
// Sem --apply é dry-run. Cria a linha com o MESMO shape que o frontend gravaria
// pelo handleConnected (id canônico = telefone, phone = "+<digitos>").
//
// URGENTE por natureza: restoreSessions apaga como "auth órfã" toda sessão sem
// linha em whatsapp_numbers, então rodar isto ANTES de qualquer restart/deploy.
require("../config/loadEnv");

const { prisma } = require("../db");

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const all = args.includes("--all");
  const userId = args.find(a => !a.startsWith("--")) || null;
  if (!userId && !all) {
    console.error("uso: node scripts/recover-orphan-number.js <userId> [--apply]  |  --all [--apply]");
    process.exit(1);
  }

  const db = prisma();

  // Sessões com credenciais (pareadas de verdade) — sessionId = "<userId>::<numberId>".
  const creds = await db.baileysAuth.findMany({ where: { keyType: "creds" }, select: { sessionId: true } });
  const pairs = creds
    .map(r => {
      const [u, n] = r.sessionId.split("::");
      return { userId: u, numberId: n };
    })
    .filter(p => p.userId && p.numberId && (all || p.userId === userId));

  if (!pairs.length) {
    console.log("nenhuma sessão com credenciais para esse filtro.");
    return;
  }

  const nums = await db.whatsappNumber.findMany({ select: { id: true, userId: true } });
  const known = new Set(nums.map(n => `${n.userId}::${n.id}`));

  const sessionStatus = require("../infra/session-status");
  const plan = [];

  for (const p of pairs) {
    if (known.has(`${p.userId}::${p.numberId}`)) continue;
    // O numberId canônico é o telefone (só dígitos). Um id provisório (Date.now())
    // significa sessão que nem chegou a canonicalizar — não é caso de recuperação.
    if (!/^\d{10,15}$/.test(p.numberId)) {
      console.log(`- ${p.userId}/${p.numberId}: id não-canônico, ignorado`);
      continue;
    }
    let snap = null;
    try { snap = await sessionStatus.read(p.userId, p.numberId); } catch { /* sem redis */ }
    plan.push({
      ...p,
      waName: snap?.info?.name || null,
      status: snap?.status || "unknown",
    });
  }

  if (!plan.length) {
    console.log("nada a recuperar — toda sessão com credenciais já tem linha em whatsapp_numbers.");
    return;
  }

  for (const p of plan) {
    console.log(`+ criar whatsapp_numbers id=${p.numberId} user=${p.userId} waName=${p.waName || "-"} (sessão: ${p.status})`);
  }

  if (!apply) {
    console.log(`\n[dry-run] ${plan.length} linha(s). Rode de novo com --apply para gravar.`);
    return;
  }

  for (const p of plan) {
    await db.whatsappNumber.create({
      data: {
        id: p.numberId,
        userId: p.userId,
        label: "Novo número",
        phone: `+${p.numberId}`,
        metadata: { status: "connected", waName: p.waName, lastActivity: "agora" },
      },
    });
    console.log(`OK ${p.userId}/${p.numberId}`);
  }
  console.log(`\n${plan.length} linha(s) criada(s). Peça ao usuário para RECARREGAR a página antes de mexer em qualquer coisa (o save do painel é replace-all).`);
}

main()
  .catch(e => { console.error("ERRO:", e.message); process.exitCode = 1; })
  .finally(async () => { try { await prisma().$disconnect(); } catch {} setTimeout(() => process.exit(process.exitCode || 0), 300); });
