# Nimbus

Plataforma de automação de ofertas no WhatsApp. Faz scraping de produtos (Mercado Livre, Amazon), organiza campanhas por categoria e dispara mensagens em grupos no horário que você quiser.

## Pastas principais

- **`backend/`** — servidor Node.js (Express). Onde fica toda a lógica: login, scraping, scheduler, envio pelo WhatsApp.
- **`frontend/`** — site React que o usuário usa. Conecta no backend pela rota `/api`.
- **`tests/`** — bateria automatizada de testes (Vitest). Roda com `windows\test.bat`; tempos e o que rodar em cada caso em `tests/TIMING.md`.
- **`docs/`** — documentos do projeto (arquitetura, plano, status). Não tem código aqui.
- **`deploy/`** — scripts pra rodar tudo em VPS Ubuntu (install, start, update, setup-backups).
- **`docker-compose.yml`** — sobe Postgres + Redis em containers locais. **Obrigatório**: Postgres é o storage primário (Prisma) e Redis é usado em modo `QUEUE_BACKEND=redis`.

## Scripts — o que cada um faz

### Windows local (`windows\*.bat`)

| Script | O que faz |
|---|---|
| **`windows\start.bat`** | Sobe **tudo** local: backend (3001) + worker (Baileys+filas) + frontend (5173). Injeta envs de dev (`DATABASE_URL`, `QUEUE_BACKEND=redis`, `ADMIN_EMAILS`). |
| **`windows\stop.bat`** | Mata os processos do Node/Vite abertos pelo `windows\start.bat`. |
| **`windows\test.bat`** | Roda a bateria completa (~1550 testes — backend unit/integration/journey + frontend Vitest, ~2min). |
| **`windows\backup.bat`** | Abre o gerenciador interativo de backups (sync-manager: dump/restore/upload Backblaze). |

### VPS Ubuntu (`deploy/*.sh`)

| Script | O que faz |
|---|---|
| **`deploy/install.sh`** | **Instalação completa one-shot** numa VPS limpa: Node 22, Docker, PM2, nginx, libs do Chromium, Postgres+Redis via compose, `prisma migrate deploy`, build do frontend, nginx servindo `dist/` em :80 com proxy `/api`→:3001, UFW (22/80/443), PM2 com autostart no boot. Idempotente. |
| **`deploy/start.sh`** | Sobe tudo: Docker (Postgres+Redis), PM2 (backend+worker), nginx. Idempotente — pode rodar com tudo já no ar. |
| **`deploy/stop.sh`** | Para tudo (mantém instalado). |
| **`deploy/update.sh`** | `git pull` + reinstala deps que mudaram + roda migrations + rebuild do frontend + `pm2 reload`. |
| **`deploy/test.sh`** | 30+ checks de saúde (containers, PM2, nginx, endpoints `/healthz`, UFW). Exit 1 se algo falhar. |
| **`deploy/setup-backups.sh`** | Setup do **backup em nuvem**: registra o cron horário e guia a configuração do Backblaze B2. |

### Backup (`backend/scripts/*`)

| Script | O que faz |
|---|---|
| **`backup-all.sh`** | Orquestrador chamado pelo cron **de hora em hora**. Faz o dump local e o upload pro B2, logando em `backend/logs/backup.log`. |
| **`backup-db.sh`** | `pg_dump` do container `nimbus-postgres` → `backend/backups/db-TS.sql.gz`. Rotaciona mantendo 48 snapshots locais. |
| **`backup-remote.js`** | Sobe os `db-*.sql.gz` cifrados pro **Backblaze B2** (ou outro S3-compatível). Sem envs `BACKUP_S3_*`, sai sem fazer nada. |
| **`backup-retention.js`** | Regra de retenção remota: tudo das últimas 48h + 1 por dia até 30 dias. |
| **`restore-remote.js`** | Baixa do B2, decifra e restaura (`--latest`, `--list`, `--file`). |
| **`backup-gdrive.sh`** | ⛔ INATIVO — espelho sem cifra no Google Drive (fora do fluxo). |

## Instalação em ambiente novo (Windows)

### Pré-requisitos

- **Node.js 20+** (testado em 22.x) — https://nodejs.org
- **Docker Desktop** (pra subir Postgres + Redis) — https://www.docker.com/products/docker-desktop
- **Git** — https://git-scm.com

### Passo a passo

```bat
:: 1) Clonar
git clone <repo-url> NewNimbus
cd NewNimbus

:: 2) Subir Postgres + Redis (Docker Desktop precisa estar aberto)
docker compose up -d

:: 3) Instalar dependências
cd backend && npm install && cd ..
cd frontend && npm install && cd ..

:: 4) Configurar variáveis de ambiente do backend
copy backend\.env.example backend\.env
:: (edite backend\.env se for usar Stripe, Sentry, backup S3, etc — opcional pra dev)

:: 5) Rodar as migrations do Prisma (cria as tabelas no Postgres)
cd backend && npx prisma migrate deploy && npx prisma generate && cd ..

:: 6) Subir tudo (backend + worker + frontend)
windows\start.bat
```

Abra `http://localhost:5173`. O `windows\start.bat` já injeta `DATABASE_URL`, `QUEUE_BACKEND=redis`, `REDIS_URL` e `ADMIN_EMAILS=allangroisman@gmail.com` (edite o `.bat` pra trocar o admin).

### O que é obrigatório vs. opcional

| Componente | Obrigatório? | Pra que serve |
|---|---|---|
| Postgres (docker) | **Sim** | Storage primário via Prisma |
| Redis (docker) | **Sim** (modo padrão `QUEUE_BACKEND=redis`) | Fila BullMQ + persistência de jobs. Pra desligar, troque pra `memory` em `windows\start.bat` |
| Stripe keys no `.env` | Não | Sem elas, endpoints de billing retornam 501 (resto funciona normal) |
| Google OAuth | Não | Sem `GOOGLE_CLIENT_ID`, o botão "Entrar com Google" fica oculto. Login por email/senha continua funcionando |
| Sentry DSN | Não | Sem, erros só ficam no console |
| Backup S3 | Não | Sem, `npm run backup:remote` sai sem fazer nada |

### Login com Google (opcional)

Pra habilitar o botão "Entrar com Google" na tela de login:

1. Acesse <https://console.cloud.google.com> → crie/escolha um projeto.
2. **APIs & Services → OAuth consent screen** → tipo "External" → preencha nome do app + email de suporte.
3. **APIs & Services → Credentials → Create Credentials → OAuth client ID** → tipo "Web application".
4. **Authorized JavaScript origins**: adicione `http://localhost:5173` (dev) e a URL do seu domínio (prod).
5. Copie o **Client ID** gerado (formato `xxx.apps.googleusercontent.com`).
6. Cole o **mesmo valor** em:
   - `backend/.env` → `GOOGLE_CLIENT_ID=...`
   - `frontend/.env` → `VITE_GOOGLE_CLIENT_ID=...`
7. Reinicie backend + frontend.

Usuários novos via Google são criados automaticamente (com trial de 7 dias). Se o email já existir como conta tradicional, o Google login só faz login sem duplicar.

### Comandos do dia a dia

```bat
windows\start.bat   :: sobe tudo
windows\stop.bat    :: mata os processos
windows\test.bat    :: roda a bateria de testes (~1550 testes, ~2min)
docker compose down :: para Postgres+Redis (dados persistem nos volumes)
```

## Instalação em VPS Ubuntu (produção)

Tem um instalador one-shot pra VPS Ubuntu 22.04+ / 24.04 limpa em `deploy/install.sh`. Doc completa em [`deploy/README.md`](deploy/README.md).

### Resumo

```bash
# Na VPS (root ou usuário normal — sudo é pedido quando precisa):
git clone https://github.com/AllanGroisman/NewNimbus.git
cd NewNimbus
bash deploy/install.sh
```

O script instala e configura **tudo** (~5–10 min): Node 22 (NodeSource), Docker + compose, PM2, nginx, libs nativas do Chromium pro Puppeteer, sobe Postgres + Redis via `docker compose`, roda `prisma migrate deploy`, builda o frontend (`npm run build` → `frontend/dist/`), configura nginx servindo o `dist/` em `:80` com proxy `/api` → `:3001`, abre UFW (22/80/443), e sobe `nimbus-backend` + `nimbus-worker` no PM2 com autostart no boot. É idempotente — pode rodar de novo sem quebrar.

### Depois do install

```bash
# Editar config (Stripe live, CORS, URLs públicas)
nano backend/.env
pm2 restart nimbus-backend nimbus-worker

# HTTPS quando tiver domínio
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d seu-dominio.com
```

### Operação na VPS

```bash
bash deploy/start.sh    # sobe tudo (idempotente)
bash deploy/stop.sh     # para tudo
bash deploy/update.sh   # git pull + reinstala deps + migrations + rebuild + pm2 reload
bash deploy/test.sh     # 30+ checks (containers, PM2, nginx, endpoints, UFW)

pm2 status              # processos
pm2 logs nimbus-backend # logs do backend
pm2 logs nimbus-worker  # logs do worker (Baileys + filas)
```

## Backup em nuvem

Backup automático do Postgres **de hora em hora** em 2 destinos: pasta local → Backblaze B2 (cifrado). Uma linha de cron chama `backend/scripts/backup-all.sh`, que faz o dump e o upload. Doc completa em [`backend/scripts/README.md`](backend/scripts/README.md).

> A antiga 3ª camada (Google Drive via rclone) está **desativada** — enviava os dumps sem cifra. Ver header de `backend/scripts/backup-gdrive.sh`.

### Setup (1 comando na VPS)

```bash
bash deploy/setup-backups.sh
```

Esse script te guia pela configuração do **Backblaze B2** (criar conta → bucket → app key → colar as envs em `backend/.env`) e registra o cron horário. Idempotente — roda de novo a qualquer momento e remove agendamentos antigos.

### Camadas e retenção

| Destino | Quem cuida | Retenção | Por quê |
|---|---|---|---|
| **Local** (`backend/backups/db-*.sql.gz`) | `backup-db.sh` | 48 snapshots horários (48h) | Restauração instantânea, sem depender de rede |
| **Backblaze B2** (cifrado `.enc`) | `backup-remote.js` | Todas as últimas 48h **+ 1 por dia até 30 dias** | Storage profissional, 11-noves de durabilidade, $0 até 10GB |

### Monitoramento

O backend vigia o backup sozinho (`backend/backup/monitor.js`): a cada hora checa a idade do último dump local e do último snapshot no B2. Se o local passar de 3h ou o remoto de 6h sem backup novo, **manda alerta no grupo de WhatsApp do admin** (mesmo canal dos erros críticos). O estado aparece também em `GET /healthz` → `checks.backup`.

### Variáveis no `backend/.env`

```bash
# Backblaze B2 — obtém em https://www.backblaze.com/cloud-storage
BACKUP_S3_ENDPOINT=https://s3.us-west-002.backblazeb2.com
BACKUP_S3_REGION=us-west-002
BACKUP_S3_BUCKET=nimbus-backups
BACKUP_S3_KEY_ID=...
BACKUP_S3_SECRET=...
BACKUP_ENC_KEY=...                 # 64 chars hex — cifra os dumps antes de subir
# Opcionais (defaults mostrados):
# BACKUP_RETAIN_LOCAL=48           # dumps locais mantidos
# BACKUP_RETAIN_REMOTE_HOURS=48    # janela em que todos os snapshots ficam no B2
# BACKUP_RETAIN_REMOTE_DAYS=30     # depois, 1 por dia até N dias
# BACKUP_ALERT_LOCAL_MAX_H=3      # alerta se o dump local passar dessa idade
# BACKUP_ALERT_REMOTE_MAX_H=6     # alerta se o snapshot remoto passar dessa idade
```

### ⚠️ Ação manual do dono (obrigatória)

**Guarde uma cópia da `BACKUP_ENC_KEY` fora do servidor** (gerenciador de senhas, anotação segura). Os backups na nuvem são cifrados com essa chave — se o servidor for perdido e a chave estiver só nele, os backups do B2 ficam **irrecuperáveis**.

**Ative "Keep only the last version"** no console web do Backblaze (`nimbus-backups` → Lifecycle Settings). O bucket é versionado: sem essa regra, todo delete (da rotação, do admin ou feito na mão no site) só empilha um *hide marker* e os bytes continuam contando no cap da conta — foi assim que 70 snapshots vivos (~1 GB) viraram 9,6 GB e o upload passou a falhar com `storage cap exceeded`. O código já expurga as versões mortas a cada execução (`purge-remote-versions.js`), a regra do B2 é a rede de segurança.

Para limpar manualmente as versões mortas de uma vez:

```bash
node backend/scripts/purge-remote-versions.js --dry-run   # quanto seria liberado
node backend/scripts/purge-remote-versions.js             # apaga por VersionId
```

Opcional: considere Object Lock — protege os backups caso a app key vaze.

### Restaurar um backup

```bash
# Do B2 (baixa, decifra e restaura o mais recente)
node backend/scripts/restore-remote.js --latest

# Local
gunzip -c backend/backups/db-AAAAMMDD-HHMMSS.sql.gz \
  | docker exec -i nimbus-postgres psql -U nimbus -d nimbus
pm2 restart nimbus-backend nimbus-worker
```

### Operação

```bash
bash backend/scripts/backup-all.sh                 # roda o backup completo agora
node backend/scripts/backup-remote.js --dry-run    # prevê uploads e rotação sem executar
node backend/scripts/check-remote.js               # último snapshot no B2
tail -f backend/logs/backup.log                    # ver log do cron
crontab -l                                         # ver agendamentos ativos
```

## Por onde começar

1. Leia `CLAUDE.md` na raiz — é o "mapa" técnico do projeto.
2. Pra entender a estrutura interna do backend, leia `backend/README.md`.
3. Pra rodar tudo localmente, dê `windows\start.bat`.

## Documentação extra

Veja `docs/` pra documentos de arquitetura, plano de escala e status do projeto.

## Testes automatizados

O projeto tem **~1550 testes** divididos em três camadas. Rodam com `windows\test.bat` (backend + frontend, ~2min) ou individualmente. Catálogo por arquivo em `tests/README.md`.

**Não precisa rodar tudo a cada mudança** — `tests/TIMING.md` tem o tempo de cada arquivo e o mapa de qual suíte roda pra qual parte do código.

### Backend — unitários (`tests/unit/`)

Testam funções isoladas, sem subir servidor.

- **`affiliate-asin.test.js`** — extração de ASIN da Amazon a partir de URLs variadas (link curto, link com parâmetros, etc).
- **`affiliate-shopee.test.js`** — parsing de links da Shopee e montagem do link de afiliado.
- **`billing-limits.test.js`** — limites de cada plano (free/basic/pro/business): números, grupos, categorias por grupo, auto-scraping.
- **`product-key.test.js`** — geração da chave única de produto (hash MLB ou fallback por URL) que evita duplicar ofertas no catálogo.
- **`scraper-shopee.test.js`** — parser do HTML da Shopee, extração de preço, desconto, imagem.

### Backend — integração (`tests/integration/`)

Sobem o backend inteiro em memória (com WhatsApp e Stripe mockados) e batem nas rotas via HTTP.

- **`auth.test.js`** — cadastro, login, `/me`, troca de senha, promoção pra admin via `ADMIN_EMAILS`.
- **`state.test.js`** — race condition entre scheduler e auto-save do frontend (`OPS_FIELDS`).
- **`catalog.test.js`** — upsert no catálogo, filtros, paginação, endpoints `/api/ofertas` e `/api/admin/catalog`.
- **`affiliate.test.js`** — geração de link de afiliado pros 3 marketplaces, cache de 7 dias, expiração.
- **`scheduler.test.js`** — tick do scheduler: refill, manual add, send next, casos sem afiliado/sem janela/sem grupo.
- **`manual-ops.test.js`** — ações manuais via HTTP (refill, add, approve/reject pending, clear history) com isolamento entre usuários.
- **`admin.test.js`** — CRUD de usuários, troca de role, config do scraper, admin do catálogo, DLQ.
- **`whatsapp.test.js`** — sessões, listagem de grupos, envio direto, broadcast, convite; gating de número novo por plano (402).
- **`billing.test.js`** — trial automático, checkout, portal, webhooks do Stripe (todos os eventos relevantes), idempotência, assinatura órfã, gating por plano com bypass de admin.
- **`health-metrics.test.js`** — `/healthz` (status dos componentes) e `/metrics` (formato Prometheus, incremento de counters).
- **`redis-queue.test.js`** — fila BullMQ real (precisa de `RUN_REDIS_TESTS=1`): enqueue, retry exponencial, RPC de control, status counts, DLQ.

### Backend — jornada (`tests/journey/`)

- **`full-journey.test.js`** — simula um usuário do zero: cadastra, configura número, cria grupo, scheduler envia ofertas. Não trunca o banco entre etapas.

### Frontend (`frontend/src/__tests__/`)

Vitest + React Testing Library + jsdom.

- **`api.test.js`** — helper `http()`: injeta `Authorization`, trata 401 (limpa token + dispara evento), trata 402 (limite de plano).
- **`constants.test.js`** — helpers de `data/constants.js` (categorias, `groupUsesML`, etc).
- **`Subscription.test.jsx`** — tela de Assinatura: status do trial, botão de checkout, bypass de admin, mensagem quando Stripe desabilitado.
- **`GroupDashboard.test.jsx`** — dashboard do grupo: botão pausar/retomar visível em qualquer aba, banner quando falta afiliado ML.

### E2E (`tests/e2e/`)

Playwright + Chromium. Sobe backend (3101) e frontend (5273) dedicados contra um Postgres isolado (`nimbus_test_e2e`).

- **`auth-flow.spec.js`** — registro de novo usuário, login inválido, logout, navegação pra tela de assinatura já com trial ativo.
- **`billing-page.spec.js`** — fluxo da tela de billing visto do navegador real.

