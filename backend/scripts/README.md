# scripts/

Scripts que rodam **fora** da aplicação principal — manualmente ou via cron. Não fazem parte do `server.js` nem do `worker.js`.

## Backup 3 camadas

```
  Postgres (Docker)
        │
        ├── 1. backup-db.sh      → backend/backups/db-YYYYMMDD-HHMMSS.sql.gz  (local, 48 snapshots)
        │
        ├── 2. backup-remote.js  → Backblaze B2 / R2 / S3                     (remoto, 30 snapshots)
        │
        └── 3. backup-gdrive.sh  → Google Drive (via rclone)                  (espelho, sem rotação)
```

Cada camada é independente — se uma falhar (sem credencial, sem internet), as outras continuam.

### Setup inicial (na VPS Ubuntu)

```bash
bash deploy/setup-backups.sh
```

Esse script:
1. Instala `rclone`.
2. Chmod +x nos scripts.
3. Avisa o que falta configurar (B2 no `.env`, Google Drive via `rclone config`).
4. Registra cron a cada 6h chamando `backup-all.sh`.

### Arquivos

| Script | O que faz |
|---|---|
| **`backup-db.sh`** | `pg_dump` do container `nimbus-postgres`, salva `.sql.gz` em `backend/backups/`. Rotaciona mantendo os últimos 48 (configurável via `BACKUP_RETAIN_LOCAL`). |
| **`backup-remote.js`** | Sobe os `db-*.sql.gz` pra um bucket S3-compatível. Sem as envs `BACKUP_S3_*`, sai exit 0 sem fazer nada. Rotaciona remoto mantendo `BACKUP_RETAIN_REMOTE` (default 30). |
| **`backup-gdrive.sh`** | `rclone sync` da pasta `backups/` pro Google Drive (remote `gdrive:`, pasta `NimbusBackups/`). |
| **`backup-all.sh`** | Orquestrador. Roda os 3 acima em sequência, loga em `backend/logs/backup.log`. Cron chama esse. |

### Comandos do dia a dia

```bash
# Rodar manualmente uma vez (cobre as 3 camadas):
bash backend/scripts/backup-all.sh

# Só dump local:
bash backend/scripts/backup-db.sh

# Só upload pro B2 (sobe o que ainda não está lá):
node backend/scripts/backup-remote.js

# Só Google Drive:
bash backend/scripts/backup-gdrive.sh

# Ver dumps locais:
ls -lh backend/backups/

# Ver no Google Drive:
rclone ls gdrive:NimbusBackups/

# Ver log do cron:
tail -f backend/logs/backup.log
```

### Restaurar um backup

```bash
# 1. Baixa o dump (escolhe a fonte: local, B2 ou Drive)
# Local:
DUMP=backend/backups/db-20260521-090000.sql.gz

# Do Drive:
rclone copy gdrive:NimbusBackups/db-20260521-090000.sql.gz /tmp/
DUMP=/tmp/db-20260521-090000.sql.gz

# Do B2 (via console web ou aws-cli)

# 2. Restaura
docker exec -i nimbus-postgres psql -U nimbus -d postgres \
  -c "DROP DATABASE nimbus; CREATE DATABASE nimbus;"
gunzip -c "$DUMP" | docker exec -i nimbus-postgres psql -U nimbus -d nimbus

# 3. Reinicia o backend pra reabrir conexões
pm2 restart nimbus-backend nimbus-worker
```

### Variáveis de ambiente

Todas opcionais — sem elas, a camada correspondente fica desativada.

```bash
# Backblaze B2 (ou R2 / Wasabi / MinIO / S3 puro)
BACKUP_S3_ENDPOINT=https://s3.us-west-002.backblazeb2.com
BACKUP_S3_REGION=us-west-002
BACKUP_S3_BUCKET=nimbus-backups
BACKUP_S3_KEY_ID=...
BACKUP_S3_SECRET=...
BACKUP_S3_PREFIX=nimbus/        # default
BACKUP_RETAIN_REMOTE=30         # default

# Rotação local (sobrescreve default 48)
BACKUP_RETAIN_LOCAL=48

# rclone (sobrescreve defaults)
GDRIVE_REMOTE=gdrive            # nome do remote
GDRIVE_FOLDER=NimbusBackups     # pasta no Drive
```
