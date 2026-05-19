# Deploy - VPS Ubuntu

Instala e sobe o Nimbus inteiro numa VPS Ubuntu limpa (22.04 ou 24.04) com **um comando**.

## O que o `install.sh` faz

1. `apt update` + Node 22 (NodeSource) + Docker + nginx + PM2 + ngrok + libs do Chromium
2. Sobe Postgres + Redis via `docker compose up -d`
3. Backend: `npm install --omit=dev`, `prisma generate`, `prisma migrate deploy`
4. Cria `backend/.env` a partir de `.env.example` (só na primeira vez) com `QUEUE_BACKEND=redis` e `NODE_ENV=production`
5. Frontend: `npm install` + `npm run build` (gera `frontend/dist/`)
6. Nginx servindo `frontend/dist/` em `:80` + proxy `/api` → `:3001`
7. UFW abrindo só 22/80/443
8. PM2 sobe `nimbus-backend` + `nimbus-worker` + autostart no boot

É idempotente — pode rodar de novo a qualquer momento.

## Passo a passo

Na VPS, como usuário normal (NÃO root):

```bash
# Clone o repo (ajuste pra seu fork)
git clone https://github.com/AllanGroisman/NewNimbus.git
cd NewNimbus

# Roda a instalação
bash deploy/install.sh
```

O script pede sudo quando precisa. Vai levar ~5–10 min (depende da velocidade do apt + npm).

### Depois da instalação

**1. Edite `backend/.env`** pra setar as chaves de produção:

```bash
nano backend/.env
```

Mínimo recomendado:

```env
NIMBUS_CORS_ORIGINS=https://seu-dominio-ou-ngrok.com

# Stripe (modo live ou test)
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_BASIC=price_...
STRIPE_PRICE_PRO=price_...
STRIPE_PRICE_BUSINESS=price_...
STRIPE_SUCCESS_URL=https://seu-dominio/?checkout=success
STRIPE_CANCEL_URL=https://seu-dominio/?checkout=cancel
```

Aí reinicia:

```bash
pm2 restart nimbus-backend nimbus-worker
```

**2. Expõe com ngrok** (enquanto você não tem domínio):

```bash
ngrok config add-authtoken SEU_TOKEN_NGROK
ngrok http 80
```

A URL `https://xxxx.ngrok-free.app` que ele imprime é a URL pública. Cole ela em:
- `STRIPE_SUCCESS_URL` / `STRIPE_CANCEL_URL`
- `NIMBUS_CORS_ORIGINS` (se for restringir)
- Webhook do Stripe (dashboard → Developers → Webhooks → `+ Add endpoint` apontando pra `https://xxxx.ngrok-free.app/api/billing/webhook`)

E reinicia o backend.

## Migrar pra HTTPS depois (quando tiver domínio)

Aponte o domínio (A record) pro IP da VPS, espere propagar, e:

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d seu-dominio.com
```

Certbot edita o `/etc/nginx/sites-available/nimbus` automaticamente, cria o bloco `listen 443 ssl`, e instala um systemd timer pra renovar a cada 90 dias.

Depois disso, atualize `NIMBUS_CORS_ORIGINS` e as URLs do Stripe pro domínio com `https://`.

## Update de versão

Pra puxar novidades do git e reiniciar:

```bash
cd NewNimbus
bash deploy/update.sh
```

Faz `git pull`, reinstala deps que mudaram, roda migrations, rebuilda o frontend e dá `pm2 reload`.

## Comandos úteis

```bash
# Status / logs
pm2 status
pm2 logs nimbus-backend
pm2 logs nimbus-worker
pm2 monit                       # dashboard interativo

# Health do backend
curl http://localhost:3001/healthz
curl http://localhost:3001/metrics

# Docker (Postgres + Redis)
sudo docker compose ps
sudo docker compose logs postgres
sudo docker compose logs redis

# Nginx
sudo nginx -t                   # valida config
sudo systemctl reload nginx     # aplica mudança de config
sudo tail -f /var/log/nginx/access.log

# Reinicia tudo do zero
pm2 restart all
sudo docker compose restart
```

## Backup do Postgres

O `backup-data.js` antigo foi removido. Pra backup periódico do DB, agende `pg_dump` via cron — algo assim em `crontab -e`:

```cron
0 */6 * * * docker exec nimbus-postgres pg_dump -U nimbus nimbus | gzip > /home/$USER/NewNimbus/backend/backups/nimbus-$(date +\%Y\%m\%d-\%H\%M).sql.gz
```

Aí o `nimbus-backup-remote` (já roda via PM2 cron de hora em hora) sobe os snapshots pro S3 — só configure `BACKUP_S3_*` no `.env`.

## Troubleshooting

**"Permission denied" no nginx ao servir `frontend/dist`** — o `www-data` precisa atravessar `/home/$USER`:

```bash
sudo chmod o+rx /home/$USER
chmod -R o+rX ~/NewNimbus/frontend/dist
```

**Docker exige sudo mesmo depois do install** — você precisa fazer logout/login (ou `newgrp docker`) pra entrar no grupo `docker`. O install.sh já adicionou, mas o shell atual ainda tem a sessão antiga.

**Puppeteer não acha o Chromium** — em Ubuntu 24.04 algumas libs mudaram de nome. O install.sh tenta `libasound2t64` e cai pra `libasound2` se não achar. Se faltar algo, rode:

```bash
sudo apt install -y $(cd ~/NewNimbus/backend && node -e "const {execSync} = require('child_process'); try { execSync('npx puppeteer browsers install chrome', {stdio:'inherit'}); } catch(e) {}")
```

**Stripe webhook não chega** — Stripe exige HTTPS público. Com ngrok funciona; HTTP local não. Veja `pm2 logs nimbus-backend | grep webhook`.

**`pm2 startup` falhou** — rode manualmente o comando que ele imprime (vai começar com `sudo env PATH=...`).
