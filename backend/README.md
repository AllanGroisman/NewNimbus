# backend/

Servidor Node.js do Nimbus. Recebe as chamadas do frontend, faz scraping, agenda os envios e fala com o WhatsApp.

## Arquivos na raiz desta pasta

- **`server.js`** — ponto de entrada do HTTP. Define todas as rotas `/api/*` e sobe o Express. Roda no `node server.js`.
- **`worker.js`** — processo separado que cuida do WhatsApp + consome a fila de envios. Só roda quando `QUEUE_BACKEND=redis`. No modo `memory`, o `server.js` já faz tudo.
- **`scheduler.js`** — o "cérebro" do sistema. A cada 30s, decide quais grupos têm que receber mensagem agora, popula a fila de produtos por grupo e dispara o envio.
- **`db.js`** — cria o cliente do Postgres (Prisma) uma vez só e exporta pra quem precisar.
- **`ecosystem.config.js`** — receita do PM2 (em produção, sobe `server` e `worker` juntos).
- **`package.json`** — dependências e scripts (`npm run prisma:migrate`, `npm run backup:remote`, etc).
- **`.env.example`** — exemplo de variáveis de ambiente. Copia pra `.env` e ajusta.

## Pastas — uma por área do código

| Pasta | O que tem ali |
|---|---|
| **`storage/`** | Estado de cada usuário (grupos, números, configs) no Postgres. |
| **`auth/`** | Login, registro, JWT, bcrypt. Também o adapter Postgres pras sessões do Baileys. |
| **`catalog/`** | Catálogo global de produtos (compartilhado entre todos os usuários). |
| **`config/`** | Configs globais salvas como chave-valor (tag de afiliado, config do scraper). |
| **`billing/`** | Stripe (Checkout/Portal/webhooks), assinaturas, trial automático, limites por plano. |
| **`whatsapp/`** | Tudo que fala com o WhatsApp (Baileys): sessões, envio, QR code. |
| **`scraping/`** | Puppeteer (scraper de ML, Amazon e Shopee), conversão pra link de afiliado (ML/Amazon/Shopee) e o agendador do admin-scraper. |
| **`affiliate-reports/`** | Desempenho de afiliado de cada usuário, consultado ao vivo com cache curto (`comum.js`). `ml.js`: cliques, pedidos e ganhos pela API JSON do painel do ML, com o cookie do usuário (a sonda que achou os endpoints é `scripts/ml-afiliados-desempenho-probe.js`). `shopee.js`: pedidos, vendas e comissão pelo `conversionReport` da Affiliate Open API, com o App ID do usuário, e vendas por grupo pelo sub_id `g<id do grupo>` que o scheduler põe no link (`affiliate.subIdDoGrupo`). |
| **`infra/`** | "Encanamento": logger, métricas Prometheus, Sentry, fila BullMQ, heartbeat do worker, cache de status de sessão WA. |
| **`scripts/`** | Scripts manuais (backup remoto S3). |
| **`prisma/`** | Schema do banco + migrations geradas pelo Prisma. |

## Pastas geradas em runtime (no `.gitignore`)

- **`backups/`** — snapshots de backup pra subir pro S3.
- **`logs/`** — logs do PM2 em produção.
- **`node_modules/`** — pacotes do npm.

## Façades (storage / auth / catalog / config / billing / whatsapp)

Quase todas essas pastas seguem o padrão `index.js` + `pg.js`: o `index.js` só re-exporta `pg.js`. Mantemos a indireção pra deixar fácil voltar a injetar mocks ou adapters em testes. O `scraping/affiliate-store/` segue o mesmo padrão (storage per-user das configs de afiliado).

A mesma ideia vale pro `whatsapp/`: `index.js` decide entre `local.js` (Baileys de verdade, no processo) e `proxy.js` (espelho via fila Redis, usado pelo `server` quando o `worker` é quem segura o Baileys).
