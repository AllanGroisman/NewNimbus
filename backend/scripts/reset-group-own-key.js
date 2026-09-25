// Ops pontual: descarta a NOSSA chave de grupo (sender key) e deixa o Baileys
// criar uma nova.
//
// O PROBLEMA. A `sender-key` de um grupo é a corrente com que ciframos tudo o
// que mandamos ali; ela avança uma casa por mensagem, e cada participante
// precisa estar na mesma casa para abrir. Quando a entrega falha em série — foi
// o caso do grupo que sofreu o bug de endereçamento do Baileys 6 — a corrente do
// nosso lado gira centenas de vezes tentando reenviar, enquanto os celulares
// ficaram parados lá atrás. A partir daí ninguém mais decifra: o grupo mostra
// "Aguardando mensagem", pede reenvio sem parar, e cada reenvio afasta mais os
// dois lados. Dá para reconhecer pelo tamanho: uma sender key saudável tem ~1 KB;
// uma queimada passa de 100 KB (centenas de iterações e de chaves guardadas).
//
// Apagar a linha é seguro: no próximo envio o Baileys gera uma chave nova e a
// distribui do zero para todos os aparelhos do grupo — exatamente o que acontece
// num grupo recém-criado. Custa um fanout. As mensagens ANTIGAS que já estavam
// presas continuam ilegíveis: nada as recupera.
//
// Diferente do `reset-group-sender-key.js`, que mexe só na anotação
// `sender-key-memory` ("pra quem eu já mandei"). Aqui apagamos a chave em si.
// NUNCA tocamos em `creds` (isso forçaria reler o QR) nem nas `session` 1:1.
//
// Uso:
//   node scripts/reset-group-own-key.js --session <id> --group <jid>            # dry-run
//   node scripts/reset-group-own-key.js --session <id> --group <jid> --apply    # apaga
//
// O <id> é o sessionId do baileys_auth, "<userId>::<numberId>".
// O <jid> é o do grupo, "1203634...@g.us".
// Antes de apagar, grava um backup JSON com os valores como estão no banco
// (cifrados) — restaurar é reinserir as linhas.
require("../config/loadEnv");

const fs = require("fs");
const path = require("path");
const os = require("os");

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

async function main(argv) {
  const { prisma } = require("../db");

  const apply = argv.includes("--apply");
  const sessionId = arg(argv, "--session");
  const group = arg(argv, "--group");

  if (!sessionId || !group) {
    console.error("uso: node scripts/reset-group-own-key.js --session <userId::numberId> --group <jid@g.us> [--apply]");
    process.exit(1);
  }

  // O keyId de uma sender key é "<grupo>::<identidade>::<device>". Filtramos
  // pelo prefixo do grupo: pega a versão PN e a LID, que é justamente o par que
  // convive num grupo migrado.
  const rows = await prisma().baileysAuth.findMany({
    where: { sessionId, keyType: "sender-key", keyId: { startsWith: `${group}::` } },
    select: { keyId: true, value: true, updatedAt: true },
  });

  if (!rows.length) {
    console.log(`nada encontrado: sessão ${sessionId}, grupo ${group}`);
    return;
  }

  console.log(`${rows.length} chave(s) de grupo em ${group} (sessão ${sessionId}):`);
  for (const r of rows) {
    console.log(`  ${r.keyId}  ${String(r.value.length).padStart(7)} bytes  ${r.updatedAt.toISOString()}`);
  }

  if (!apply) {
    console.log("\ndry-run — nada foi apagado. Rode de novo com --apply para valer.");
    return;
  }

  const dir = path.join(os.homedir(), "nimbus-rollback");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `senderkey-${group.split("@")[0]}-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify({ sessionId, keyType: "sender-key", rows }, null, 2));
  console.log(`\nbackup: ${file}`);

  const del = await prisma().baileysAuth.deleteMany({
    where: { sessionId, keyType: "sender-key", keyId: { startsWith: `${group}::` } },
  });
  console.log(`apagadas ${del.count} linha(s). O próximo envio no grupo cria uma chave nova e a distribui para todos.`);
}

main(process.argv.slice(2))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    const { prisma } = require("../db");
    await prisma().$disconnect();
  });
