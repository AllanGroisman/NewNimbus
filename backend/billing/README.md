# billing/

Integração com **Stripe** (Checkout + Customer Portal hosted) + lógica de plano/assinatura/trial.

## Arquivos

- **`index.js`** — re-exporta `pg.js` e expõe `limits` (de `./limits`). É o ponto único que o resto do backend importa (`require("./billing")`).
- **`pg.js`** — CRUD da `Subscription` (Prisma): `getByUserId`, `getByCustomerId`, `ensureForUser`, `update`, `startTrialFor`, `isActive`, `getStatus`, `markWebhookProcessed` (idempotência via tabela `WebhookEvent`).
- **`stripe.js`** — wrapper do SDK do Stripe. `enabled()` (true se `STRIPE_SECRET_KEY` setada), `getOrCreateCustomer`, `createCheckoutSession`, `createPortalSession`, `constructEvent` (validação HMAC do webhook), `normalizeSubscription`, `priceFor(planId)`. Em testes, é mockado por `tests/helpers/stripe-mock.js`.
- **`limits.js`** — fonte única dos limites por plano: `PLANS.{free,basic,pro,business}.limits` (`numbers`, `groups`, `categoriesPerGroup`, `autoScraping`). Helpers `getLimits(sub, role)`, `checkLimit(sub, key, value, role)`, `effectivePlanId(sub, role)` (admin sempre vira `business`).

## Fluxo

1. **Registro** → `auth.register` cria User → `billing.startTrialFor(userId)` cria `Subscription { planId:"pro", status:"trialing", currentPeriodEnd:+7d }` (sem cartão).
2. **Checkout** → `POST /api/billing/checkout { planId }` cria customer (idempotente), gera Stripe Checkout Session, devolve `url` pra UI redirecionar.
3. **Webhook** → `POST /api/billing/webhook` (com `express.raw` antes do JSON parser pra HMAC) processa `checkout.session.completed`, `customer.subscription.{created,updated,deleted}`, `invoice.payment_{succeeded,failed}`. Idempotência por `event.id` via `markWebhookProcessed`.
4. **Portal** → `POST /api/billing/portal` cria Stripe Portal Session pra trocar cartão / cancelar.
5. **Plan-gating** acontece em 3 lugares: `PUT /api/state` (limites de groups/numbers/categoriesPerGroup/autoScraping → 402), `POST /api/whatsapp/sessions/:id` (criação de sessão NOVA → 402), `scheduler.tick` (pula user sem `isActive`).

## Admin bypass

`role=admin` (via `ADMIN_EMAILS`) sempre vira `effectivePlan=business` independente da assinatura. Vide `limits.effectivePlanId` e `billing.isActive`.

## Stripe local (dev)

```bash
stripe login
stripe listen --forward-to http://localhost:3001/api/billing/webhook
# Cole o whsec_... no .env como STRIPE_WEBHOOK_SECRET
stripe trigger checkout.session.completed
stripe trigger customer.subscription.updated
```

Sem `STRIPE_SECRET_KEY` setada, os endpoints `/checkout` e `/portal` retornam **501**. O webhook retorna 501 também — útil pra rodar dev sem credencial nenhuma.
