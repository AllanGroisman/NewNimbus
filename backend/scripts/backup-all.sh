#!/usr/bin/env bash
# Orquestrador de backup. Cron chama esse.
#
# Fluxo:
#   1. pg_dump local (backup-db.sh)             -> backend/backups/db-TS.sql.gz
#   2. upload pro S3-compatível (backup-remote)  -> Backblaze B2 / R2 / S3
#   3. espelho no Google Drive (backup-gdrive)   -> via rclone
#
# Cada etapa é independente — se uma falhar, as outras tentam (warn em vez de
# abortar). Loga tudo em backend/logs/backup.log.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_DIR="$BACKEND_DIR/logs"
LOG_FILE="$LOG_DIR/backup.log"

mkdir -p "$LOG_DIR"

# Carrega .env do backend pra ter as envs BACKUP_S3_*
if [[ -f "$BACKEND_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$BACKEND_DIR/.env"
  set +a
fi

log() {
  echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

run_step() {
  local name="$1"
  shift
  log "=== $name ==="
  if "$@" >> "$LOG_FILE" 2>&1; then
    log "$name: OK"
    return 0
  else
    local rc=$?
    log "$name: FALHOU (exit $rc)"
    return $rc
  fi
}

log "==================== backup-all start ===================="

# 1. dump local (essa é obrigatória — se falhar, sem sentido continuar)
if ! run_step "backup-db" bash "$SCRIPT_DIR/backup-db.sh"; then
  log "==================== backup-all ABORTADO (dump falhou) ===================="
  exit 1
fi

# 2. S3 / Backblaze B2 (não-fatal — pode estar sem credencial)
run_step "backup-remote (S3/B2)" node "$SCRIPT_DIR/backup-remote.js" || true

# 3. Google Drive (não-fatal — rclone pode não estar configurado)
run_step "backup-gdrive" bash "$SCRIPT_DIR/backup-gdrive.sh" || true

log "==================== backup-all done ===================="
