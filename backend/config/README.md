# config/

Configurações **globais** do app, salvas como chave-valor. Não é configuração de cada usuário (isso é em `storage/`) — é configuração da aplicação inteira.

## O que mora aqui

- **Configuração do afiliado** (`key = "affiliate"`) — tag e cookie do Mercado Livre, tag da Amazon. Cookie do ML expira de tempos em tempos e precisa ser renovado.
- **Configuração do admin-scraper** (`key = "scraper-config"`) — categorias e lojas habilitadas, intervalo entre rodadas, limite de produtos por categoria, etc.

## Arquivos

- **`index.js`** — fachada. Devolve a versão JSON ou Postgres.
- **`json.js`** — guarda em arquivos separados em `backend/data/` (`affiliate.json`, `scraper-config.json`).
- **`pg.js`** — guarda tudo na tabela `AppConfig` (uma linha por chave, valor é JSONB).

## Por que a interface é síncrona

A interface é `get(key)` / `set(key, value)` síncrona, mesmo na versão Postgres. Isso é proposital: tem um cache em memória que é populado no boot do servidor (`warmup()`), então o `get` nunca toca o banco.

Quem chama: `scraping/affiliate.js` e `scraping/admin.js`. Como elas têm muito ponto onde precisam ler config, deixar tudo síncrono evita transformar a base em `async` à toa.
