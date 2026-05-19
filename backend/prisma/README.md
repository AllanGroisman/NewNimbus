# prisma/

Schema do banco de dados e migrations geradas pelo Prisma.

## Arquivos e pastas

- **`schema.prisma`** — descreve todas as tabelas (User, CatalogProduct, GroupState, BaileysAuth, AppConfig, etc) e a conexão com o banco. É a "fonte da verdade" do schema.
- **`migrations/`** — pasta gerada pelo Prisma. Cada subpasta é uma migration (com SQL puro). Não edite manualmente — gere com `npx prisma migrate dev`.

## Comandos comuns (rodar dentro de `backend/`)

```bash
# Cria uma migration nova depois de editar o schema.prisma (dev local)
npx prisma migrate dev --name <nome-descritivo>

# Aplica todas as migrations pendentes (produção, CI)
npx prisma migrate deploy

# Gera o cliente TypeScript/JS depois de mexer no schema
npx prisma generate

# Abre uma UI web pra inspecionar o banco
npx prisma studio
```

## Conexão

A conexão é configurada pela env `DATABASE_URL` (ver `.env.example` ou `start.bat`). Em dev, o `docker compose up -d` sobe um Postgres em `localhost:5432` com a string já no formato esperado.
