// Cifra as linhas de baileys_auth que ainda estão em texto puro.
//
// A cifra em repouso (auth/baileys-pg.js) só se aplica a escritas novas — as
// linhas antigas seguem legíveis até o Baileys reescrever cada chave, o que pode
// nunca acontecer pras chaves de sessão antigas. Este script faz a passagem
// única sobre o que ficou pra trás.
//
// Idempotente: pula o que já está cifrado (prefixo "v1:").
//
// Uso:
//   node scripts/encrypt-baileys-auth.js --dry-run   # só conta
//   node scripts/encrypt-baileys-auth.js             # aplica
//
// Faça backup da tabela antes:
//   docker exec nimbus-postgres pg_dump -U nimbus -d nimbus -t baileys_auth > baileys.sql

require("../config/loadEnv");
const crypto = require("crypto");
const { prisma } = require("../db");

const ENC_PREFIX = "v1:";
const DRY_RUN = process.argv.includes("--dry-run");
const BATCH = 200;

const key = (() => {
  const raw = String(process.env.SESSION_ENC_KEY || "").trim();
  const buf = Buffer.from(raw, "hex");
  if (buf.length !== 32) {
    console.error("SESSION_ENC_KEY ausente ou inválida (precisa de 32 bytes em hex). Abortando.");
    process.exit(1);
  }
  return buf;
})();

function encrypt(json) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(json, "utf8"), cipher.final()]);
  return ENC_PREFIX + [iv, cipher.getAuthTag(), ct].map(b => b.toString("base64")).join(":");
}

function decrypt(str) {
  const [ivB64, tagB64, ctB64] = str.slice(ENC_PREFIX.length).split(":");
  const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  d.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([d.update(Buffer.from(ctB64, "base64")), d.final()]).toString("utf8");
}

(async () => {
  const total = await prisma().baileysAuth.count();
  const pendentes = await prisma().baileysAuth.count({
    where: { NOT: { value: { startsWith: ENC_PREFIX } } },
  });
  console.log(`baileys_auth: ${total} linhas, ${pendentes} em texto puro.`);

  if (DRY_RUN) { console.log("--dry-run: nada foi alterado."); process.exit(0); }
  if (pendentes === 0) { console.log("Nada a fazer."); process.exit(0); }

  let feitas = 0;
  let erros = 0;
  for (;;) {
    const lote = await prisma().baileysAuth.findMany({
      where: { NOT: { value: { startsWith: ENC_PREFIX } } },
      take: BATCH,
    });
    if (!lote.length) break;

    for (const row of lote) {
      const cifrado = encrypt(row.value);
      // Confere que dá pra voltar antes de gravar — não vale trocar dado bom por
      // dado ilegível; perder isto significa reescanear o QR de todos os números.
      if (decrypt(cifrado) !== row.value) {
        console.error(`FALHA ida-e-volta em ${row.sessionId}/${row.keyType}/${row.keyId} — pulando`);
        erros++;
        continue;
      }
      await prisma().baileysAuth.update({
        where: {
          sessionId_keyType_keyId: {
            sessionId: row.sessionId, keyType: row.keyType, keyId: row.keyId,
          },
        },
        data: { value: cifrado },
      });
      feitas++;
    }
    console.log(`  ${feitas}/${pendentes}...`);
  }

  console.log(`Pronto: ${feitas} linhas cifradas, ${erros} com erro.`);
  process.exit(erros ? 1 : 0);
})().catch(err => {
  console.error("Erro:", err.message);
  process.exit(1);
});
