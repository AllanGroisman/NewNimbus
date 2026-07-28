#!/usr/bin/env bash
# Reinicia o Nimbus: roda o stop.sh e, em seguida, o start.sh.
#
# O banco LOCAL nunca é sobrescrito: exportamos NIMBUS_SKIP_RESTORE=1, que é o
# mesmo que responder "N" na pergunta "Restaurar banco do Backblaze? [s/N]" do
# start.sh — ou seja, o restart nunca fica travado esperando teclado.
#
# Uso (da raiz do repo):
#   bash deploy/restart.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Responde "N" automaticamente pro restore do Backblaze (mantém banco local).
export NIMBUS_SKIP_RESTORE=1

echo "=== Nimbus - restart ==="

# stop.sh roda sem `set -e` e tolera processos inexistentes; ainda assim não
# deixamos um retorno diferente de zero abortar o restart antes de subir nada.
if ! bash "$SCRIPT_DIR/stop.sh"; then
  echo
  echo "!! stop.sh terminou com erro — seguindo pro start.sh de qualquer forma."
fi

echo
bash "$SCRIPT_DIR/start.sh"

echo
echo "=== Nimbus reiniciado. ==="
