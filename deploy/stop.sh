#!/usr/bin/env bash
# Para tudo: PM2 (backend + worker) e Postgres + Redis.
# Não desinstala — só desliga.
#
# Uso (da raiz do repo):
#   bash deploy/stop.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "=== Nimbus - stop ==="

echo
echo "[1/2] PM2 stop..."
pm2 stop nimbus-backend nimbus-worker 2>/dev/null || true

echo
echo "[2/2] Postgres + Redis stop..."
cd "$REPO_DIR"
sudo docker compose stop

echo
echo "=== Parado. ==="
echo "Pra subir de novo: bash deploy/start.sh"
