# auth/

Cuida do **login, registro e identidade do usuário**. Também tem a versão Postgres das sessões do Baileys (whatsapp).

## Arquivos

- **`index.js`** — fachada. Olha `STORAGE_BACKEND` e devolve a versão JSON ou Postgres.
- **`json.js`** — guarda usuários em `backend/data/users.json`. Senha vai como hash bcrypt. O segredo do JWT mora em `backend/data/.jwt_secret`.
- **`pg.js`** — mesma coisa, mas no Postgres (tabela `User`).
- **`baileys-pg.js`** — adapter pra guardar a sessão do WhatsApp no Postgres (em vez de arquivos em `backend/auth_states/`). Permite trocar de máquina sem perder sessão. Só roda quando `STORAGE_BACKEND=pg`.

## Como funciona o login

1. Frontend manda email + senha pra `/api/auth/login`.
2. `auth/json.js` (ou `pg.js`) compara o hash bcrypt da senha.
3. Se bater, gera um JWT (válido por 30 dias) e devolve pro frontend.
4. Frontend guarda o token em `localStorage["nimbus.token"]` e manda em todo request seguinte no header `Authorization: Bearer <token>`.
5. Em cada request o middleware `auth.requireAuth` decodifica o token e bota `req.user = { id, name, email, role }`.

## Admin

A função `syncRole()` é chamada no login e olha o email. Se o email tá na lista da env `ADMIN_EMAILS`, promove pra `role=admin`. **Ela só promove, nunca rebaixa** (evita você se trancar fora por acidente).

Pra virar admin localmente: defina `ADMIN_EMAILS=seuemail@gmail.com` no `start.bat` ou no `.env`.
