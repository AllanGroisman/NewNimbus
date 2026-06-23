// Módulo de operações de backup — usado pelas rotas admin do server.js.
// Encapsula: listar local/remoto, criar dump, upload S3, download+restore, deletar.

const fs   = require("fs");
const fsp  = require("fs/promises");
const path = require("path");
const os   = require("os");
const { spawn, execSync } = require("child_process");
const {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} = require("@aws-sdk/client-s3");

const { mode } = require("../config/loadEnv");

const BACKUPS_DIR = path.join(__dirname, "..", "backups");
const CONTAINER   = process.env.POSTGRES_CONTAINER || "nimbus-postgres";
const PG_USER     = process.env.POSTGRES_USER      || "nimbus";
const PG_DB       = process.env.POSTGRES_DB        || "nimbus";

// No modo ngrok os prefixos S3 apontam pros backups de PRODUÇÃO (nimbus/) só pra
// LEITURA/restore — testar com dados reais. Bloqueamos qualquer ESCRITA no remoto
// (upload e delete) pra o ambiente de testes nunca poluir nem apagar os snapshots
// de produção. Em produção (mode=prod) tudo é permitido normalmente.
const REMOTE_WRITE_ALLOWED = mode !== "ngrok";

function assertRemoteWriteAllowed() {
  if (!REMOTE_WRITE_ALLOWED) {
    throw new Error("Escrita no backup remoto desabilitada no modo ngrok (protege os backups de produção). Envie/exclua na nuvem pelo modo produção.");
  }
}

const s3cfg = {
  endpoint:        process.env.BACKUP_S3_ENDPOINT || undefined,
  region:          process.env.BACKUP_S3_REGION   || "us-east-1",
  bucket:          process.env.BACKUP_S3_BUCKET,
  prefix:          process.env.BACKUP_S3_PREFIX   || "nimbus/",
  accessKeyId:     process.env.BACKUP_S3_KEY_ID,
  secretAccessKey: process.env.BACKUP_S3_SECRET,
};

const B2_OK = !!(s3cfg.bucket && s3cfg.accessKeyId && s3cfg.secretAccessKey);

function makeClient() {
  return new S3Client({
    region: s3cfg.region,
    credentials: { accessKeyId: s3cfg.accessKeyId, secretAccessKey: s3cfg.secretAccessKey },
    ...(s3cfg.endpoint ? { endpoint: s3cfg.endpoint } : {}),
  });
}

function getTimestamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function dockerPrefix() {
  try { execSync("docker ps", { stdio: "pipe" }); return "docker"; }
  catch { return "sudo docker"; }
}

// ── Local ─────────────────────────────────────────────────────────────────

async function listLocal() {
  await fsp.mkdir(BACKUPS_DIR, { recursive: true });
  const files = (await fsp.readdir(BACKUPS_DIR))
    .filter(f => /^db-\d{8}-\d{6}\.sql\.gz$/.test(f))
    .sort((a, b) => b.localeCompare(a));
  const result = [];
  for (const name of files) {
    const stat = await fsp.stat(path.join(BACKUPS_DIR, name));
    result.push({ name, size: stat.size, createdAt: stat.mtime.toISOString() });
  }
  return result;
}

async function createLocalDump() {
  await fsp.mkdir(BACKUPS_DIR, { recursive: true });
  const filename = `db-${getTimestamp()}.sql.gz`;
  const outPath  = path.join(BACKUPS_DIR, filename);
  const docker   = dockerPrefix();

  return new Promise((resolve, reject) => {
    const proc = spawn(docker, ["exec", CONTAINER, "sh", "-c", `pg_dump -U ${PG_USER} ${PG_DB} | gzip`], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const ws = fs.createWriteStream(outPath);
    proc.stdout.pipe(ws);
    let stderr = "";
    proc.stderr.on("data", chunk => { stderr += chunk; });
    proc.on("close", async code => {
      if (code === 0) {
        const stat = await fsp.stat(outPath);
        resolve({ name: filename, path: outPath, size: stat.size });
      } else {
        try { await fsp.unlink(outPath); } catch {}
        reject(new Error(`pg_dump falhou: ${stderr.trim() || "erro desconhecido"}`));
      }
    });
  });
}

async function deleteLocal(filename) {
  if (!/^db-\d{8}-\d{6}\.sql\.gz$/.test(filename)) throw new Error("Arquivo inválido");
  const filePath = path.join(BACKUPS_DIR, filename);
  await fsp.unlink(filePath);
}

// ── Remoto ────────────────────────────────────────────────────────────────

async function listRemote() {
  if (!B2_OK) return { ok: false, error: "Backblaze não configurado", items: [] };
  const client = makeClient();
  const res = await client.send(new ListObjectsV2Command({ Bucket: s3cfg.bucket, Prefix: s3cfg.prefix }));
  const items = (res.Contents || [])
    .filter(o => /db-\d{8}-\d{6}\.sql\.gz$/.test(o.Key))
    .sort((a, b) => b.Key.localeCompare(a.Key))
    .map(o => ({ name: o.Key.replace(s3cfg.prefix, ""), size: o.Size, createdAt: o.LastModified?.toISOString() }));
  return { ok: true, items, writable: REMOTE_WRITE_ALLOWED };
}

async function uploadToRemote(filename) {
  assertRemoteWriteAllowed();
  if (!B2_OK) throw new Error("Backblaze não configurado");
  if (!/^db-\d{8}-\d{6}\.sql\.gz$/.test(filename)) throw new Error("Arquivo inválido");
  const filePath = path.join(BACKUPS_DIR, filename);
  if (!fs.existsSync(filePath)) throw new Error("Arquivo local não encontrado");

  const client = makeClient();
  const stat   = await fsp.stat(filePath);
  await client.send(new PutObjectCommand({
    Bucket:        s3cfg.bucket,
    Key:           s3cfg.prefix + filename,
    Body:          fs.createReadStream(filePath),
    ContentLength: stat.size,
    ContentType:   "application/gzip",
  }));
  return { ok: true };
}

async function deleteRemote(filename) {
  assertRemoteWriteAllowed();
  if (!B2_OK) throw new Error("Backblaze não configurado");
  if (!/^db-\d{8}-\d{6}\.sql\.gz$/.test(filename)) throw new Error("Arquivo inválido");
  const client = makeClient();
  await client.send(new DeleteObjectCommand({ Bucket: s3cfg.bucket, Key: s3cfg.prefix + filename }));
  return { ok: true };
}

// ── Restore ───────────────────────────────────────────────────────────────

function restoreFromFile(filePath) {
  const docker = dockerPrefix();

  // Termina conexões ativas
  try {
    execSync(
      `${docker} exec -i ${CONTAINER} psql -U ${PG_USER} -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${PG_DB}' AND pid <> pg_backend_pid();"`,
      { stdio: "pipe" }
    );
  } catch {}

  execSync(
    `${docker} exec -i ${CONTAINER} psql -U ${PG_USER} -d postgres -c "DROP DATABASE IF EXISTS ${PG_DB};"`,
    { stdio: "pipe" }
  );
  execSync(
    `${docker} exec -i ${CONTAINER} psql -U ${PG_USER} -d postgres -c "CREATE DATABASE ${PG_DB};"`,
    { stdio: "pipe" }
  );
  execSync(
    `gunzip -c "${filePath}" | ${docker} exec -i ${CONTAINER} psql -U ${PG_USER} -d ${PG_DB}`,
    { stdio: ["pipe", "pipe", "pipe"], shell: true }
  );
}

async function restoreLocal(filename) {
  if (!/^db-\d{8}-\d{6}\.sql\.gz$/.test(filename)) throw new Error("Arquivo inválido");
  const filePath = path.join(BACKUPS_DIR, filename);
  if (!fs.existsSync(filePath)) throw new Error("Arquivo local não encontrado");
  restoreFromFile(filePath);
  return { ok: true };
}

async function restoreRemote(filename) {
  if (!B2_OK) throw new Error("Backblaze não configurado");
  if (!/^db-\d{8}-\d{6}\.sql\.gz$/.test(filename)) throw new Error("Arquivo inválido");

  const client  = makeClient();
  const tmpFile = path.join(os.tmpdir(), filename);

  const res = await client.send(new GetObjectCommand({ Bucket: s3cfg.bucket, Key: s3cfg.prefix + filename }));
  const ws  = fs.createWriteStream(tmpFile);
  await new Promise((resolve, reject) => {
    res.Body.pipe(ws);
    res.Body.on("error", reject);
    ws.on("finish", resolve);
  });

  try {
    restoreFromFile(tmpFile);
  } finally {
    try { await fsp.unlink(tmpFile); } catch {}
  }
  return { ok: true };
}

module.exports = {
  B2_OK,
  REMOTE_WRITE_ALLOWED,
  listLocal,
  createLocalDump,
  deleteLocal,
  listRemote,
  uploadToRemote,
  deleteRemote,
  restoreLocal,
  restoreRemote,
};
