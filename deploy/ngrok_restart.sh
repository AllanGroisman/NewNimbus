#!/usr/bin/env bash
# Reinicia o Nimbus em modo TESTES (ngrok): roda o stop.sh e, em seguida, o
# ngrok_start.sh.
#
# Não precisa exportar NIMBUS_SKIP_RESTORE: o ngrok_start.sh já define
# NIMBUS_MODE=ngrok e NIMBUS_SKIP_RESTORE=1 por conta própria, então o banco
# LOCAL nunca é sobrescrito e o restart não fica travado esperando teclado.
#
# Uso (da raiz do repo):
#   bash deploy/ngrok_restart.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=== Nimbus - restart (ngrok) ==="

# stop.sh roda sem `set -e` e tolera processos inexistentes; ainda assim não
# deixamos um retorno diferente de zero abortar o restart antes de subir nada.
if ! bash "$SCRIPT_DIR/stop.sh"; then
  echo
  echo "!! stop.sh terminou com erro — seguindo pro ngrok_start.sh de qualquer forma."
fi

echo
bash "$SCRIPT_DIR/ngrok_start.sh"

echo
echo "=== Nimbus reiniciado (ngrok). ==="
