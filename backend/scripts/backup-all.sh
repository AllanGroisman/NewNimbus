#!/usr/bin/env bash
# Orquestrador de backup — ÚNICO entry point, chamado pelo cron de hora em hora:
#   0 * * * * bash /root/NewNimbus/backend/scripts/backup-all.sh
#
# Fluxo:
#   1. pg_dump local (backup-db.sh)             -> backend/backups/db-TS.sql.gz
#   2. upload pro S3-compatível (backup-remote)  -> Backblaze B2, cifrado
#
# (A camada Google Drive/rclone está desativada — ver backup-gdrive.sh.)
#
# Cada etapa é independente — se uma falhar, as outras tentam (warn em vez de
# abortar). Loga tudo em backend/logs/backup.log.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_DIR="$BACKEND_DIR/logs"
LOG_FILE="$LOG_DIR/backup.log"

mkdir -p "$LOG_DIR"

# Carrega .env do backend pra ter as envs BACKUP_S3_*.
# Lê linha a linha em vez de `source`: valores com espaço e sem aspas (ex:
# DEFAULT_ADMIN_NAME=Allan Groisman) fariam o bash tentar executar a segunda
# palavra como comando, sujando o log com erro a cada execução.
if [[ -f "$BACKEND_DIR/.env" ]]; then
  while IFS= read -r linha || [[ -n "$linha" ]]; do
    [[ "$linha" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] || continue
    chave="${linha%%=*}"
    valor="${linha#*=}"
    valor="${valor%\"}"; valor="${valor#\"}"
    valor="${valor%\'}"; valor="${valor#\'}"
    export "$chave=$valor"
  done < "$BACKEND_DIR/.env"
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
# O cron roda com PATH mínimo e o node do sistema pode ser antigo demais
# (/usr/bin/node v12 não executa o backup-remote.js). Resolve o node do nvm
# antes; se ainda assim for < 18, pula o upload com aviso em vez de estourar.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [[ -z "$NODE_BIN" || "$NODE_MAJOR" -lt 18 ]]; then
  log "backup-remote: PULADO — precisa de node >= 18 (encontrado: ${NODE_BIN:-nenhum} v${NODE_MAJOR})"
else
  run_step "backup-remote (S3/B2)" "$NODE_BIN" "$SCRIPT_DIR/backup-remote.js" || true
fi

log "==================== backup-all done ===================="
