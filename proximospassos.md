# Próximos passos — Baileys 7 em produção

Escrito em 08/09/2026, para ser lido "frio" depois da viagem. Não precisa
reler nada antes: o essencial está aqui. Detalhe técnico completo em
`relatorio_baileys7.md`; diagnóstico do bug em `backend/whatsapp/README.md`.

---

## Onde as coisas pararam

A migração está **pronta e testada**, no branch `baileys-7` (commits `5ec294c` e
`43efbf8`, a partir de `58d3db7`). **Produção não foi tocada** — continua no
Baileys 6.7.23 com o patch caseiro.

O que foi provado no notebook, com o chip de teste e um grupo real de 3 celulares:

- a sessão criada pelo Baileys 6 **reconectou no 7 sem pedir QR**;
- o grupo recebeu a promoção normalmente, com os 12 destinos endereçados
  corretamente em `@lid`;
- **zero** ocorrências de `<telefone>@lid`, que era o endereço inexistente que
  causava o "Aguardando mensagem";
- `Bad MAC`: 0. Reenvios: 7, todos atendidos (contra 3.044 num dia no incidente);
- suíte inteira verde: 901 testes unitários + 722 de banco.

**Resposta às suas duas perguntas:** ninguém precisa refazer a conexão, e os
envios novos passam a funcionar. As mensagens que **já** estão travadas em
"Aguardando mensagem" no celular de alguém continuam travadas — o celular desiste
depois de 5 tentativas e aquela mensagem específica morre. O que muda é dali para
frente.

---

## A decisão que é só sua

`7.0.0-rc14` é **release candidate**, não versão estável. Funcionou bem no teste,
mas é um candidato. Duas saídas legítimas:

- **subir agora**, porque o bug está custando grupos inteiros sem ver promoção;
- **esperar a estável**, mantendo o patch caseiro que já contém o problema.

O resto deste arquivo assume que você escolheu subir.

---

## Antes de subir — três checagens na VPS

Faça as três **antes** de mexer em qualquer coisa. Levam 2 minutos.

**1. Qual branch a VPS acompanha** (o `deploy/update.sh` faz `git pull --ff-only`
no branch que estiver lá):

```bash
cd ~/NewNimbus && git branch --show-current && git rev-parse HEAD
```

Anote o commit — é o seu ponto de rollback.

**2. A VPS consegue instalar o Baileys 6 de novo?** Isso é o rollback. O lock do
6.x busca o `libsignal` por `git+ssh://`, e sem chave SSH no GitHub o rollback
falha na hora em que você mais precisa dele:

```bash
ssh -T git@github.com
```

- Se responder `Hi <usuário>!` → tudo certo.
- Se responder `Permission denied (publickey)` → **prepare a rede de segurança
  antes de subir**:
  ```bash
  cd ~/NewNimbus/backend
  mkdir -p ~/nimbus-rollback
  tar czf ~/nimbus-rollback/node_modules_baileys6.tgz -C node_modules @whiskeysockets/baileys libsignal
  ```
  Com esse tarball, o rollback vira uma extração de arquivo, sem rede.

**3. Backup do banco fresquinho.** O cron horário já faz, mas confirme que o
último rodou.

---

## Subir

```bash
# 1. Na sua máquina: levar o branch para o que a produção acompanha.
#    Troque "beta" pelo branch que você anotou no passo 1 acima.
cd ~/NewNimbus
git checkout beta
git merge baileys-7
git push

# 2. Na VPS:
cd ~/NewNimbus
bash deploy/update.sh
```

O `update.sh` cuida de tudo (pull, `npm install --omit=dev`, prisma, build do
frontend, reload do PM2). **Não há migration de banco nesta mudança** — o único
mexido no schema foi um comentário.

O `postinstall` vai imprimir `No patch files found`. **Isso é o esperado**: o
patch caseiro foi removido de propósito, porque o Baileys 7 corrige de fábrica.

---

## Depois de subir — o que olhar nos primeiros minutos

**1. As sessões voltaram sem QR?**

```bash
pm2 logs nimbus-worker --lines 100
```

Procure `restaurando N sessão(ões)` seguido de conexão normal. Se aparecer QR
novo ou `logged_out` para algum número, **pare e faça o rollback** — não era para
acontecer, e significa que aquele número precisaria repareamento.

**2. O mapa LID nativo entrou?**

```bash
grep "Own LID session created successfully" ~/NewNimbus/backend/logs/worker-out.log
```

Uma linha por número conectado. Se não aparecer nenhuma, o mapa nativo não está
funcionando e o resto não vale.

**3. O banco ganhou os tipos novos** (depois de alguns envios):

```bash
psql "$DATABASE_URL" -c 'select "keyType", count(*) from baileys_auth group by 1 order by 2 desc;'
```

Tem que aparecer **`lid-mapping`** e **`device-list`** — eles não existem no 6.x.

**4. Mande uma promoção num grupo** e acompanhe:

```bash
tail -f ~/NewNimbus/backend/logs/worker-out.log | grep -E "sending new sender key|sending message to|retry"
```

- **Bom:** `sending new sender key` com `senderKeyJids` cheio, e os endereços em
  `@lid` com números que **não** são telefones brasileiros.
- **Ruim:** `senderKeyJids` vazio num grupo com gente, ou chuva de `retry`.
- **Normal:** `sending message to 0 devices` a partir da segunda mensagem no mesmo
  grupo — quer dizer que todo mundo já tem a chave, não que não foi enviado.

---

## Se algum grupo continuar mudo

Este é o cenário que eu mais esperaria, e tem conserto conhecido.

O WhatsApp guarda uma anotação de "já mandei a chave para essas pessoas"
(`sender-key-memory`). Se sob o Baileys 6 a entrega falhou, essa anotação ficou
mentindo — e o 7 confia nela e **não redistribui**. O grupo segue mudo e o log
parece saudável.

Conserto, um grupo por vez:

```bash
cd ~/NewNimbus/backend
node scripts/reset-group-sender-key.js <jid-do-grupo>            # dry-run, só mostra
node scripts/reset-group-sender-key.js <jid-do-grupo> --apply    # aplica
```

Depois mande uma mensagem no grupo: o `sending new sender key` tem que voltar com
a lista cheia.

## Se aparecer `Bad MAC` em massa

```bash
cd ~/NewNimbus/backend
node scripts/fix-lid-sessions.js            # dry-run
node scripts/fix-lid-sessions.js --apply    # apaga as sessões divergentes
```

É seguro: o libsignal refaz a sessão do zero no próximo envio. **Nunca apague
`creds`** — isso sim forçaria reler o QR de todo mundo.

---

## Rollback

```bash
cd ~/NewNimbus
pm2 stop nimbus-backend nimbus-worker
git checkout <commit-que-voce-anotou>
cd backend
rm -rf node_modules/@whiskeysockets/baileys node_modules/libsignal

# com chave SSH no GitHub:
npm install --omit=dev
# sem chave SSH — use o tarball da checagem 2:
#   tar xzf ~/nimbus-rollback/node_modules_baileys6.tgz -C node_modules

pm2 start nimbus-backend nimbus-worker --update-env
```

O banco **não** precisa de rollback: nada no schema mudou, e os tipos novos
(`lid-mapping`, `device-list`) simplesmente ficam lá sem atrapalhar o 6.x.

---

## Pendências menores (não bloqueiam nada)

- **Soak de 24h** no notebook — ficou por fazer. Serve só para trocar "7 reenvios
  na janela de teste" por um número de um dia inteiro no relatório.
- **Grupo antigo (PN)** — não deu para testar aqui: os únicos grupos desta máquina
  foram criados agora, e grupo novo já nasce em modo LID. Um grupo antigo de
  verdade seria um dos seus grupos de cliente, e não valia mandar promoção de
  teste para eles. Fica como observação: se algum grupo antigo se comportar
  estranho depois da subida, é o primeiro suspeito.
- **`plano_sete.md`** ficou como registro histórico e tem **duas afirmações
  falsas** (o pacote não muda de nome, e o `pairingEphemeralKeyPair` não é
  novidade do 7 — existe desde o 6.5.0). As correções estão no
  `backend/whatsapp/README.md`. Se for ler o briefing, leia com isso em mente.

## Estado desta máquina (notebook)

Ficou no branch `baileys-7`, rodando o Baileys 7 com o chip de teste pareado. Se
quiser devolver ao estado anterior:

```bash
cd ~/NewNimbus
git checkout beta
cd backend && npm install
pm2 restart nimbus-backend nimbus-worker --update-env
```

O dump da sessão do 6.x e o tarball do node_modules antigo estão em
`~/nimbus-rollback/`.
