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

# Postgres + Redis
echo
echo "[1/4] Postgres + Redis..."
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
echo "[2/4] PM2 (backend + worker)..."
cd "$REPO_DIR/backend"
if pm2 describe nimbus-backend >/dev/null 2>&1; then
  pm2 restart nimbus-backend nimbus-worker
else
  pm2 start ecosystem.config.js
fi
pm2 save >/dev/null

# Nginx (caso esteja parado)
echo
echo "[3/4] Nginx..."
sudo systemctl start nginx 2>/dev/null || true
sudo systemctl reload nginx

# ngrok (opcional, roda no PM2)
echo
echo "[4/4] ngrok..."
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
