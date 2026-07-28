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

# ── 6. Sobe Postgres + Redis ───────────────────────────────────────────
echo
echo "[6/8] Postgres + Redis (docker compose)..."
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

# ── 7. Backend + Frontend ──────────────────────────────────────────────
echo
echo "[7/8] Backend: npm install + prisma migrate deploy..."
cd "$REPO_DIR/backend"
npm install --omit=dev
npx prisma generate
npx prisma migrate deploy

# .env NÃO vem do repo (guarda senha de banco, chaves de API e credenciais de
# e-mail). Copie o arquivo do servidor atual, ou preencha a partir do exemplo.
if [[ ! -f .env ]]; then
  cp .env.example .env
  chmod 600 .env
  echo "  backend/.env criado a partir do .env.example."
  echo "  >>> PREENCHA backend/.env (DATABASE_URL, REDIS_URL, STRIPE_*, SMTP_*,"
  echo "      BACKUP_S3_*, ADMIN_EMAILS) antes de seguir. <<<"
else
  chmod 600 .env
  echo "  backend/.env encontrado — usando."
fi

# O docker-compose lê variáveis do .env da RAIZ do projeto, não do backend/.env.
if [[ ! -f "$REPO_DIR/.env" ]]; then
  umask 077
  {
    echo "# Variáveis lidas pelo docker-compose.yml. Fora do Git."
    echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)"
    echo "REDIS_PASSWORD=$(openssl rand -hex 24)"
  } > "$REPO_DIR/.env"
  echo "  .env da raiz criado com senhas geradas para Postgres e Redis."
  echo "  >>> Ajuste DATABASE_URL e REDIS_URL em backend/.env com essas senhas. <<<"
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

# ── 8. Nginx + UFW + PM2 ───────────────────────────────────────────────
echo
echo "[8/8] Nginx + UFW + PM2..."

# Nginx config
sudo cp "$REPO_DIR/deploy/nginx.conf" /etc/nginx/sites-available/nimbus
sudo sed -i "s|__FRONTEND_DIST__|$REPO_DIR/frontend/dist|g" /etc/nginx/sites-available/nimbus
sudo ln -sf /etc/nginx/sites-available/nimbus /etc/nginx/sites-enabled/nimbus
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
sudo systemctl enable nginx >/dev/null

# HTTPS. Sem isso a instalação fica em HTTP puro — senha e token de sessão
# trafegam em texto claro. O domínio sai do PUBLIC_BASE_URL do backend/.env.
NIMBUS_DOMAIN="$(grep -m1 '^PUBLIC_BASE_URL=' "$REPO_DIR/backend/.env" 2>/dev/null \
  | cut -d= -f2- | sed -E 's#^https?://##; s#/.*$##')"
if [[ -z "$NIMBUS_DOMAIN" ]]; then
  echo "  !! PUBLIC_BASE_URL não definido em backend/.env — pulando HTTPS."
  echo "     Rode depois: sudo certbot --nginx -d SEU.DOMINIO"
elif sudo test -d "/etc/letsencrypt/live/$NIMBUS_DOMAIN"; then
  echo "  Certificado para $NIMBUS_DOMAIN já existe — mantendo."
else
  echo "  Emitindo certificado para $NIMBUS_DOMAIN..."
  sudo apt-get install -y certbot python3-certbot-nginx >/dev/null
  # --redirect: força o 301 de HTTP pra HTTPS. Se falhar (DNS ainda não
  # apontando, porta 80 fechada), o install segue e avisa.
  if ! sudo certbot --nginx -d "$NIMBUS_DOMAIN" --non-interactive --agree-tos \
        --register-unsafely-without-email --redirect; then
    echo "  !! certbot falhou. O site está em HTTP puro."
    echo "     Confira se o DNS de $NIMBUS_DOMAIN aponta pra esta máquina e rode:"
    echo "       sudo certbot --nginx -d $NIMBUS_DOMAIN --redirect"
  fi
fi

# UFW
# A porta do SSH é lida do sshd_config, não chutada: o perfil "OpenSSH" do ufw
# libera só a 22, e este servidor escuta na 22022 — habilitar o firewall com a
# regra errada tranca o acesso à máquina na hora.
SSH_PORT="$(sudo sshd -T 2>/dev/null | awk '/^port /{print $2; exit}')"
SSH_PORT="${SSH_PORT:-22}"
echo "  SSH detectado na porta ${SSH_PORT} — liberando no firewall."

sudo ufw --force reset >/dev/null 2>&1 || true
sudo ufw default deny incoming >/dev/null
sudo ufw default allow outgoing >/dev/null
sudo ufw allow "${SSH_PORT}/tcp" >/dev/null
sudo ufw allow 80/tcp >/dev/null
sudo ufw allow 443/tcp >/dev/null
sudo ufw --force enable >/dev/null

# O UFW não filtra portas publicadas por container: o Docker insere as próprias
# regras antes das dele. Postgres e Redis já sobem com bind em 127.0.0.1 (ver
# docker-compose.yml), e esta regra é a segunda camada, caso alguém volte a
# publicar uma porta em 0.0.0.0 sem perceber.
if ! grep -q 'NIMBUS-DOCKER-USER' /etc/ufw/after.rules 2>/dev/null; then
  sudo tee -a /etc/ufw/after.rules >/dev/null <<'EOF'

# NIMBUS-DOCKER-USER: bloqueia acesso externo a portas publicadas por container.
*filter
:DOCKER-USER - [0:0]
-A DOCKER-USER -i lo -j RETURN
-A DOCKER-USER -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN
-A DOCKER-USER -s 172.16.0.0/12 -j RETURN
-A DOCKER-USER -j DROP
COMMIT
EOF
  sudo ufw reload >/dev/null 2>&1 || true
fi

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
echo "  Status:   pm2 status"
echo "  Logs:     pm2 logs nimbus-backend"
echo "  Update:   bash deploy/update.sh"
echo
echo "  >>> Não esqueça de editar backend/.env e rodar:"
echo "      pm2 restart nimbus-backend nimbus-worker"
echo
