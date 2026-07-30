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
