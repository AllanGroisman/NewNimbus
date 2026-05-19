# config/

Configurações **globais** do app, salvas como chave-valor. Não é configuração de cada usuário (isso é em `storage/`) — é configuração da aplicação inteira.

## O que mora aqui

- **Configuração do admin-scraper** (`key = "scraper-config"`) — categorias e lojas habilitadas, intervalo entre rodadas, limite de produtos por categoria, etc.
- **Segredo JWT** (`key = "jwt_secret"`) — gerado/lido por `auth.warmup()`. Env `JWT_SECRET` tem prioridade.

A configuração de afiliado **per-user** (ML/Amazon/Shopee) vive em `scraping/affiliate-store/` (tabela `affiliate_config`), não aqui.

## Arquivos

- **`index.js`** — re-exporta `pg.js`.
- **`pg.js`** — guarda tudo na tabela `AppConfig` (uma linha por chave, valor é JSONB).

## Por que a interface é síncrona

A interface é `get(key)` / `set(key, value)` síncrona. Isso é proposital: tem um cache em memória que é populado no boot do servidor (`warmup()`), então o `get` nunca toca o banco. `set` atualiza o cache na hora e dispara o upsert em background.

Quem chama: `scraping/affiliate.js` e `scraping/admin.js`. Como elas têm muito ponto onde precisam ler config, deixar tudo síncrono evita transformar a base em `async` à toa.
