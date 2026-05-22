#!/usr/bin/env node
// Gerenciador interativo de backups Nimbus.
// Uso: node backend/scripts/sync-manager.js

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const fs      = require("fs");
const fsp     = require("fs/promises");
const path    = require("path");
const os      = require("os");
const rl      = require("readline");
const { spawn, spawnSync } = require("child_process");
const {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} = require("@aws-sdk/client-s3");

// ── Config ────────────────────────────────────────────────────────────────
const BACKUPS_DIR = path.join(__dirname, "..", "backups");
const CONTAINER   = process.env.POSTGRES_CONTAINER || "nimbus-postgres";
const PG_USER     = process.env.POSTGRES_USER      || "nimbus";
const PG_DB       = process.env.POSTGRES_DB        || "nimbus";

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

// ── Cores ANSI ────────────────────────────────────────────────────────────
const C = {
  reset:   "\x1b[0m",
  bold:    "\x1b[1m",
  dim:     "\x1b[2m",
  green:   "\x1b[32m",
  yellow:  "\x1b[33m",
  red:     "\x1b[31m",
  cyan:    "\x1b[36m",
  blue:    "\x1b[34m",
  magenta: "\x1b[35m",
};
const b  = s => `${C.bold}${s}${C.reset}`;
const g  = s => `${C.green}${s}${C.reset}`;
const y  = s => `${C.yellow}${s}${C.reset}`;
const r  = s => `${C.red}${s}${C.reset}`;
const c  = s => `${C.cyan}${s}${C.reset}`;
const d  = s => `${C.dim}${s}${C.reset}`;

// ── Helpers ───────────────────────────────────────────────────────────────
function mb(bytes) { return (bytes / 1024 / 1024).toFixed(2) + " MB"; }

function fmtDate(iso) {
  const dt = new Date(iso);
  return dt.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit",
    hour: "2-digit", minute: "2-digit" });
}

function tsFromName(name) {
  // db-20260522-143000.sql.gz → "20260522-143000"
  const m = name.match(/db-(\d{8}-\d{6})\.sql\.gz/);
  return m ? m[1] : "0";
}

function getTimestamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function dockerPrefix() {
  const r = spawnSync("docker", ["ps"], { encoding: "utf8" });
  return r.status !== 0 ? "sudo" : null;
}

// ── Local ─────────────────────────────────────────────────────────────────
async function listLocal() {
  try {
    await fsp.mkdir(BACKUPS_DIR, { recursive: true });
    const files = (await fsp.readdir(BACKUPS_DIR))
      .filter(f => /^db-\d{8}-\d{6}\.sql\.gz$/.test(f))
      .sort((a, b) => b.localeCompare(a));
    const result = [];
    for (const f of files) {
      const stat = await fsp.stat(path.join(BACKUPS_DIR, f));
      result.push({ name: f, size: stat.size, mtime: stat.mtime });
    }
    return result;
  } catch {
    return [];
  }
}

// ── Remoto ────────────────────────────────────────────────────────────────
async function listRemote(client) {
  const res = await client.send(new ListObjectsV2Command({
    Bucket: s3cfg.bucket, Prefix: s3cfg.prefix,
  }));
  return (res.Contents || [])
    .filter(o => /db-\d{8}-\d{6}\.sql\.gz$/.test(o.Key))
    .sort((a, b) => b.Key.localeCompare(a.Key))
    .map(o => ({ name: o.Key.replace(s3cfg.prefix, ""), size: o.Size, mtime: o.LastModified }));
}

// ── Dump local ────────────────────────────────────────────────────────────
async function createDump() {
  await fsp.mkdir(BACKUPS_DIR, { recursive: true });
  const filename = `db-${getTimestamp()}.sql.gz`;
  const outPath  = path.join(BACKUPS_DIR, filename);

  const sudo = dockerPrefix();
  const cmd  = sudo ? "sudo" : "docker";
  const args = sudo
    ? ["docker", "exec", CONTAINER, "sh", "-c", `pg_dump -U ${PG_USER} ${PG_DB} | gzip`]
    : ["exec", CONTAINER, "sh", "-c", `pg_dump -U ${PG_USER} ${PG_DB} | gzip`];

  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const ws   = fs.createWriteStream(outPath);
    proc.stdout.pipe(ws);
    let stderr = "";
    proc.stderr.on("data", chunk => { stderr += chunk; });
    proc.on("close", code => {
      if (code === 0) resolve({ filename, outPath });
      else {
        try { fs.unlinkSync(outPath); } catch {}
        reject(new Error(`pg_dump falhou (código ${code})\n${stderr}`));
      }
    });
  });
}

// ── Upload ────────────────────────────────────────────────────────────────
async function uploadFile(client, filePath, name) {
  const body = fs.createReadStream(filePath);
  const size = (await fsp.stat(filePath)).size;
  await client.send(new PutObjectCommand({
    Bucket:        s3cfg.bucket,
    Key:           s3cfg.prefix + name,
    Body:          body,
    ContentLength: size,
    ContentType:   "application/gzip",
  }));
}

// ── Download + restore ────────────────────────────────────────────────────
async function downloadFile(client, name, destPath) {
  const res = await client.send(new GetObjectCommand({
    Bucket: s3cfg.bucket, Key: s3cfg.prefix + name,
  }));
  const ws = fs.createWriteStream(destPath);
  await new Promise((resolve, reject) => {
    res.Body.pipe(ws);
    res.Body.on("error", reject);
    ws.on("finish", resolve);
  });
}

function restoreFile(filePath) {
  const sudo   = dockerPrefix();
  const prefix = sudo ? "sudo docker" : "docker";
  const { execSync } = require("child_process");

  // termina conexões ativas
  try {
    execSync(`${prefix} exec -i ${CONTAINER} psql -U ${PG_USER} -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${PG_DB}' AND pid <> pg_backend_pid();" 2>/dev/null`, { stdio: "pipe" });
  } catch {}
  execSync(`${prefix} exec -i ${CONTAINER} psql -U ${PG_USER} -d postgres -c "DROP DATABASE IF EXISTS ${PG_DB};"`, { stdio: "pipe" });
  execSync(`${prefix} exec -i ${CONTAINER} psql -U ${PG_USER} -d postgres -c "CREATE DATABASE ${PG_DB};"`, { stdio: "pipe" });
  execSync(`gunzip -c "${filePath}" | ${prefix} exec -i ${CONTAINER} psql -U ${PG_USER} -d ${PG_DB}`, { stdio: ["pipe","pipe","pipe"], shell: true });
}

// ── Delete remoto ─────────────────────────────────────────────────────────
async function deleteRemote(client, name) {
  await client.send(new DeleteObjectCommand({
    Bucket: s3cfg.bucket, Key: s3cfg.prefix + name,
  }));
}

// ── UI ────────────────────────────────────────────────────────────────────
function ask(question) {
  const iface = rl.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => iface.question(question, ans => { iface.close(); resolve(ans.trim()); }));
}

function sep(char = "─", len = 52) { return C.dim + char.repeat(len) + C.reset; }

function header() {
  console.clear();
  console.log();
  console.log(b(c("  NIMBUS — Gerenciador de Backup")));
  console.log(sep("═"));
}

async function showStatus(locals, remotes) {
  const latestLocal  = locals[0];
  const latestRemote = remotes ? remotes[0] : null;

  console.log();
  console.log(b("  LOCAL") + d(`  (${BACKUPS_DIR})`));
  if (latestLocal) {
    console.log(`    Mais recente : ${g(latestLocal.name)}  ${d(mb(latestLocal.size))}`);
    console.log(`    Total        : ${locals.length} arquivo(s)`);
  } else {
    console.log(`    ${d("Nenhum backup local encontrado.")}`);
  }

  console.log();
  if (!B2_OK) {
    console.log(b("  BACKBLAZE") + "  " + r("não configurado"));
    console.log(d("    Configure BACKUP_S3_* no backend/.env para habilitar."));
  } else if (!remotes) {
    console.log(b("  BACKBLAZE") + "  " + y("carregando..."));
  } else if (latestRemote) {
    console.log(b("  BACKBLAZE"));
    console.log(`    Mais recente : ${g(latestRemote.name)}  ${d(mb(latestRemote.size))}`);
    console.log(`    Total        : ${remotes.length} arquivo(s)`);
  } else {
    console.log(b("  BACKBLAZE") + "  " + d("sem backups remotos"));
  }

  if (latestLocal && latestRemote) {
    console.log();
    const lTs = tsFromName(latestLocal.name);
    const rTs = tsFromName(latestRemote.name);
    if (lTs === rTs)        console.log(`  Status : ${g("✓ sincronizado")}`);
    else if (lTs > rTs)     console.log(`  Status : ${y("▲ local mais novo")}  ${d("(rode push para sincronizar)")}`);
    else                    console.log(`  Status : ${y("▼ remoto mais novo")}  ${d("(rode pull para atualizar)")}`);
  }
}

function showMenu() {
  console.log();
  console.log(sep());
  console.log(`  ${b("1")}  Listar backups locais`);
  console.log(`  ${b("2")}  Listar backups remotos (Backblaze)`);
  console.log(`  ${b("3")}  ${g("Push")} — criar dump e enviar ao Backblaze`);
  console.log(`  ${b("4")}  ${y("Pull")} — restaurar do Backblaze para o banco local`);
  console.log(`  ${b("5")}  ${r("Deletar")} backup remoto`);
  console.log(`  ${b("6")}  Atualizar`);
  console.log(`  ${b("0")}  Sair`);
  console.log(sep());
}

function printList(items, label) {
  console.log();
  console.log(b(`  ${label}:`));
  if (items.length === 0) {
    console.log(d("    Nenhum backup encontrado."));
    return;
  }
  items.forEach((item, i) => {
    const date = item.mtime ? fmtDate(item.mtime) : "—";
    console.log(`  [${i+1}]  ${g(item.name)}  ${d(mb(item.size))}  ${d(date)}`);
  });
}

// ── Ações ────────────────────────────────────────────────────────────────
async function actionPush(client) {
  console.log();
  console.log("  Criando dump do banco local...");
  let dump;
  try {
    dump = await createDump();
    const stat = await fsp.stat(dump.outPath);
    console.log(g(`  Dump criado: ${dump.filename}  (${mb(stat.size)})`));
  } catch (e) {
    console.log(r(`  Erro ao criar dump: ${e.message}`));
    return;
  }

  if (!B2_OK) {
    console.log(y("  Backblaze não configurado — dump salvo apenas localmente."));
    return;
  }

  console.log("  Enviando ao Backblaze...");
  try {
    await uploadFile(client, dump.outPath, dump.filename);
    console.log(g(`  Upload concluído: ${dump.filename}`));
  } catch (e) {
    console.log(r(`  Erro no upload: ${e.message}`));
  }
}

async function actionPull(client, remotes) {
  if (!B2_OK) { console.log(r("  Backblaze não configurado.")); return; }
  if (!remotes || remotes.length === 0) { console.log(y("  Sem backups remotos.")); return; }

  printList(remotes, "Backups disponíveis no Backblaze");
  console.log();
  const ans = await ask(`  Qual restaurar? [1–${remotes.length}] (Enter = mais recente): `);
  const idx = ans === "" ? 0 : parseInt(ans, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= remotes.length) {
    console.log(r("  Opção inválida.")); return;
  }
  const chosen = remotes[idx];

  console.log();
  const confirm = await ask(r(`  ⚠ Isso VAI SOBRESCREVER o banco local (${PG_DB}). Confirma? [s/N] `));
  if (!["s","sim","y","yes"].includes(confirm.toLowerCase())) {
    console.log("  Cancelado."); return;
  }

  console.log(`  Baixando ${chosen.name}...`);
  const tmpFile = path.join(os.tmpdir(), chosen.name);
  try {
    await downloadFile(client, chosen.name, tmpFile);
    console.log(g(`  Download OK (${mb(chosen.size)})`));
  } catch (e) {
    console.log(r(`  Erro no download: ${e.message}`)); return;
  }

  console.log("  Restaurando banco...");
  try {
    restoreFile(tmpFile);
    await fsp.unlink(tmpFile);
    console.log(g("  Banco restaurado com sucesso!"));
    console.log(d("  Reinicie o backend para aplicar as mudanças."));
  } catch (e) {
    console.log(r(`  Erro na restauração: ${e.message}`));
    console.log(d("  (gunzip precisa estar no PATH — instale o Git for Windows se estiver no Windows)"));
  }
}

async function actionDeleteRemote(client, remotes) {
  if (!B2_OK) { console.log(r("  Backblaze não configurado.")); return; }
  if (!remotes || remotes.length === 0) { console.log(y("  Sem backups remotos.")); return; }

  printList(remotes, "Backups remotos");
  console.log();
  const ans = await ask(`  Qual deletar? [1–${remotes.length}]: `);
  const idx = parseInt(ans, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= remotes.length) {
    console.log(r("  Opção inválida.")); return;
  }
  const chosen = remotes[idx];
  const confirm = await ask(r(`  Deletar ${chosen.name} do Backblaze? Isso não pode ser desfeito. [s/N] `));
  if (!["s","sim","y","yes"].includes(confirm.toLowerCase())) {
    console.log("  Cancelado."); return;
  }
  try {
    await deleteRemote(client, chosen.name);
    console.log(g(`  Deletado: ${chosen.name}`));
  } catch (e) {
    console.log(r(`  Erro: ${e.message}`));
  }
}

// ── Main loop ─────────────────────────────────────────────────────────────
async function main() {
  const client = B2_OK ? makeClient() : null;
  let locals  = [];
  let remotes = null;

  const refresh = async () => {
    locals  = await listLocal();
    remotes = null;
    if (B2_OK) {
      try { remotes = await listRemote(client); }
      catch (e) { remotes = []; console.log(r(`  Erro ao buscar Backblaze: ${e.message}`)); }
    }
  };

  await refresh();

  while (true) {
    header();
    await showStatus(locals, remotes);
    showMenu();
    console.log();
    const opt = await ask("  > ");

    switch (opt.trim()) {
      case "1":
        header();
        printList(locals, "Backups locais");
        await ask("\n  Enter para continuar...");
        break;
      case "2":
        header();
        if (!B2_OK) { console.log(r("\n  Backblaze não configurado.")); }
        else { printList(remotes || [], "Backups remotos (Backblaze)"); }
        await ask("\n  Enter para continuar...");
        break;
      case "3":
        header();
        await actionPush(client);
        await refresh();
        await ask("\n  Enter para continuar...");
        break;
      case "4":
        header();
        await actionPull(client, remotes);
        await refresh();
        await ask("\n  Enter para continuar...");
        break;
      case "5":
        header();
        await actionDeleteRemote(client, remotes);
        await refresh();
        await ask("\n  Enter para continuar...");
        break;
      case "6":
        await refresh();
        break;
      case "0":
      case "q":
      case "":
        console.log("\n  Saindo.\n");
        process.exit(0);
      default:
        console.log(r("  Opção inválida."));
        await new Promise(r => setTimeout(r, 800));
    }
  }
}

main().catch(e => { console.error(r(`\nErro fatal: ${e.message}`)); process.exit(1); });
