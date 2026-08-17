#!/usr/bin/env node
// Expurgo de versões antigas no bucket S3/B2.
//
// Por que existe: o bucket do Backblaze é versionado. Um DELETE comum (o da rotação
// em backup-remote.js, o do botão de excluir no admin, ou o feito na mão pelo site do
// B2) NÃO apaga o arquivo — só empilha um "hide marker" em cima dele. O objeto some da
// listagem mas os bytes continuam contando no cap da conta. Foi assim que o bucket
// chegou a 9,6 GB de 10 GB com apenas ~70 snapshots vivos: 8,6 GB eram versões mortas.
//
// Este script apaga PERMANENTEMENTE (por VersionId):
//   - toda versão com IsLatest=false  → cópias antigas/escondidas de um dump
//   - todo delete marker              → as etiquetas de "escondido"
// A versão atual de cada arquivo vivo nunca é tocada.
//
// Uso:
//   node scripts/purge-remote-versions.js --dry-run     # só conta e soma bytes
//   node scripts/purge-remote-versions.js               # apaga de verdade
//   node scripts/purge-remote-versions.js --prefix=     # varre o bucket inteiro

require("../config/loadEnv");

const {
  S3Client,
  ListObjectVersionsCommand,
  DeleteObjectsCommand,
} = require("@aws-sdk/client-s3");

function s3ConfigFromEnv() {
  return {
    endpoint: process.env.BACKUP_S3_ENDPOINT || undefined,
    region: process.env.BACKUP_S3_REGION || "us-east-1",
    bucket: process.env.BACKUP_S3_BUCKET,
    prefix: process.env.BACKUP_S3_PREFIX || "nimbus/",
    accessKeyId: process.env.BACKUP_S3_KEY_ID,
    secretAccessKey: process.env.BACKUP_S3_SECRET,
  };
}

// Lista tudo que é descartável sob o prefixo. Separado do delete pra poder ser
// testado com um client fake e pra o --dry-run usar exatamente a mesma seleção.
async function listPurgeable(client, { bucket, prefix, includeLatest = false }) {
  const items = [];
  let bytes = 0;
  let versions = 0;
  let markers = 0;
  let KeyMarker;
  let VersionIdMarker;
  do {
    const out = await client.send(new ListObjectVersionsCommand({
      Bucket: bucket,
      Prefix: prefix || undefined,
      KeyMarker,
      VersionIdMarker,
    }));
    for (const v of (out.Versions || [])) {
      if (v.IsLatest && !includeLatest) continue; // versão viva — nunca apagar aqui
      items.push({ Key: v.Key, VersionId: v.VersionId });
      bytes += v.Size || 0;
      versions++;
    }
    for (const d of (out.DeleteMarkers || [])) {
      items.push({ Key: d.Key, VersionId: d.VersionId });
      markers++;
    }
    KeyMarker = out.IsTruncated ? out.NextKeyMarker : undefined;
    VersionIdMarker = out.IsTruncated ? out.NextVersionIdMarker : undefined;
  } while (KeyMarker || VersionIdMarker);
  return { items, bytes, versions, markers };
}

async function deleteBatched(client, bucket, items) {
  for (let i = 0; i < items.length; i += 1000) {
    await client.send(new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: { Objects: items.slice(i, i + 1000), Quiet: true },
    }));
  }
}

// Usado pelo backup-remote.js depois da rotação: transforma os hide markers que a
// rotação acabou de criar em espaço livre de verdade.
async function purgeOldVersions(client, { bucket, prefix, dryRun = false, log = () => {} }) {
  const found = await listPurgeable(client, { bucket, prefix });
  const mb = (found.bytes / 1024 / 1024).toFixed(1);
  if (!found.items.length) {
    log("[purge] nenhuma versão morta no bucket");
    return { ...found, deleted: 0 };
  }
  log(`[purge] ${found.versions} versões antigas (${mb} MB) + ${found.markers} hide markers${dryRun ? " [dry-run]" : ""}`);
  if (dryRun) return { ...found, deleted: 0 };
  await deleteBatched(client, bucket, found.items);
  log(`[purge] removido permanentemente: ${found.items.length} objetos, ${mb} MB liberados`);
  return { ...found, deleted: found.items.length };
}

// Apaga TODAS as versões de uma chave específica (delete de verdade, não hide).
// Usado pelo botão de excluir remoto no admin.
async function purgeKey(client, { bucket, key }) {
  const { items } = await listPurgeable(client, { bucket, prefix: key, includeLatest: true });
  // Prefix casa por prefixo: filtra sobras de chaves parecidas (ex: <key>.enc.bak).
  const exact = items.filter(i => i.Key === key || i.Key === `${key}.enc`);
  if (exact.length) await deleteBatched(client, bucket, exact);
  return exact.length;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const cfg = s3ConfigFromEnv();
  const prefixArg = args.find(a => a.startsWith("--prefix="));
  if (prefixArg) cfg.prefix = prefixArg.slice("--prefix=".length);

  if (!cfg.bucket || !cfg.accessKeyId || !cfg.secretAccessKey) {
    console.error("[purge] env faltando: BACKUP_S3_BUCKET / BACKUP_S3_KEY_ID / BACKUP_S3_SECRET");
    process.exit(0);
  }

  const client = new S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    forcePathStyle: !!cfg.endpoint,
  });

  console.log(`[purge] alvo: ${cfg.bucket}/${cfg.prefix}`);
  await purgeOldVersions(client, { ...cfg, dryRun, log: console.log });
}

if (require.main === module) {
  main().catch(err => {
    console.error("[purge] falha:", err);
    process.exit(1);
  });
}

module.exports = { listPurgeable, purgeOldVersions, purgeKey, s3ConfigFromEnv };
