# Briefing: migrar o WhatsApp da Nimbus para o Baileys 7 (ambiente de teste)

> **Para o Claude que vai executar:** este documento é um **briefing**, não um passo
> a passo. Leia inteiro, confirme na máquina o que aqui está marcado como
> *verificar*, e então **monte o seu próprio plano** antes de mexer em qualquer
> coisa. Vários pontos abaixo são hipóteses baseadas em leitura de código-fonte do
> Baileys 7 no GitHub, não em execução — trate-os como tal.

## Contexto

A Nimbus manda promoções em grupos de WhatsApp. Hoje, várias dessas mensagens
chegam nos celulares como *"Aguardando mensagem. Essa ação pode levar alguns
instantes"* e nunca abrem — o grupo inteiro fica sem ver a promoção. A causa é uma
mudança do WhatsApp (endereços "LID") que a biblioteca que usamos, na versão
atual, não acompanha. A versão nova da biblioteca já resolve isso de fábrica. Esta
tarefa é experimentar essa versão nova **numa máquina separada**, sem tocar em
produção, e só depois decidir se ela vai pro ar.

### O que já foi feito (07-08/09/2026)

Diagnóstico completo em `backend/whatsapp/README.md`, seção *"O endereço LID"* e
*"O mesmo defeito no fanout de GRUPO"*. Em resumo: num grupo com
`addressingMode: 'lid'`, o Baileys 6.7.23 montava destinatários da chave do grupo
como `<telefone>@lid` — endereço inexistente. A chave não chegava a ninguém, e num
único dia isso gerou **3.044 pedidos de reenvio**, 3.013 deles num só grupo.

Correções já em produção (commit ainda pendente):

| O quê | Onde |
|---|---|
| Patch do Baileys estendido ao fanout de grupo + log `info` "fanout da sender key do grupo" | `backend/patches/@whiskeysockets+baileys+6.7.23.patch` |
| Limpeza de sessões Signal PN×LID divergentes (rodado, 6 linhas apagadas) | `backend/scripts/fix-lid-sessions.js` |
| Reset do `sender-key-memory` de um grupo | `backend/scripts/reset-group-sender-key.js` (novo) |
| Pool do Prisma 3 → 10 (VPS de 1 core; rajada de reenvios esgotava) | `backend/db.js` |
| Alerta ao cruzar 15 reenvios na mesma mensagem | `backend/whatsapp/msg-store.js` + `notifications/admin-notifier.js` |

**Isso é um remendo.** O Baileys 6.7.23 não tem o mapa PN↔LID; o patch adivinha o
mapeamento a partir do metadata do grupo e, quando não dá, cai para o endereço PN.
O Baileys 7 tem `LIDMappingStore` nativo — é a correção de verdade.

## Objetivo

Provar, numa máquina de teste isolada, que o Baileys 7 (`7.0.0-rc14`) resolve o
"Aguardando mensagem" em grupo, e deixar a migração pronta para ir a produção.
**Não** subir para produção nesta tarefa.

## Decisões já tomadas pelo usuário

- **Máquina:** VPS/máquina **separada** da produção. Não é o modo ngrok da VPS
  atual — aquele modo, hoje, compartilharia o banco de produção.
- **Número:** o usuário tem um **chip separado** para o teste. Nenhum número de
  cliente deve ser pareado na máquina de teste.
- **Versão:** testar o `7.0.0-rc14` mesmo sendo release candidate.

## Restrição inegociável

`baileys_auth` (Postgres) guarda as sessões do WhatsApp. **Duas máquinas com a
mesma linha de `creds` derrubam o aparelho do cliente** — está avisado em
`deploy/start.sh` e em `backend/whatsapp/README.md`. Portanto a máquina de teste
precisa de:

1. banco Postgres **próprio** (não `nimbus` de produção, nem réplica com
   `baileys_auth` populado);
2. `DATABASE_URL` próprio, `PUBLIC_BASE_URL` próprio, Redis próprio;
3. **nenhuma** linha de `baileys_auth` de produção restaurada — se restaurar dump,
   apagar `baileys_auth` antes de subir o worker;
4. `NIMBUS_MODE` que não seja `prod`, para o rótulo do aparelho sair como "Teste"
   (`backend/whatsapp/local.js`, `deviceLabel()`) e o backup remoto ficar bloqueado
   (`backend/backup/api.js`);
5. `WHATSAPP_DEVICE_LABEL` distinto, se houver mais de uma máquina de teste.

Como subir o ambiente: `deploy/start.sh` (docker compose PG+Redis → `npm install
--omit=dev` → `prisma migrate deploy` → pm2 `ecosystem.config.js` → build do
frontend → nginx). `NIMBUS_SKIP_RESTORE=1` pula o restore do Backblaze. Detalhes
em `fresh_install.md` e `deploy/README.md`.

## Inventário: onde o Baileys encosta no código

Isto foi levantado por varredura completa do repositório. É pouca coisa — a
migração é mais estreita do que parece.

### Produção — 3 arquivos, 7 símbolos

| Arquivo | Símbolos |
|---|---|
| `backend/whatsapp/local.js:41,51` | `default` (makeWASocket), `DisconnectReason`, `fetchLatestBaileysVersion`, `makeCacheableSignalKeyStore` |
| `backend/auth/baileys-pg.js:12` | `initAuthCreds`, `BufferJSON`, `proto` |
| `backend/whatsapp/msg-store.js:61` | `BufferJSON` (lazy) |

**Todos os 7 continuam exportados no 7.0.0-rc14** (conferido em `src/index.ts` e
`src/Utils/index.ts` da tag `v7.0.0-rc14`).

`backend/whatsapp/proxy.js` duplica helpers puros de propósito e **não** importa
Baileys. `backend/whatsapp/index.js` escolhe `local` vs `proxy` em runtime.

### Opções do `makeWASocket` hoje (`local.js:689-737`)

`version`, `auth` (`creds` + `makeCacheableSignalKeyStore(state.keys, log)`),
`printQRInTerminal`, `browser`, `logger`, `syncFullHistory`,
`markOnlineOnConnect`, `getMessage`, `cachedGroupMetadata`. Todas existem no
`SocketConfig` do 7 (conferido em `src/Types/Socket.ts`).

### Eventos e métodos do socket usados

Eventos: `creds.update`, `messages.upsert`, `groups.update`,
`group-participants.update`, `connection.update`.
Métodos: `ev.on`, `ev.removeAllListeners`, `end`, `logout`, `requestPairingCode`,
`user`, `authState.creds`, `sendMessage`, `groupMetadata`, `groupCreate`,
`groupSettingUpdate`, `groupInviteCode`, `groupRevokeInvite`,
`groupFetchAllParticipating`, `groupLeave`.

### Adapter de credenciais — `backend/auth/baileys-pg.js`

`useDatabaseAuthState(sessionId, { onPersistError })` devolve
`{ state: { creds, keys: { get, set } }, saveCreds }`. Guarda em `baileys_auth`
com PK `(sessionId, keyType, keyId)`, serializa com `BufferJSON` e opcionalmente
cifra com AES-256-GCM (`SESSION_ENC_KEY`, prefixo `v1:`).

**Ponto importante:** o adapter **não** implementa `transaction` — quem embrulha é
o `addTransactionCapability` do próprio Baileys. Logo a mudança de assinatura
(`transaction(exec, key)` no 7, `transaction(exec)` no 6) provavelmente **não nos
afeta**. *Verificar.*

## Mudanças conhecidas do 6.7.23 → 7.0.0-rc14

Levantadas lendo o código-fonte da tag `v7.0.0-rc14`. Confirme cada uma na
máquina.

1. **O nome do pacote NÃO muda.** `@whiskeysockets/baileys` e `baileys` publicam
   as mesmas versões, incluindo `7.0.0-rc14`. O `README.md` do repo afirma que
   muda — **está desatualizado, corrija**. Recomendação: **manter o nome com
   escopo**, porque `tests/unit/whatsapp-close.test.js:16` e
   `tests/unit/whatsapp-pairing-code.test.js:24` importam pelo caminho físico
   `backend/node_modules/@whiskeysockets/baileys` e quebrariam à toa.
2. **Não há migração de CommonJS para ESM a fazer.** O 6.7.23 já é
   `"type": "module"` e o backend já o carrega de CJS via `require(esm)`, disponível
   a partir do Node 20.19. A VPS atual está no Node 20.20.2. O 7 exige Node ≥ 20;
   **use Node 22 LTS na máquina de teste** para dar folga.
3. **Novos `keyType` no key store:** `lid-mapping`, `device-list`, `tctoken`,
   `identity-key` (`src/Types/Auth.ts`). O `LIDMappingStore` persiste via
   `keys.get('lid-mapping', ...)` / `keys.set`. Nosso adapter é genérico, então
   deve aceitar sem mudança de código — mas o comentário em
   `backend/prisma/schema.prisma:276` lista os tipos e precisa ser atualizado.
   *Verificar que nada filtra keyType por lista branca.*
4. **`initAuthCreds` ganhou `pairingEphemeralKeyPair`.** Credenciais criadas pelo
   6.x não têm esse campo. **Este é o maior risco da migração:** uma sessão já
   pareada pode não sobreviver ao upgrade. É a pergunta nº 1 do teste (ver
   Verificação).
5. **`libsignal` 2.0.1 → ^6.0.0.** O formato dos blobs `session` e `sender-key`
   pode ser incompatível. Apagar linhas `session` é seguro e já documentado
   (`backend/scripts/fix-lid-sessions.js`): o libsignal refaz a sessão do zero no
   próximo envio. **Nunca apagar `creds`** — isso força reler o QR.
6. **Nova dependência `whatsapp-rust-bridge@0.5.4`.** É **WebAssembly**, não addon
   nativo — sem `os`/`cpu` no package.json e sem etapa de compilação. Não deve
   exigir toolchain Rust. *Verificar no `npm install`.*
7. **Novas opções de socket** que valem avaliar depois que o básico funcionar:
   `enableAutoSessionRecreation`, `enableRecentMessageCache`,
   `placeholderResendCache`, e `makeSignalRepository(auth, logger, pnToLIDFunc)` —
   este último é o gancho para alimentar o mapa PN↔LID.

## O que remover na migração

- **O patch inteiro:** `backend/patches/@whiskeysockets+baileys+6.7.23.patch`. Ele
  existe só para suprir a falta do mapa PN↔LID no 6.x. Manter um patch de 6.7.23
  com o 7 instalado não aplica nada e vira ruído.
- **`tests/unit/whatsapp-lid-patch.test.js`** inteiro — ele asserta strings
  literais do fonte patchado em `node_modules`. Substitua por um teste que prove o
  comportamento (fanout de grupo LID) em vez do texto do patch.
- Avalie se `patch-package` ainda precisa ser dependência de **produção**
  (`backend/package.json`) — hoje é, só por causa desse patch.

## Sobre os testes

`cd tests && npm test` (722 passando hoje). Pontos de contato com Baileys:

- 5 testes injetam o módulo Baileys via `require.cache` com o stub
  `{ default: fakeSocket, DisconnectReason, makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion }` — `DisconnectReason` e
  `makeCacheableSignalKeyStore` vêm do Baileys **real**. Arquivos:
  `whatsapp-retry-getmessage`, `whatsapp-ghost-session`, `whatsapp-pairing-flow`,
  `whatsapp-send-mutex`, `whatsapp-device-label`.
- `tests/unit/baileys-auth-atomic.test.js` usa o `BufferJSON` real.
- `tests/helpers/wa-mock.js` mocka a **fachada** `backend/whatsapp/index.js`, não o
  Baileys — não deve precisar de mudança.
- A suíte usa banco real (`nimbus_test`, com guarda em
  `tests/helpers/pg-helpers.js` que recusa banco sem "test" no nome).

## Verificação — o que prova que deu certo

Em ordem. Não pule a 1: ela decide se a migração é viável sem repareamento geral.

1. **Sessão existente sobrevive?** Numa cópia do banco (nunca no de produção),
   suba o worker com o Baileys 7 sobre uma linha de `creds` criada pelo 6.x e veja
   se conecta sem pedir QR. Se não sobreviver, a migração passa a exigir
   repareamento de todos os números — mude o plano e avise o usuário, isso muda a
   decisão dele.
2. **Parear o chip de teste por QR** e confirmar que o aparelho aparece como
   "Teste" em Aparelhos conectados.
3. **Criar um grupo de teste** com o chip + pelo menos 2 celulares de verdade
   (quanto mais participantes, melhor: o bug é de fanout).
4. **Enviar pelo painel** e acompanhar:
   ```bash
   grep -E "fanout|sender key|retry pedido" backend/logs/worker-out.log
   ```
   - **Sucesso:** todos os participantes veem a mensagem com foto e preço, e
     **nenhum** `retry pedido` para aquele id.
   - **Falha:** volta a enxurrada de `retry pedido`.
   Note que o log `fanout da sender key do grupo` vem do nosso patch do 6.x — com
   o 7 ele some. Confirme qual sinal equivalente o 7 emite e documente-o; sem esse
   sinal, um fanout vazio volta a ser invisível, que foi o que escondeu o bug por
   dias.
5. **Verificar o mapa LID nativo:** conferir que aparecem linhas
   `keyType = 'lid-mapping'` em `baileys_auth` depois de alguns envios.
6. **`cd tests && npm test`** inteiro verde.
7. **Deixar rodando 24h** com envio agendado e comparar
   `grep -c "retry pedido" backend/logs/worker-out.log` — precisa ficar em zero ou
   dezenas, não milhares.

## Rollback

Não existe rollback de código no `deploy/update.sh` (é `git pull --ff-only`). Na
máquina de teste, o rollback é: `git checkout` do commit anterior +
`npm install` (o `postinstall` reaplica o patch do 6.x) + `pm2 reload`. Antes de
começar, anote o commit atual. Como o banco de teste é próprio e descartável, o
rollback de dados é recriar o banco.

## Entregável

Um branch com a migração, os testes verdes, o `backend/whatsapp/README.md`
atualizado (incluindo a correção sobre o nome do pacote) e um relatório curto
respondendo: a sessão do 6.x sobreviveu? o "Aguardando mensagem" sumiu no grupo de
teste? quantos reenvios em 24h? o que ainda preocupa antes de ir pra produção?
