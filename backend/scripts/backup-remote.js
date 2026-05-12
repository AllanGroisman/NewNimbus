#!/usr/bin/env node
// Backup remoto S3-compatível (Fase 4 / hardening++).
//
// Sobe o snapshot mais recente de backend/backups/ pra um bucket S3-compatível
// (AWS S3, Backblaze B2, Wasabi, MinIO, Cloudflare R2, etc).
//
// Configuração via env:
//   BACKUP_S3_ENDPOINT   — opcional. Default: AWS. Pra B2: https://s3.us-west-002.backblazeb2.com
//                          Pra R2:  https://<accountid>.r2.cloudflarestorage.com
//   BACKUP_S3_REGION     — region (B2/R2 aceita "auto" ou a region específica)
//   BACKUP_S3_BUCKET     — nome do bucket
//   BACKUP_S3_PREFIX     — prefixo dentro do bucket (default: "nimbus/")
//   BACKUP_S3_KEY_ID     — access key id
//   BACKUP_S3_SECRET     — secret access key
//   BACKUP_RETAIN_REMOTE — quantos snapshots remotos manter (default: 30)
//
// Uso:
//   node scripts/backup-remote.js               # sobe último snapshot local
//   node scripts/backup-remote.js --all         # sobe todos snapshots locais ainda não enviados
//   node scripts/backup-remote.js --dry-run     # mostra o que faria
//
// Idempotência: usa o nome do snapshot local como key. Re-uploads sobrescrevem.

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const BACKUPS_DIR = path.join(__dirname, "..", "backups");

const config = {
  endpoint: process.env.BACKUP_S3_ENDPOINT || undefined,
  region: process.env.BACKUP_S3_REGION || "us-east-1",
  bucket: process.env.BACKUP_S3_BUCKET,
  prefix: process.env.BACKUP_S3_PREFIX || "nimbus/",
  accessKeyId: process.env.BACKUP_S3_KEY_ID,
  secretAccessKey: process.env.BACKUP_S3_SECRET,
  retain: Number(process.env.BACKUP_RETAIN_REMOTE) || 30,
};

const args = new Set(process.argv.slice(2));
const ALL = args.has("--all");
const DRY = args.has("--dry-run");

async function listLocalSnapshots() {
  if (!fs.existsSync(BACKUPS_DIR)) return [];
  const entries = await fsp.readdir(BACKUPS_DIR, { withFileTypes: true });
  return entries
    .filter(e => e.isDirectory() && e.name.startsWith("data-"))
    .map(e => ({ name: e.name, path: path.join(BACKUPS_DIR, e.name) }))
    .sort((a, b) => b.name.localeCompare(a.name)); // mais recente primeiro
}

// Walk recursivo gerando lista de arquivos relativos
async function walk(root) {
  const out = [];
  async function rec(dir, rel) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const r = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) await rec(full, r);
      else out.push({ full, rel: r.replace(/\\/g, "/") });
    }
  }
  await rec(root, "");
  return out;
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

async function uploadSnapshot(client, snapshot) {
  const { PutObjectCommand } = require("@aws-sdk/client-s3");
  const files = await walk(snapshot.path);
  console.log(`[backup-remote] subindo ${snapshot.name}: ${files.length} arquivos`);
  let bytes = 0;
  for (const f of files) {
    const key = `${config.prefix}${snapshot.name}/${f.rel}`;
    const stat = await fsp.stat(f.full);
    bytes += stat.size;
    if (DRY) {
      console.log(`  [dry] ${key} (${stat.size} bytes)`);
      continue;
    }
    const body = await fsp.readFile(f.full);
    await client.send(new PutObjectCommand({
      Bucket: config.bucket,
      Key: key,
      Body: body,
    }));
  }
  console.log(`[backup-remote] ${snapshot.name} OK (${(bytes / 1024 / 1024).toFixed(2)} MB)`);
  return bytes;
}

async function listRemoteSnapshots(client) {
  const { ListObjectsV2Command } = require("@aws-sdk/client-s3");
  const seen = new Set();
  let token;
  do {
    const out = await client.send(new ListObjectsV2Command({
      Bucket: config.bucket,
      Prefix: config.prefix,
      ContinuationToken: token,
    }));
    for (const obj of (out.Contents || [])) {
      // key formato: nimbus/data-YYYYMMDD-HHMMSS/...
      const key = obj.Key.slice(config.prefix.length);
      const snapName = key.split("/")[0];
      if (snapName.startsWith("data-")) seen.add(snapName);
    }
    token = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (token);
  return [...seen].sort((a, b) => b.localeCompare(a));
}

async function rotateRemote(client, all) {
  if (all.length <= config.retain) return;
  const { DeleteObjectsCommand, ListObjectsV2Command } = require("@aws-sdk/client-s3");
  const toDelete = all.slice(config.retain);
  for (const snap of toDelete) {
    const out = await client.send(new ListObjectsV2Command({
      Bucket: config.bucket,
      Prefix: `${config.prefix}${snap}/`,
    }));
    const keys = (out.Contents || []).map(o => ({ Key: o.Key }));
    if (!keys.length) continue;
    if (DRY) {
      console.log(`[dry] removeria ${snap} (${keys.length} objs)`);
      continue;
    }
    // S3 DeleteObjects: max 1000 por chamada
    for (let i = 0; i < keys.length; i += 1000) {
      await client.send(new DeleteObjectsCommand({
        Bucket: config.bucket,
        Delete: { Objects: keys.slice(i, i + 1000) },
      }));
    }
    console.log(`[backup-remote] removido remoto antigo: ${snap}`);
  }
}

async function main() {
  if (!validateConfig()) process.exit(0); // exit 0 — não é erro fatal, só desativado

  const local = await listLocalSnapshots();
  if (!local.length) {
    console.log("[backup-remote] sem snapshots locais em backend/backups/. Rode `npm run backup` antes.");
    process.exit(0);
  }

  const client = await makeClient();
  const remote = new Set(await listRemoteSnapshots(client));
  console.log(`[backup-remote] local=${local.length} remote=${remote.size} target=${config.bucket}/${config.prefix}`);

  const candidates = ALL ? local : [local[0]];
  const toUpload = candidates.filter(s => !remote.has(s.name));
  if (!toUpload.length) {
    console.log("[backup-remote] nada a subir — tudo já em remoto");
  }
  for (const s of toUpload) {
    await uploadSnapshot(client, s);
  }

  // Rotação no remoto
  const allRemote = await listRemoteSnapshots(client);
  await rotateRemote(client, allRemote);

  console.log("[backup-remote] done");
}

main().catch(err => {
  console.error("[backup-remote] falha:", err);
  process.exit(1);
});
