#!/usr/bin/env node
// Backup remoto S3-compatível.
//
// Sobe os arquivos db-*.sql.gz de backend/backups/ pra um bucket S3-compatível
// (AWS S3, Backblaze B2, Wasabi, MinIO, Cloudflare R2, etc).
//
// Configuração via env (sem elas, sai exit 0 sem fazer nada):
//   BACKUP_S3_ENDPOINT   — opcional. AWS deixa vazio. Pra B2:
//                          https://s3.us-west-002.backblazeb2.com (ajuste a region)
//                          Pra R2: https://<accountid>.r2.cloudflarestorage.com
//   BACKUP_S3_REGION     — region (B2/R2 aceita "auto" ou a region específica)
//   BACKUP_S3_BUCKET     — nome do bucket
//   BACKUP_S3_PREFIX     — prefixo dentro do bucket (default: "nimbus/")
//   BACKUP_S3_KEY_ID     — access key id
//   BACKUP_S3_SECRET     — secret access key
//   BACKUP_RETAIN_REMOTE_HOURS — janela em que TODOS os snapshots ficam (default: 48h)
//   BACKUP_RETAIN_REMOTE_DAYS  — depois da janela, 1 por dia até N dias (default: 30)
//
// Uso:
//   node scripts/backup-remote.js               # sobe os que ainda não estão em remoto
//   node scripts/backup-remote.js --latest      # sobe só o último snapshot local
//   node scripts/backup-remote.js --dry-run     # mostra o que faria

require("../config/loadEnv"); // .env + override por modo (honra BACKUP_S3_PREFIX do ngrok)

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const backupCrypto = require("./backup-crypto");
const { computeRemoteKeep } = require("./backup-retention");

const BACKUPS_DIR = path.join(__dirname, "..", "backups");

const config = {
  endpoint: process.env.BACKUP_S3_ENDPOINT || undefined,
  region: process.env.BACKUP_S3_REGION || "us-east-1",
  bucket: process.env.BACKUP_S3_BUCKET,
  prefix: process.env.BACKUP_S3_PREFIX || "nimbus/",
  accessKeyId: process.env.BACKUP_S3_KEY_ID,
  secretAccessKey: process.env.BACKUP_S3_SECRET,
  retainHours: Number(process.env.BACKUP_RETAIN_REMOTE_HOURS) || 48,
  retainDays: Number(process.env.BACKUP_RETAIN_REMOTE_DAYS) || 30,
};

const args = new Set(process.argv.slice(2));
const LATEST_ONLY = args.has("--latest");
const DRY = args.has("--dry-run");

// BACKUP_REMOTE_AUTO_UPLOAD=0 desliga o upload automático sem desconfigurar o S3
// (assim o restore/download remoto continua funcionando). Usado no modo ngrok pra
// nunca subir dados de teste pra nuvem. Default: ligado.
const AUTO_UPLOAD = !/^(0|false|no|off)$/i.test(String(process.env.BACKUP_REMOTE_AUTO_UPLOAD ?? "1").trim());

const DUMP_RE = /^db-\d{8}-\d{6}\.sql\.gz$/;

async function listLocalDumps() {
  if (!fs.existsSync(BACKUPS_DIR)) return [];
  const entries = await fsp.readdir(BACKUPS_DIR, { withFileTypes: true });
  return entries
    .filter(e => e.isFile() && DUMP_RE.test(e.name))
    .map(e => ({ name: e.name, path: path.join(BACKUPS_DIR, e.name) }))
    .sort((a, b) => b.name.localeCompare(a.name));
}

function validateConfig() {
  const missing = [];
  if (!config.bucket) missing.push("BACKUP_S3_BUCKET");
  if (!config.accessKeyId) missing.push("BACKUP_S3_KEY_ID");
  if (!config.secretAccessKey) missing.push("BACKUP_S3_SECRET");
  if (missing.length) {
    console.error(`[backup-remote] env faltando: ${missing.join(", ")}`);
    console.error(`[backup-remote] backup remoto desativado. Defina as envs acima pra ativar.`);
    return false;
  }
  return true;
}

async function makeClient() {
  const { S3Client } = require("@aws-sdk/client-s3");
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    forcePathStyle: !!config.endpoint, // necessário pra B2/MinIO
  });
}

async function uploadDump(client, dump) {
  const { PutObjectCommand } = require("@aws-sdk/client-s3");
  // O dump vai cifrado pra nuvem quando BACKUP_ENC_KEY existe: o bucket está
  // fora do nosso controle e o conteúdo inclui hashes de senha e as sessões de
  // WhatsApp. O sufixo .enc marca o formato pro restore-remote.js.
  const cifrar = backupCrypto.isEnabled();
  const key = `${config.prefix}${dump.name}${cifrar ? backupCrypto.ENC_SUFFIX : ""}`;
  const stat = await fsp.stat(dump.path);
  if (DRY) {
    console.log(`  [dry] ${key} (${(stat.size / 1024 / 1024).toFixed(2)} MB)${cifrar ? " cifrado" : ""}`);
    return stat.size;
  }
  const body = cifrar
    ? backupCrypto.encryptBuffer(await fsp.readFile(dump.path))
    : fs.createReadStream(dump.path);
  await client.send(new PutObjectCommand({
    Bucket: config.bucket,
    Key: key,
    Body: body,
    ContentType: cifrar ? "application/octet-stream" : "application/gzip",
  }));
  const marca = cifrar ? " (cifrado)" : " (SEM CIFRA — defina BACKUP_ENC_KEY)";
  console.log(`[backup-remote] ${dump.name} OK (${(stat.size / 1024 / 1024).toFixed(2)} MB)${marca}`);
  return stat.size;
}

// Devolve [{ name, key }] — `name` é o nome canônico do dump (sem o .enc) e
// `key` é o objeto real no bucket. Separar os dois importa porque a comparação
// "já subi este dump?" e a rotação usam o nome, mas o delete precisa da chave.
// Sem isso, um bucket com objetos .enc pareceria vazio: o script re-enviaria
// tudo a cada execução e nunca rotacionaria.
async function listRemoteDumps(client) {
  const { ListObjectsV2Command } = require("@aws-sdk/client-s3");
  const seen = new Map();
  let token;
  do {
    const out = await client.send(new ListObjectsV2Command({
      Bucket: config.bucket,
      Prefix: config.prefix,
      ContinuationToken: token,
    }));
    for (const obj of (out.Contents || [])) {
      const key = obj.Key.slice(config.prefix.length);
      const name = key.endsWith(backupCrypto.ENC_SUFFIX)
        ? key.slice(0, -backupCrypto.ENC_SUFFIX.length)
        : key;
      if (DUMP_RE.test(name)) seen.set(name, key);
    }
    token = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (token);
  return [...seen.entries()]
    .map(([name, key]) => ({ name, key }))
    .sort((a, b) => b.name.localeCompare(a.name));
}

async function rotateRemote(client, all) {
  const { drop } = computeRemoteKeep(all.map(d => d.name), Date.now(), {
    hourlyWindowH: config.retainHours,
    retainDays: config.retainDays,
  });
  if (!drop.length) return;
  const keyByName = new Map(all.map(d => [d.name, d.key]));
  const toDelete = drop.map(name => ({ name, key: keyByName.get(name) })).filter(d => d.key);
  if (!toDelete.length) return;
  if (DRY) {
    for (const d of toDelete) console.log(`[dry] removeria remoto ${d.name}`);
    return;
  }
  const { DeleteObjectsCommand } = require("@aws-sdk/client-s3");
  const keys = toDelete.map(d => ({ Key: `${config.prefix}${d.key}` }));
  for (let i = 0; i < keys.length; i += 1000) {
    await client.send(new DeleteObjectsCommand({
      Bucket: config.bucket,
      Delete: { Objects: keys.slice(i, i + 1000) },
    }));
  }
  for (const d of toDelete) console.log(`[backup-remote] removido remoto antigo: ${d.name}`);
}

async function main() {
  if (!AUTO_UPLOAD) {
    console.log("[backup-remote] upload automático desligado (BACKUP_REMOTE_AUTO_UPLOAD=0). Nada a subir.");
    process.exit(0);
  }
  if (!validateConfig()) process.exit(0);

  const local = await listLocalDumps();
  if (!local.length) {
    console.log("[backup-remote] sem dumps locais em backend/backups/. Rode backup-db.sh antes.");
    process.exit(0);
  }

  const client = await makeClient();
  const remote = new Set((await listRemoteDumps(client)).map(d => d.name));
  console.log(`[backup-remote] local=${local.length} remote=${remote.size} target=${config.bucket}/${config.prefix}`);

  const candidates = LATEST_ONLY ? [local[0]] : local;
  const toUpload = candidates.filter(d => !remote.has(d.name));
  if (!toUpload.length) {
    console.log("[backup-remote] nada a subir — tudo já em remoto");
  }
  for (const d of toUpload) {
    await uploadDump(client, d);
  }

  const allRemote = await listRemoteDumps(client);
  await rotateRemote(client, allRemote);

  console.log("[backup-remote] done");
}

main().catch(err => {
  console.error("[backup-remote] falha:", err);
  process.exit(1);
});
