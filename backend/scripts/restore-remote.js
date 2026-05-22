#!/usr/bin/env node
// Restaura o banco a partir do backup mais recente no Backblaze B2 (ou S3-compatível).
//
// Uso:
//   node scripts/restore-remote.js              # lista backups disponíveis e pergunta
//   node scripts/restore-remote.js --latest     # restaura o mais novo sem perguntar
//   node scripts/restore-remote.js --list       # só lista, não restaura
//   node scripts/restore-remote.js --file db-20260522-114802.sql.gz
//
// Requer as mesmas envs do backup-remote.js (BACKUP_S3_*).
// O Postgres precisa estar rodando (docker compose up -d).

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const { execSync, spawnSync } = require("child_process");
const fs   = require("fs");
const fsp  = require("fs/promises");
const path = require("path");
const os   = require("os");
const readline = require("readline");

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
  return (res.Contents || [])
    .filter(o => o.Key.endsWith(".sql.gz"))
    .sort((a, b) => b.Key.localeCompare(a.Key)); // mais novo primeiro
}

async function download(client, key, destPath) {
  const res = await client.send(new GetObjectCommand({
    Bucket: config.bucket,
    Key:    key,
  }));
  const ws = fs.createWriteStream(destPath);
  await new Promise((resolve, reject) => {
    res.Body.pipe(ws);
    res.Body.on("error", reject);
    ws.on("finish", resolve);
  });
}

function docker(cmd) {
  const result = spawnSync("docker", ["ps", "--format", "{{.Names}}"], { encoding: "utf8" });
  const needSudo = result.status !== 0;
  return needSudo ? `sudo docker ${cmd}` : `docker ${cmd}`;
}

function restoreBackup(filePath) {
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
  execSync(
    `gunzip -c "${filePath}" | ${prefix} exec -i ${CONTAINER} psql -U ${PG_USER} -d ${PG_DB}`,
    { stdio: ["pipe", "pipe", "pipe"], shell: true }
  );

  console.log("[restore-remote] banco restaurado com sucesso.");
  console.log("  Reinicie o backend: pm2 restart nimbus-backend nimbus-worker");
}

function ask(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, ans => { rl.close(); resolve(ans.trim()); });
  });
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

  const tmpFile = path.join(os.tmpdir(), name);
  await download(client, chosen.Key, tmpFile);
  console.log(`[restore-remote] download OK (${(fs.statSync(tmpFile).size / 1024 / 1024).toFixed(2)} MB)`);

  restoreBackup(tmpFile);
  await fsp.unlink(tmpFile);
}

main().catch(err => {
  console.error("[restore-remote] erro:", err.message);
  process.exit(1);
});
