#!/usr/bin/env bash
# Sobe tudo: Postgres + Redis (docker compose), backend + worker (PM2) e ngrok (opcional, PM2).
# Roda DEPOIS de install.sh (que já configurou tudo).
#
# Uso (da raiz do repo):
#   bash deploy/start.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "=== Nimbus - start ==="

# Postgres + Redis (sobe primeiro — restore precisa do container)
echo
echo "[1/6] Postgres + Redis..."
cd "$REPO_DIR"
sudo docker compose up -d
for i in {1..30}; do
  if sudo docker exec nimbus-postgres pg_isready -U nimbus -d nimbus >/dev/null 2>&1; then
    echo "  Postgres pronto."
    break
  fi
  sleep 1
done

# Banco remoto: verifica se tem backup mais novo no Backblaze
echo
echo "[2/6] Verificando backup remoto (Backblaze)..."
_ENV_FILE="$REPO_DIR/backend/.env"
_B2_BUCKET=""
_B2_KEY_ID=""
if [[ -f "$_ENV_FILE" ]]; then
  _B2_BUCKET=$(grep -m1 '^BACKUP_S3_BUCKET=' "$_ENV_FILE" | cut -d= -f2-)
  _B2_KEY_ID=$(grep -m1 '^BACKUP_S3_KEY_ID=' "$_ENV_FILE" | cut -d= -f2-)
fi

if [[ -z "$_B2_BUCKET" || -z "$_B2_KEY_ID" ]]; then
  echo "  Backblaze não configurado — pulando."
else
  _LATEST_REMOTE=$(node "$REPO_DIR/backend/scripts/restore-remote.js" --list 2>/dev/null \
    | grep -o 'db-[0-9]\{8\}-[0-9]\{6\}\.sql\.gz' | head -1 || true)
  _LATEST_LOCAL=$(find "$REPO_DIR/backend/backups" -name 'db-*.sql.gz' 2>/dev/null \
    | xargs -r basename -a | sort -r | head -1 || true)

  if [[ -z "$_LATEST_REMOTE" ]]; then
    echo "  Sem backups remotos encontrados."
  elif [[ "$_LATEST_REMOTE" > "${_LATEST_LOCAL:-0}" ]]; then
    echo "  Backup remoto mais novo detectado: $_LATEST_REMOTE"
    [[ -n "$_LATEST_LOCAL" ]] && echo "  Local atual:                    $_LATEST_LOCAL"
    read -rp "  Restaurar banco do Backblaze antes de subir? [s/N] " _restore_resp
    case "${_restore_resp,,}" in
      s|sim|y|yes)
        node "$REPO_DIR/backend/scripts/restore-remote.js" --latest
        ;;
      *)
        echo "  Mantendo banco local."
        ;;
    esac
  else
    echo "  Banco local já está atualizado ($_LATEST_LOCAL)."
  fi
fi

# Backend: deps + migrations
echo
echo "[3/6] Backend: npm install + migrations + PM2..."
cd "$REPO_DIR/backend"
npm install --omit=dev
npx prisma generate
npx prisma migrate deploy
if pm2 describe nimbus-backend >/dev/null 2>&1; then
  pm2 restart nimbus-backend nimbus-worker
else
  pm2 start ecosystem.config.js
fi
pm2 save >/dev/null

# Frontend: build
echo
echo "[4/6] Frontend: build..."
cd "$REPO_DIR/frontend"
npm install
npm run build
chmod -R o+rX "$REPO_DIR/frontend/dist"

# Nginx (caso esteja parado)
echo
echo "[5/6] Nginx..."
sudo systemctl start nginx 2>/dev/null || true
sudo systemctl reload nginx

# ngrok (opcional, roda no PM2)
echo
echo "[6/6] ngrok..."
if ! command -v ngrok >/dev/null 2>&1; then
  echo "  ngrok não instalado — pulando."
  echo "  Para instalar: bash deploy/install.sh"
else
  read -rp "  Quer iniciar o ngrok agora? [s/N] " _resp
  case "${_resp,,}" in
    s|sim|y|yes)
      # Remove instância anterior se existir
      pm2 delete nimbus-ngrok 2>/dev/null || true

      pm2 start "$(command -v ngrok)" \
        --name nimbus-ngrok \
        --no-autorestart \
        -- http 80
      pm2 save >/dev/null

      echo "  Aguardando URL do ngrok..."
      NGROK_URL=""
      for i in {1..25}; do
        RAW=$(curl -s http://localhost:4040/api/tunnels 2>/dev/null)
        # tenta jq primeiro, cai no python3, depois grep
        if command -v jq >/dev/null 2>&1; then
          NGROK_URL=$(echo "$RAW" | jq -r '.tunnels[]? | select(.proto=="https") | .public_url' 2>/dev/null | head -1)
        elif command -v python3 >/dev/null 2>&1; then
          NGROK_URL=$(echo "$RAW" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    urls = [t['public_url'] for t in d.get('tunnels',[]) if t.get('proto')=='https']
    print(urls[0] if urls else '')
except: pass
" 2>/dev/null)
        else
          NGROK_URL=$(echo "$RAW" \
            | grep -o '"public_url":"https://[^"]*"' \
            | head -1 \
            | sed 's/"public_url":"//;s/"//')
        fi
        [[ -n "$NGROK_URL" ]] && break
        sleep 1
      done

      if [[ -n "$NGROK_URL" ]]; then
        echo
        echo "  ┌─────────────────────────────────────────────────────┐"
        echo "  │  ngrok URL:  $NGROK_URL"
        echo "  └─────────────────────────────────────────────────────┘"
        echo
        echo "  Lembre de atualizar:"
        echo "    FRONTEND_URL / NEXT_PUBLIC_API_URL no .env"
        echo "    Webhook do Stripe → ${NGROK_URL}/api/billing/webhook"
      else
        echo "  ngrok subiu mas URL ainda não disponível."
        echo "  Acesse http://localhost:4040 para ver o link."
      fi
      ;;
    *)
      echo "  ngrok não iniciado. Para subir manualmente: ngrok http 80"
      ;;
  esac
fi

echo
echo "=== Tudo no ar. ==="
pm2 status
echo
echo "Acesse:"
echo "  Local:  curl http://localhost/healthz"
