# Falta antes de lançar

Revisão do sistema em 28/07/2026, com o sistema rodando em produção.
Bateria de testes na data: **474 passaram, 0 falharam** (31 arquivos, 2 pulados).

Resumo: a base está sólida. O que preocupa são 3 bloqueadores, e o mais sério é
que um cliente que cancelar ou baixar de plano fica preso numa tela que não
deixa ele mexer em nada.

---

## 🔴 Bloqueadores

### RESOLVIDO 1. Cliente que cancela ou baixa de plano trava o sistema inteiro dele

**Resolvido em 29/07 (task 34).** O limite passou a valer só sobre o que está
**ativo**. Quem passa do limite fica *pausado pelo plano*: continua na tela,
editável, com fila e histórico intactos, mas não envia e não conta no limite —
nada é apagado. O cliente escolhe o que fica ativo pelo botão **Ativar**, que
pergunta qual sai no lugar quando o plano já está cheio. Salvamento que só apaga
ou edita sempre passa; só criar item ativo acima do limite dá 402. Cartão que
falha (`past_due`) ainda ganha 3 dias de carência antes de pausar qualquer coisa.

Descrição original do problema:

Quando a assinatura vence, cancela ou fica em atraso, o plano vira `free` — que
tem limite **0 campanhas e 0 números**. A partir daí, `PUT /api/state`
(`backend/server.js:501`) recusa **qualquer** salvamento com erro 402, inclusive
a tentativa de **apagar campanhas** para voltar ao limite.

O cliente com 5 campanhas que cancela fica assim: vê tudo, não consegue mudar
nada, e não tem saída pela interface. O mesmo vale para downgrade Pro → Básico —
cada exclusão passa por um estado intermediário (4, 3, 2 campanhas) que ainda
estoura o limite de 1, então nenhuma é aceita.

Ainda não estourou porque as duas únicas contas com campanhas
(`allangroisman@` e `pedrobeurengu@`) são admin, e admin passa direto. O
primeiro cliente real que cancelar vai bater nisso.

**Correção:** aceitar o salvamento quando a quantidade **não aumenta** em
relação ao que já está gravado. Assim quem está acima do limite consegue
reduzir, mas não criar mais.

### 2. Sentry está instalado e desligado

`SENTRY_DSN` está vazio no `.env` de produção. Todo o encanamento existe
(server + worker, captura até crash de processo), mas não envia nada. Hoje, se
quebrar para um cliente pagante, você só descobre se ele reclamar. É o ajuste de
10 minutos com maior retorno antes de abrir.

### 3. Correções importantes estão fora do Git

`git status` mostra 4 arquivos modificados e não commitados — justamente as
correções do dia: instalar o Chrome no `install.sh`/`update.sh` e detectar loja
que não coletou nada. Se rodar um `update.sh` ou reinstalar, isso se perde e o
scraping volta a quebrar em silêncio.

Arquivos: `backend/scraping/admin.js`, `backend/scraping/scraper.js`,
`backend/whatsapp/local.js`, `deploy/install.sh`, `deploy/update.sh`, e o teste
novo `tests/unit/scraper-empty-sweep.test.js` (ainda não rastreado).

---

## 🟠 Riscos altos

### 4. Servidor no limite

1 vCPU, 1,9 GB de RAM com **1,1 GB já em swap**, 5,3 GB de disco livre. Nisso
rodam Postgres, Redis, server, worker (Baileys) e o Chrome do scraping — que na
Amazon abre 3 abas em paralelo. Isso é muito provavelmente a causa real do
Chrome ter sumido. Recomendo subir para 2 vCPU / 4 GB antes de abrir para
clientes.

### 5. Ninguém vigia o sistema de fora

O `/healthz` é bem-feito e completo, mas os alertas saem pelo WhatsNimbus, que
roda na mesma máquina. Se a VPS cair, o alerta cai junto e você não fica
sabendo. Um monitor externo gratuito (UptimeRobot / BetterStack) apontando para
`/healthz` resolve.

### 6. Webhook do Stripe pode perder um evento

Em `backend/server.js:130` o evento é marcado como processado **antes** de ser
processado; se der erro no meio, o Stripe não reenvia e a assinatura nunca
atualiza. Esse é exatamente o sintoma da tarefa 1 do `tasks.md` (pagou Business,
continuou no Pro). Está mitigado pelo sync ao abrir a página de assinatura, mas
dá para eliminar apagando a marca quando o processamento falha.

---

## 🟡 Menores

- `.env.example` não documenta `SENTRY_DSN` nem `SESSION_ENC_KEY`. Sem a
  segunda, uma instalação nova grava as sessões do WhatsApp **sem
  criptografia** — só emite um aviso no log que passa batido.
- **Falta Termos de Uso e Política de Privacidade (LGPD).** Produto pago,
  cobrando cartão de brasileiro. O Stripe costuma cobrar isso na revisão da
  conta.
- 2 das 5 sessões de WhatsApp estão desconectadas e a fila `control` tem 17 jobs
  falhados acumulados — vale limpar antes de abrir.
- O número `555597140686` está conectado ao mesmo tempo como sessão de usuário
  **e** como WhatsNimbus (admin). O sistema deduplica corretamente, mas convém
  separar o número do admin.

---

## ✅ O que já está bem resolvido

- Isolamento entre clientes: toda consulta filtra por `userId` (conferido nas
  rotas de campanha, incluindo `updateGroupOps`).
- HTTPS com certificado válido, headers de segurança no nginx, CORS travado com
  falha no boot se faltar configuração.
- JWT com versão de sessão — trocar senha, resetar ou suspender expulsa as
  sessões antigas na hora.
- Webhook Stripe com verificação de assinatura HMAC e idempotência.
- Backup de hora em hora, 30 dias de retenção no B2, com alerta se parar.
- Fila com retry exponencial e limite de 1 envio/segundo, que é o ritmo seguro
  para não tomar bloqueio do WhatsApp.
- Preços puxados ao vivo do Stripe, com fallback local.
