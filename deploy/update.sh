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
echo "[1/5] git pull..."
git pull --ff-only

echo
echo "[2/5] backend: npm install + migrations..."
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
echo "[3/5] frontend: build..."
cd "$REPO_DIR/frontend"
npm install
npm run build
chmod -R o+rX "$REPO_DIR/frontend/dist"

echo
echo "[4/5] nginx: aplicando deploy/nginx.conf..."
# O update só buildava o frontend e recarregava o PM2 — mudanças no nginx.conf
# (ex: a resposta JSON de indisponibilidade em vez do "502 Bad Gateway" em HTML)
# ficavam no repo e nunca chegavam ao servidor.
NGINX_SITE=/etc/nginx/sites-available/nimbus
if [[ -f "$NGINX_SITE" ]]; then
  # O bloco 443 dentro do arquivo instalado é escrito pelo certbot. Copiar por
  # cima o apaga e derruba o HTTPS, então guardamos uma cópia e reinstalamos o
  # certificado logo depois.
  HAD_TLS=0
  grep -q "listen 443" "$NGINX_SITE" && HAD_TLS=1
  sudo cp "$NGINX_SITE" "${NGINX_SITE}.bak-$(date +%Y%m%d-%H%M%S)"

  sudo cp "$REPO_DIR/deploy/nginx.conf" "$NGINX_SITE"
  sudo sed -i "s|__FRONTEND_DIST__|$REPO_DIR/frontend/dist|g" "$NGINX_SITE"

  if [[ "$HAD_TLS" == "1" ]]; then
    NIMBUS_DOMAIN="$(grep -m1 '^PUBLIC_BASE_URL=' "$REPO_DIR/backend/.env" 2>/dev/null \
      | cut -d= -f2- | sed -E 's#^https?://##; s#/.*$##')"
    echo "  reinstalando o bloco HTTPS do certbot para $NIMBUS_DOMAIN..."
    if ! sudo certbot --nginx -d "$NIMBUS_DOMAIN" --non-interactive --agree-tos \
          --register-unsafely-without-email --redirect; then
      echo "  !! certbot falhou — restaurando a config anterior para não derrubar o HTTPS."
      sudo cp "$(ls -t ${NGINX_SITE}.bak-* | head -1)" "$NGINX_SITE"
    fi
  fi

  # nginx -t antes do reload: config inválida derruba o site inteiro.
  if sudo nginx -t; then
    sudo systemctl reload nginx
    echo "  nginx recarregado."
  else
    echo "  !! nginx -t falhou — restaurando a config anterior e abortando."
    sudo cp "$(ls -t ${NGINX_SITE}.bak-* | head -1)" "$NGINX_SITE"
    sudo nginx -t && sudo systemctl reload nginx
    exit 1
  fi
else
  echo "  $NGINX_SITE não existe — nginx não instalado por aqui, pulando."
fi

echo
echo "[5/5] PM2 reload..."
cd "$REPO_DIR/backend"
# --update-env: sem isso o PM2 reusa as variáveis capturadas no primeiro start,
# e mudanças no .env (senha do Redis, DATABASE_URL) não chegam aos processos.
pm2 reload nimbus-backend nimbus-worker --update-env

echo
echo "=== Update done. ==="
pm2 status
