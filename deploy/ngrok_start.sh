#!/usr/bin/env bash
# Sobe o Nimbus em modo TESTES via ngrok (link do domínio estático do ngrok).
#
# Diferenças pro modo produção:
#   - PUBLIC_BASE_URL vem do backend/.env.ngrok (CORS, e-mails, retorno Stripe)
#   - Banco LOCAL: nunca restaura da nuvem (NIMBUS_SKIP_RESTORE=1)
#   - Backup remoto vai pro prefixo nimbus-ngrok/ (isolado do prod)
#   - Abre o túnel ngrok no fim (foreground; Ctrl+C encerra só o túnel)
#
# Pré-requisitos:
#   - backend/.env.ngrok com o seu domínio estático do ngrok
#   - ngrok instalado e autenticado
#
# Uso (da raiz do repo):
#   bash deploy/ngrok_start.sh

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export NIMBUS_MODE=ngrok
export NIMBUS_SKIP_RESTORE=1

# Sobe a stack (Postgres/Redis + backend/worker via PM2 + frontend + nginx).
bash "$SCRIPT_DIR/start.sh"

# Abre o túnel no domínio estático (lê backend/.env.ngrok). Fica em foreground.
exec bash "$SCRIPT_DIR/ngrok.sh"
