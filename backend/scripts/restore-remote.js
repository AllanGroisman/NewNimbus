#!/usr/bin/env node
// Restaura o banco a partir do backup mais recente no Backblaze B2 (ou S3-compatível).
//
// Uso:
//   node scripts/restore-remote.js              # lista backups disponíveis e pergunta
//   node scripts/restore-remote.js --latest     # restaura o mais novo sem perguntar
//   node scripts/restore-remote.js --list       # só lista, não restaura
//   node scripts/restore-remote.js --file db-20260522-114802.sql.gz
//   node scripts/restore-remote.js --latest --keep-sessions   # mantém baileys_auth
//   node scripts/restore-remote.js --latest --drop-sessions   # zera baileys_auth
//
// A tabela `baileys_auth` (sessões do WhatsApp) é tratada à parte: num terminal o
// script PERGUNTA se deve trazê-la junto. Restaurar um dump de produção em outra
// máquina e subir o worker abre um device duplicado e derruba o WhatsApp dos
// usuários reais; mas restaurar a PRÓPRIA produção depois de um desastre precisa
// das sessões, senão todo mundo relê QR. O default (Enter / sem TTY) é NÃO trazer.
//
// Requer as mesmas envs do backup-remote.js (BACKUP_S3_*).
// O Postgres precisa estar rodando (docker compose up -d).

require("../config/loadEnv"); // .env + override por modo (honra BACKUP_S3_PREFIX do ngrok)

const { execSync, spawnSync } = require("child_process");
const fs   = require("fs");
const fsp  = require("fs/promises");
const path = require("path");
const os   = require("os");
const readline = require("readline");
const backupCrypto = require("./backup-crypto");
const { verifyDumpFile } = require("../backup/verify-dump");

const {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
} = require("@aws-sdk/client-s3");

const config = {
  endpoint:        process.env.BACKUP_S3_ENDPOINT || undefined,
  region:          process.env.BACKUP_S3_REGION   || "us-east-1",
  bucket:          process.env.BACKUP_S3_BUCKET,
  prefix:          process.env.BACKUP_S3_PREFIX   || "nimbus/",
  accessKeyId:     process.env.BACKUP_S3_KEY_ID,
  secretAccessKey: process.env.BACKUP_S3_SECRET,
};

const CONTAINER = process.env.POSTGRES_CONTAINER || "nimbus-postgres";
const PG_USER   = process.env.POSTGRES_USER       || "nimbus";
const PG_DB     = process.env.POSTGRES_DB         || "nimbus";

const args = new Set(process.argv.slice(2));
const LATEST   = args.has("--latest");
const LIST     = args.has("--list");
// Por padrão o restore NÃO traz as sessões do WhatsApp junto (ver
// clearBaileysAuth). --keep-sessions / NIMBUS_KEEP_SESSIONS=1 é o escape hatch
// pra recuperação de desastre NA PRÓPRIA produção, onde herdar a sessão é o certo.
const KEEP_SESSIONS = args.has("--keep-sessions") || process.env.NIMBUS_KEEP_SESSIONS === "1";
const DROP_SESSIONS = args.has("--drop-sessions") || process.env.NIMBUS_KEEP_SESSIONS === "0";
const FILE_ARG = (() => {
  const arr = process.argv.slice(2);
  const i   = arr.indexOf("--file");
  return i !== -1 ? arr[i + 1] : null;
})();

function validateConfig() {
  const missing = [];
  if (!config.bucket)          missing.push("BACKUP_S3_BUCKET");
  if (!config.accessKeyId)     missing.push("BACKUP_S3_KEY_ID");
  if (!config.secretAccessKey) missing.push("BACKUP_S3_SECRET");
  if (missing.length) {
    console.error(`[restore-remote] env faltando: ${missing.join(", ")}`);
    process.exit(0);
  }
}

function makeClient() {
  const opts = {
    region: config.region,
    credentials: {
      accessKeyId:     config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  };
  if (config.endpoint) opts.endpoint = config.endpoint;
  return new S3Client(opts);
}

async function listRemoteBackups(client) {
  const res = await client.send(new ListObjectsV2Command({
    Bucket: config.bucket,
    Prefix: config.prefix,
  }));
  // Aceita os dois formatos: .sql.gz (antigos, em claro) e .sql.gz.enc (cifrados
  // a partir de 07/2026). Um bucket pode ter os dois durante a transição.
  return (res.Contents || [])
    .filter(o => o.Key.endsWith(".sql.gz") || o.Key.endsWith(`.sql.gz${backupCrypto.ENC_SUFFIX}`))
    .sort((a, b) => b.Key.localeCompare(a.Key)); // mais novo primeiro
}

async function download(client, key, destPath) {
  const res = await client.send(new GetObjectCommand({
    Bucket: config.bucket,
    Key:    key,
  }));

  const chunks = [];
  for await (const chunk of res.Body) chunks.push(chunk);
  let buf = Buffer.concat(chunks);

  // Decifra se o arquivo veio cifrado. A detecção é pelo cabeçalho, não pela
  // extensão — assim um objeto renomeado no bucket ainda é tratado certo.
  if (backupCrypto.looksEncrypted(buf)) {
    if (!backupCrypto.isEnabled()) {
      throw new Error(
        `${key} está cifrado e BACKUP_ENC_KEY não está definida. ` +
        `Sem a chave o backup não pode ser restaurado — recupere-a da cópia guardada fora do servidor.`
      );
    }
    buf = backupCrypto.decryptBuffer(buf);
    console.log(`[restore-remote] ${key} decifrado (${(buf.length / 1024 / 1024).toFixed(2)} MB)`);
  }

  await fsp.writeFile(destPath, buf);
}

function docker(cmd) {
  const result = spawnSync("docker", ["ps", "--format", "{{.Names}}"], { encoding: "utf8" });
  const needSudo = result.status !== 0;
  return needSudo ? `sudo docker ${cmd}` : `docker ${cmd}`;
}

function restoreBackup(filePath, keepSessions) {
  const dockerCmd = spawnSync("docker", ["ps", "--format", "{{.Names}}"], { encoding: "utf8" });
  const prefix = dockerCmd.status !== 0 ? "sudo docker" : "docker";

  // Verifica container rodando
  const ps = execSync(`${prefix} ps --format "{{.Names}}"`, { encoding: "utf8" });
  if (!ps.includes(CONTAINER)) {
    console.error(`[restore-remote] container ${CONTAINER} não está rodando.`);
    console.error("  Suba o banco primeiro: sudo docker compose up -d");
    process.exit(1);
  }

  console.log(`[restore-remote] restaurando ${path.basename(filePath)} → ${PG_DB}...`);

  // Drop + re-cria o banco pra restauração limpa
  execSync(
    `${prefix} exec -i ${CONTAINER} psql -U ${PG_USER} -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${PG_DB}' AND pid <> pg_backend_pid();" 2>/dev/null`,
    { stdio: "pipe" }
  );
  execSync(
    `${prefix} exec -i ${CONTAINER} psql -U ${PG_USER} -d postgres -c "DROP DATABASE IF EXISTS ${PG_DB};"`,
    { stdio: "pipe" }
  );
  execSync(
    `${prefix} exec -i ${CONTAINER} psql -U ${PG_USER} -d postgres -c "CREATE DATABASE ${PG_DB};"`,
    { stdio: "pipe" }
  );

  // Restaura
  // ON_ERROR_STOP + pipefail: um erro no meio aborta com exit != 0 em vez de
  // terminar "com sucesso" com o banco pela metade.
  execSync(
    `set -o pipefail; gunzip -c "${filePath}" | ${prefix} exec -i ${CONTAINER} psql -v ON_ERROR_STOP=1 -q -U ${PG_USER} -d ${PG_DB}`,
    { stdio: ["pipe", "pipe", "pipe"], shell: "/bin/bash", maxBuffer: 64 * 1024 * 1024 }
  );

  clearBaileysAuth(prefix, keepSessions);

  console.log("[restore-remote] banco restaurado com sucesso.");
  console.log("  Reinicie o backend: pm2 restart nimbus-backend nimbus-worker");
}

// As linhas de `baileys_auth` são as CREDENCIAIS DE DEVICE dos WhatsApps dos
// usuários. Restaurar um dump de produção em outra máquina e subir o worker faz
// essa máquina abrir um SEGUNDO device com as mesmas credenciais — o WhatsApp
// trata como conflito, remove o device e o usuário REAL cai. Foi assim que
// vários usuários apareceram desconectados. Por padrão o restore descarta as
// sessões: o banco é uma cópia, a sessão não é copiável.
function clearBaileysAuth(prefix, keepSessions) {
  if (keepSessions) {
    console.log("[restore-remote] ⚠️  --keep-sessions: as sessões do WhatsApp vieram no restore.");
    console.log("  Só use isto na máquina que é DONA das sessões (recuperação de produção).");
    console.log("  Duas máquinas com a mesma auth = conflito e usuários desconectados.");
    return;
  }
  try {
    execSync(
      `${prefix} exec -i ${CONTAINER} psql -U ${PG_USER} -d ${PG_DB} -c "TRUNCATE TABLE baileys_auth;"`,
      { stdio: "pipe" }
    );
    console.log("[restore-remote] sessões do WhatsApp NÃO foram restauradas (baileys_auth limpa).");
    console.log("  Este banco é uma cópia: reusar a auth abriria um device duplicado e");
    console.log("  derrubaria o WhatsApp de quem está em produção. Releia o QR nesta máquina");
    console.log("  ou rode com --keep-sessions se aqui for a instância dona.");
  } catch (err) {
    // Dump antigo pode não ter a tabela — não é motivo pra falhar o restore.
    console.warn(`[restore-remote] não consegui limpar baileys_auth: ${err.message}`);
  }
}

function ask(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, ans => { rl.close(); resolve(ans.trim()); });
  });
}

// Decide se as sessões do WhatsApp vêm junto. Sem flag e com terminal, pergunta:
// a resposta certa depende de esta máquina ser ou não a DONA das sessões, e só
// quem está rodando o comando sabe disso.
async function decideSessions() {
  if (KEEP_SESSIONS) return true;
  if (DROP_SESSIONS) return false;
  if (!process.stdin.isTTY) return false; // automação: default seguro
  console.log("\n  Sessões do WhatsApp (baileys_auth):");
  console.log("    - Responda S só se ESTA máquina for a dona das sessões (ex.: recuperando");
  console.log("      a própria produção depois de um desastre).");
  console.log("    - Responda N (padrão) se este banco é uma CÓPIA. Duas máquinas com a");
  console.log("      mesma auth abrem um device duplicado e derrubam o WhatsApp dos usuários.");
  const ans = await ask("  Trazer as sessões do WhatsApp junto? [s/N] ");
  return ["s", "sim", "y", "yes"].includes(ans.toLowerCase());
}

async function main() {
  validateConfig();
  const client = makeClient();

  console.log("[restore-remote] buscando backups em", `${config.bucket}/${config.prefix}`);
  const backups = await listRemoteBackups(client);

  if (backups.length === 0) {
    console.log("[restore-remote] nenhum backup encontrado no bucket.");
    process.exit(0);
  }

  console.log("\nBackups disponíveis (mais novo primeiro):");
  backups.forEach((b, i) => {
    const name = b.Key.replace(config.prefix, "");
    const size = (b.Size / 1024 / 1024).toFixed(2);
    console.log(`  [${i + 1}] ${name}  (${size} MB)  ${b.LastModified.toISOString()}`);
  });

  if (LIST) process.exit(0);

  // Resolve qual backup usar
  let chosen;
  if (FILE_ARG) {
    chosen = backups.find(b => b.Key.endsWith(FILE_ARG));
    if (!chosen) { console.error(`[restore-remote] arquivo não encontrado: ${FILE_ARG}`); process.exit(1); }
  } else if (LATEST) {
    chosen = backups[0];
  } else {
    const ans = await ask("\nQual restaurar? [1] ou número: ");
    const idx = (ans === "" ? 1 : parseInt(ans, 10)) - 1;
    if (isNaN(idx) || idx < 0 || idx >= backups.length) {
      console.error("[restore-remote] opção inválida.");
      process.exit(1);
    }
    chosen = backups[idx];
  }

  const name = chosen.Key.replace(config.prefix, "");
  console.log(`\n[restore-remote] baixando ${name}...`);

  // Confirmação de segurança
  if (!LATEST && !FILE_ARG) {
    const confirm = await ask(`  ⚠️  Isso VAI SOBRESCREVER o banco local (${PG_DB}). Confirma? [s/N] `);
    if (!["s", "sim", "y", "yes"].includes(confirm.toLowerCase())) {
      console.log("[restore-remote] cancelado.");
      process.exit(0);
    }
  }

  // Tira o .enc do nome local: depois do download o arquivo já está decifrado e
  // é um .sql.gz comum. O gunzip do restoreBackup recusa sufixo desconhecido.
  const localName = name.endsWith(backupCrypto.ENC_SUFFIX)
    ? name.slice(0, -backupCrypto.ENC_SUFFIX.length)
    : name;
  const tmpFile = path.join(os.tmpdir(), localName);
  await download(client, chosen.Key, tmpFile);
  console.log(`[restore-remote] download OK (${(fs.statSync(tmpFile).size / 1024 / 1024).toFixed(2)} MB)`);

  // Valida antes do restoreBackup, que dropa o banco: arquivo truncado aqui para
  // tudo com o banco atual intacto.
  await verifyDumpFile(tmpFile);
  console.log("[restore-remote] dump íntegro (gzip ok + marcador de fim do pg_dump)");

  restoreBackup(tmpFile, await decideSessions());
  await fsp.unlink(tmpFile);
}

main().catch(err => {
  console.error("[restore-remote] erro:", err.message);
  process.exit(1);
});
