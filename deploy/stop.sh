#!/usr/bin/env bash
# Para e remove tudo do PM2: backend, worker e backup.
# Encerra o que sobrar do Downloader (yt-dlp/ffmpeg) e limpa o tmp/ dele.
# Para também Postgres + Redis (docker compose).
# Não desinstala — só desliga.
#
# Uso (da raiz do repo):
#   bash deploy/stop.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "=== Nimbus - stop ==="

echo
echo "[1/4] PM2 delete (backend, worker, backup, ngrok)..."
for proc in nimbus-backend nimbus-worker nimbus-backup-remote nimbus-ngrok; do
  if pm2 describe "$proc" >/dev/null 2>&1; then
    pm2 delete "$proc"
    echo "  $proc removido."
  else
    echo "  $proc não estava no PM2."
  fi
done
pm2 save >/dev/null

# Downloader: o yt-dlp e o ffmpeg rodam como filhos do nimbus-backend. O PM2
# derruba a árvore junto, mas um download pego no meio do kill_timeout pode
# sobrar órfão segurando CPU e o arquivo parcial. O casamento é pelo caminho
# completo dos binários deste repo NO INÍCIO da linha de comando (o `nice` faz
# exec, então o processo vira o próprio binário) — não mexe em yt-dlp/ffmpeg de
# outra coisa nem num shell/editor que só cite o caminho.
# O tmp/ só guarda vídeos de lotes da fila em memória, que morreu com o
# backend; o server também o limpa no boot, aqui é pra não ficar ocupando
# disco enquanto o sistema está parado.
echo
echo "[2/4] Downloader (yt-dlp/ffmpeg órfãos + tmp/)..."
DL_BINS=(
  "$REPO_DIR/backend/downloader/bin/yt-dlp"
  "$REPO_DIR/backend/node_modules/ffmpeg-static/ffmpeg"
)
dl_killed=0
for bin in "${DL_BINS[@]}"; do
  if pgrep -f "^$bin( |\$)" >/dev/null 2>&1; then
    pkill -TERM -f "^$bin( |\$)" && dl_killed=1
  fi
done
if [[ "$dl_killed" == "1" ]]; then
  sleep 2
  for bin in "${DL_BINS[@]}"; do pkill -KILL -f "^$bin( |\$)" 2>/dev/null; done
  echo "  processos do Downloader encerrados."
else
  echo "  nenhum processo do Downloader rodando."
fi
DL_TMP="$REPO_DIR/backend/downloader/tmp"
if [[ -d "$DL_TMP" ]]; then
  find "$DL_TMP" -mindepth 1 -delete 2>/dev/null \
    && echo "  tmp/ do Downloader limpo." \
    || echo "  (falha ao limpar $DL_TMP)"
fi

echo
echo "[3/4] Encerrando túnel ngrok (se houver)..."
if pgrep -x ngrok >/dev/null 2>&1; then
  pkill -x ngrok && echo "  ngrok encerrado." || echo "  (falha ao encerrar ngrok)"
else
  echo "  ngrok não estava rodando."
fi

echo
echo "[4/4] Postgres + Redis stop..."
cd "$REPO_DIR"
sudo docker compose stop

echo
echo "=== Parado. ==="
echo "Pra subir de novo: bash deploy/normal_start.sh  (ou ngrok_start.sh)"
