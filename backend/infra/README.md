# infra/

O "encanamento" do app: coisas que não são feature, mas que tudo usa. Logs, métricas, fila, monitoramento.

## Arquivos

- **`logger.js`** — logger estruturado (pino). Em dev imprime bonito; em produção vira JSON. Cada módulo cria seu sub-logger com `logger.child({ module: "scheduler" })`.
- **`metrics.js`** — métricas no formato Prometheus. Counters (`nimbus_sends_total`, `nimbus_http_requests_total`), histograms (latência de envio, de request), gauges (sessões abertas, profundidade da fila). Expostas em `GET /metrics`.
- **`sentry.js`** — captura de erros. Se a env `SENTRY_DSN` estiver definida, manda `unhandledRejection`, `uncaughtException` e falhas finais de jobs BullMQ pro Sentry. Sem DSN, é no-op.
- **`queue.js`** — fila BullMQ (modo redis) ou execução inline (modo memory). Duas filas:
  - `nimbus.send-message` — envios agendados, com retry exponencial (5 tentativas).
  - `nimbus.control` — RPC do `server.js` falando com `worker.js` (start session, send manual, etc).
- **`session-status.js`** — cache em Redis do status de cada sessão do WhatsApp. O `worker.js` (que tem o Baileys) escreve aqui, o `server.js` (que não tem) lê daqui pra responder pro frontend.
- **`worker-heartbeat.js`** — o `worker.js` escreve um timestamp no Redis a cada 5s. O `server.js` consulta no health check — se passou mais de 30s sem heartbeat, considera o worker morto e devolve 503 em `/healthz`.

## Quando isso aqui importa

- **Em dev (modo `memory`)**: praticamente só `logger.js` e `metrics.js`. O resto vira no-op.
- **Em produção (modo `redis`)**: tudo aqui é crítico. Sem `queue.js` o scheduler não dispara, sem `session-status.js` o server não sabe o status do WhatsApp, sem `worker-heartbeat.js` o health check fica cego.
