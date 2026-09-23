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
const backupCrypto = require("../scripts/backup-crypto");
const { purgeKey } = require("../scripts/purge-remote-versions");
const { verifyDumpFile } = require("./verify-dump");

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
  // Mesmo esquema do backup-db.sh: .partial até validar, pra um dump quebrado
  // nunca ganhar o nome db-*.sql.gz (que o upload automático sobe pro B2).
  const partial  = `${outPath}.partial`;
  const docker   = dockerPrefix();

  const { code, stderr } = await new Promise((resolve, reject) => {
    const proc = spawn(docker, ["exec", CONTAINER, "sh", "-c", `pg_dump -U ${PG_USER} ${PG_DB} | gzip`], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const ws = fs.createWriteStream(partial);
    proc.stdout.pipe(ws);
    let err = "";
    proc.stderr.on("data", chunk => { err += chunk; });
    proc.on("error", reject);
    // Espera o arquivo fechar, não só o processo — senão a validação lê o fim cortado.
    let exitCode = null;
    let done = 0;
    const finish = () => { if (++done === 2) resolve({ code: exitCode, stderr: err }); };
    proc.on("close", c => { exitCode = c; finish(); });
    ws.on("close", finish);
  });

  try {
    if (code !== 0) throw new Error(`pg_dump falhou: ${stderr.trim() || "erro desconhecido"}`);
    // O `sh` do container não tem pipefail: o exit code é o do gzip, e um pg_dump
    // que morre ainda dá 0. O conteúdo é a única prova confiável.
    try {
      await verifyDumpFile(partial);
    } catch (err) {
      throw new Error(`pg_dump falhou: ${stderr.trim() || err.message}`);
    }
    await fsp.rename(partial, outPath);
  } catch (err) {
    try { await fsp.unlink(partial); } catch {}
    throw err;
  }
  const stat = await fsp.stat(outPath);
  return { name: filename, path: outPath, size: stat.size };
}

async function deleteLocal(filename) {
  if (!/^db-\d{8}-\d{6}\.sql\.gz$/.test(filename)) throw new Error("Arquivo inválido");
  const filePath = path.join(BACKUPS_DIR, filename);
  await fsp.unlink(filePath);
}

// ── Remoto ────────────────────────────────────────────────────────────────

// Nome de arquivo remoto. Continua estrito (é input de request e vira chave no
// bucket e caminho em disco) — só passou a aceitar o sufixo .enc dos dumps
// cifrados. As rotas locais mantêm a regex sem .enc: o dump local não é cifrado.
const REMOTE_NAME_RE = /^db-\d{8}-\d{6}\.sql\.gz(\.enc)?$/;

async function listRemote() {
  if (!B2_OK) return { ok: false, error: "Backblaze não configurado", items: [] };
  const client = makeClient();
  const res = await client.send(new ListObjectsV2Command({ Bucket: s3cfg.bucket, Prefix: s3cfg.prefix }));
  const items = (res.Contents || [])
    // O .enc é opcional: dumps enviados a partir de 07/2026 vão cifrados.
    .filter(o => /db-\d{8}-\d{6}\.sql\.gz(\.enc)?$/.test(o.Key))
    .sort((a, b) => b.Key.localeCompare(a.Key))
    .map(o => ({ name: o.Key.replace(s3cfg.prefix, ""), size: o.Size, createdAt: o.LastModified?.toISOString() }));
  return { ok: true, items, writable: REMOTE_WRITE_ALLOWED };
}

async function uploadToRemote(filename) {
  assertRemoteWriteAllowed();
  if (!B2_OK) throw new Error("Backblaze não configurado");
  if (!REMOTE_NAME_RE.test(filename)) throw new Error("Arquivo inválido");
  const filePath = path.join(BACKUPS_DIR, filename);
  if (!fs.existsSync(filePath)) throw new Error("Arquivo local não encontrado");

  const client = makeClient();
  // Mesma regra do backup automático: sai cifrado do servidor quando há chave.
  const cifrar = backupCrypto.isEnabled();
  const body   = cifrar
    ? backupCrypto.encryptBuffer(await fsp.readFile(filePath))
    : fs.createReadStream(filePath);
  const stat   = await fsp.stat(filePath);
  await client.send(new PutObjectCommand({
    Bucket:        s3cfg.bucket,
    Key:           s3cfg.prefix + filename + (cifrar ? backupCrypto.ENC_SUFFIX : ""),
    Body:          body,
    ContentLength: cifrar ? body.length : stat.size,
    ContentType:   cifrar ? "application/octet-stream" : "application/gzip",
  }));
  return { ok: true };
}

async function deleteRemote(filename) {
  assertRemoteWriteAllowed();
  if (!B2_OK) throw new Error("Backblaze não configurado");
  if (!REMOTE_NAME_RE.test(filename)) throw new Error("Arquivo inválido");
  const client = makeClient();
  // Num bucket versionado (o do B2 é), DeleteObject só empilha um hide marker: o
  // arquivo some da lista mas continua ocupando o cap. purgeKey apaga por VersionId.
  const removidos = await purgeKey(client, { bucket: s3cfg.bucket, key: s3cfg.prefix + filename });
  if (!removidos) {
    await client.send(new DeleteObjectCommand({ Bucket: s3cfg.bucket, Key: s3cfg.prefix + filename }));
  }
  return { ok: true };
}

// ── Restore ───────────────────────────────────────────────────────────────

async function restoreFromFile(filePath) {
  // Valida ANTES do DROP: com um arquivo truncado o restore apagava o banco e
  // recriava só metade, respondendo "restaurado com sucesso".
  await verifyDumpFile(filePath);
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
  // ON_ERROR_STOP + pipefail: erro de SQL ou de gunzip derruba o comando em vez
  // de ser engolido (antes o psql seguia e saía 0 com o banco pela metade).
  execSync(
    `set -o pipefail; gunzip -c "${filePath}" | ${docker} exec -i ${CONTAINER} psql -v ON_ERROR_STOP=1 -q -U ${PG_USER} -d ${PG_DB}`,
    { stdio: ["pipe", "pipe", "pipe"], shell: "/bin/bash", maxBuffer: 64 * 1024 * 1024 }
  );
}

async function restoreLocal(filename) {
  if (!/^db-\d{8}-\d{6}\.sql\.gz$/.test(filename)) throw new Error("Arquivo inválido");
  const filePath = path.join(BACKUPS_DIR, filename);
  if (!fs.existsSync(filePath)) throw new Error("Arquivo local não encontrado");
  await restoreFromFile(filePath);
  return { ok: true };
}

async function restoreRemote(filename) {
  if (!B2_OK) throw new Error("Backblaze não configurado");
  if (!REMOTE_NAME_RE.test(filename)) throw new Error("Arquivo inválido");

  const client = makeClient();
  // O arquivo local precisa terminar em .sql.gz: depois de decifrado ele é um
  // gzip comum, e o gunzip do restoreFromFile recusa sufixo desconhecido.
  const localName = filename.endsWith(backupCrypto.ENC_SUFFIX)
    ? filename.slice(0, -backupCrypto.ENC_SUFFIX.length)
    : filename;
  const tmpFile = path.join(os.tmpdir(), localName);

  const res = await client.send(new GetObjectCommand({ Bucket: s3cfg.bucket, Key: s3cfg.prefix + filename }));
  const chunks = [];
  for await (const chunk of res.Body) chunks.push(chunk);
  let buf = Buffer.concat(chunks);

  if (backupCrypto.looksEncrypted(buf)) {
    if (!backupCrypto.isEnabled()) {
      throw new Error("Backup cifrado e BACKUP_ENC_KEY não está definida — sem a chave não dá pra restaurar.");
    }
    buf = backupCrypto.decryptBuffer(buf);
  }
  await fsp.writeFile(tmpFile, buf);

  try {
    await restoreFromFile(tmpFile);
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
