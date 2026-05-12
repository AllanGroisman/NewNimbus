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
- **`AffiliateShopee.jsx`** — placeholder pra Shopee (não implementado no backend ainda).
- **`Subscription.jsx`** — tela de plano/assinatura (UI; pagamento real ainda não plugado).
- **`AdminUsers.jsx`** — só admin: lista de usuários, promove/rebaixa role.
- **`AdminScraper.jsx`** — só admin: configura o admin-scraper (intervalo, categorias, limites) e vê status.
