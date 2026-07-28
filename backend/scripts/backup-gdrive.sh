#!/usr/bin/env bash
# ⛔ INATIVO — fora do fluxo de backup desde 07/2026. O backup-all.sh não chama
# mais este script: o rclone não está instalado na VPS e este caminho enviaria
# os dumps SEM CIFRA (ver aviso abaixo). O esquema em uso é local + Backblaze B2
# cifrado — ver backend/scripts/README.md. Só reative depois de configurar um
# remote "crypt" no rclone.
#
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
#
# ⚠️  ESTE CAMINHO ENVIA OS DUMPS SEM CIFRA.
# Diferente do backup-remote.js (Backblaze), que cifra com BACKUP_ENC_KEY, aqui
# o rclone espelha os .sql.gz como estão. Cada dump contém hashes de senha,
# e-mails, credenciais de afiliado e as sessões de WhatsApp de todos os clientes
# — e o destino costuma ser uma conta pessoal do Drive.
#
# Antes de ligar isto, configure um remote do tipo "crypt" no rclone envolvendo o
# gdrive (`rclone config` → crypt) e aponte GDRIVE_REMOTE pra ele. Sem isso, você
# está publicando o banco inteiro em claro numa conta pessoal.

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
