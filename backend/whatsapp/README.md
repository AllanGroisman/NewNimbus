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

Sessão esperando **código de pareamento** também fica em `awaiting_qr`, de propósito: os dois modos rodam no mesmo socket, então não há status novo — `LIVE_STATUSES` do `infra/session-status.js` e as telas de admin ficam intactas.

Quando a sessão desconecta sem ser logout, o `local.js` agenda um restart automático com backoff (1.5s × tentativa + jitter, máx 30s). Em logout real, ele apaga as credenciais (linhas do PG) — usuário vai precisar escanear o QR de novo. O snapshot `logged_out` fica mais tempo no Redis (7 dias) só pra tela seguir mostrando "Desconectado (relogar)".

### Um socket por número

`startSession` é **single-flight e idempotente**: chamadas concorrentes (rota POST, timer de backoff, re-run de job "stalled" do BullMQ, restore no boot) compartilham a mesma abertura, e uma sessão com socket vivo é devolvida como está. Antes de abrir um socket novo o anterior é encerrado e tem os listeners removidos, e cada socket carrega uma **geração** (`isCurrentGen`) que faz o handler de um socket substituído virar no-op.

Isso não é preciosismo: dois sockets no mesmo número gravam chaves Signal conflitantes na mesma linha de `baileys_auth` (`Bad MAC` no log) e o WhatsApp trata a dupla conexão como conflito — remove o device e o usuário cai de verdade.

Os timers de reconexão são rastreados e cancelados em `deleteSession`, na canonicalização e no `closeAll`. Sem isso, apagar uma sessão não impedia o timer pendente de recriá-la segundos depois com credenciais novas: a "conexão fantasma".

### 401: logout de verdade ou eco de conflito?

O WhatsApp responde 401 tanto pra logout real quanto pra conflito, e a reconexão logo após um conflito costuma voltar um 401 **seco** (sem tag). `classifyClose` só chama de logout o 401 que estiver fora de uma janela de 60s desde o último conflito (com teto de tentativas) e numa sessão já registrada — "já registrada" agora quer dizer `isPairedCreds`, não um `creds.me` cru (ver a seção do código de pareamento).

### O status no Redis pode mentir

Se o worker morre sem passar pelo `closeAll` (OOM do `max_memory_restart`, SIGKILL, `uncaughtException`), o snapshot fica com `connected` até o TTL. Por isso `infra/session-status.js` aplica `decaySnapshot` em toda leitura: sem heartbeat de worker vivo, ou com o snapshot parado além de 180s, status vivo é rebaixado pra `disconnected` + `stale`. O `local.js` republica os snapshots a cada 60s justamente pra essa idade significar alguma coisa, e o `restoreSessions` reconcilia as chaves órfãs no boot.

### Sessões provisórias do QR

O frontend abre o QR sob um id provisório (`Date.now()`) antes de saber o telefone. Se o usuário fechar a aba, o frontend avisa o servidor (DELETE com `keepalive`), mas isso é best-effort — a garantia é uma varredura de 5 em 5 minutos no `local.js` (`isOrphanQrSession`) que descarta sessão nunca pareada esperando QR há mais de 10 min.

A varredura também cobre tentativa de **código de pareamento** abandonada — e só cobre por causa do `isPairedCreds`: um pedido de código grava `creds.me` antes de parear, e o teste antigo (`creds.me` existe → não é órfã) deixaria essa sessão viva pra sempre.

`scripts/kill-pending-session.js` continua existindo, mas virou ferramenta de emergência: com as travas acima não deveria mais ser rotina.

### Código de pareamento (8 dígitos)

Alternativa ao QR: o usuário digita o telefone no site, recebe 8 caracteres e os
digita no celular (Dispositivos vinculados › Vincular dispositivo › **Vincular com
número de telefone**). Pedir um código **reabre o socket** (ver o item 0), mas o QR
segue valendo no socket novo: o Baileys aceita o scan com um código pendente.

Sete coisas não são óbvias:

**0. O `browser` tem que ser plausível — é a causa mais provável de "código
inválido".** A tupla é `[SO, navegador, versão]`, e nós usamos a posição 0 pro
rótulo do aparelho (`deviceLabel()`, "Nimbus"/"Teste") porque é o que o celular
mostra em Aparelhos conectados. O README do Baileys autoriza isso **só pro QR**
("You can customize browser name if you connect with QR-CODE"), e a doc é
categórica sobre o outro caminho: *"When logging in using pairing code, you should
only set a valid/logical browser config, otherwise the pair will fail."* Com
`["Nimbus", "Chrome", "1.0"]` o código sai normalmente e **nenhum telefone
funciona** — a falha é silenciosa, porque o IQ é fire-and-forget.

Por isso o socket de pareamento usa `PAIRING_BROWSER` (`["Ubuntu", "Chrome",
"22.04.4"]`, o default do próprio Baileys, que é o que o exemplo de pairing code
da doc usa ao não passar `browser`). Como `browser` é opção de **construção**,
isso implica: pedir código reabre o socket se o atual foi aberto pro QR
(`startSession` recusa reaproveitar socket do modo errado), e `session.pairingMode`
é herdado nas reaberturas por backoff — senão o primeiro reconnect voltaria pro
rótulo e derrubaria o pareamento em andamento. Ao conectar, o flag é limpo ("Once
you are fully paired, you can switch the browser config back to normal").

Custo aceito: número pareado por código aparece no celular como Ubuntu, **sem** o
rótulo Nimbus/Teste que separa a máquina de teste da produção no mesmo aparelho.
Quem precisa dessa separação pareia por QR.

**1. `requestPairingCode` envenena as credenciais.** Ele grava `creds.me` (montado
a partir do telefone digitado) e `creds.pairingCode` **antes** de qualquer
pareamento, e emite `creds.update` — que o nosso handler persiste no Postgres. O
veneno sobrevive a restart do worker e ao `restoreSessions`. Por isso `creds.me`
deixou de ser prova de pareamento e existe o `isPairedCreds`: sem ele, uma
tentativa abandonada passa por "sessão boa", desliga os dois caminhos de limpeza
(401 de handshake e 408 de QR esgotado) e reconecta pra sempre — a cada boot.

Reconhecer o veneno não bastava: **o socket de pareamento começa apagando a auth**
quando ela tem `creds.me` e o `isPairedCreds` diz que não é pareamento de verdade.
O motivo é o `validateConnection` do Baileys, que decide o handshake por um teste
só — `if (!creds.me)` manda registro, senão manda **login**. Com o `me` fantasma de
uma tentativa anterior ele manda login com credencial que não existe: 401 na hora,
nenhum QR, nenhum pair-device. Era isso que fazia a segunda tentativa em diante
falhar sempre (`close … code=401 … Connection Failure` em fila no log), com a
limpeza do close correndo atrás por ser assíncrona e sem `await`. Só apagamos o que
o `isPairedCreds` já reprova, e sem `logout()`: não há device pra desvincular.

**2. `creds.account` é o marcador durável dos dois fluxos.** `creds.registered`
sozinho continua proibido (é o parágrafo ATENÇÃO do `classifyClose`: ele é sempre
false em quem pareou por QR). Quem pareou de verdade tem `creds.account`, o
`ADVSignedDeviceIdentity` que o `configureSuccessfulPairing` grava no handler
`CB:iq,,pair-success` — o mesmo para QR e para código. É isso que faz "pedi o
código, desisti, escaneei o QR" não apagar auth boa. Para toda sessão que existe
hoje (sem `pairingCode`), `isPairedCreds` é idêntico a `!!creds.me?.id`.

**3. O relógio do código é a lista de refs do QR.** `requestPairingCode` **não**
cancela o `qrTimer`: as refs continuam girando por baixo e, ao esgotarem, o
Baileys mata o socket (~2 min) — e o código morre com ele. Daí `PAIRING_CODE_TTL_MS`
(110s) ser deliberadamente menor: a tela oferece "gerar novo código" antes de o
backend derrubar a sessão. Aumentar `qrTimeout` resolveria, mas é opção de
construção do socket — forçaria um socket dedicado e mataria a propriedade de um
socket servir os dois modos. E como esse relógio começa na **abertura do socket** e
não na emissão do código, o `expiresAt` da tela é o menor entre os dois prazos
(`PAIRING_SOCKET_LIFE_MS` a partir do `socketOpenedAt`) — contar só da emissão
prometia tempo que o socket não tinha.

**4. O código sai só na resposta do RPC, nunca no snapshot do Redis.** Ele só é
resgatável contra o socket exato que o emitiu, enquanto o snapshot vive 24h — um
código que sobrevive ao socket é pior que nenhum (o WhatsApp diz "inválido" e a
culpa parece nossa). Pelo mesmo motivo, erro esperado volta como **valor**
(`{ ok: false, reason }`) e não como exceção: o RPC do BullMQ só carrega a
`message` de um `Error`, então `err.code` não atravessaria server↔worker.

**5. O telefone é o que a conta usa, e aceitamos 8 ou 9 dígitos.** A rota valida com
`toWhatsappPhone` (55 + DDD + **8 ou 9** dígitos), não com o `toStoredPhone` que o
cadastro usa. Aquele exige o nono dígito, e há contas antigas de 8 ativas —
`555596168060` é uma delas. Cuidado com a leitura desse JID: no Brasil o WhatsApp
guarda o endereço de contas antigas **sem o nono dígito** mesmo quando o telefone
real o tem — o JID é endereçamento, não o número que se digita. Como não dá pra
saber qual forma a conta usa (o IQ não valida nada), aceitamos as duas e a tela
mostra, embaixo do código, qual número ele endereça. Mesma regra do
`looksLikePhoneUser` de `scripts/fix-lid-sessions.js`.

**6. O sinal de "pode pedir o código" é o QR DESTA geração.** O IQ do
`link_code_companion_reg` só tem pra onde ir depois do handshake noise, e
`ws.isOpen` é anterior a isso. O sinal que serve é o primeiro evento `qr` — mas o
objeto `session` sobrevive à troca de socket, então `session.qr` sozinho pode ser o
QR da conexão ANTERIOR. E é o caso normal: a tela abre em modo QR e reabre o socket
ao pedir o código (item 0). Aceitar aquele QR fazia o `requestPairingCode` sair com
o WebSocket novo ainda nem aberto → `Error: Connection Closed` do `sendRawMessage`,
500 na rota, "não foi possível gerar o código" na tela. Daí o `session.qrGen`, e daí
o `_openSocket` zerar `qr`/`qrDataUrl` ao reabrir — o handler de `close`, que era o
único lugar que fazia isso, **não roda** nessa troca, porque os listeners saem antes
do `end()`.

**7. Regerar código não apaga sessão.** Com o item 1 no lugar, o backend já garante
credencial limpa a cada pedido. A tela chegou a fazer `DELETE` antes de pedir de
novo: isso abria uma janela de 404 no polling e, numa sessão que tivesse acabado de
parear, o `deleteSession` chama `sock.logout()` — desvincularia o aparelho recém
conectado.

Aviso que a UI dá e o backend não pode dar: o IQ de pareamento é `sendNode`,
fire-and-forget. Telefone errado gera um código perfeitamente válido que
simplesmente nunca funciona — não há resposta do servidor pra validar contra. Por
isso a tela mostra, embaixo do código, o número que ele endereça.

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

### O endereço LID — a causa que faltava

O WhatsApp migrou o endereço interno de cada aparelho do telefone (**PN**,
`555596168060@s.whatsapp.net`) para um número opaco novo (**LID**,
`4269197504618@lid`). O Baileys 6.7.23 não tem o mapa PN↔LID: ele compara a
identidade própria só contra `creds.me.id`, que é sempre PN. Quando o destino ou
o participante do retry vem em LID:

- o celular **do próprio usuário** é classificado como "outra pessoa" e recebe a
  cópia sem o envelope `deviceSentMessage` — é exatamente por isso que o
  auto-DM do teste de conexão ficava em "Aguardando mensagem" para sempre;
- o fanout empurra o user PN num destino LID, montando `<telefone>@lid`, um
  endereço que não existe;
- o stanza de reenvio sai sem o atributo `recipient`;
- a usync devolve o próprio device do socket como destinatário.

E, como consequência, o banco acumula **duas sessões Signal para o mesmo
aparelho** (`555596168060.47` e `4269197504618.47` lado a lado em
`baileys_auth`): dois ratchets independentes que divergem — `Bad MAC` aqui,
placeholder lá.

Correção em duas partes:

1. **`patches/@whiskeysockets+baileys+6.7.23.patch`** — ensina o Baileys que
   `creds.me.lid` e `creds.me.id` são a mesma conta. Aplicado pelo `postinstall`
   (`patch-package`, que por isso é dependência de **produção**: o deploy roda
   `npm install --omit=dev`). `tests/unit/whatsapp-lid-patch.test.js` falha se o
   patch sumir do `node_modules` — sem esse alarme, um deploy desfaria a
   correção em silêncio.
2. **`scripts/fix-lid-sessions.js`** — apaga os pares PN×LID que já divergiram,
   para o libsignal refazer a sessão do zero (o patch impede novos casos, não
   desfaz os antigos). Dry-run por padrão; só apaga com `--apply`. Nunca toca em
   `creds` — apagar creds é que forçaria reler o QR.

A correção definitiva é o `baileys` 7.x, que tem `LIDMappingStore` nativo. Está
em release candidate (7.0.0-rc14), muda o nome do pacote e exige adaptar o
auth-state — fica para quando sair a versão estável.

## Onde as credenciais ficam

Tabela `baileys_auth` no Postgres (ver `backend/auth/baileys-pg.js`). Trocar de máquina não perde sessão.
