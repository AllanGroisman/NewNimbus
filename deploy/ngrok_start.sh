#!/usr/bin/env bash
# Sobe o Nimbus em modo TESTES via ngrok (link do domínio estático do ngrok).
#
# Diferenças pro modo produção:
#   - PUBLIC_BASE_URL vem do backend/.env.ngrok (CORS, e-mails, retorno Stripe)
#   - Banco LOCAL: nunca restaura da nuvem (NIMBUS_SKIP_RESTORE=1)
#   - Backup remoto vai pro prefixo nimbus-ngrok/ (isolado do prod)
#   - O túnel ngrok sobe TAMBÉM no PM2 (processo nimbus-ngrok) — fica gerenciado
#     junto com backend/worker, sobrevive a fechar o terminal e aparece no
#     `pm2 status`. Logs: `pm2 logs nimbus-ngrok`. Encerra com `bash deploy/stop.sh`.
#
# Pré-requisitos:
#   - backend/.env.ngrok com o seu domínio estático do ngrok
#   - ngrok instalado e autenticado
#
# Uso (da raiz do repo):
#   bash deploy/ngrok_start.sh
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_NGROK="$REPO_DIR/backend/.env.ngrok"

export NIMBUS_MODE=ngrok
export NIMBUS_SKIP_RESTORE=1

# Valida o domínio estático ANTES de subir nada — assim falha cedo (em foreground)
# em vez de virar um nimbus-ngrok em crash-loop no PM2.
BASE=""
if [[ -f "$ENV_NGROK" ]]; then
  BASE=$(grep -m1 '^PUBLIC_BASE_URL=' "$ENV_NGROK" | cut -d= -f2- || true)
fi
DOMAIN=$(echo "$BASE" | sed -E 's#^https?://##; s#/+$##')
if [[ -z "$DOMAIN" || "$DOMAIN" == *SEU-DOMINIO* ]]; then
  echo "!! PUBLIC_BASE_URL não está configurado em backend/.env.ngrok."
  echo "   Edite a linha PUBLIC_BASE_URL=https://SEU-DOMINIO.ngrok-free.app"
  echo "   com o seu domínio estático do ngrok e rode de novo."
  exit 1
fi

# Sobe a stack (Postgres/Redis + backend/worker via PM2 + frontend + nginx).
bash "$SCRIPT_DIR/start.sh"

# Sobe o túnel ngrok TAMBÉM no PM2 (nimbus-ngrok). O ngrok.sh resolve o domínio
# do .env.ngrok e faz exec do ngrok em foreground — o que é exatamente o que o
# PM2 precisa pra gerenciar o processo. delete+start garante que ele relê o
# domínio atual a cada (re)subida.
echo
echo "[ngrok] Subindo túnel no PM2 (nimbus-ngrok)..."
pm2 delete nimbus-ngrok >/dev/null 2>&1 || true
pm2 start "$SCRIPT_DIR/ngrok.sh" --name nimbus-ngrok --interpreter bash --time
pm2 save >/dev/null

echo
echo "=== Tudo no ar (inclusive o ngrok no PM2). ==="
pm2 status
echo
echo "  Domínio : https://$DOMAIN"
echo "  Logs    : pm2 logs nimbus-ngrok"
echo "  Parar   : bash deploy/stop.sh"
