#!/usr/bin/env bash
# Verifica se a instalação do Nimbus está completa e funcionando.
#
# Uso (da raiz do repo):
#   bash deploy/test.sh
#
# Saída:
#   exit 0 = tudo OK
#   exit 1 = alguma coisa falhou (detalhe no output)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Cores (desativadas se não for terminal)
if [[ -t 1 ]]; then
  G='\033[0;32m'; R='\033[0;31m'; Y='\033[1;33m'; B='\033[1;34m'; N='\033[0m'
else
  G=''; R=''; Y=''; B=''; N=''
fi

PASS=0; FAIL=0; WARN=0

ok()   { printf "  ${G}OK${N}    %s\n" "$1"; PASS=$((PASS+1)); }
bad()  { printf "  ${R}FAIL${N}  %s\n" "$1"; FAIL=$((FAIL+1)); }
warn() { printf "  ${Y}WARN${N}  %s\n" "$1"; WARN=$((WARN+1)); }
sect() { printf "\n${B}── %s${N}\n" "$1"; }

echo "========================================="
echo "  Nimbus - smoke test"
echo "  Repo: $REPO_DIR"
echo "========================================="

# ── 1. Comandos do sistema ─────────────────────────────────────────────
sect "Pacotes do sistema"

if command -v node >/dev/null 2>&1; then
  NODE_V=$(node -v)
  MAJOR=$(echo "$NODE_V" | sed 's/v\([0-9]*\).*/\1/')
  if [[ "$MAJOR" -ge 20 ]]; then
    ok "node $NODE_V"
  else
    bad "node $NODE_V (precisa >= 20)"
  fi
else
  bad "node não instalado"
fi

command -v npm    >/dev/null 2>&1 && ok "npm $(npm -v)"               || bad "npm não instalado"
command -v docker >/dev/null 2>&1 && ok "docker $(docker --version | awk '{print $3}' | tr -d ,)" || bad "docker não instalado"
command -v pm2    >/dev/null 2>&1 && ok "pm2 $(pm2 -v)"               || bad "pm2 não instalado"
command -v nginx  >/dev/null 2>&1 && ok "nginx $(nginx -v 2>&1 | awk -F/ '{print $2}')" || bad "nginx não instalado"
command -v git    >/dev/null 2>&1 && ok "git"                          || bad "git não instalado"
command -v ngrok  >/dev/null 2>&1 && ok "ngrok"                        || warn "ngrok não instalado (opcional)"

# ── 2. Docker compose: Postgres + Redis ────────────────────────────────
sect "Containers (Postgres + Redis)"

DOCKER="docker"
if ! docker ps >/dev/null 2>&1; then
  DOCKER="sudo docker"
fi

if $DOCKER ps --format '{{.Names}}' 2>/dev/null | grep -q '^nimbus-postgres$'; then
  ok "container nimbus-postgres rodando"
  if $DOCKER exec nimbus-postgres pg_isready -U nimbus -d nimbus >/dev/null 2>&1; then
    ok "  postgres aceitando conexões (db=nimbus, user=nimbus)"
  else
    bad "  postgres NÃO aceita conexões"
  fi
else
  bad "container nimbus-postgres NÃO está rodando"
fi

if $DOCKER ps --format '{{.Names}}' 2>/dev/null | grep -q '^nimbus-redis$'; then
  ok "container nimbus-redis rodando"
  if $DOCKER exec nimbus-redis redis-cli ping 2>/dev/null | grep -q PONG; then
    ok "  redis responde PONG"
  else
    bad "  redis NÃO responde"
  fi
else
  bad "container nimbus-redis NÃO está rodando"
fi

# ── 3. Build do projeto ────────────────────────────────────────────────
sect "Build do projeto"

[[ -d "$REPO_DIR/backend/node_modules" ]] \
  && ok "backend/node_modules existe" \
  || bad "backend/node_modules ausente — rode 'cd backend && npm install'"

[[ -d "$REPO_DIR/backend/node_modules/.prisma/client" ]] \
  && ok "Prisma client gerado" \
  || bad "Prisma client ausente — rode 'npx prisma generate'"

[[ -f "$REPO_DIR/backend/.env" ]] \
  && ok "backend/.env existe" \
  || bad "backend/.env ausente — copie de .env.example"

# Avisa sobre estado do Stripe no .env
if [[ -f "$REPO_DIR/backend/.env" ]]; then
  if grep -qE '^STRIPE_SECRET_KEY=sk_live_' "$REPO_DIR/backend/.env" 2>/dev/null; then
    ok "Stripe em modo LIVE"
  elif grep -qE '^STRIPE_SECRET_KEY=sk_test_' "$REPO_DIR/backend/.env" 2>/dev/null; then
    warn "Stripe em modo TEST (trocar pra sk_live_ quando for vender de verdade)"
  else
    warn "STRIPE_SECRET_KEY não configurada (billing vai retornar 501)"
  fi
fi

[[ -d "$REPO_DIR/frontend/node_modules" ]] \
  && ok "frontend/node_modules existe" \
  || bad "frontend/node_modules ausente"

[[ -f "$REPO_DIR/frontend/dist/index.html" ]] \
  && ok "frontend/dist/index.html existe (build feito)" \
  || bad "frontend não buildado — rode 'cd frontend && npm run build'"

# ── 4. PM2 ─────────────────────────────────────────────────────────────
sect "PM2"

if pm2 ping >/dev/null 2>&1; then
  ok "daemon PM2 vivo"

  PM2_JSON=$(pm2 jlist 2>/dev/null || echo "[]")

  check_pm2() {
    local app="$1"
    local status
    status=$(echo "$PM2_JSON" | node -e "
let d='';
process.stdin.on('data', c => d += c).on('end', () => {
  try {
    const arr = JSON.parse(d);
    const p = arr.find(x => x.name === '$app');
    console.log(p ? (p.pm2_env && p.pm2_env.status) || 'unknown' : 'missing');
  } catch (e) { console.log('parse-error'); }
});
" 2>/dev/null)
    case "$status" in
      online)  ok   "$app online" ;;
      missing) bad  "$app NÃO registrado no PM2" ;;
      "")      bad  "$app status=desconhecido (node falhou no parse)" ;;
      *)       bad  "$app status=$status" ;;
    esac
  }

  check_pm2 "nimbus-backend"
  check_pm2 "nimbus-worker"
else
  bad "daemon PM2 não respondeu"
fi

# ── 5. Nginx ───────────────────────────────────────────────────────────
sect "Nginx"

[[ -f /etc/nginx/sites-enabled/nimbus ]] \
  && ok "site nimbus habilitado" \
  || bad "site nimbus NÃO habilitado em /etc/nginx/sites-enabled/"

if sudo nginx -t >/dev/null 2>&1; then
  ok "config válida (nginx -t)"
else
  bad "config inválida — rode 'sudo nginx -t' pra ver o erro"
fi

if systemctl is-active --quiet nginx; then
  ok "serviço nginx ativo"
else
  bad "serviço nginx NÃO ativo (sudo systemctl start nginx)"
fi

# ── 6. Endpoints HTTP ──────────────────────────────────────────────────
sect "Endpoints"

# Backend direto
if curl -fsS --max-time 5 http://127.0.0.1:3001/healthz >/dev/null 2>&1; then
  ok "backend :3001/healthz → 200"
else
  bad "backend :3001/healthz NÃO responde"
fi

# Via nginx
if curl -fsS --max-time 5 http://127.0.0.1/healthz >/dev/null 2>&1; then
  ok "nginx :80/healthz (proxy → :3001) → 200"
else
  bad "nginx :80/healthz NÃO responde"
fi

# Frontend servindo HTML
if curl -fsS --max-time 5 http://127.0.0.1/ 2>/dev/null | grep -qi "<html"; then
  ok "nginx :80/ serve o frontend (HTML)"
else
  bad "nginx :80/ NÃO serve o frontend (404? permissão? dist faltando?)"
fi

# Metrics endpoint
if curl -fsS --max-time 5 http://127.0.0.1:3001/metrics 2>/dev/null | grep -q "^nimbus_"; then
  ok "/metrics retorna formato Prometheus"
else
  warn "/metrics não respondeu ou sem métricas nimbus_*"
fi

# ── 7. UFW (firewall) ──────────────────────────────────────────────────
sect "UFW (firewall)"

if sudo ufw status 2>/dev/null | grep -q "Status: active"; then
  ok "UFW ativo"
  UFW_STATUS=$(sudo ufw status 2>/dev/null)
  echo "$UFW_STATUS" | grep -qE "(22|OpenSSH)" && ok "  porta 22 (SSH) aberta" || warn "  porta 22 não listada"
  echo "$UFW_STATUS" | grep -q "80/tcp"          && ok "  porta 80 aberta"      || bad  "  porta 80 NÃO aberta"
  echo "$UFW_STATUS" | grep -q "443/tcp"         && ok "  porta 443 aberta"     || warn "  porta 443 não aberta (precisa pra HTTPS)"
else
  warn "UFW não ativo (sem firewall — OK pra teste, ruim pra prod)"
fi

# ── Sumário ────────────────────────────────────────────────────────────
echo
echo "========================================="
printf "  ${G}OK: %d${N}    ${R}FAIL: %d${N}    ${Y}WARN: %d${N}\n" "$PASS" "$FAIL" "$WARN"
echo "========================================="

if [[ $FAIL -gt 0 ]]; then
  echo
  echo "Algo falhou. Veja a saída acima e:"
  echo "  - logs do backend:  pm2 logs nimbus-backend"
  echo "  - logs do worker:   pm2 logs nimbus-worker"
  echo "  - logs do nginx:    sudo tail -f /var/log/nginx/error.log"
  echo "  - containers:       sudo docker compose ps"
  exit 1
fi

echo
echo "Tudo OK. Bora subir o ngrok:"
echo "  ngrok http 80"
exit 0
