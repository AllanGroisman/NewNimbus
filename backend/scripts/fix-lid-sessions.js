// Ops pontual: apaga sessões Signal duplicadas PN×LID.
//
// O PROBLEMA. O WhatsApp migrou o endereço interno de cada aparelho do telefone
// ("PN", 555596168060) para um número opaco novo ("LID", 4269197504618). O
// Baileys 6.7.23 não sabe que os dois são a MESMA conta, então acaba guardando
// DUAS sessões Signal para o mesmo celular — dois ratchets independentes. Aí um
// lado cifra por um endereço e o outro decifra pelo outro: sai "Bad MAC" aqui e
// "Aguardando mensagem. Essa ação pode levar alguns instantes" lá. Ver o patch
// em patches/@whiskeysockets+baileys+6.7.23.patch, que fecha a causa; este
// script limpa os ratchets que JÁ divergiram (o patch sozinho não desfaz isso).
//
// Apagar uma linha `session` é seguro: na próxima mensagem o libsignal busca um
// pre-key bundle novo e refaz a sessão do zero — custa um round-trip. NUNCA
// tocamos em `creds`: apagar creds é que forçaria reler o QR.
//
// Uso:
//   node scripts/fix-lid-sessions.js                 # dry-run, todas as sessões
//   node scripts/fix-lid-sessions.js --session <id>  # só um número
//   node scripts/fix-lid-sessions.js --apply         # apaga de verdade
//
// O <id> é o sessionId do baileys_auth, no formato "<userId>::<numberId>".
require("../config/loadEnv");

// ── Quem é PN e quem é LID ───────────────────────────────────────────────
// O keyId de uma sessão Signal é "<user>.<device>". Precisamos separar os dois
// espaços de endereço sem ter o mapa (é justamente o que falta nesta versão do
// Baileys), então usamos a única coisa que dá pra afirmar: um PN é um telefone
// brasileiro de verdade — 55 + DDD válido + 8 ou 9 dígitos. Um LID não tem
// forma nenhuma, é opaco.
//
// Mais frouxo que o isValidPhone de utils/phone.js DE PROPÓSITO: aquele exige
// o nono dígito (é para cadastro de cliente novo), e há números antigos de 8
// dígitos ativos no WhatsApp — 555596168060 é um deles.
const DDDS = new Set([
  11, 12, 13, 14, 15, 16, 17, 18, 19,
  21, 22, 24, 27, 28,
  31, 32, 33, 34, 35, 37, 38,
  41, 42, 43, 44, 45, 46, 47, 48, 49,
  51, 53, 54, 55,
  61, 62, 63, 64, 65, 66, 67, 68, 69,
  71, 73, 74, 75, 77, 79,
  81, 82, 83, 84, 85, 86, 87, 88, 89,
  91, 92, 93, 94, 95, 96, 97, 98, 99,
]);

function looksLikePhoneUser(user) {
  if (!/^\d+$/.test(user || "")) return false;
  if (!user.startsWith("55")) return false;      // só atendemos Brasil
  if (user.length !== 12 && user.length !== 13) return false; // 55 + DDD + 8|9
  return DDDS.has(Number(user.slice(2, 4)));
}

function parseAddr(keyId) {
  const i = String(keyId).lastIndexOf(".");
  if (i <= 0) return null;
  const user = keyId.slice(0, i);
  const device = keyId.slice(i + 1);
  if (!/^\d+$/.test(device)) return null;
  return { user, device };
}

// Recebe os keyIds de session de UMA sessão Baileys e descobre quais deles são
// o MESMO aparelho gravado em dois endereços.
//
// Parear só por device seria errado: o número do device é por conta, então o
// device 41 do contato X e o device 41 do usuário não têm nada a ver um com o
// outro. Então exigimos evidência do par (pnUser, lidUser) em si:
//
//   - `proven`: mapeamentos que sabemos de fato — os `creds.me` das sessões
//     (id em PN e lid em LID são, por definição, o mesmo aparelho);
//   - co-ocorrência em 2+ devices: um LID que acompanha o mesmo PN em vários
//     devices é a mesma pessoa; num device só é coincidência e vai pra
//     `ambiguous`, que o script só lista.
function findDuplicatePairs(keyIds, proven = new Set()) {
  const byDevice = new Map();
  for (const keyId of keyIds) {
    const addr = parseAddr(keyId);
    if (!addr) continue;
    if (!byDevice.has(addr.device)) byDevice.set(addr.device, []);
    byDevice.get(addr.device).push({ ...addr, keyId });
  }

  // Candidatos: device com exatamente um PN e um LID.
  const candidates = [];
  for (const [device, entries] of byDevice) {
    const pn = entries.filter(e => looksLikePhoneUser(e.user));
    const lid = entries.filter(e => !looksLikePhoneUser(e.user));
    if (pn.length !== 1 || lid.length !== 1) continue;
    candidates.push({ device, pn: pn[0].keyId, lid: lid[0].keyId, mapping: `${pn[0].user}|${lid[0].user}` });
  }

  const support = new Map();
  for (const c of candidates) support.set(c.mapping, (support.get(c.mapping) || 0) + 1);

  const byDeviceNum = (a, b) => Number(a.device) - Number(b.device);
  const trusted = (c) => proven.has(c.mapping) || support.get(c.mapping) >= 2;
  return {
    pairs: candidates.filter(trusted).sort(byDeviceNum),
    ambiguous: candidates.filter(c => !trusted(c)).sort(byDeviceNum),
  };
}

// Mapeamentos que não são palpite: o `creds.me` de cada sessão diz, na fonte,
// que aquele id (PN) e aquele lid (LID) são o mesmo aparelho.
async function provenMappings(pgAuth, prismaClient) {
  const out = new Set();
  const rows = await prismaClient.baileysAuth.findMany({
    where: { keyType: "creds" },
    select: { sessionId: true, keyId: true },
  });
  for (const r of rows) {
    let creds = null;
    try { creds = await pgAuth.readKey(r.sessionId, "creds", r.keyId); } catch { continue; }
    const pn = parseAddr(String(creds?.me?.id || "").split("@")[0].replace(":", "."));
    const lid = parseAddr(String(creds?.me?.lid || "").split("@")[0].replace(":", "."));
    if (pn && lid) out.add(`${pn.user}|${lid.user}`);
  }
  return out;
}

async function main(argv) {
  const { prisma } = require("../db");
  const pgAuth = require("../auth/baileys-pg");

  const apply = argv.includes("--apply");
  const sIdx = argv.indexOf("--session");
  const onlySession = sIdx >= 0 ? argv[sIdx + 1] : null;
  if (sIdx >= 0 && !onlySession) {
    console.error("uso: --session <userId::numberId>");
    process.exit(1);
  }

  const p = prisma();
  const rows = await p.baileysAuth.findMany({
    where: { keyType: "session", ...(onlySession ? { sessionId: onlySession } : {}) },
    select: { sessionId: true, keyId: true },
  });
  if (!rows.length) {
    console.log(onlySession ? `nenhuma sessão Signal em ${onlySession}` : "nenhuma sessão Signal no banco");
    return;
  }

  const bySession = new Map();
  for (const r of rows) {
    if (!bySession.has(r.sessionId)) bySession.set(r.sessionId, []);
    bySession.get(r.sessionId).push(r.keyId);
  }

  const proven = await provenMappings(pgAuth, p);

  let totalPairs = 0;
  let totalDeleted = 0;
  let totalAmbiguous = 0;
  for (const sessionId of [...bySession.keys()].sort()) {
    const { pairs, ambiguous } = findDuplicatePairs(bySession.get(sessionId), proven);
    totalAmbiguous += ambiguous.length;
    if (!pairs.length && !ambiguous.length) continue;
    totalPairs += pairs.length;
    console.log(`\n${sessionId} — ${pairs.length} par(es) duplicado(s):`);
    for (const pair of pairs) {
      console.log(`  device ${pair.device}: ${pair.pn}  ↔  ${pair.lid}`);
      if (!apply) continue;
      for (const keyId of [pair.pn, pair.lid]) {
        try {
          await pgAuth.deleteKey(sessionId, "session", keyId);
          totalDeleted++;
        } catch (err) {
          console.error(`    ERRO ao apagar ${keyId}: ${err.message}`);
        }
      }
    }
    for (const a of ambiguous) {
      console.log(`  device ${a.device}: ${a.pn}  ↔  ${a.lid}  — ambíguo (1 device só), IGNORADO`);
    }
  }

  if (totalAmbiguous) {
    console.log(`\n${totalAmbiguous} candidato(s) ambíguo(s) ignorado(s) — provavelmente contatos diferentes que só coincidem no número do device.`);
  }
  if (!totalPairs) {
    console.log("nenhum par PN×LID duplicado encontrado.");
  } else if (apply) {
    console.log(`\n${totalDeleted} linha(s) apagada(s). Rode: pm2 reload nimbus-worker`);
  } else {
    console.log(`\n${totalPairs} par(es) — DRY RUN, nada foi apagado. Rode de novo com --apply.`);
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

module.exports = { looksLikePhoneUser, parseAddr, findDuplicatePairs, provenMappings };
