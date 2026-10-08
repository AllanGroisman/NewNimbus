# Fresh Install — rodar o Nimbus numa máquina Linux nova

Guia para subir o sistema do zero. Há um instalador one-shot (`deploy/install.sh`)
que faz quase tudo — então o caminho de produção é bem direto.

> O repositório `NewNimbus` é **privado** e deve continuar privado. A máquina nova
> precisa de acesso ao GitHub (PAT ou chave SSH) para clonar.

---

## Pré-requisitos

- **Ubuntu 22.04 ou 24.04** (o `install.sh` usa `apt`).
- **Acesso ao repo privado** no GitHub.
- O resto — **Node 22, Docker + compose, PM2, nginx, libs nativas do Chromium** —
  o instalador instala sozinho.

> **Nenhum `.env` é versionado.** Eles guardam senha de banco, chaves do Stripe e
> do Backblaze e credenciais de e-mail — repo privado não protege, porque o
> histórico do Git acompanha qualquer clone, fork ou CI.
>
> Numa máquina nova você precisa levar **dois** arquivos, copiados do servidor
> atual (por `scp`, nunca por e-mail ou chat):
>
> | Arquivo | Para que serve |
> |---|---|
> | `backend/.env` | Configuração da aplicação (DB, SMTP, Stripe, Backblaze) |
> | `.env` (raiz) | Senhas do Postgres e do Redis, lidas pelo `docker-compose.yml` |
>
> Se não tiver de onde copiar, o `install.sh` cria os dois a partir do exemplo,
> com senhas novas geradas para o banco e a fila — aí é só preencher o resto.
> `backend/.env.ngrok` continua opcional, só para o modo ngrok.

---

## Caminho A — produção / VPS (recomendado, one-shot)

```bash
sudo apt-get update && sudo apt-get install -y git
git clone https://github.com/<você>/NewNimbus.git
cd NewNimbus
bash deploy/install.sh
```

O `deploy/install.sh` é **idempotente** e faz tudo:

1. Deps de base via apt + `build-essential`, `nginx`, `ufw`.
2. **Node.js 22 LTS** (NodeSource).
3. **Docker + plugin compose**.
4. **PM2** global.
5. **Libs nativas do Chromium** (Puppeteer) — trata o `libasound2` → `libasound2t64` do 24.04.
6. Sobe **Postgres + Redis** (`docker compose up -d`).
7. Backend: `npm install --omit=dev` + `prisma generate` + **`prisma migrate deploy`**.
   Frontend: `npm install` + **`npm run build`**.
8. **nginx na :80** servindo `frontend/dist/` com proxy `/api → :3001`; **UFW**
   (22/80/443); **PM2** sobe `backend` + `worker` com **autostart no boot**.

No fim o app está no ar na **porta 80**. O **admin** é criado no boot a partir de
`DEFAULT_ADMIN_EMAIL` / `DEFAULT_ADMIN_PASSWORD` do `.env`.

---

## Caminho B — só rodar local (dev, sem nginx/PM2)

```bash
git clone https://github.com/<você>/NewNimbus.git && cd NewNimbus
docker compose up -d                  # Postgres + Redis

cd backend
npm install
npx prisma generate
npx prisma migrate deploy             # cria o schema (banco vem VAZIO)
node server.js                        # backend na :3001

# em outro terminal — worker (filas + WhatsApp/Baileys):
cd backend && node worker.js          # (ou via pm2: pm2 start ecosystem.config.js)

# em outro terminal — frontend:
cd frontend && npm install && npm run dev   # :5173
```

Depois de instalado uma vez, dá pra usar os scripts prontos:
`bash deploy/start.sh` (sobe Docker + PM2 + nginx) e `bash deploy/stop.sh`.

---

## Depois de instalar: os dados

`prisma migrate deploy` cria **só o schema vazio**. Duas opções:

1. **Começar limpo** — `seedDefaultAdmin` cria o admin no boot a partir do `.env`;
   você reconfigura afiliados/campanhas pela interface.
2. **Restaurar dados** — pela página **Admin → Backups** (restaurar do Backblaze),
   ou via script. Requer as chaves `BACKUP_S3_*` no `.env` (já presentes). Traz
   usuários, catálogo, credenciais de afiliado, etc.

   Restore do snapshot mais recente via linha de comando (a partir de `backend/`):

   ```bash
   node -e 'require("./config/loadEnv"); const api=require("./backup/api");
   (async()=>{ const r=await api.listRemote();
     console.log("mais recente:", r.items[0].name);
     await api.restoreRemote(r.items[0].name); console.log("restaurado"); })()'
   ```

---

## Variáveis de ambiente (`backend/.env`)

Não vem no clone (gitignored) — o `install.sh` cria a partir do `.env.example`. As principais chaves:

| Chave | Para quê |
|---|---|
| `DATABASE_URL` | Postgres (precisa bater com a senha do `docker-compose.yml`, `nimbus_dev`). |
| `QUEUE_BACKEND` / `REDIS_URL` | Filas. Com `redis`, o Redis do compose é **obrigatório** (sem ele o worker não processa). |
| `DEFAULT_ADMIN_EMAIL/PASSWORD/NAME` | Admin semeado no boot. |
| `ADMIN_EMAILS` | Lista de e-mails com papel admin. |
| `SMTP_*` / `MAIL_FROM` | Envio de e-mail (verificação de conta, etc.). |
| `STRIPE_*` | Pagamentos (opcional — sem isso o checkout fica desabilitado). Sem sufixo = modo teste; com `_LIVE` = produção. Qual dos dois vale se escolhe na aba **Stripe** do painel admin. |
| `BACKUP_S3_*` / `BACKUP_RETAIN_REMOTE_HOURS` / `BACKUP_RETAIN_REMOTE_DAYS` | Backup remoto no Backblaze B2. |
| `PUBLIC_BASE_URL` | URL pública (usada em links/e-mails). |
| `ML_AFFILIATE_TAG` / `AMAZON_AFFILIATE_TAG` | Override **global** das credenciais de afiliado (opcional — normalmente ficam no banco por usuário). |
| `SHOPEE_AFFILIATE_APP_ID` / `SHOPEE_AFFILIATE_APP_SECRET` | Conta Shopee **do sistema**, usada nas buscas da API (opcional — normalmente vai em Admin › Shopee). Não substitui a conta de cada usuário, que gera os links dele. |
| `ML_SCRAPER_COOKIE` | Sessão de uma conta do Mercado Livre **do sistema**, usada só para abrir o Hub de Afiliados (opcional — normalmente vai em Admin › Mercado Livre). Não confundir com `ML_AFFILIATE_COOKIE`, que é o cookie do afiliado. |

---

## Notas / pegadinhas

- **Senha do Postgres:** o `docker-compose.yml` usa `nimbus_dev`; o `DATABASE_URL`
  do `.env` já bate. Se mudar uma, mude a outra.
- **WhatsApp (Baileys):** a sessão fica no banco (`baileys_auth`). Em máquina nova
  você re-escaneia o QR (ou restaura um backup que já tenha a sessão).
- **ngrok:** recrie o `backend/.env.ngrok` (não vem no clone) e rode
  `bash deploy/ngrok_start.sh`. Nesse modo o app **lê** backups de produção mas
  **não escreve** (protege os snapshots de produção).
- **Backups automáticos:** `bash deploy/setup-backups.sh` registra o cron de hora
  em hora (dump local + upload cifrado pro Backblaze B2).
- **Atualizar depois:** `bash deploy/update.sh` (git pull + deps + migrations +
  rebuild + `pm2 reload`).
- **Saúde do deploy:** `bash deploy/test.sh` roda 30+ checks (containers, PM2,
  nginx, `/healthz`, UFW).

---

## ⚠️ Rodar os testes com segurança

A bateria de testes roda contra o banco **`nimbus_test`** (separado do dev `nimbus`).
Há duas proteções no harness (`config/loadEnv.js` honra `NODE_ENV=test`;
`tests/helpers/pg-helpers.js` recusa truncar bancos sem "test" no nome). Ainda
assim, **nunca** aponte `DATABASE_URL` de teste para o banco de dev/prod.
