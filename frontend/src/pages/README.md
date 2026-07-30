# pages/

Uma página por rota/seção do app. O `App.jsx` decide qual renderizar baseado na navegação.

## Páginas

- **`Login.jsx`** — tela de login/registro. Não exige token.
- **`Dashboard.jsx`** — visão geral: lista de grupos, métricas, dispara ações (refill agora, send now).
- **`Products.jsx`** — explorador do catálogo de ofertas. Lê de `/api/ofertas`.
- **`WhatsApp.jsx`** — gestão das sessões/números do WhatsApp. Conecta novo número (QR), lista grupos do número conectado.
- **`Settings.jsx`** — configurações do usuário (preferências, horários padrão, tema).
- **`AffiliateML.jsx`** — configuração da tag + cookie do Mercado Livre.
- **`AffiliateAmazon.jsx`** — configuração da tag da Amazon.
- **`AffiliateShopee.jsx`** — configuração do App ID + App Secret da Shopee (integração completa: GraphQL Open API, cache 7d, gating).
- **`Subscription.jsx`** — tela de plano/assinatura. Stripe Checkout + Portal hosted, trial 7d sem cartão, badge `past_due`. Bypass automático pra `role=admin`.
- **`AdminUsers.jsx`** — só admin: lista de usuários, promove/rebaixa role.
- **`AdminScraper.jsx`** — só admin: configura o admin-scraper (intervalo, categorias, limites) e vê status.
- **`AdminStripe.jsx`** — só admin: mostra qual modo do Stripe está valendo (teste/produção), o que cada modo tem configurado no `.env`, os produtos em uso, e troca de modo em dois cliques.
