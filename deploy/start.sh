#!/usr/bin/env bash
# Sobe tudo: Postgres + Redis (docker compose), backend + worker (PM2) e o
# Downloader (garante/atualiza yt-dlp e ffmpeg).
# Roda DEPOIS de install.sh (que já configurou tudo).
#
# Uso (da raiz do repo):
#   bash deploy/start.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Detecta se o sistema já está rodando (algum processo PM2 do Nimbus registrado).
# Se estiver, entra em "modo reinício": pula o prompt de restore do banco e usa
# startOrRestart no PM2 — assim dá pra rodar start.sh de novo sem chamar stop.sh.
ALREADY_RUNNING=0
if pm2 describe nimbus-backend >/dev/null 2>&1 || pm2 describe nimbus-worker >/dev/null 2>&1; then
  ALREADY_RUNNING=1
fi

echo "=== Nimbus - start ==="
if [[ "$ALREADY_RUNNING" == "1" ]]; then
  echo "  (sistema já está rodando — modo reinício: vou reiniciar sem pedir restore do banco)"
fi

# Postgres + Redis (sobe primeiro — restore precisa do container)
echo
echo "[1/7] Postgres + Redis..."
cd "$REPO_DIR"
sudo docker compose up -d
for i in {1..30}; do
  if sudo docker exec nimbus-postgres pg_isready -U nimbus -d nimbus >/dev/null 2>&1; then
    echo "  Postgres pronto."
    break
  fi
  sleep 1
done

# Banco remoto: verifica se tem backup mais novo no Backblaze.
# No modo reinício (sistema já no ar) pulamos — não faz sentido restaurar o banco
# só pra reiniciar o código, e o prompt interativo travaria o fluxo.
# NIMBUS_SKIP_RESTORE=1 (modo ngrok, restart.sh): usa o banco LOCAL, nunca
# restaura da nuvem — equivale a responder "N" no prompt abaixo.
echo
if [[ "${NIMBUS_SKIP_RESTORE:-0}" == "1" ]]; then
  echo "[2/7] Restore remoto: pulado (NIMBUS_SKIP_RESTORE=1 — mantendo banco local)."
elif [[ "$ALREADY_RUNNING" == "1" ]]; then
  echo "[2/7] Backup remoto: pulado (reinício de sistema já rodando)."
else
echo "[2/7] Verificando backup remoto (Backblaze)..."
_ENV_FILE="$REPO_DIR/backend/.env"
_B2_BUCKET=""
_B2_KEY_ID=""
if [[ -f "$_ENV_FILE" ]]; then
  _B2_BUCKET=$(grep -m1 '^BACKUP_S3_BUCKET=' "$_ENV_FILE" | cut -d= -f2- || true)
  _B2_KEY_ID=$(grep -m1 '^BACKUP_S3_KEY_ID=' "$_ENV_FILE" | cut -d= -f2- || true)
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
  else
    echo "  Backup remoto disponível: $_LATEST_REMOTE"
    if [[ "$_LATEST_REMOTE" > "${_LATEST_LOCAL:-0}" ]]; then
      echo "  >>> Mais novo que o local — recomendado restaurar."
    elif [[ -n "$_LATEST_LOCAL" ]]; then
      echo "  Local atual:              $_LATEST_LOCAL"
      echo "  (banco local parece mais recente — mas você pode sobrescrever)"
    fi
    echo
    echo "  Opções:"
    echo "    s = restaurar do Backblaze (sobrescreve banco local)"
    echo "    n = manter banco local como está"
    echo "  (o restore pergunta à parte se traz as sessões do WhatsApp; o padrão é NÃO —"
    echo "   duas máquinas com a mesma auth derrubam o device dos usuários.)"
    read -rp "  Restaurar banco do Backblaze? [s/N] " _restore_resp
    case "${_restore_resp,,}" in
      s|sim|y|yes)
        node "$REPO_DIR/backend/scripts/restore-remote.js" --latest
        ;;
      *)
        echo "  Mantendo banco local."
        ;;
    esac
  fi
fi
fi

# Backend: deps + migrations
echo
echo "[3/7] Backend: npm install + migrations..."
cd "$REPO_DIR/backend"
npm install --omit=dev
npx prisma generate
npx prisma migrate deploy

# Downloader (Admin > Downloader): roda dentro do nimbus-backend, mas depende de
# dois binários que o npm install sozinho não garante — o yt-dlp mora FORA do
# node_modules e o ffmpeg do ffmpeg-static é baixado no install do pacote (se
# o arquivo sumir, o pacote não mudou e o install não roda de novo).
# Mesma lógica do botão "Atualizar yt-dlp" (downloader/ytdlp.js): se o binário
# não existe, baixa; se existe, `-U` só baixa quando há versão nova — assim o
# restart não rebaixa 40MB toda vez, mas pega as correções que o YouTube/TikTok
# vivem exigindo. Nunca aborta o start: GitHub fora do ar não impede o resto.
echo
echo "[4/7] Downloader: yt-dlp + ffmpeg..."
_YTDLP="$REPO_DIR/backend/downloader/bin/yt-dlp"
if [[ -x "$_YTDLP" ]]; then
  timeout 120 "$_YTDLP" -U \
    || echo "  !! yt-dlp nao atualizado - use o botao 'Atualizar yt-dlp' em Admin > Downloader."
else
  node scripts/setup-ytdlp.js \
    || echo "  !! yt-dlp nao baixado - use o botao 'Atualizar yt-dlp' em Admin > Downloader."
fi
if [[ -x "$_YTDLP" ]]; then
  echo "  yt-dlp: $("$_YTDLP" --version 2>/dev/null || echo '?')"
fi
_FFMPEG=$(node -e 'process.stdout.write(require("ffmpeg-static") || "")' 2>/dev/null || true)
if [[ -z "$_FFMPEG" || ! -x "$_FFMPEG" ]]; then
  echo "  ffmpeg-static sem binário — reinstalando..."
  npm rebuild ffmpeg-static \
    || echo "  !! ffmpeg nao instalado - o Downloader nao vai conseguir juntar/renderizar videos."
else
  echo "  ffmpeg: ok"
fi

echo
echo "[5/7] PM2: backend + worker..."
# startOrRestart: sobe o que não existe e reinicia o que já estiver rodando — em
# um comando só, sem erro de "already launched". Funciona tanto no boot inicial
# quanto no reinício (sem precisar de stop.sh antes).
pm2 startOrRestart ecosystem.config.js --update-env
pm2 save >/dev/null

# Frontend: build
echo
echo "[6/7] Frontend: build..."
cd "$REPO_DIR/frontend"
npm install
npm run build
chmod -R o+rX "$REPO_DIR/frontend/dist"

# Nginx (caso esteja parado)
echo
echo "[7/7] Nginx..."
sudo systemctl start nginx 2>/dev/null || true
sudo systemctl reload nginx

echo
echo "=== Tudo no ar. ==="
pm2 status
echo
# URL pública efetiva — lida pelo mesmo carregador do app, respeitando o modo
# (NIMBUS_MODE=prod usa .env; =ngrok sobrepõe com .env.ngrok).
_PUB=$(cd "$REPO_DIR/backend" && node -e 'require("./config/loadEnv"); process.stdout.write(require("./config/publicUrl").PUBLIC_BASE_URL || "")' 2>/dev/null || true)
echo "Acesse:"
echo "  ${_PUB:-https://sistema.nimbuspromocoes.com}"
echo "  Local:  curl http://localhost/healthz"
if [[ "$_PUB" == *ngrok* ]]; then
  echo
  echo "  (modo testes/ngrok — o túnel sobe pelo ngrok_start.sh, ou rode: bash deploy/ngrok.sh)"
fi
