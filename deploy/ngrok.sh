#!/usr/bin/env bash
# Expõe a versão de TESTES via ngrok (túnel pro nginx local na porta 80).
#
# Pré-requisitos:
#   - Sistema no ar: bash deploy/ngrok_start.sh (ou deploy/start.sh)
#   - ngrok instalado e autenticado (ngrok config add-authtoken ...)
#   - PUBLIC_BASE_URL no backend/.env.ngrok com seu domínio estático ngrok
#
# Uso (da raiz do repo):
#   bash deploy/ngrok.sh
#
# Normalmente é o ngrok_start.sh que chama este script. Deixa rodando em
# foreground (Ctrl+C encerra o túnel). Para background:
#   nohup bash deploy/ngrok.sh >/tmp/ngrok.log 2>&1 &

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_NGROK="$REPO_DIR/backend/.env.ngrok"

# Porta local que o ngrok vai expor (nginx serve frontend + /api juntos).
PORT="${NGROK_PORT:-80}"

# Lê PUBLIC_BASE_URL do .env.ngrok e extrai só o host (sem https:// e sem barra).
BASE=""
if [[ -f "$ENV_NGROK" ]]; then
  BASE=$(grep -m1 '^PUBLIC_BASE_URL=' "$ENV_NGROK" | cut -d= -f2- || true)
fi
DOMAIN=$(echo "$BASE" | sed -E 's#^https?://##; s#/+$##')

if [[ -z "$DOMAIN" || "$DOMAIN" == *SEU-DOMINIO* ]]; then
  echo "!! PUBLIC_BASE_URL não está configurado em backend/.env.ngrok."
  echo "   Crie/edite a linha PUBLIC_BASE_URL=https://SEU-DOMINIO.ngrok-free.app"
  echo "   com o seu domínio estático do ngrok e rode de novo."
  exit 1
fi

echo "=== Nimbus - ngrok (testes) ==="
echo "  Domínio : https://$DOMAIN"
echo "  Túnel   : http://localhost:$PORT  (nginx)"
echo
echo "  Lembre: o nginx precisa estar no ar (bash deploy/start.sh)."
echo "  Ctrl+C encerra o túnel."
echo

exec ngrok http "$PORT" --domain="$DOMAIN"
