#!/usr/bin/env bash
# Sobe o Nimbus em modo PRODUÇÃO (link sistema.nimbuspromocoes.com).
# Restore da nuvem habilitado, backup no prefixo nimbus/. Comportamento padrão.
#
# Uso (da raiz do repo):
#   bash deploy/start_normal.sh

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export NIMBUS_MODE=prod

exec bash "$SCRIPT_DIR/start.sh"
