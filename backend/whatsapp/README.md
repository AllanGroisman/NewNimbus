# whatsapp/

Tudo que fala com o WhatsApp via [Baileys](https://github.com/WhiskeySockets/Baileys). Sessões, QR code, envio de texto e imagem, criar/listar grupos.

## Arquivos

- **`index.js`** — fachada. Decide entre `local.js` (Baileys de verdade no processo) e `proxy.js` (espelho que conversa via fila Redis com o `worker`).
- **`local.js`** — implementação real. Mantém um mapa de sessões em memória, gera QR como data URL, escuta eventos do Baileys, reconecta automaticamente, persiste a sessão na tabela `baileys_auth` (Postgres) via `auth/baileys-pg.js`.
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

Quando a sessão desconecta sem ser logout, o `local.js` agenda um restart automático com backoff (1.5s × tentativa + jitter, máx 30s). Em logout real, ele apaga as credenciais (linhas do PG) — usuário vai precisar escanear o QR de novo. O snapshot `logged_out` fica mais tempo no Redis (7 dias) só pra tela seguir mostrando "Desconectado (relogar)".

### Um socket por número

`startSession` é **single-flight e idempotente**: chamadas concorrentes (rota POST, timer de backoff, re-run de job "stalled" do BullMQ, restore no boot) compartilham a mesma abertura, e uma sessão com socket vivo é devolvida como está. Antes de abrir um socket novo o anterior é encerrado e tem os listeners removidos, e cada socket carrega uma **geração** (`isCurrentGen`) que faz o handler de um socket substituído virar no-op.

Isso não é preciosismo: dois sockets no mesmo número gravam chaves Signal conflitantes na mesma linha de `baileys_auth` (`Bad MAC` no log) e o WhatsApp trata a dupla conexão como conflito — remove o device e o usuário cai de verdade.

Os timers de reconexão são rastreados e cancelados em `deleteSession`, na canonicalização e no `closeAll`. Sem isso, apagar uma sessão não impedia o timer pendente de recriá-la segundos depois com credenciais novas: a "conexão fantasma".

### 401: logout de verdade ou eco de conflito?

O WhatsApp responde 401 tanto pra logout real quanto pra conflito, e a reconexão logo após um conflito costuma voltar um 401 **seco** (sem tag). `classifyClose` só chama de logout o 401 que estiver fora de uma janela de 60s desde o último conflito (com teto de tentativas) e numa sessão já registrada.

### O status no Redis pode mentir

Se o worker morre sem passar pelo `closeAll` (OOM do `max_memory_restart`, SIGKILL, `uncaughtException`), o snapshot fica com `connected` até o TTL. Por isso `infra/session-status.js` aplica `decaySnapshot` em toda leitura: sem heartbeat de worker vivo, ou com o snapshot parado além de 180s, status vivo é rebaixado pra `disconnected` + `stale`. O `local.js` republica os snapshots a cada 60s justamente pra essa idade significar alguma coisa, e o `restoreSessions` reconcilia as chaves órfãs no boot.

### Sessões provisórias do QR

O frontend abre o QR sob um id provisório (`Date.now()`) antes de saber o telefone. Se o usuário fechar a aba, o frontend avisa o servidor (DELETE com `keepalive`), mas isso é best-effort — a garantia é uma varredura de 5 em 5 minutos no `local.js` (`isOrphanQrSession`) que descarta sessão nunca pareada esperando QR há mais de 10 min.

`scripts/kill-pending-session.js` continua existindo, mas virou ferramenta de emergência: com as travas acima não deveria mais ser rotina.

### "Aguardando mensagem" no celular do destinatário

É o placeholder do WhatsApp quando o aparelho do outro lado não decriptou um
pacote nosso. Ele manda um *retry receipt*, o Baileys recria a sessão Signal
daquele peer e reenvia — buscando a mensagem original no `getMessage`, servido
por `msg-store.js` (memória + Redis, `nimbus:wamsg:<id>`, 24h; a camada durável
existe porque um restart do worker no meio de um retry deixava o placeholder pra
sempre).

Reenvio que **não gruda** é outra coisa: significa que o estado Signal não está
sendo persistido. O `relayMessage` envolve o envio inteiro numa transação de
chaves e só commita no fim — quando a gravação falha, o texto cifrado já saiu na
rede e o ratchet fica avançado na memória e velho no banco. Por isso:
`keys.set` é uma transação só (tudo ou nada), `keys.get` é uma query só, e uma
falha de gravação **derruba o socket** (`onPersistError`) para a reconexão
reler o banco. Não é caso de apagar auth e reler QR — isso não conserta o
ratchet do outro lado.

Pelo mesmo motivo os envios de uma sessão passam por uma fila (`withSendLock`):
a fila `control` roda concurrency 4, e dois `relayMessage` no mesmo socket
compartilham o `transactionCache` do Baileys — o que fecha primeiro limpa o
cache do outro.

## Onde as credenciais ficam

Tabela `baileys_auth` no Postgres (ver `backend/auth/baileys-pg.js`). Trocar de máquina não perde sessão.
