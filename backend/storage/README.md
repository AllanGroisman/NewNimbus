# storage/

Aqui mora o **estado de cada usuário**: a lista de grupos que ele configurou, os números de WhatsApp dele, os ajustes (horários, intervalos), o histórico de envios.

Imagina o estado como uma "caixinha" por usuário. Cada usuário tem uma caixinha grande com tudo dentro.

## Arquivos

- **`index.js`** — fachada. Olha a variável `STORAGE_BACKEND` e devolve a versão JSON ou Postgres. Quem importa `require("./storage")` recebe a versão correta automaticamente.
- **`json.js`** — guarda em arquivos `.json` em `backend/data/state/<userId>.json`. Modo simples, sem banco.
- **`pg.js`** — guarda no Postgres via Prisma. Modo de produção.

## A parte chata: `OPS_FIELDS`

Tem um conflito: o **frontend** salva o estado a cada 800ms quando o usuário mexe em algo. Mas o **scheduler** também escreve no estado a cada 30s (pra registrar envios que aconteceram).

Se os dois escrevem ao mesmo tempo, um pode apagar o trabalho do outro.

Solução: na lista `OPS_FIELDS` (em `json.js`) ficam os campos que **só o scheduler escreve** (`queue`, `pending`, `history`, `sentToday`, etc). Quando o frontend manda um save, o backend ignora esses campos no que o frontend mandou e preserva o que tava no disco.

Se você criar um campo novo controlado pelo scheduler, **adicione ele em `OPS_FIELDS` nos dois lados** (`backend/storage/json.js` e `frontend/src/App.jsx`) — senão o auto-save do frontend vai apagar.

A versão `pg.js` não tem esse hack porque cada campo vira coluna/tabela própria — o banco resolve a corrida sozinho.
