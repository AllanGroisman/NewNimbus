#!/usr/bin/env bash
# Setup do backup na VPS Ubuntu — esquema atual (2 camadas):
#   1. Dump local (pg_dump|gzip) de hora em hora  -> backend/backups/ (48h)
#   2. Upload cifrado pro Backblaze B2            -> últimas 48h + 1/dia por 30 dias
#
# Tudo roda por UMA linha de cron chamando backend/scripts/backup-all.sh.
# (A camada Google Drive/rclone foi desativada — ver backup-gdrive.sh.)
#
# Rode 1x na VPS, depois de install.sh:
#   bash deploy/setup-backups.sh
#
# Idempotente — pode rodar de novo.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RUN_USER="${SUDO_USER:-$USER}"

echo "========================================="
echo "  Nimbus - setup de backup (local + B2)"
echo "  Repo: $REPO_DIR"
echo "  User: $RUN_USER"
echo "========================================="

# ── 1. Permissões nos scripts ──────────────────────────────────────────
echo
echo "[1/3] chmod +x nos scripts..."
chmod +x "$REPO_DIR/backend/scripts/backup-db.sh"
chmod +x "$REPO_DIR/backend/scripts/backup-all.sh"
echo "  OK."

# ── 2. Verifica credenciais B2 no .env ─────────────────────────────────
echo
echo "[2/3] checando credenciais B2/S3 em backend/.env..."
ENV_FILE="$REPO_DIR/backend/.env"
MISSING_S3=0
for key in BACKUP_S3_BUCKET BACKUP_S3_KEY_ID BACKUP_S3_SECRET BACKUP_S3_ENDPOINT; do
  if ! grep -qE "^${key}=.+" "$ENV_FILE" 2>/dev/null; then
    MISSING_S3=1
    echo "  AUSENTE: $key"
  fi
done
if [[ "$MISSING_S3" == "1" ]]; then
  cat <<'EOF'

  >>> Configure o Backblaze B2 (ou Cloudflare R2) e cole no backend/.env:

  1. Cria conta em https://www.backblaze.com/cloud-storage (10GB free)
  2. Cria bucket "nimbus-backups" (privado)
  3. Cria "App Key" só com acesso a esse bucket
  4. Edita backend/.env:

     BACKUP_S3_ENDPOINT=https://s3.us-west-002.backblazeb2.com   # ajuste a region!
     BACKUP_S3_REGION=us-west-002
     BACKUP_S3_BUCKET=nimbus-backups
     BACKUP_S3_KEY_ID=<sua_keyID>
     BACKUP_S3_SECRET=<sua_applicationKey>
     # Retenção remota (opcional — estes já são os defaults):
     # BACKUP_RETAIN_REMOTE_HOURS=48   # todos os snapshots das últimas 48h
     # BACKUP_RETAIN_REMOTE_DAYS=30    # depois, 1 por dia até 30 dias

  O cron é registrado mesmo assim — o dump local funciona sem o B2, e o
  upload passa a funcionar sozinho quando as envs existirem.
EOF
else
  echo "  B2/S3 configurado."
fi

# ── 3. Cron ────────────────────────────────────────────────────────────
echo
echo "[3/3] registrando cron job (de hora em hora)..."
CRON_LINE="0 * * * * bash $REPO_DIR/backend/scripts/backup-all.sh"
# Remove qualquer variação antiga (backup-all, backup-db direto, backup-remote
# direto — os dois últimos eram o esquema antigo com node quebrado no cron).
( crontab -l 2>/dev/null \
    | grep -v 'backend/scripts/backup-all.sh' \
    | grep -v 'backend/scripts/backup-db.sh' \
    | grep -v 'backend/scripts/backup-remote.js' \
  ; echo "$CRON_LINE" ) | crontab -
echo "  cron registrado: $CRON_LINE"

echo
echo "========================================="
echo "  Setup OK."
echo "========================================="
echo
echo "  Testar manualmente agora:"
echo "    bash $REPO_DIR/backend/scripts/backup-all.sh"
echo
echo "  Ver log:"
echo "    tail -f $REPO_DIR/backend/logs/backup.log"
echo
echo "  Ver crons:"
echo "    crontab -l"
echo
echo "  Listar backups remotos no B2:"
echo "    node $REPO_DIR/backend/scripts/check-remote.js  (ou console web do B2)"
echo
echo "  IMPORTANTE: guarde uma cópia da BACKUP_ENC_KEY (backend/.env) FORA do"
echo "  servidor — sem ela os backups cifrados na nuvem são irrecuperáveis."
echo
