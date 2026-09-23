# Tempo dos testes — o que rodar e quando

Medido em 23/09/2026, nesta máquina (4 CPUs, Postgres em Docker com `fsync=on`).
Pra remedir: `npm run test:timing`. Os tempos variam uns 20% com o que mais
estiver rodando na máquina (um Chrome aberto já pesa).

## Resumo

| Camada | Comando | Testes | Tempo |
|---|---|---:|---:|
| Unitários (sem banco) | `npm run test:unit` | 1014 | **~17 s** |
| Integração + jornada (Postgres) | `npm run test:db` | 872 | **~55-65 s** |
| **Backend inteiro** | `npm test` | **1886** | **~85 s** |
| Frontend | `cd ../frontend && npm test` | 619 | **~58 s** |
| E2E (Playwright) | `npm run test:e2e` | 44 | minutos — só no CI noturno |

Antes das mudanças de 26/08 o backend passava de **50 minutos** (foi cortado sem
terminar). Em 23/09, com a suíte quase dobrada, estava de novo em ~150 s
(unit 28 s + banco 120 s) e o frontend em ~105 s — ver "Segunda rodada" abaixo.

### De onde vinha o tempo

Quatro coisas, todas fora dos testes em si:

1. **`TRUNCATE` antes de cada teste — ~4,3 s cada.** `truncateAll()` recriava as
   25 tabelas e fazia fsync. Rodava num `beforeEach` de *todo* teste da suíte,
   inclusive nos unitários, que não usam banco. Sozinho, isso explicava a maior
   parte dos 50 min. Hoje a limpeza é por `DELETE` com as FK triggers desligadas,
   tudo num bloco `DO` só: **~5 ms** com as tabelas vazias, algumas dezenas de ms
   quando o teste anterior deixou linhas.
2. **bcrypt com 12 rounds — ~485 ms por senha.** Quase todo teste de integração
   cria um usuário. Sob `NODE_ENV=test` são 4 rounds (~3 ms).
3. **Pausas anti-bot rodando contra mocks.** O crawler de cupons do ML pausava
   800-1500 ms entre páginas e o scheduler esperava 4 s entre envios de
   WhatsApp. Em teste não há site nem WhatsApp do outro lado. Zeradas sob
   `NODE_ENV=test`.
4. **Tudo em série.** Hoje os unitários rodam em paralelo (não têm estado) e a
   integração também, com **um banco por worker** (`nimbus_test_1..4`, criados
   pelo `helpers/global-setup.js` a partir do molde `nimbus_test`).

### Segunda rodada (23/09): carga de módulo e jsdom

Com a suíte maior, o tempo tinha voltado pra fora dos testes:

1. **Cada arquivo recarregava o backend inteiro.** Com `isolate: true` (o padrão)
   cada arquivo de teste ganha um processo novo e reimporta `server.js`, Prisma
   etc. — ~2 s por arquivo de integração, ~0,4 s por unitário. Os testes em si
   dos unitários somavam 9 s de 28 s.
   - **Integração**: `isolate: false`. Os arquivos de um worker dividem o
     processo; o `helpers/setup-each.js` zera no começo de cada arquivo o que
     vazaria (flag do journey, cache do `app_config`). 120 s → ~60 s.
   - **Unitários**: duas passadas. A primeira (`vitest.config.mjs`) roda sem
     isolamento; a segunda (`vitest.unit-isolated.config.mjs`) roda isolados só
     os arquivos que mexem no `require.cache`, usam `vi.mock` ou fake timers —
     sem processo próprio eles quebravam os vizinhos. A lista sai de um regex
     sobre o conteúdo dos arquivos, não de lista manual. 28 s → ~17 s.
     (Workspace com os dois como projetos não serve no vitest 2.1: o `isolate`
     vale pro pool inteiro, e o pool `threads` deu segfault com sharp/Prisma.)
2. **jsdom no frontend** custava ~3 s por arquivo só pra montar. Trocado por
   `happy-dom` (a suíte passou igual) e os `.test.js` de lógica pura rodam em
   `node`, sem DOM nenhum. 105 s → ~58 s.
3. **`createTestUser()`** fazia 3 requisições HTTP por usuário; agora chama
   `auth.register()`/`auth.verifyEmail()` direto (as rotas continuam cobertas
   no `auth.test.js`).

## Mudei X → rodo Y

O caminho é filtro posicional do vitest, então qualquer pedaço do nome serve.

| Mexi em… | Rodo |
|---|---|
| `backend/repasse/**` (captura e a aba de cupons do repasse) | `npm run test:repasse` |
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
| qualquer coisa, antes de commitar | `npm test` (~85 s) — cabe sempre |

Regra prática: **função pura → `npm run test:unit` (17 s)**; qualquer coisa que
toque rota, banco ou estado → `npm run test:db`.

## Rodar menos que uma área

```bash
# um arquivo (unitário: pelo script, que sabe em qual das duas passadas ele cai)
node scripts/unit.mjs scheduler-core
npx vitest run -c vitest.integration.config.mjs integration/billing.test.js

# um teste pelo nome
npx vitest run -c vitest.integration.config.mjs integration/auth.test.js -t "login com sucesso"

# watch enquanto desenvolve (unitários — todos isolados, uma config só)
npm run test:watch
```

## Arquivos mais lentos

Se um destes não tem nada a ver com a tua mudança, não precisa rodar.

### Integração (~60 s no total, em 4 workers paralelos)

| Arquivo | Testes | Tempo |
|---|---:|---:|
| `integration/billing.test.js` | 83 | 17,1 s |
| `integration/repasse-capture.test.js` | 34 | 15,2 s |
| `integration/admin.test.js` | 46 | 13,9 s |
| `integration/tutoriais.test.js` | 19 | 12,7 s |
| `integration/coupons-rodada-local.test.js` | 58 | 11,2 s |
| `integration/whatsapp.test.js` | 41 | 10,7 s |
| `integration/coupons-produtos.test.js` | 24 | 10,2 s |
| `integration/scheduler.test.js` | 29 | 10,0 s |
| os outros 36 arquivos | — | < 8,5 s cada |

Um teste de integração típico custa ~200-300 ms: criar usuário, algumas
requisições autenticadas (~35 ms cada) e a limpeza do banco. O `billing` sozinho
é o piso de um worker — se ele crescer muito, vale dividir o arquivo.

### Unitários (~17 s no total)

Nenhum arquivo passa de 2 s; os testes em si somam ~8 s. O resto é subir o
vitest duas vezes e carregar módulos. Não vale escolher a dedo: rode todos.

### Frontend (~58 s)

| Arquivo | Testes | Tempo |
|---|---:|---:|
| `ProductSearchTab.test.jsx` | 74 | ~26 s |
| `AdminCupomML.test.jsx` | 51 | ~17 s |
| `GroupDashboardTabs.test.jsx` | 40 | ~11 s |
| `Subscription.test.jsx` | 39 | ~8,5 s |
| `GroupDashboard.test.jsx` | 31 | ~7 s |
| os `.test.js` puros (constants, nav, opsMerge…) | — | < 100 ms cada, em `node` |

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

- **`unit/` não pode tocar no banco.** É o que garante os ~17 s. Se um teste
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
- **Estado em memória do backend vaza entre arquivos de integração** (eles
  dividem o processo, `isolate: false`). Cache novo em módulo do backend que
  guarda algo lido do banco precisa ser zerado no `beforeAll` do
  `helpers/setup-each.js` — é o que já acontece com o `app_config`
  (`resetForTests()`). Sintoma típico de esquecer: um arquivo passa sozinho e
  falha na suíte inteira. Pra caçar isso, embaralhe a ordem dos arquivos:
  ```bash
  npx vitest run -c vitest.integration.config.mjs --sequence.shuffle.files --sequence.shuffle.tests=false
  ```
  (Não use o `--sequence.shuffle` puro: ele embaralha também os testes dentro do
  arquivo, e o journey e alguns outros dependem da ordem de propósito.)
- **Unitário que troca módulo no `require.cache`, usa `vi.mock` ou fake timers**
  vai sozinho pra passada isolada — o regex está na `vitest.config.mjs`. Se
  inventar outro jeito de mexer em estado global do processo, acrescente ao
  regex.
- **Frontend: limpe o `localStorage` no `beforeEach`** de componente que lembra
  coisa no navegador (aba aberta, checkbox…). Senão um teste herda o estado do
  anterior.
