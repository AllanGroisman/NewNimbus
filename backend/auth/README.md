# auth/

Cuida do **login, registro e identidade do usuário**. Também tem o adapter Postgres das sessões do Baileys (whatsapp).

## Arquivos

- **`index.js`** — re-exporta `pg.js`.
- **`pg.js`** — guarda usuários na tabela `User` (Postgres). Senha vai como hash bcrypt. O segredo do JWT mora na tabela `AppConfig` (key `jwt_secret`), persistido pela função `warmup()` no boot. Env `JWT_SECRET` tem prioridade.
- **`baileys-pg.js`** — adapter pra guardar a sessão do WhatsApp na tabela `baileys_auth`. Permite trocar de máquina sem perder sessão.

## Como funciona o login

1. Frontend manda email + senha pra `/api/auth/login`.
2. `auth/pg.js` compara o hash bcrypt da senha.
3. Se bater, gera um JWT (válido por 30 dias) e devolve pro frontend.
4. Frontend guarda o token em `localStorage["nimbus.token"]` e manda em todo request seguinte no header `Authorization: Bearer <token>`.
5. Em cada request o middleware `auth.requireAuth` decodifica o token e bota `req.user = { id, name, email, role }`.

## Admin

A função `syncRole()` é chamada no login e olha o email. Se o email tá na lista da env `ADMIN_EMAILS`, promove pra `role=admin`. **Ela só promove, nunca rebaixa** (evita você se trancar fora por acidente).

Pra virar admin localmente: defina `ADMIN_EMAILS=seuemail@gmail.com` no `start.bat` ou no `.env`.
