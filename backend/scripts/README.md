# scripts/

Scripts que rodam **fora** da aplicação principal — manualmente ou via cron. Não fazem parte do `server.js` nem do `worker.js`.

## Backup (local + Backblaze B2)

```
  Postgres (Docker)
        │
        ├── 1. backup-db.sh      → backend/backups/db-YYYYMMDD-HHMMSS.sql.gz  (local, 48 snapshots horários = 48h)
        │
        └── 2. backup-remote.js  → Backblaze B2 / R2 / S3, cifrado (.enc)     (últimas 48h + 1/dia até 30 dias)
```

Uma única linha de cron roda `backup-all.sh` **de hora em hora** — ele faz o dump local e o upload. Cada camada é independente: se o upload falhar (sem credencial, sem internet), o dump local continua.

> `backup-gdrive.sh` (3ª camada antiga, Google Drive via rclone) está **DESATIVADO** — enviava os dumps sem cifra pra uma conta pessoal. Ver o header do próprio script antes de reativar.

O backend também vigia o backup (`backend/backup/monitor.js`): checa a cada hora a idade do último dump local (limite 3h) e do último snapshot no B2 (limite 6h) e **alerta o admin pelo WhatsApp** quando estoura. Estado em `GET /healthz` → `checks.backup`.

### Setup inicial (na VPS Ubuntu)

```bash
bash deploy/setup-backups.sh
```

Esse script:
1. Chmod +x nos scripts.
2. Avisa o que falta configurar (B2 no `.env`).
3. Registra o cron horário chamando `backup-all.sh` (e remove agendamentos antigos).

### Arquivos

| Script | O que faz |
|---|---|
| **`backup-all.sh`** | Orquestrador — o cron chama esse. Dump local + upload B2, resolvendo o node do nvm (o node do sistema pode ser antigo demais). Loga em `backend/logs/backup.log`. |
| **`backup-db.sh`** | `pg_dump` do container `nimbus-postgres`, salva `.sql.gz` em `backend/backups/`. Rotaciona mantendo os últimos 48 (`BACKUP_RETAIN_LOCAL`). |
| **`backup-remote.js`** | Sobe os `db-*.sql.gz` pro bucket S3-compatível, cifrados quando `BACKUP_ENC_KEY` existe. Sem as envs `BACKUP_S3_*`, sai exit 0. Rotação GFS via `backup-retention.js`. |
| **`backup-retention.js`** | Regra de retenção remota (função pura, testada em `tests/unit/backup-retention.test.js`): mantém tudo das últimas 48h + o snapshot mais recente de cada dia até 30 dias. |
| **`backup-crypto.js`** | Cifra AES-256-GCM dos dumps que saem da máquina (`BACKUP_ENC_KEY`, 64 chars hex). |
| **`restore-remote.js`** | Baixa do B2, decifra e restaura (`--list`, `--latest`, `--file <nome>`). |
| **`check-remote.js`** | Imprime o snapshot mais recente no B2. |
| **`backup-gdrive.sh`** | ⛔ INATIVO — espelho sem cifra no Google Drive. |

### Comandos do dia a dia

```bash
# Rodar o backup completo agora:
bash backend/scripts/backup-all.sh

# Só dump local:
bash backend/scripts/backup-db.sh

# Só upload pro B2 (sobe o que ainda não está lá):
node backend/scripts/backup-remote.js

# Prever uploads e rotação sem executar nada:
node backend/scripts/backup-remote.js --dry-run

# Ver dumps locais:
ls -lh backend/backups/

# Último snapshot no B2:
node backend/scripts/check-remote.js

# Ver log do cron:
tail -f backend/logs/backup.log
```

### Restaurar um backup

```bash
# Do B2 — baixa, decifra e restaura o mais recente:
node backend/scripts/restore-remote.js --latest
# (ou --list pra escolher, --file <nome> pra um específico)

# De um dump local:
DUMP=backend/backups/db-20260728-090000.sql.gz
docker exec -i nimbus-postgres psql -U nimbus -d postgres \
  -c "DROP DATABASE nimbus; CREATE DATABASE nimbus;"
gunzip -c "$DUMP" | docker exec -i nimbus-postgres psql -U nimbus -d nimbus

# Reinicia o backend pra reabrir conexões
pm2 restart nimbus-backend nimbus-worker
```

### Variáveis de ambiente

Todas opcionais — sem elas, a camada correspondente fica desativada (defaults nos comentários).

```bash
# Backblaze B2 (ou R2 / Wasabi / MinIO / S3 puro)
BACKUP_S3_ENDPOINT=https://s3.us-west-002.backblazeb2.com
BACKUP_S3_REGION=us-west-002
BACKUP_S3_BUCKET=nimbus-backups
BACKUP_S3_KEY_ID=...
BACKUP_S3_SECRET=...
BACKUP_S3_PREFIX=nimbus/           # default

# Cifra dos dumps na nuvem — GUARDE UMA CÓPIA FORA DO SERVIDOR!
# Sem a chave, os .enc do B2 são irrecuperáveis num desastre.
BACKUP_ENC_KEY=<64 chars hex>

# Retenção
BACKUP_RETAIN_LOCAL=48             # dumps locais (1/h → 48h)
BACKUP_RETAIN_REMOTE_HOURS=48      # janela em que TODOS os snapshots ficam no B2
BACKUP_RETAIN_REMOTE_DAYS=30       # depois da janela, 1 por dia até N dias

# Alertas do monitor (backend/backup/monitor.js)
BACKUP_ALERT_LOCAL_MAX_H=3         # alerta se o dump local passar dessa idade
BACKUP_ALERT_REMOTE_MAX_H=6        # alerta se o snapshot remoto passar dessa idade
```
