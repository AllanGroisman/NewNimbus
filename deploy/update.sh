#!/usr/bin/env bash
# Update: puxa do git, reinstala deps que mudaram, roda migrations,
# rebuilda o frontend e reinicia o PM2.
#
# Uso (da raiz do repo):
#   bash deploy/update.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "=== Nimbus update ==="
cd "$REPO_DIR"

echo
echo "[1/4] git pull..."
git pull --ff-only

echo
echo "[2/4] backend: npm install + migrations..."
cd "$REPO_DIR/backend"
npm install --omit=dev
npx prisma generate
npx prisma migrate deploy

echo
echo "[3/4] frontend: build..."
cd "$REPO_DIR/frontend"
npm install
npm run build
chmod -R o+rX "$REPO_DIR/frontend/dist"

echo
echo "[4/4] PM2 reload..."
cd "$REPO_DIR/backend"
pm2 reload nimbus-backend nimbus-worker

echo
echo "=== Update done. ==="
pm2 status
