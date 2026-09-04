# billing/

Integração com **Stripe** (Checkout + Customer Portal hosted) + lógica de plano/assinatura/trial.

## Arquivos

- **`index.js`** — re-exporta `pg.js` e expõe `limits` (de `./limits`). É o ponto único que o resto do backend importa (`require("./billing")`).
- **`pg.js`** — CRUD da `Subscription` (Prisma): `getByUserId`, `getByCustomerId`, `ensureForUser`, `update`, `startTrialFor`, `isActive`, `getStatus`, `markWebhookProcessed` (idempotência via tabela `WebhookEvent`).
- **`stripe.js`** — wrapper do SDK do Stripe. `enabled()` (true se o modo ativo tem chave secreta), `mode()`/`setMode()`/`modeInfo()` (modo teste ↔ produção), `getOrCreateCustomer`, `createCheckoutSession`, `createPortalSession`, `constructEvent` (validação HMAC do webhook), `normalizeSubscription`, `priceFor(planId)`, `fetchPlanPrices()` (preço + nome do produto). Em testes, é mockado por `tests/helpers/stripe-mock.js`.
- **`prices.js`** — cache (1h, stale-while-revalidate) do catálogo vindo do Stripe, **por modo**. É o que faz o nome e o preço exibidos no site virem do dashboard do Stripe em vez do código; `limits.js` só entra como fallback.
- **`limits.js`** — fonte única dos limites por plano: `PLANS.{free,basic,pro,business}.limits` (`numbers`, `groups`, `categoriesPerGroup`). Helpers `getLimits(sub, role)`, `checkLimit(sub, key, value, role)`, `effectivePlanId(sub, role)` (admin sempre vira `business`).

## Fluxo

1. **Registro** → `auth.register` cria User → `billing.startTrialFor(userId)` cria `Subscription { planId:"pro", status:"trialing", currentPeriodEnd:+7d }` (sem cartão).
2. **Checkout** → `POST /api/billing/checkout { planId }` cria customer (idempotente), gera Stripe Checkout Session, devolve `url` pra UI redirecionar.
3. **Webhook** → `POST /api/billing/webhook` (com `express.raw` antes do JSON parser pra HMAC) processa `checkout.session.completed`, `customer.subscription.{created,updated,deleted}`, `invoice.payment_{succeeded,failed}`. Idempotência por `event.id` via `markWebhookProcessed`.
4. **Portal** → `POST /api/billing/portal` cria Stripe Portal Session pra trocar cartão / cancelar.
5. **Plan-gating** acontece em 3 lugares: `PUT /api/state` (limites de groups/numbers/categoriesPerGroup → 402), `POST /api/whatsapp/sessions/:id` (criação de sessão NOVA → 402), `scheduler.tick` (pula user sem `isActive`).

## Checkout público (landing page → Stripe → sistema)

Quem chega da landing **paga antes de ter conta**: a conta nasce do pagamento aprovado. `provision.js` é o coração disso.

Caminho: landing (popup de e-mail + CPF no `index.html`, ou `/assinar?plano=pro` na SPA) → `POST /api/public/checkout` → Stripe → volta em `/bem-vindo?session_id=…` → `POST /api/public/claim` → já entra logado e define a senha.

- **Por que pedimos e-mail e CPF antes do Stripe**: é a única chance de barrar quem já assina. O Checkout só coletaria o e-mail depois de cobrar, e aí a saída seria estorno. `provision.decideForSignup` decide entre `checkout`, `invalid_cpf`, `cpf_taken` (o CPF já é de outra conta), `blocked` (plano igual ou melhor já ativo) e `upgrade_requires_login` (quer plano melhor → o caminho certo é `/api/billing/change-plan`, que cobra só a diferença).
- **Uma conta = um CPF** (`User.cpf`, UNIQUE, só dígitos — `backend/utils/cpf.js`). É o que impede a mesma pessoa de repetir o teste de R$ 1,00 trocando de e-mail; o bloqueio vale mesmo se a conta antiga estiver cancelada. Contas anteriores à regra ficam com `cpf = NULL` e informam o documento na primeira entrada (`user.cpfRequired` → `POST /api/account/cpf`). O CPF vai como `metadata.pendingCpf` na Checkout Session e é carimbado no Customer do Stripe.
- **`provisionFromCheckout(session)` é idempotente** e disputado por dois caminhos: o webhook `checkout.session.completed` (sem `client_reference_id`) e o `/claim`. O trilho é o UNIQUE em `Subscription.checkoutSessionId`; quem chegar primeiro cria.
- **Conta criada pelo pagamento** (`auth.createPaidUser`): senha aleatória, `emailVerified=true` (o cartão naquele e-mail prova posse melhor que o link de verificação) e **bypass do beta fechado** — quem pagou não pode ficar sem acesso. A senha é escolhida em `/bem-vindo` (`POST /api/auth/set-initial-password`), e o e-mail de boas-vindas com link de definição de senha é o plano B.
- **`/claim` é de uso único** (`Subscription.claimedAt`) e expira em 2h: o `session_id` viaja na URL de retorno do Stripe, então vale como credencial temporária.

## Trial manual (cortesia do admin)

Acesso liberado à mão em **Admin › Usuários** (`POST`/`DELETE /api/admin/users/:id/manual-trial`), para beta tester, teste com conta real ou compensação de suporte. **Não é o teste de R$ 1,00**: não passa pelo Stripe, não cobra nada e não consome `trialUsedAt` — quem ganhou cortesia continua elegível ao teste de R$1.

Mora nas colunas `manualTrial*` da própria `Subscription`, então `limits.effectivePlanId` e `billing.isActive` resolvem tudo e nenhum call site de gating precisou mudar.

- **Ordem:** assinatura paga (`active`/`trialing`/carência) vence a cortesia, mesmo sendo de um plano menor. Sem ela, vale a cortesia enquanto `manualTrialEndsAt` estiver no futuro — inclusive **depois de um cancelamento**, até a data acabar (é o estado que `manualTrialInfo` chama de `dormant` enquanto a assinatura paga cobre).
- **Expiração:** é só data, então o acesso cai sozinho na virada. `reminders.expireManualTrials()` (dentro do `runOnce`, de 6 em 6h) existe só pra reconciliar o `planPaused` das campanhas que só cabiam no plano da cortesia; `manualTrialEndedAt` faz cada concessão ser varrida uma vez só.
- **Assinar durante a cortesia é uma escolha do cliente**, num modal da página de Assinatura (`POST /api/billing/checkout` aceita `keepManualTrial`, default `true`):
  - **Manter a cortesia** — `subscription_data.trial_end` = fim da cortesia, com `payment_method_collection: "always"`: o cartão entra hoje e a primeira fatura roda na virada. **Enquanto não cobra, vale o plano da CORTESIA**, e o contratado assume no mesmo instante da primeira cobrança (`trialing` → `active`). É o degrau do meio de `effectivePlanId`, e é o que faz upgrade e downgrade terem uma resposta só — ninguém perde plano no meio de um prazo prometido, nem paga por dias que já tem.
  - **Começar agora** (`keepManualTrial: false`) — sem `trial_end`: cobra hoje, o plano contratado vale na hora, e a Checkout Session leva `metadata.manualTrialCancel="1"`. **Quem encerra a cortesia é o webhook**, não o clique: encerrar antes faria um checkout abandonado custar os dias dela. Essa cortesia é consumida e não reassume depois.
  O Stripe exige `trial_end` ao menos 48h à frente, então cortesia terminando antes disso cobra normal (`deferralFor` em `server.js`). `metadata.manualTrialDefer="1"` é como o webhook sabe **não** queimar o teste de R$1 — que, pelo mesmo motivo, não é oferecido enquanto a cortesia corre.
- **`limits.paidPlanId`** é o "já é cliente?" sem a cortesia. O checkout público usa ele, e não `effectivePlanId`: senão a landing bloquearia a compra de quem está em cortesia dizendo que "já assina".
- **Revogar** não apaga nada: puxa `manualTrialEndsAt` pro instante atual e carimba `manualTrialEndedAt`. Plano e observação ficam de histórico na ficha do usuário.

## Admin bypass

`role=admin` (via `ADMIN_EMAILS`) sempre vira `effectivePlan=business` independente da assinatura. Vide `limits.effectivePlanId` e `billing.isActive`.

## Modo teste ↔ produção

As credenciais dos dois modos ficam no `.env` (`STRIPE_SECRET_KEY_TEST`/`_LIVE`, `STRIPE_WEBHOOK_SECRET_TEST`/`_LIVE`, `STRIPE_PRICE_*_TEST`/`_LIVE`). As variáveis **sem sufixo** são o formato antigo e valem pro modo da própria chave (`sk_live_…` = live, qualquer outra = test) — de propósito: se valessem pro `STRIPE_MODE_DEFAULT`, setar `live` sem preencher as `_LIVE` faria o sistema rodar "em produção" com chave de teste. Qual está valendo é escolhido na aba **Stripe** do painel admin (`GET`/`PUT /api/admin/stripe`), que grava `stripe-mode` em `app_config` — o worker acompanha pelo auto-refresh, sem restart.

Consequências:

- Cadastre um endpoint de webhook nos **dois** modos do dashboard apontando pra mesma URL. `constructEvent` tenta os dois segredos, então evento de qualquer modo é aceito.
- Cada `Subscription` guarda em `stripeMode` o modo em que nasceu (vem do `livemode` do objeto Stripe). `getByUserId` **mascara** a linha quando o modo não bate: o usuário aparece como sem plano ativo enquanto o sistema está no outro modo, e volta ao normal ao retornar. Nada é apagado. `getByCustomerId`/`getBySubscriptionId` devolvem a linha crua — o webhook precisa gravar eventos de qualquer modo.
- Existe **uma linha por usuário**: assinar no modo teste com uma conta que tem assinatura de produção sobrescreve a linha (o plano de produção volta no próximo webhook ou `POST /api/billing/sync` feito no modo live). Não use contas reais para testes.

## Stripe local (dev)

```bash
stripe login
stripe listen --forward-to http://localhost:3001/api/billing/webhook
# Cole o whsec_... no .env como STRIPE_WEBHOOK_SECRET
stripe trigger checkout.session.completed
stripe trigger customer.subscription.updated
```

Sem `STRIPE_SECRET_KEY` setada, os endpoints `/checkout` e `/portal` retornam **501**. O webhook retorna 501 também — útil pra rodar dev sem credencial nenhuma.
