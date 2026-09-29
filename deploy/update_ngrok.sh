#!/usr/bin/env bash
# Reinicia o Nimbus em modo TESTES (ngrok): para tudo e sobe de novo.
# Atalho pra: bash deploy/stop.sh && bash deploy/ngrok_start.sh
#
# Inclui o Downloader: o stop.sh encerra yt-dlp/ffmpeg que sobrarem e limpa o
# tmp/ dele; o start.sh garante/atualiza o yt-dlp e confere o ffmpeg.
#
# Uso (da raiz do repo):
#   bash deploy/update_ngrok.sh
#
# Dica: pra não digitar a senha do sudo no meio da execução, configure um
# drop-in de sudoers com os comandos usados pelo stop/start (veja o final
# deste arquivo / a explicação que o Claude deu).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=== Nimbus - update (ngrok) ==="
echo
echo ">>> [1/2] Parando a stack..."
bash "$SCRIPT_DIR/stop.sh"

echo
echo ">>> [2/2] Subindo de novo (modo ngrok)..."
bash "$SCRIPT_DIR/ngrok_start.sh"

echo
echo "=== Update concluído. ==="
