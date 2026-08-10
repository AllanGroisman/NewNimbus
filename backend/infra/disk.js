// Espaço em disco da máquina que roda o sistema — usado pelo botão em
// Admin › Backups.
//
// O backend roda direto no host (PM2), então o statfs daqui já é o disco real;
// só o Postgres/Redis ficam em container, e o volume deles mora no mesmo disco.
// O tamanho do banco vem do próprio Postgres (pg_database_size) porque medir
// /var/lib/docker/volumes na mão exige root.
//
// Do Backblaze só dá pra dizer quanto está OCUPADO: o B2 não tem espaço livre —
// é cobrado por GB guardado, sem limite fixo, e o cap de armazenamento da conta
// (quando existe) não aparece na API S3 que usamos aqui.

const fsp = require("fs/promises");
const path = require("path");
const { prisma } = require("../db");
const backupApi = require("../backup/api");

const BACKUPS_DIR = path.join(__dirname, "..", "backups");

async function backupsUsage() {
  const files = await fsp.readdir(BACKUPS_DIR).catch(err => {
    if (err.code === "ENOENT") return [];
    throw err;
  });
  let bytes = 0;
  let count = 0;
  for (const name of files) {
    const st = await fsp.stat(path.join(BACKUPS_DIR, name)).catch(() => null);
    if (!st || !st.isFile()) continue;
    bytes += st.size;
    count += 1;
  }
  return { bytes, count };
}

// Quanto os backups ocupam no bucket. Reusa listRemote pra bater exatamente com
// a lista que a tela já mostra (mesmo filtro de nome, mesmo prefixo).
async function remoteUsage() {
  const r = await backupApi.listRemote();
  if (!r.ok) return { configured: false, bytes: null, count: null };
  const items = r.items || [];
  return {
    configured: true,
    bytes: items.reduce((sum, it) => sum + (it.size || 0), 0),
    count: items.length,
  };
}

async function databaseBytes() {
  const rows = await prisma().$queryRaw`SELECT pg_database_size(current_database()) AS bytes`;
  return Number(rows[0].bytes);   // vem como BigInt
}

// Erro de uma parte não pode derrubar o resto: sem backups ainda queremos ver o
// disco, sem banco também, e o Backblaze fora do ar não pode esconder o resto.
async function safe(fn) {
  try {
    return { value: await fn(), error: null };
  } catch (err) {
    return { value: null, error: err.message };
  }
}

async function report() {
  // bavail = blocos livres para quem NÃO é root — é o número honesto pra quem
  // vai gravar um backup.
  const st = await fsp.statfs(BACKUPS_DIR).catch(() => fsp.statfs(path.join(__dirname, "..")));
  const totalBytes = st.bsize * st.blocks;
  const freeBytes = st.bsize * st.bavail;
  // Mesma conta do `df`: ocupado ignora os blocos reservados pro root, que não
  // são nem livres pra gente nem usados por ninguém.
  const usedBytes = st.bsize * (st.blocks - st.bfree);

  const [backups, database, remote] = await Promise.all([
    safe(backupsUsage), safe(databaseBytes), safe(remoteUsage),
  ]);

  return {
    path: BACKUPS_DIR,
    totalBytes,
    freeBytes,
    usedBytes,
    usedPct: usedBytes + freeBytes ? Math.round((usedBytes / (usedBytes + freeBytes)) * 100) : 0,
    backups: backups.value || { bytes: null, count: null, error: backups.error },
    database: { bytes: database.value, error: database.error },
    // Sem freeBytes de propósito: o B2 não tem esse número (ver comentário do topo).
    remote: remote.value
      ? { ...remote.value, error: null }
      : { configured: false, bytes: null, count: null, error: remote.error },
    checkedAt: new Date().toISOString(),
  };
}

module.exports = { report, BACKUPS_DIR };
