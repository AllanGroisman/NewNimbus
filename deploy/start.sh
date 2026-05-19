#!/usr/bin/env bash
# Sobe tudo: Postgres + Redis (docker compose) e backend + worker (PM2).
# Roda DEPOIS de install.sh (que já configurou tudo).
#
# Uso (da raiz do repo):
#   bash deploy/start.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "=== Nimbus - start ==="

# Postgres + Redis
echo
echo "[1/3] Postgres + Redis..."
cd "$REPO_DIR"
sudo docker compose up -d
for i in {1..30}; do
  if sudo docker exec nimbus-postgres pg_isready -U nimbus -d nimbus >/dev/null 2>&1; then
    echo "  Postgres pronto."
    break
  fi
  sleep 1
done

# PM2: backend + worker
echo
echo "[2/3] PM2 (backend + worker)..."
cd "$REPO_DIR/backend"
if pm2 describe nimbus-backend >/dev/null 2>&1; then
  pm2 restart nimbus-backend nimbus-worker
else
  pm2 start ecosystem.config.js
fi
pm2 save >/dev/null

# Nginx (caso esteja parado)
echo
echo "[3/3] Nginx..."
sudo systemctl start nginx 2>/dev/null || true
sudo systemctl reload nginx

echo
echo "=== Tudo no ar. ==="
pm2 status
echo
echo "Acesse:"
echo "  Local:    curl http://localhost/healthz"
echo "  Externo:  ngrok http 80"
