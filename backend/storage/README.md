# storage/

Aqui mora o **estado de cada usuário**: a lista de grupos que ele configurou, os números de WhatsApp dele, os ajustes (horários, intervalos), o histórico de envios.

## Arquivos

- **`index.js`** — re-exporta `pg.js`.
- **`pg.js`** — guarda tudo no Postgres via Prisma (tabelas `Group`, `Number`, `WhatsAppGroup`, `Setting`, `Queue`, `Pending`, `History`, etc).

## `OPS_FIELDS` (frontend)

O frontend salva o estado a cada 800ms quando o usuário mexe em algo. O scheduler também escreve no estado a cada 30s (registra envios). Como `queue/pending/history` viraram tabelas dedicadas, não há race entre os dois — `PUT /api/state` só persiste o que o frontend é dono.

Mesmo assim, o frontend mantém uma lista `OPS_FIELDS` em `App.jsx` (constante perto do topo do arquivo) pra filtrar o payload do save e ler operações via `GET /api/state/ops` a cada 3s. A mesma lista existe em `backend/storage/pg.js` (export `OPS_FIELDS`). Se você criar um campo novo controlado pelo scheduler, **adicione ele em ambos os lugares** — senão o auto-save manda um valor stale ou o ops-poll não enxerga o novo campo.
