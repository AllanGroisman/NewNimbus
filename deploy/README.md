# Deploy - VPS Ubuntu

Instala e sobe o Nimbus inteiro numa VPS Ubuntu limpa (22.04 ou 24.04) com **um comando**.

## O que o `install.sh` faz

1. `apt update` + Node 22 (NodeSource) + Docker + nginx + PM2 + libs do Chromium
2. Sobe Postgres + Redis via `docker compose up -d`
3. Backend: `npm install --omit=dev`, `prisma generate`, `prisma migrate deploy`
4. Cria `backend/.env` a partir de `.env.example` (só na primeira vez) com `QUEUE_BACKEND=redis` e `NODE_ENV=production`
5. Frontend: `npm install` + `npm run build` (gera `frontend/dist/`)
6. Nginx servindo `frontend/dist/` em `:80` + proxy `/api` → `:3001`
7. UFW abrindo só 22/80/443
8. PM2 sobe `nimbus-backend` + `nimbus-worker` + autostart no boot

É idempotente — pode rodar de novo a qualquer momento.

## Passo a passo

Na VPS (aceita rodar como root ou usuário normal):

```bash
# Clone o repo (ajuste pra seu fork)
git clone https://github.com/AllanGroisman/NewNimbus.git
cd NewNimbus

# Roda a instalação
bash deploy/install.sh
```

O script pede sudo quando precisa. Vai levar ~5–10 min (depende da velocidade do apt + npm).

### Depois da instalação

O `backend/.env` **já vem do repo** com as chaves do Stripe (modo test), `QUEUE_BACKEND=redis`, `NODE_ENV=production`, `ADMIN_EMAILS`. Só precisa ajustar se for:

- Trocar Stripe pra **modo live** (`sk_live_...`)
- Apontar `STRIPE_SUCCESS_URL` / `STRIPE_CANCEL_URL` pro domínio de produção
- Restringir `NIMBUS_CORS_ORIGINS`

Pra editar:

```bash
nano backend/.env
pm2 restart nimbus-backend nimbus-worker
```

## Migrar pra HTTPS (quando tiver domínio)

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

## Ligar / desligar

Depois do `install.sh` ter rodado uma vez, pra ligar/desligar tudo:

```bash
bash deploy/start.sh   # sobe Postgres+Redis+backend+worker+nginx
bash deploy/stop.sh    # para tudo (mantém instalado)
bash deploy/restart.sh # stop.sh + start.sh em seguida (sem perguntar nada)
```

`start.sh` é idempotente — pode rodar mesmo se já estiver tudo no ar.

`restart.sh` roda o `stop.sh` e depois o `start.sh`. Ele nunca restaura o banco
do Backblaze (responde "N" automaticamente), então o banco local é mantido.

## Verificar se está tudo OK

```bash
bash deploy/test.sh
```

Checa 30+ pontos: pacotes do sistema, containers Postgres/Redis, build do projeto, PM2 (backend + worker online), nginx (config válida + ativo), endpoints (`:3001/healthz`, `:80/healthz`, frontend), UFW. Imprime sumário no fim e `exit 1` se algo falhar.

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

## Backup do Postgres (3 camadas)

Backup automático a cada 6h em **3 destinos**: local → Backblaze B2 → Google Drive. Setup em 1 comando:

```bash
bash deploy/setup-backups.sh
```

Esse script instala `rclone`, registra o cron e te guia pela configuração do B2 (envs no `.env`) e do Google Drive (`rclone config`). Depois, o cron roda `backend/scripts/backup-all.sh` a cada 6h.

Doc completa em [`../backend/scripts/README.md`](../backend/scripts/README.md). Resumo:

| Camada | Quem cuida | Retenção |
|---|---|---|
| 1. Dump local em `backend/backups/db-*.sql.gz` | `backup-db.sh` (pg_dump) | 48 snapshots (12 dias) |
| 2. Upload pro Backblaze B2 (S3-compatível) | `backup-remote.js` | 30 snapshots (7.5 dias) |
| 3. Espelho no Google Drive | `backup-gdrive.sh` (rclone) | sem rotação (1TB cabe muito) |

Restaurar:

```bash
gunzip -c backend/backups/db-AAAAMMDD-HHMMSS.sql.gz | \
  docker exec -i nimbus-postgres psql -U nimbus -d nimbus
pm2 restart nimbus-backend nimbus-worker
```

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

**Stripe webhook não chega** — Stripe exige HTTPS público. Configure o webhook apontando pra `https://seu-dominio.com/api/billing/webhook` no dashboard do Stripe. Veja `pm2 logs nimbus-backend | grep webhook`.

**`pm2 startup` falhou** — rode manualmente o comando que ele imprime (vai começar com `sudo env PATH=...`).
