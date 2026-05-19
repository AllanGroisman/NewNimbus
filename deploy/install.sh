#!/usr/bin/env bash
# Nimbus - instalação one-shot na VPS Ubuntu (22.04+ ou 24.04).
#
# Uso (a partir da raiz do repo, já clonado):
#   bash deploy/install.sh
#
# Idempotente — pode rodar de novo sem quebrar nada.

set -euo pipefail

# ── localiza o repo (esse script vive em <repo>/deploy/) ───────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RUN_USER="${SUDO_USER:-$USER}"

echo "========================================="
echo "  Nimbus - install"
echo "  Repo: $REPO_DIR"
echo "  User: $RUN_USER"
echo "========================================="

if [[ "$RUN_USER" == "root" ]]; then
  USER_HOME="/root"
  echo "AVISO: rodando como root. Pra produção, troque pra usuário normal depois."
else
  USER_HOME="/home/$RUN_USER"
fi

# ── 1. apt deps básicas ────────────────────────────────────────────────
echo
echo "[1/9] apt update + pacotes do sistema..."
sudo apt-get update
sudo apt-get install -y \
  curl git ca-certificates gnupg lsb-release \
  nginx ufw build-essential

# ── 2. Node.js 22 LTS (via NodeSource) ─────────────────────────────────
echo
echo "[2/9] Node.js 22..."
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -lt 20 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
else
  echo "  Node $(node -v) já instalado."
fi

# ── 3. Docker + compose plugin ─────────────────────────────────────────
echo
echo "[3/9] Docker..."
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$RUN_USER"
  echo "  Docker instalado. Pra usar sem sudo, faça logout/login depois."
else
  echo "  Docker $(docker --version | awk '{print $3}' | tr -d ,) já instalado."
fi

# ── 4. PM2 global ──────────────────────────────────────────────────────
echo
echo "[4/9] PM2..."
if ! command -v pm2 >/dev/null 2>&1; then
  sudo npm install -g pm2
else
  echo "  PM2 $(pm2 -v) já instalado."
fi

# ── 5. Dependências nativas do Chromium (Puppeteer) ────────────────────
echo
echo "[5/9] Libs do Chromium..."
sudo apt-get install -y \
  libnss3 libatk-bridge2.0-0 libxkbcommon0 libxcomposite1 \
  libxdamage1 libxfixes3 libxrandr2 libgbm1 \
  fonts-liberation libcurl4 libdbus-1-3 libgtk-3-0 \
  libpangocairo-1.0-0 libcairo2 libxshmfence1 libxss1 \
  libnspr4 libxext6 libxrender1 libdrm2 libxcb1 \
  || true
# libasound2 mudou de nome em Ubuntu 24.04
sudo apt-get install -y libasound2t64 2>/dev/null \
  || sudo apt-get install -y libasound2 \
  || true

# ── 6. ngrok (opcional, mas você pediu) ────────────────────────────────
echo
echo "[6/9] ngrok..."
if ! command -v ngrok >/dev/null 2>&1; then
  curl -sSL https://ngrok-agent.s3.amazonaws.com/ngrok.asc \
    | sudo tee /etc/apt/trusted.gpg.d/ngrok.asc >/dev/null
  echo "deb https://ngrok-agent.s3.amazonaws.com buster main" \
    | sudo tee /etc/apt/sources.list.d/ngrok.list >/dev/null
  sudo apt-get update
  sudo apt-get install -y ngrok
else
  echo "  ngrok já instalado."
fi

# ── 7. Sobe Postgres + Redis ───────────────────────────────────────────
echo
echo "[7/9] Postgres + Redis (docker compose)..."
cd "$REPO_DIR"
sudo docker compose up -d
echo "  Esperando Postgres ficar pronto..."
for i in {1..30}; do
  if sudo docker exec nimbus-postgres pg_isready -U nimbus -d nimbus >/dev/null 2>&1; then
    echo "  OK."
    break
  fi
  sleep 2
done

# ── 8. Backend + Frontend ──────────────────────────────────────────────
echo
echo "[8/9] Backend: npm install + prisma migrate deploy..."
cd "$REPO_DIR/backend"
npm install --omit=dev
npx prisma generate
npx prisma migrate deploy

# .env só se não existir
if [[ ! -f .env ]]; then
  cp .env.example .env
  # Patches pra prod
  sed -i 's|^QUEUE_BACKEND=.*|QUEUE_BACKEND=redis|' .env
  cat >> .env <<EOF

# ─── Setado pelo install.sh ─────────────────────────────────────────
NODE_ENV=production
ADMIN_EMAILS=allangroisman@gmail.com
LOG_LEVEL=info
EOF
  echo "  backend/.env criado a partir de .env.example."
  echo "  >>> EDITE: STRIPE_*, NIMBUS_CORS_ORIGINS, e revise ADMIN_EMAILS <<<"
else
  echo "  backend/.env já existe — preservado."
fi

mkdir -p logs

echo
echo "  Frontend: npm install + build..."
cd "$REPO_DIR/frontend"
npm install
npm run build

# Permissão pra www-data ler o dist/ (e atravessar o home).
# /root é 700 por padrão — 711 deixa atravessar sem listar.
if [[ "$RUN_USER" == "root" ]]; then
  sudo chmod 711 /root
else
  sudo chmod o+rx "$USER_HOME" 2>/dev/null || true
fi
chmod -R o+rX "$REPO_DIR/frontend/dist"

# ── 9. Nginx + UFW + PM2 ───────────────────────────────────────────────
echo
echo "[9/9] Nginx + UFW + PM2..."

# Nginx config
sudo cp "$REPO_DIR/deploy/nginx.conf" /etc/nginx/sites-available/nimbus
sudo sed -i "s|__FRONTEND_DIST__|$REPO_DIR/frontend/dist|g" /etc/nginx/sites-available/nimbus
sudo ln -sf /etc/nginx/sites-available/nimbus /etc/nginx/sites-enabled/nimbus
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
sudo systemctl enable nginx >/dev/null

# UFW
sudo ufw --force reset >/dev/null 2>&1 || true
sudo ufw default deny incoming >/dev/null
sudo ufw default allow outgoing >/dev/null
sudo ufw allow OpenSSH >/dev/null
sudo ufw allow 80/tcp >/dev/null
sudo ufw allow 443/tcp >/dev/null
sudo ufw --force enable >/dev/null

# PM2 — sobe backend + worker
cd "$REPO_DIR/backend"
pm2 delete all >/dev/null 2>&1 || true
pm2 start ecosystem.config.js
pm2 save
# Autostart no boot — comando precisa rodar como root
sudo env PATH="$PATH:/usr/bin" pm2 startup systemd -u "$RUN_USER" --hp "$USER_HOME" >/dev/null

# ── Smoke test ─────────────────────────────────────────────────────────
echo
echo "[smoke test] esperando backend responder em /healthz..."
for i in {1..15}; do
  if curl -fsS http://127.0.0.1:3001/healthz >/dev/null 2>&1; then
    echo "  OK — backend está vivo."
    break
  fi
  sleep 2
done

echo
echo "========================================="
echo "  Tudo pronto."
echo "========================================="
echo
echo "  Backend  → http://127.0.0.1:3001 (PM2)"
echo "  Worker   → pm2 logs nimbus-worker"
echo "  Frontend → servido por nginx em :80"
echo
echo "  Pra expor com ngrok:"
echo "    ngrok config add-authtoken SEU_TOKEN"
echo "    ngrok http 80"
echo
echo "  Status:   pm2 status"
echo "  Logs:     pm2 logs nimbus-backend"
echo "  Update:   bash deploy/update.sh"
echo
echo "  >>> Não esqueça de editar backend/.env e rodar:"
echo "      pm2 restart nimbus-backend nimbus-worker"
echo
