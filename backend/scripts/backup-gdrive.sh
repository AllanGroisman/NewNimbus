#!/usr/bin/env bash
# Espelha os dumps de backend/backups/ pro Google Drive via rclone.
#
# Pré-requisito: rclone instalado e configurado com um remote chamado "gdrive"
# (rodar `rclone config` uma vez, escolher "drive", autenticar via browser).
# O deploy/setup-backups.sh faz isso de forma guiada.
#
# Uso:
#   bash backend/scripts/backup-gdrive.sh
#
# Env (opcional):
#   GDRIVE_REMOTE   — nome do remote rclone (default: gdrive)
#   GDRIVE_FOLDER   — pasta no Drive (default: NimbusBackups)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKUPS_DIR="$BACKEND_DIR/backups"
REMOTE="${GDRIVE_REMOTE:-gdrive}"
FOLDER="${GDRIVE_FOLDER:-NimbusBackups}"

if ! command -v rclone >/dev/null 2>&1; then
  echo "[backup-gdrive] rclone nao instalado. Rode deploy/setup-backups.sh primeiro." >&2
  exit 0
fi

if ! rclone listremotes | grep -q "^${REMOTE}:"; then
  echo "[backup-gdrive] remote '$REMOTE' nao configurado no rclone." >&2
  echo "[backup-gdrive] Rode: rclone config  (ou deploy/setup-backups.sh)" >&2
  exit 0
fi

if [[ ! -d "$BACKUPS_DIR" ]] || [[ -z "$(find "$BACKUPS_DIR" -maxdepth 1 -name 'db-*.sql.gz' -print -quit)" ]]; then
  echo "[backup-gdrive] sem dumps em $BACKUPS_DIR. Rode backup-db.sh antes."
  exit 0
fi

echo "[backup-gdrive] sync $BACKUPS_DIR -> ${REMOTE}:${FOLDER}/"
# sync com --include espelha apenas os dumps; o --max-age 30d evita re-upload de
# arquivos muito antigos que ja foram rotacionados localmente
rclone sync \
  --include 'db-*.sql.gz' \
  --transfers 4 \
  --checkers 8 \
  --progress=false \
  --stats=0 \
  "$BACKUPS_DIR" "${REMOTE}:${FOLDER}/"

echo "[backup-gdrive] OK"
