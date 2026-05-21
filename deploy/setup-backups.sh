#!/usr/bin/env bash
# Setup do backup 3-camadas na VPS Ubuntu:
#   1. Dump local (pg_dump) a cada 6h
#   2. Upload pro Backblaze B2 (ou S3-compatível)
#   3. Espelho no Google Drive via rclone
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
echo "  Nimbus - setup de backup 3 camadas"
echo "  Repo: $REPO_DIR"
echo "  User: $RUN_USER"
echo "========================================="

# ── 1. rclone ──────────────────────────────────────────────────────────
echo
echo "[1/4] rclone..."
if ! command -v rclone >/dev/null 2>&1; then
  curl https://rclone.org/install.sh | sudo bash
else
  echo "  rclone $(rclone version | head -1) já instalado."
fi

# ── 2. Permissões nos scripts ──────────────────────────────────────────
echo
echo "[2/4] chmod +x nos scripts..."
chmod +x "$REPO_DIR/backend/scripts/backup-db.sh"
chmod +x "$REPO_DIR/backend/scripts/backup-gdrive.sh"
chmod +x "$REPO_DIR/backend/scripts/backup-all.sh"
echo "  OK."

# ── 3. Verifica credenciais B2 no .env ─────────────────────────────────
echo
echo "[3/4] checando credenciais B2/S3 em backend/.env..."
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
     BACKUP_RETAIN_REMOTE=30

  5. Roda de novo: bash deploy/setup-backups.sh
EOF
else
  echo "  B2/S3 configurado."
fi

# ── 4. rclone Google Drive ─────────────────────────────────────────────
echo
echo "[4/4] rclone Google Drive..."
if rclone listremotes 2>/dev/null | grep -q '^gdrive:'; then
  echo "  remote 'gdrive' já configurado."
else
  cat <<'EOF'

  >>> rclone ainda nao tem o remote 'gdrive'. Configura agora:

     rclone config

  Passo a passo:
     n) New remote
     name> gdrive
     Storage> drive
     client_id> (deixa vazio — usa o default, ok pra uso pessoal)
     client_secret> (vazio)
     scope> 1   (Full access)
     service_account_file> (vazio)
     Edit advanced config? n
     Use auto config? n        <- IMPORTANTE em VPS headless
     # Vai imprimir uma URL — cola no seu browser local, autentica com sua conta
     # do Google (allangroisman@gmail.com), copia o codigo, cola no terminal.
     Configure this as a Shared Drive? n
     y) Yes this is OK
     q) Quit config

  Depois: bash deploy/setup-backups.sh  (pra registrar o cron)
EOF
  exit 0
fi

# ── 5. Cron ────────────────────────────────────────────────────────────
echo
echo "[5/5] registrando cron job (a cada 6h)..."
CRON_LINE="0 */6 * * * cd $REPO_DIR && bash $REPO_DIR/backend/scripts/backup-all.sh"
# Remove qualquer linha antiga do nimbus backup-all, adiciona a nova
( crontab -l 2>/dev/null | grep -v 'backend/scripts/backup-all.sh' ; echo "$CRON_LINE" ) | crontab -
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
echo "    cd $REPO_DIR/backend && node -e \"require('dotenv').config(); ...\"  (ou via console web do B2)"
echo
echo "  Listar backups no Google Drive:"
echo "    rclone ls gdrive:NimbusBackups/"
echo
