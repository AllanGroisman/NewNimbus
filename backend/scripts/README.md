# scripts/

Scripts que rodam **fora** da aplicação principal — manualmente ou agendados via PM2/Task Scheduler. Não fazem parte do `server.js` nem do `worker.js`.

## Arquivos

- **`backup-data.js`** — copia `backend/data/` pra `backend/backups/data-YYYYMMDD-HHMMSS/`. Mantém os últimos 96 (≈ 24h se rodar a cada 15min). Rodar com `npm run backup`.
- **`backup-remote.js`** — sobe o último snapshot pra S3 (ou compatível: B2, R2, Wasabi). Sem as envs `BACKUP_S3_*` configuradas, sai sem fazer nada. Rodar com `npm run backup:remote`.
- **`backup-all.ps1`** — versão PowerShell que faz pg_dump do Postgres + copia `data/`. Rodada pelo Task Scheduler do Windows a cada 15min.
- **`migrate-json-to-pg.js`** — copia tudo de `backend/data/*.json` pras tabelas Postgres equivalentes. Idempotente, aceita `--dry-run`. Rodar com `npm run migrate-data`.
- **`migrate-auth-to-pg.js`** — copia as sessões do WhatsApp de `backend/auth_states/` pra tabela `baileys_auth` no Postgres. Idempotente, aceita `--dry-run`. Rodar com `npm run migrate-auth`.

## Quando você precisa rodar

- **Trocando de JSON pra Postgres pela primeira vez**: rode `npm run migrate-data` e depois `npm run migrate-auth`. Depois mude `STORAGE_BACKEND=pg` e suba o backend.
- **Antes de uma mudança grande no `data/`**: `npm run backup` pra garantir.
- **Em produção**: o PM2 (via `ecosystem.config.js`) já agenda `backup-data` a cada 15min e `backup-remote` a cada 1h. Não precisa chamar à mão.
