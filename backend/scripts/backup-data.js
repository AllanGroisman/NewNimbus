// Backup local de backend/data/ — copia o diretório com timestamp em backend/backups/.
// Mantém os últimos N snapshots (default 96 = 24h se rodar a cada 15min).
//
// Sem dependências externas, sem compressão (data é ~poucos MB hoje).
// Para schedule:
//   Windows  — Task Scheduler:  node C:\...\backend\scripts\backup-data.js
//   Linux    — cron:            */15 * * * * /usr/bin/node /opt/nimbus/backend/scripts/backup-data.js
//
// Uso manual:
//   node scripts/backup-data.js              # cria 1 backup, faz rotação
//   node scripts/backup-data.js --keep 50    # mantém últimos 50

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const BACKUP_DIR = path.join(__dirname, "..", "backups");

function parseArgs() {
  const args = process.argv.slice(2);
  const keepIdx = args.indexOf("--keep");
  return {
    keep: keepIdx >= 0 ? parseInt(args[keepIdx + 1]) || 96 : 96,
  };
}

function timestamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// Cópia recursiva nativa (Node 16.7+).
async function copyDir(src, dst) {
  await fsp.mkdir(dst, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    // Pula arquivos temporários (.tmp do storage atômico)
    if (e.name.endsWith(".tmp")) continue;
    if (e.isDirectory()) await copyDir(s, d);
    else if (e.isFile()) await fsp.copyFile(s, d);
  }
}

async function rotate(keep) {
  const entries = await fsp.readdir(BACKUP_DIR, { withFileTypes: true });
  const dirs = entries
    .filter(e => e.isDirectory() && /^data-\d{8}-\d{6}$/.test(e.name))
    .map(e => e.name)
    .sort(); // crescente — mais antigos primeiro
  const toRemove = dirs.slice(0, Math.max(0, dirs.length - keep));
  for (const name of toRemove) {
    await fsp.rm(path.join(BACKUP_DIR, name), { recursive: true, force: true });
  }
  return { kept: dirs.length - toRemove.length, removed: toRemove.length };
}

(async () => {
  const { keep } = parseArgs();

  if (!fs.existsSync(DATA_DIR)) {
    console.error(`[backup] ${DATA_DIR} não existe — nada a fazer`);
    process.exit(0);
  }

  await fsp.mkdir(BACKUP_DIR, { recursive: true });

  const target = path.join(BACKUP_DIR, `data-${timestamp()}`);
  const t0 = Date.now();

  try {
    await copyDir(DATA_DIR, target);
    const stats = await rotate(keep);
    const elapsed = Date.now() - t0;
    console.log(`[backup] ok: ${path.basename(target)} (${elapsed}ms) — mantendo ${stats.kept}, removidos ${stats.removed}`);
  } catch (err) {
    console.error(`[backup] FALHOU:`, err);
    process.exit(1);
  }
})();
