# Relatório: migração para o Baileys 7.0.0-rc14 (ambiente de teste)

Branch `baileys-7`, commit `5ec294c`, a partir de `58d3db7`.
Executado em 08/09/2026 no notebook (`NIMBUS_MODE=ngrok`, Postgres/Redis locais,
banco próprio). Nenhuma credencial de produção foi copiada ou tocada.
Ver `plano_sete.md` (briefing) e `backend/whatsapp/README.md` (diagnóstico).

## As quatro perguntas

### A sessão do 6.x sobreviveu?

**Sim, sem repareamento.** O chip foi pareado por QR ainda no 6.7.23, criando uma
linha de `creds` genuína do 6.x (dump congelado em
`~/nimbus-rollback/baileys_auth_6x_2026-09-08.sql`). O worker subiu no 7 sobre
essa mesma linha, restaurou a sessão e conectou **sem pedir QR**. Nenhum
`logged_out`, nenhum `conflict`.

No primeiro connect o mapa nativo já apareceu:

```
"myPN":"555596168060:69@s.whatsapp.net","myLID":"4269197504618:69@lid",
"msg":"Own LID session created successfully"
```

E o `baileys_auth` ganhou tipos que não existiam no 6.x — `lid-mapping` (2 linhas:
o par direto e o `_reverse`) e `device-list` (4). O adapter
`backend/auth/baileys-pg.js` aceitou sem uma linha de código nova, porque trata
`keyType` como string opaca.

**Consequência para produção: a migração não exige janela de repareamento.**

### O "Aguardando mensagem" sumiu no grupo de teste?

**Sim.** Grupo `Teste1` (`120363425437718920@g.us`), 3 participantes reais, em
`addressingMode: 'lid'`. No 7:

```
senderKeyJids: ["90735630110854@lid","90735630110854:17@lid","90735630110854:23@lid",
                "90735630110854:27@lid","82214951903310@lid","82214951903310:17@lid",
                "82214951903310:18@lid","82214951903310:19@lid","4269197504618@lid",
                "4269197504618:31@lid","4269197504618:47@lid","4269197504618:69@lid"]
msg: "sending new sender key"  →  "sending message to 12 devices"
```

Doze destinos, todos com o **LID real** do participante. **Zero ocorrências de
`<telefone>@lid`** no log — o endereço inexistente que fazia a chave não chegar a
ninguém. Confirmado nos celulares: as mensagens chegam.

Controle: o mesmo grupo, no 6.7.23, produziu `Bad MAC`, `failed to decrypt
message` e retry receipts. No 7, `Bad MAC` = 0.

### Quantos reenvios?

Na janela de teste: **7 `recv retry request`, 3 contabilizados, 0 `Bad MAC`** —
dezenas, não milhares. E todos foram *atendidos*: `found message in retry cache`
→ reenvio para 1 device. Isso é o mecanismo funcionando, não o bug.

Comparação com o incidente: 3.044 pedidos num dia, 3.013 num só grupo.

**O soak de 24h ainda não foi feito** — é o que falta para fechar este número.

### O que ainda preocupa antes de ir pra produção

1. **`7.0.0-rc14` é release candidate.** Um `rc15` pode mudar comportamento. A
   versão está fixada sem range, então nada se move sozinho.
2. **`sender-key-memory` é promessa, não fato.** No 7, `sending message to 0
   devices` é normal e correto para grupos que já receberam a chave — só os
   devices sem ela entram na conta (`messages-send.js:554`). Mas se sob o 6.x a
   distribuição falhou e o mapa ficou dizendo "já mandei", o 7 não redistribui
   sozinho. Aqui a redistribuição aconteceu porque o mapa do 6.x estava chaveado
   por JIDs que o 7 não usa mais — **não confie que isso valha para todo grupo.**
   Depois de subir, conferir grupo a grupo e usar
   `backend/scripts/reset-group-sender-key.js` nos que continuarem mudos.
3. **A amostra é pequena.** Um número, um grupo, três participantes, um modo de
   endereçamento. Produção tem muito mais. Em especial: **não foi testado um grupo
   PN** (antigo). O 7 assume `addressingMode: 'lid'` como default quando o
   metadata não traz o campo, e nosso `cachedGroupMetadata` serve metadata com
   TTL — metadata velho pode fazer um grupo PN ser tratado como LID.
4. **Blobs do libsignal.** A troca 2.0.1 → 6.0.0 não gerou `Bad MAC` aqui, mas
   esta sessão tinha poucos peers. Se aparecer em massa na produção:
   `backend/scripts/fix-lid-sessions.js` (dry-run, depois `--apply`). **Nunca
   apagar `creds`.**
5. **Rollback.** O lock do 6.x resolve o `libsignal` por `git+ssh://` e o notebook
   **não tem chave SSH no GitHub** — um `npm install` de rollback falharia. Há um
   tarball em `~/nimbus-rollback/node_modules_baileys6_libsignal_2026-09-08.tgz`
   que torna o rollback uma extração. **Verificar se a VPS de produção tem chave
   SSH antes de subir**, ou preparar o mesmo tarball lá.
6. **VPS de 1 core.** O 7 grava mais tipos de chave (`lid-mapping`, `device-list`,
   `tctoken`). O pool do Prisma já está em 10 (`backend/db.js`), mas vale vigiar
   `[baileys-auth] falha ao gravar` durante o soak.

## Ganhos colaterais

- O `libsignal` passou a vir do npm (6.0.0) em vez de `git+ssh://` — **o deploy
  não depende mais de chave SSH** para instalar do zero.
- `npm audit --omit=dev`: de **13 vulnerabilidades (1 crítica, 11 high)** para
  **10 (0 críticas, 9 high)**. As que sumiram eram do `protobufjs` aninhado sob o
  `libsignal` antigo.
- O patch caseiro saiu (`backend/patches/` está vazio), e com ele o risco de um
  `npm install` sem `postinstall` desfazer a correção em silêncio.

## Duas crenças do briefing que são falsas

- **"o pacote muda de nome no 7"** — não muda. `@whiskeysockets/baileys` publica o
  `7.0.0-rc14`. Ficamos no nome com escopo porque dois testes importam pelo
  caminho físico em `node_modules`.
- **"o 7 acrescentou `pairingEphemeralKeyPair`; sessão antiga pode não sobreviver
  — este é o maior risco da migração"** — o campo existe desde pelo menos o
  **6.5.0**. Nenhuma credencial em uso está sem ele. Cheguei a escrever um backfill
  defensivo; ele nunca disparou, e foi removido por ser código morto.

O `plano_sete.md` foi mantido como registro histórico; as correções vivem no
`backend/whatsapp/README.md`, seção *"O mapa PN↔LID nativo (Baileys 7)"*.

## Testes

`cd tests && npm test`: **901 unit + 722 db, zero falhas.**

Os 5 arquivos que injetam o Baileys por `require.cache` passaram **sem edição** —
`DisconnectReason` e `makeCacheableSignalKeyStore` mantiveram a forma.

- Saiu `tests/unit/whatsapp-lid-patch.test.js`: assertava strings literais do
  fonte patchado em `node_modules`, com a versão `6.7.23` no caminho.
- Entrou `tests/unit/whatsapp-lid-mapping.test.js`: prova comportamento, não
  texto. Monta a pilha real (LIDMappingStore → `addTransactionCapability` →
  `makeCacheableSignalKeyStore` → nosso auth-state → AES/BufferJSON → banco falso)
  e assere a conta que o 6.7.23 errava: `555596168060:47@s.whatsapp.net` tem que
  virar `4269197504618:47@lid`, e não `555596168060:47@lid`.
- Entrou `tests/unit/whatsapp-log-filter.test.js`: impede que alguém aperte o
  regex e devolva o sistema à cegueira que escondeu o bug por dias.
- Entrou `tests/unit/baileys-version-guard.test.js`: pega o descasamento entre o
  pin e o `node_modules`. **Esse descasamento existia nesta máquina** — o patch
  tinha sido estendido no repo e o `node_modules` seguia com a versão antiga, ou
  seja, a correção de fanout de grupo não estava no ar e nada avisava.

## O que falta

1. Soak de 24h com envio agendado, comparando a contagem de retries.
2. Um envio num grupo **PN** (não-LID), pelo item 3 acima.
3. Decidir se vai a produção antes da versão estável.
