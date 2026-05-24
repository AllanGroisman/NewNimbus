#!/usr/bin/env bash
# Para e remove tudo do PM2: backend, worker e backup.
# Para também Postgres + Redis (docker compose).
# Não desinstala — só desliga.
#
# Uso (da raiz do repo):
#   bash deploy/stop.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "=== Nimbus - stop ==="

echo
echo "[1/2] PM2 delete (backend, worker, backup)..."
for proc in nimbus-backend nimbus-worker nimbus-backup-remote; do
  if pm2 describe "$proc" >/dev/null 2>&1; then
    pm2 delete "$proc"
    echo "  $proc removido."
  else
    echo "  $proc não estava no PM2."
  fi
done
pm2 save >/dev/null

echo
echo "[2/2] Postgres + Redis stop..."
cd "$REPO_DIR"
sudo docker compose stop

echo
echo "=== Parado. ==="
echo "Pra subir de novo: bash deploy/start.sh"
