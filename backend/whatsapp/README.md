# whatsapp/

Tudo que fala com o WhatsApp via [Baileys](https://github.com/WhiskeySockets/Baileys). Sessões, QR code, envio de texto e imagem, criar/listar grupos.

## Arquivos

- **`index.js`** — fachada. Decide entre `local.js` (Baileys de verdade no processo) e `proxy.js` (espelho que conversa via fila Redis com o `worker`).
- **`local.js`** — implementação real. Mantém um mapa de sessões em memória, gera QR como data URL, escuta eventos do Baileys, reconecta automaticamente, persiste a sessão em arquivo (`backend/auth_states/`) ou no Postgres.
- **`proxy.js`** — usado pelo `server.js` quando `QUEUE_BACKEND=redis` (modo 2 processos). O `server` não tem Baileys; em vez disso, manda comandos pro `worker.js` pela fila `control` (BullMQ RPC) e lê status/QR de um cache no Redis.

## Como a fachada decide

A fachada (`index.js`) olha duas envs:

| `QUEUE_BACKEND` | `WORKER_PROCESS` | Resultado |
|---|---|---|
| `memory` | qualquer | usa `local.js` (server faz tudo) |
| `redis` | `true` (worker.js setta) | usa `local.js` (worker é dono do Baileys) |
| `redis` | não setado (server) | usa `proxy.js` (server fala com worker) |

Em modo `redis`, só **um processo** carrega o Baileys: o `worker`. O `server` só conversa com ele.

## Estado de uma sessão

Cada sessão é a chave `${userId}::${numberId}` num `Map` em memória. Status pode ser: `connecting`, `awaiting_qr`, `connected`, `disconnected`, `logged_out`.

Quando a sessão desconecta sem ser logout, o `local.js` agenda um restart automático com backoff (1.5s × tentativa, máx 30s). Em logout, ele apaga as credenciais (arquivo ou linha do PG) — usuário vai precisar escanear o QR de novo.

## Onde os arquivos da sessão ficam

- Modo `STORAGE_BACKEND=json`: `backend/auth_states/<userId>/<numberId>/`. Cada sessão é uma pasta com vários `.json` que o Baileys gerencia.
- Modo `STORAGE_BACKEND=pg`: tabela `baileys_auth` (ver `backend/auth/baileys-pg.js`).

Pra migrar de arquivo pra Postgres: `npm run migrate-auth` na pasta `backend/`.
