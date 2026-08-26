# Tempo dos testes — o que rodar e quando

Medido em 26/08/2026, nesta máquina (4 CPUs, Postgres em Docker com `fsync=on`).
Pra remedir: `npm run test:timing`.

## Resumo

| Camada | Comando | Testes | Tempo |
|---|---|---:|---:|
| Unitários (sem banco) | `npm run test:unit` | 634 | **~14 s** |
| Integração + jornada (Postgres) | `npm run test:db` | 549 | **~54 s** |
| **Backend inteiro** | `npm test` | **1183** | **~69 s** |
| Frontend | `cd ../frontend && npm test` | 370 | ~61 s |
| E2E (Playwright) | `npm run test:e2e` | 44 | minutos — só no CI noturno |

Antes das mudanças de 26/08 o backend passava de **50 minutos** (foi cortado sem
terminar). O `README.md` prometia "~2min"; nunca foi verdade nesta máquina.

### De onde vinha o tempo

Quatro coisas, todas fora dos testes em si:

1. **`TRUNCATE` antes de cada teste — ~4,3 s cada.** `truncateAll()` recriava as
   25 tabelas e fazia fsync. Rodava num `beforeEach` de *todo* teste da suíte,
   inclusive nos unitários, que não usam banco. Sozinho, isso explicava a maior
   parte dos 50 min. Hoje a limpeza é por `DELETE` com as FK triggers desligadas
   na transação: **~1,6 ms**.
2. **bcrypt com 12 rounds — ~485 ms por senha.** Quase todo teste de integração
   cria um usuário. Sob `NODE_ENV=test` são 4 rounds (~3 ms).
3. **Pausas anti-bot rodando contra mocks.** O crawler de cupons do ML pausava
   800-1500 ms entre páginas e o scheduler esperava 4 s entre envios de
   WhatsApp. Em teste não há site nem WhatsApp do outro lado. Zeradas sob
   `NODE_ENV=test`.
4. **Tudo em série.** Hoje os unitários rodam em paralelo (não têm estado) e a
   integração também, com **um banco por worker** (`nimbus_test_1..4`, criados
   pelo `helpers/global-setup.js` a partir do molde `nimbus_test`).

## Mudei X → rodo Y

O caminho é filtro posicional do vitest, então qualquer pedaço do nome serve.

| Mexi em… | Rodo |
|---|---|
| `backend/repasse/**` | `npm run test:repasse` |
| `backend/scraping/**` (ML, Amazon, Shopee, cupons) | `npm run test:scraper` |
| `backend/scheduler.js`, campanhas, fila, envio | `npm run test:scheduler` |
| `backend/billing/**`, Stripe, planos, checkout | `npm run test:billing` |
| `backend/auth/**`, login, senha, verificação de email | `npm run test:auth` |
| `backend/whatsapp/**`, sessões, números | `npm run test:whatsapp` |
| `backend/scraping/affiliate.js`, links de afiliado | `npm run test:affiliate` |
| rotas `/api/admin/**`, travas de loja, tutoriais | `npm run test:admin` |
| `backend/catalog/**` | `vitest run -c vitest.integration.config.mjs catalog` |
| `backend/notifications/**`, e-mails | `vitest run -c vitest.integration.config.mjs emails` |
| `backend/storage/**`, `db.js`, schema Prisma | `npm run test:db` (schema mexe em tudo) |
| `backend/server.js`, middleware, error handler | `npm run test:db` |
| `frontend/src/**` | `cd ../frontend && npm test` |
| qualquer coisa, antes de commitar | `npm test` (~69 s) — cabe sempre |

Regra prática: **função pura → `npm run test:unit` (14 s)**; qualquer coisa que
toque rota, banco ou estado → `npm run test:db`.

## Rodar menos que uma área

```bash
# um arquivo
npx vitest run -c vitest.config.mjs unit/scheduler-core.test.js
npx vitest run -c vitest.integration.config.mjs integration/billing.test.js

# um teste pelo nome
npx vitest run -c vitest.integration.config.mjs integration/auth.test.js -t "login com sucesso"

# watch enquanto desenvolve (unitários)
npm run test:watch
```

## Arquivos mais lentos

Se um destes não tem nada a ver com a tua mudança, não precisa rodar.

### Integração (54 s no total, em 4 workers paralelos)

| Arquivo | Testes | Tempo |
|---|---:|---:|
| `integration/billing.test.js` | 66 | 15,6 s |
| `integration/repasse-capture.test.js` | 31 | 15,3 s |
| `integration/scheduler.test.js` | 32 | 12,0 s |
| `integration/admin.test.js` | 37 | 9,3 s |
| `integration/catalog.test.js` | 46 | 8,3 s |
| `integration/public-checkout.test.js` | 56 | 8,1 s |
| `integration/tutoriais.test.js` | 19 | 7,7 s |
| `integration/whatsapp.test.js` | 29 | 7,0 s |
| `integration/manual-ops.test.js` | 23 | 6,9 s |
| `journey/full-journey.test.js` | 11 | 6,4 s |
| os outros 18 arquivos | — | < 5,5 s cada |

### Unitários (14 s no total)

Nenhum arquivo passa de 1 s — o tempo é quase todo carregamento de módulo, não
teste. Os testes em si somam ~3 s. Não vale escolher a dedo: rode todos.

### Frontend (61 s)

| Arquivo | Testes | Tempo |
|---|---:|---:|
| `ProductSearchTab.test.jsx` | 66 | 28,0 s |
| `GroupDashboardTabs.test.jsx` | 36 | 16,2 s |
| `GroupDashboard.test.jsx` | 31 | 12,9 s |
| `AdminCupomML.test.jsx` | 15 | 8,1 s |
| `Subscription.test.jsx` | 28 | 6,6 s |
| os `.test.js` puros (api, constants, nav, opsMerge…) | — | < 100 ms cada |

O custo do frontend é montar o jsdom em cada arquivo de componente (~50 s dos
61 s). Testes de lógica pura (`.test.js`) são instantâneos.

## Suítes opt-in (não rodam no `npm test`)

| Suíte | Como rodar | Por quê é opt-in |
|---|---|---|
| `integration/redis-queue.test.js` | `RUN_REDIS_TESTS=1 npm run test:db` | Broker BullMQ real, sensível a timing |
| `unit/scraper-live.test.js` | `RUN_LIVE_SCRAPE=1 npm run test:unit` | Abre Chromium e bate no site de verdade |
| E2E | `npm run test:e2e` | Sobe backend + Vite + Chromium |

## O que o CI já cobre

`.github/workflows/tests.yml` roda backend + frontend **em todo push/PR**. O E2E
só roda no agendamento noturno ou disparado à mão pela aba Actions. Ou seja: se
esqueceu de rodar algo local, o push pega — o `npm test` local é pra ter a
resposta em 1 minuto em vez de esperar o CI.

## Remedir

```bash
npm run test:timing              # backend inteiro, tabela por arquivo
npm run test:timing -- --unit    # só unitários
npm run test:timing -- --frontend
```

## Cuidados ao mexer nos testes

- **`unit/` não pode tocar no banco.** É o que garante os 14 s. Se um teste
  precisa de Postgres, ele vai pra `integration/` — foi o que aconteceu com os
  quatro `affiliate-*.test.js`, que estavam em `unit/` mas usavam Prisma. Pra
  conferir que a regra vale, rode os unitários com um banco inexistente:
  ```bash
  NIMBUS_TEST_DATABASE_URL="postgresql://x:x@127.0.0.1:1/nada" npm run test:unit
  ```
  Tem que passar 100%.
- **A limpeza entre testes descobre as tabelas sozinha** (`helpers/pg-helpers.js`
  lê `pg_tables`). Não existe mais lista manual pra esquecer de atualizar — era
  assim antes, e a `repasse_capture_log` tinha ficado de fora, vazando linhas de
  um teste pro outro.
- **Migrations novas**: o `globalSetup` compara quantas migrations existem no
  disco com quantas o molde tem aplicadas e recria os bancos-worker quando muda.
  Se editar uma migration existente sem criar diretório novo, force com
  `NIMBUS_FORCE_MIGRATE=1`.
- **Quantos workers**: `NIMBUS_TEST_SHARDS=8 npm run test:db` (padrão 4). Precisa
  bater com o número de bancos que o `globalSetup` cria — ele usa a mesma
  variável.
