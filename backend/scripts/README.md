# scripts/

Scripts que rodam **fora** da aplicação principal — manualmente ou via cron. Não fazem parte do `server.js` nem do `worker.js`.

## Backup (local + Backblaze B2)

```
  Postgres (Docker)
        │
        ├── 1. backup-db.sh      → backend/backups/db-YYYYMMDD-HHMMSS.sql.gz  (local, 48 snapshots horários = 48h)
        │
        └── 2. backup-remote.js  → Backblaze B2 / R2 / S3, cifrado (.enc)     (últimas 48h + 1/dia até 30 dias)
```

Uma única linha de cron roda `backup-all.sh` **de hora em hora** — ele faz o dump local e o upload. Cada camada é independente: se o upload falhar (sem credencial, sem internet), o dump local continua.

> `backup-gdrive.sh` (3ª camada antiga, Google Drive via rclone) está **DESATIVADO** — enviava os dumps sem cifra pra uma conta pessoal. Ver o header do próprio script antes de reativar.

O backend também vigia o backup (`backend/backup/monitor.js`): checa a cada hora a idade do último dump local (limite 3h) e do último snapshot no B2 (limite 6h) e **alerta o admin pelo WhatsApp** quando estoura. Estado em `GET /healthz` → `checks.backup`.

### Setup inicial (na VPS Ubuntu)

```bash
bash deploy/setup-backups.sh
```

Esse script:
1. Chmod +x nos scripts.
2. Avisa o que falta configurar (B2 no `.env`).
3. Registra o cron horário chamando `backup-all.sh` (e remove agendamentos antigos).

### Arquivos

| Script | O que faz |
|---|---|
| **`backup-all.sh`** | Orquestrador — o cron chama esse. Dump local + upload B2, resolvendo o node do nvm (o node do sistema pode ser antigo demais). Loga em `backend/logs/backup.log`. |
| **`backup-db.sh`** | `pg_dump` do container `nimbus-postgres`, salva `.sql.gz` em `backend/backups/`. Rotaciona mantendo os últimos 48 (`BACKUP_RETAIN_LOCAL`). |
| **`backup-remote.js`** | Sobe **só os dumps novos** (o que nunca foi enviado, histórico em `backend/backups/.remote-sent.json`) pro bucket S3-compatível, cifrados quando `BACKUP_ENC_KEY` existe. Sem as envs `BACKUP_S3_*`, sai exit 0. Rotação GFS + expurgo de versões **antes** do upload. `--backfill` ignora o histórico e reenvia o que faltar. |
| **`purge-remote-versions.js`** | Apaga permanentemente (por `VersionId`) versões não-atuais e hide markers do bucket versionado — sem isso, delete no B2 não libera espaço. `--dry-run` mostra quanto liberaria. |
| **`backup-retention.js`** | Regra de retenção remota (função pura, testada em `tests/unit/backup-retention.test.js`): mantém tudo das últimas 48h + o snapshot mais recente de cada dia até 30 dias. |
| **`backup-crypto.js`** | Cifra AES-256-GCM dos dumps que saem da máquina (`BACKUP_ENC_KEY`, 64 chars hex). |
| **`restore-remote.js`** | Baixa do B2, decifra e restaura (`--list`, `--latest`, `--file <nome>`). |
| **`check-remote.js`** | Imprime o snapshot mais recente no B2. |
| **`backup-gdrive.sh`** | ⛔ INATIVO — espelho sem cifra no Google Drive. |

### Comandos do dia a dia

```bash
# Rodar o backup completo agora:
bash backend/scripts/backup-all.sh

# Só dump local:
bash backend/scripts/backup-db.sh

# Só upload pro B2 (sobe só backup novo — o que você apagou na mão no B2 não volta):
node backend/scripts/backup-remote.js

# Liberar espaço: apaga de vez as versões escondidas do bucket versionado
node backend/scripts/purge-remote-versions.js --dry-run
node backend/scripts/purge-remote-versions.js

# Prever uploads e rotação sem executar nada:
node backend/scripts/backup-remote.js --dry-run

# Ver dumps locais:
ls -lh backend/backups/

# Último snapshot no B2:
node backend/scripts/check-remote.js

# Ver log do cron:
tail -f backend/logs/backup.log
```

### Restaurar um backup

```bash
# Do B2 — baixa, decifra e restaura o mais recente:
node backend/scripts/restore-remote.js --latest
# (ou --list pra escolher, --file <nome> pra um específico)

# De um dump local:
DUMP=backend/backups/db-20260728-090000.sql.gz
docker exec -i nimbus-postgres psql -U nimbus -d postgres \
  -c "DROP DATABASE nimbus; CREATE DATABASE nimbus;"
gunzip -c "$DUMP" | docker exec -i nimbus-postgres psql -U nimbus -d nimbus

# Reinicia o backend pra reabrir conexões
pm2 restart nimbus-backend nimbus-worker
```

### Variáveis de ambiente

Todas opcionais — sem elas, a camada correspondente fica desativada (defaults nos comentários).

```bash
# Backblaze B2 (ou R2 / Wasabi / MinIO / S3 puro)
BACKUP_S3_ENDPOINT=https://s3.us-west-002.backblazeb2.com
BACKUP_S3_REGION=us-west-002
BACKUP_S3_BUCKET=nimbus-backups
BACKUP_S3_KEY_ID=...
BACKUP_S3_SECRET=...
BACKUP_S3_PREFIX=nimbus/           # default

# Cifra dos dumps na nuvem — GUARDE UMA CÓPIA FORA DO SERVIDOR!
# Sem a chave, os .enc do B2 são irrecuperáveis num desastre.
BACKUP_ENC_KEY=<64 chars hex>

# Retenção
BACKUP_RETAIN_LOCAL=48             # dumps locais (1/h → 48h)
BACKUP_RETAIN_REMOTE_HOURS=48      # janela em que TODOS os snapshots ficam no B2
BACKUP_RETAIN_REMOTE_DAYS=30       # depois da janela, 1 por dia até N dias

# Alertas do monitor (backend/backup/monitor.js)
BACKUP_ALERT_LOCAL_MAX_H=3         # alerta se o dump local passar dessa idade
BACKUP_ALERT_REMOTE_MAX_H=6        # alerta se o snapshot remoto passar dessa idade
```

## WhatsApp: limpar sessões Signal duplicadas (PN×LID)

`fix-lid-sessions.js` — ferramenta pontual para o "Aguardando mensagem" que não some.

O WhatsApp trocou o endereço interno de cada aparelho do telefone (**PN**, `555596168060`) para um número opaco novo (**LID**, `4269197504618`). O Baileys 6.7.23 não sabe que os dois são a mesma conta e acaba guardando **dois ratchets Signal para o mesmo celular**, que divergem: dá `Bad MAC` do nosso lado e "Aguardando mensagem. Essa ação pode levar alguns instantes" do lado do destinatário. O patch em `backend/patches/` fecha a causa; este script limpa os pares que **já** divergiram.

```bash
cd backend
node scripts/fix-lid-sessions.js                                  # dry-run, todas as sessões
node scripts/fix-lid-sessions.js --session "<userId>::<numberId>" # só um número
node scripts/fix-lid-sessions.js --apply                          # apaga de verdade
pm2 reload nimbus-worker                                          # o worker é o dono do Baileys
```

Apagar uma linha `session` é seguro: o libsignal busca um pre-key bundle novo e refaz a sessão — custa um round-trip. O script **nunca** toca em `creds`; apagar creds é que forçaria reler o QR.

Ele só apaga o par quando tem evidência de que os dois endereços são o mesmo aparelho: ou o mapeamento aparece em 2+ devices, ou está provado pelo `creds.me` de alguma sessão. Candidato visto num device só é listado como `ambíguo` e ignorado — o número do device é por conta, então dois contatos diferentes coincidem nele o tempo todo.

Detalhes em `backend/whatsapp/README.md`, seção "O endereço LID".

## Sonda visual: por que a busca de produtos de um cupom só traz a prévia

`cupom-produtos-visual.js` fotografa, em ordem, cada página do caminho que o botão
"Sincronizar produtos" percorre — e grava tudo em **`debug-cupom/`** na raiz do
projeto (gitignorada, uma subpasta por rodada, as antigas podadas).

```
node scripts/cupom-produtos-visual.js --campaign 13471229
node scripts/cupom-produtos-visual.js --url "<containerUrl>" --paginas 3 --keep 10
```

| Arquivo | O quê |
| --- | --- |
| `00-cupom.json` | A linha do banco. Sem `containerUrl` o caminho termina aqui (cupom não ativado não tem vitrine). |
| `01-link-afiliado.json` | O link curto do ML — o passo escondido do caminho da landing. |
| `02-landing.*` | A landing de afiliado como o **parser** a vê: HTML do fetch cru, o print dela renderizada, e o JSON com as duas assinaturas comparadas e o **inventário dos quatro blocos** (só o `carousel-featured` é a vitrine). |
| `03-landing-navegador.*` | A mesma landing no Chrome logado — pra comparar com o fetch. |
| `04-vitrine-p<N>.*` | A vitrine murada (`lista.mercadolivre.com.br/_Container_…`), **forçada**. |
| `resumo.json` / `LEIA.md` | A narrativa: onde o fluxo de produção teria parado, e quanto cada caminho entregou. |

A resposta que ela documenta: a vitrine no navegador **só é tentada quando a
landing falha** (`coupons/sync.js:syncOneCoupon` e
`scraping/ml-cupons.js:scrapeCouponProducts` retornam assim que a landing
responde, com `parcial: true`). Por isso só chegam os 3–8 produtos da prévia. A
sonda força a etapa do navegador de propósito — é o único jeito de fotografar o
que existe do outro lado do muro.

Só lê: não ativa cupom, não escreve no banco, nunca grava o cookie.

## A vitrine dos cupons: a extensão do Chrome

Não há script aqui para isso, e a ausência é o ponto. A vitrine de um cupom
(`lista.mercadolivre.com.br/_Container_…`) responde CAPTCHA para navegador
automatizado — e a sonda acima provou que isso acontece **mesmo rodando fora da
VPS**. O que o Mercado Livre barra é o navegador automatizado, não a máquina (o
mesmo diagnóstico que destravou o repasse em 25/08).

Então quem colhe é uma **extensão do Chrome** (`extension/`, na raiz): você clica
em "no meu Chrome" na linha do cupom em *Admin › Cupom › Cupons do ML*, ela abre a
vitrine numa aba em segundo plano com a sua sessão, colhe, e a própria tela grava.

Instalação e detalhes: `extension/README.md`.
