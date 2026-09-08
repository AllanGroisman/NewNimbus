// Ops pontual: força o Baileys a redistribuir a chave de um grupo.
//
// O PROBLEMA. Numa mensagem de grupo o conteúdo vai cifrado com uma *sender key*,
// e essa chave precisa ter sido entregue antes a cada participante. O Baileys
// guarda em `sender-key-memory` o mapa "pra quem eu já mandei" — e ele é uma
// promessa, não um fato: se a entrega falhou (endereço LID errado, sessão Signal
// divergente, socket caído no meio), o mapa continua dizendo "já mandei" e a
// chave NUNCA mais sai. Do outro lado o grupo inteiro fica em "Aguardando
// mensagem. Essa ação pode levar alguns instantes", pede reenvio até o teto de
// tentativas do WhatsApp e desiste — o placeholder fica pra sempre.
//
// Apagar a linha é seguro: sem o mapa, o próximo envio trata todo mundo como
// "ainda não recebeu" e redistribui a chave. Custa um fanout a mais. NUNCA
// tocamos em `creds` nem em `sender-key` (a chave em si) — só na anotação de
// quem já a recebeu.
//
// Uso:
//   node scripts/reset-group-sender-key.js                          # dry-run, todos
//   node scripts/reset-group-sender-key.js --group <jid>            # só um grupo
//   node scripts/reset-group-sender-key.js --session <id>           # só um número
//   node scripts/reset-group-sender-key.js --apply                  # apaga de verdade
//
// O <id> é o sessionId do baileys_auth, no formato "<userId>::<numberId>".
// O <jid> é o do grupo, "1203634...@g.us".
require("../config/loadEnv");

function arg(argv, name) {
  const i = argv.indexOf(name);
  if (i < 0) return null;
  const v = argv[i + 1];
  if (!v || v.startsWith("--")) {
    console.error(`uso: ${name} <valor>`);
    process.exit(1);
  }
  return v;
}

// Quantos destinatários o mapa promete ter atendido. É o número que importa: um
// mapa com 60 jids é o que está bloqueando a redistribuição; um mapa `null` (o
// Baileys zera assim ao atender um retry) já não bloqueia nada.
function mapSize(value) {
  try {
    const v = JSON.parse(value);
    return v && typeof v === "object" ? Object.keys(v).length : 0;
  } catch {
    return 0;
  }
}

async function main(argv) {
  const { prisma } = require("../db");
  const pgAuth = require("../auth/baileys-pg");

  const apply = argv.includes("--apply");
  const onlySession = arg(argv, "--session");
  const onlyGroup = arg(argv, "--group");

  const rows = await prisma().baileysAuth.findMany({
    where: {
      keyType: "sender-key-memory",
      ...(onlySession ? { sessionId: onlySession } : {}),
      ...(onlyGroup ? { keyId: onlyGroup } : {}),
    },
    select: { sessionId: true, keyId: true, value: true },
    orderBy: [{ sessionId: "asc" }, { keyId: "asc" }],
  });

  if (!rows.length) {
    console.log("nenhum sender-key-memory com esse filtro.");
    return;
  }

  let deleted = 0;
  for (const r of rows) {
    const n = mapSize(r.value);
    console.log(`${r.sessionId} | ${r.keyId} | ${n} destinatário(s) marcado(s) como já atendidos`);
    if (!apply) continue;
    try {
      await pgAuth.deleteKey(r.sessionId, "sender-key-memory", r.keyId);
      deleted++;
    } catch (err) {
      console.error(`  ERRO ao apagar: ${err.message}`);
    }
  }

  if (apply) {
    console.log(`\n${deleted} linha(s) apagada(s). Rode: pm2 reload nimbus-worker`);
  } else {
    console.log(`\n${rows.length} linha(s) — DRY RUN, nada foi apagado. Rode de novo com --apply.`);
  }
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then(() => require("../db").disconnect())
    .then(() => process.exit(process.exitCode || 0))
    .catch(async (err) => {
      console.error("ERRO:", err.message);
      try { await require("../db").disconnect(); } catch { /* ignore */ }
      process.exit(1);
    });
}

module.exports = { mapSize };
