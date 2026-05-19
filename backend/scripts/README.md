# scripts/

Scripts que rodam **fora** da aplicação principal — manualmente ou agendados via PM2/Task Scheduler. Não fazem parte do `server.js` nem do `worker.js`.

## Arquivos

- **`backup-remote.js`** — sobe snapshots de `backend/backups/` pra S3 (ou compatível: B2, R2, Wasabi). Sem as envs `BACKUP_S3_*` configuradas, sai sem fazer nada. Rodar com `npm run backup:remote`.

## Backups de Postgres

Esta pasta não tem script de backup local — recomenda-se rodar `pg_dump` agendado (Task Scheduler no Windows, cron no Linux) escrevendo em `backend/backups/`. O `backup-remote.js` cuida de subir esses snapshots pra storage remota.
