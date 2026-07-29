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

# O Chrome do Puppeteer mora em ~/.cache/puppeteer, FORA do node_modules: se o
# cache for apagado (limpeza de disco, troca de usuário), o npm install não o
# traz de volta — o pacote não mudou, então não roda o postinstall. Sem isso o
# scraping de ML/Amazon morre em silêncio. Idempotente: sai na hora se já existe.
echo "  garantindo o Chrome do Puppeteer..."
npx puppeteer browsers install chrome

echo
echo "[3/4] frontend: build..."
cd "$REPO_DIR/frontend"
npm install
npm run build
chmod -R o+rX "$REPO_DIR/frontend/dist"

echo
echo "[4/4] PM2 reload..."
cd "$REPO_DIR/backend"
# --update-env: sem isso o PM2 reusa as variáveis capturadas no primeiro start,
# e mudanças no .env (senha do Redis, DATABASE_URL) não chegam aos processos.
pm2 reload nimbus-backend nimbus-worker --update-env

echo
echo "=== Update done. ==="
pm2 status
