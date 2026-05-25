#!/usr/bin/env node
// Imprime na stdout o nome do backup mais recente no Backblaze (ex: db-20260522-120000.sql.gz).
// Sem output se não houver backups ou se o Backblaze não estiver configurado.
// Usado pelo windows\start.bat para comparar com o banco local.

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const { S3Client, ListObjectsV2Command } = require("@aws-sdk/client-s3");

const config = {
  endpoint:        process.env.BACKUP_S3_ENDPOINT || undefined,
  region:          process.env.BACKUP_S3_REGION   || "us-east-1",
  bucket:          process.env.BACKUP_S3_BUCKET,
  prefix:          process.env.BACKUP_S3_PREFIX   || "nimbus/",
  accessKeyId:     process.env.BACKUP_S3_KEY_ID,
  secretAccessKey: process.env.BACKUP_S3_SECRET,
};

if (!config.bucket || !config.accessKeyId || !config.secretAccessKey) process.exit(0);

const client = new S3Client({
  region: config.region,
  credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  ...(config.endpoint ? { endpoint: config.endpoint } : {}),
});

(async () => {
  try {
    const res = await client.send(new ListObjectsV2Command({
      Bucket: config.bucket,
      Prefix: config.prefix,
    }));
    const backups = (res.Contents || [])
      .filter(o => /db-\d{8}-\d{6}\.sql\.gz$/.test(o.Key))
      .sort((a, b) => b.Key.localeCompare(a.Key));
    if (backups.length > 0) {
      process.stdout.write(backups[0].Key.replace(config.prefix, "") + "\n");
    }
  } catch (_) {
    // silently fail — windows\start.bat trata ausência de output como "não configurado"
  }
})();
