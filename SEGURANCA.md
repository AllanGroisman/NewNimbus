# Segurança — auditoria e correções

Auditoria feita em **28/07/2026**. Este documento registra o que foi encontrado, o que já foi corrigido e o que ainda depende de você.

---

## O problema principal

**O banco de dados e a fila de tarefas estavam abertos para qualquer pessoa na internet, sem senha.**

Isso foi confirmado na prática: uma conexão feita ao endereço público do servidor na porta da fila (6379) respondeu normalmente, sem pedir autenticação. Quem descobrisse o IP do servidor conseguiria ler todos os dados dos clientes e enviar mensagens pelos WhatsApps conectados, sem precisar de login.

O resto do sistema está bem construído. Login, permissões de administrador, separação de dados entre clientes e a integração de cobrança passaram na auditoria sem problema grave. A falha estava em como o servidor foi exposto na rede.

### O que estava aberto

| Serviço | Porta | Situação encontrada |
|---|---|---|
| Redis (fila de tarefas) | 6379 | Aberto em `0.0.0.0`, **sem senha nenhuma** |
| Postgres (banco de dados) | 5432 | Aberto em `0.0.0.0`, com senha publicada no repositório |
| API do sistema | 3001 | Escutando em todas as interfaces, respondendo sem HTTPS |
| Firewall (UFW) | — | **Desligado** |

Por que a fila aberta era o pior dos casos: o worker (`backend/worker.js`) executa a função indicada no próprio conteúdo do job. Quem conseguisse escrever na fila mandaria o sistema enviar mensagens, apagar sessões ou criar grupos no WhatsApp de qualquer cliente, sem passar por autenticação.

---

## ✅ O que já foi corrigido

Todos os 5 passos foram aplicados e verificados em 28/07/2026. O sistema ficou fora do ar cerca de um minuto durante o reinício dos containers; **as 3 sessões de WhatsApp reconectaram e voltaram a enviar mensagens normalmente**.

Antes de encerrar, rodei a suíte de testes automatizados e comparei com o código anterior numa cópia isolada: **nenhuma falha nova** foi introduzida, e 7 testes a mais passam.

### Passo 1 — Fechar a exposição de rede ✅ concluído em 28/07/2026
- [x] Postgres e Redis passam a aceitar conexão só de dentro do servidor
- [x] Senha forte criada para o Redis
- [x] API passa a escutar só internamente (obrigando entrada pelo nginx com HTTPS)
- [x] `deploy/update.sh` corrigido para recarregar variáveis de ambiente
- [x] `deploy/install.sh` corrigido: liberava SSH na porta 22, mas o SSH roda na 22022
- [x] Firewall UFW ativado, com regras que cobrem também as portas do Docker

**Verificado depois de aplicar:**
- As portas 5432, 6379 e 3001 agora aparecem como `127.0.0.1` e **recusam conexão** pelo IP público
- Firewall ativo, liberando só 80, 443 e 22022 (SSH), em IPv4 e IPv6
- Site respondendo normal (HTTP 200), banco e fila saudáveis
- **As 3 sessões de WhatsApp reconectaram** e voltaram a enviar mensagens normalmente

**Uma coisa que apareceu no caminho:** o firewall estava num estado inconsistente — a configuração dizia "ativado", mas o serviço estava desligado e nenhuma regra existia no sistema. Foi por isso que ele passou tanto tempo sem proteger nada, apesar do instalador ter a etapa de ligá-lo. Agora está ativo e marcado para subir junto com o servidor.

### Passo 2 — Arquivos de senha ✅ concluído em 28/07/2026
- [x] Arquivos `.env` retirados do controle de versão (`backend/.env`, `backend/.env.e2e`, `frontend/.env`)
- [x] `DEFAULT_ADMIN_PASSWORD` esvaziada e o travamento removido do código
- [x] Permissões corrigidas: `.env` e backups agora só o dono lê (eram legíveis por qualquer programa do servidor)
- [x] `backend/.env.example` criado — ele **não existia**, e sem ele uma instalação nova quebraria agora que o `.env` saiu do repositório
- [x] Instalador e `fresh_install.md` atualizados

**Sobre o travamento da senha de admin:** o código reaplicava a senha do arquivo de configuração a cada boot, comparando com a que estava no banco. Agora a senha do arquivo é usada **só na criação da conta**, na primeira instalação. Se a conta já existe, o sistema apenas garante que ela continua com papel de administrador — a senha em uso passa a ser a que você definir pela interface.

Verificado: as duas contas de administrador continuam existindo e com o papel correto depois do restart.

### Passo 3 — Correções no código ✅ concluído em 28/07/2026
- [x] Buscador de links limitado às lojas conhecidas
- [x] Troca de senha passa a derrubar as sessões abertas
- [x] Rotas de envio passam a conferir a assinatura
- [x] Bibliotecas atualizadas — de **18 falhas conhecidas para 3**

**O buscador de links.** Antes aceitava qualquer endereço e o servidor ia buscar. Testei os 9 casos de abuso mais comuns (endereços internos, o serviço de metadados da nuvem, `file://`, e domínios disfarçados como `amazon.evil.com`) — todos bloqueados. E os 5 formatos de link real de loja continuam passando. A checagem antiga era frouxa: bastava a palavra "amazon" aparecer em qualquer lugar do endereço.

**Sessões.** Cada conta ganhou um número de versão que vai dentro do token de acesso. Trocar a senha, pedir reset ou ser suspenso incrementa esse número, e todos os acessos antigos param de valer na hora. Quem troca a própria senha continua logado na aba em que está; só as outras sessões caem. **As sessões abertas hoje não foram derrubadas** — a mudança vale daqui pra frente.

**Envio sem assinatura.** As rotas de envio direto e de disparo imediato agora conferem se a assinatura está ativa. Antes, só o envio automático conferia — quem cancelava seguia enviando à mão. Adicionei dois testes que cobrem isso.

**Bibliotecas.** A do WhatsApp subiu de 6.7.21 para 6.7.23 e saiu da lista de falhas críticas. A de e-mail foi para a versão 9 (testei que a conexão com o servidor de e-mail continua autenticando). Restam **3 falhas sem correção disponível**, todas na mesma dependência interna da biblioteca do WhatsApp (`protobufjs`, via `libsignal`) — não existe versão corrigida publicada ainda. A única alternativa seria pular para a versão 7 do Baileys, que ainda é uma versão de testes; não achei prudente fazer isso no sistema de produção sem você decidir.

**Ajustes menores:** custo do bcrypt de 10 para 12; algoritmo do token fixado; o link de reset de senha deixou de ir para o log em produção.

### Passo 4 — nginx ✅ concluído em 28/07/2026
- [x] Página `/metrics` deixa de ser pública — agora responde **403** para quem vem de fora, e `/healthz` continua aberto para monitoramento
- [x] Proteções de navegador adicionadas na tela do sistema (HSTS, anti-clickjacking, anti-sniffing e uma política de conteúdo)
- [x] HTTPS incluído no instalador (este servidor já tinha; uma instalação nova subia sem)
- [x] CORS passa a falhar no boot se a configuração de origem faltar, em vez de liberar tudo em silêncio
- [x] `/healthz` deixa de expor detalhes internos para quem vem de fora

A política de conteúdo precisou de um ajuste: a versão inicial bloqueava o **login com Google**, porque a tela carrega um script do `accounts.google.com`. Foi corrigida antes de ficar no ar, liberando só os domínios do Google que o login usa.

### Passo 5 — Backups ✅ concluído em 28/07/2026
- [x] Cópias do banco passam a ser criptografadas antes do envio para a nuvem
- [x] Sessões de WhatsApp criptografadas dentro do banco

**Sessões de WhatsApp.** As 2.591 linhas que estavam em texto puro foram convertidas (com backup da tabela antes). Reiniciei o worker para forçar a leitura do zero: **as 3 sessões reconectaram normalmente**, sem nenhum erro.

**Backups.** Os dumps continuam normais no servidor, mas saem criptografados para o Backblaze. Verifiquei o ciclo completo com um dump real de 3,36 MB: subiu criptografado, baixei de volta, decifrou byte a byte idêntico ao original e descomprimiu em 12,5 MB de SQL válido. Também confirmei que um arquivo adulterado é detectado em vez de passar batido.

No caminho, corrigi um problema que eu mesmo teria causado: vários scripts filtravam os arquivos da nuvem por nome terminando em `.sql.gz`, e não reconheceriam os novos `.sql.gz.enc`. Isso faria o sistema reenviar tudo a cada hora e nunca apagar os antigos. Ajustei os 4 lugares (envio, restauração, verificação e a tela de administração).

**O backup para o Google Drive não está ativo** neste servidor — o rclone nem está instalado. Deixei um aviso destacado no script: se for ligado do jeito que está, mandaria o banco inteiro em texto puro para uma conta pessoal do Drive.

---

## 🔑 O que VOCÊ precisa fazer

As senhas do sistema estavam guardadas dentro do repositório do GitHub, de propósito — havia inclusive um comentário no código explicando a escolha. Elas ficaram lá por cerca de 100 commits.

**Apagar o arquivo não resolve**, porque o histórico do Git guarda todas as versões antigas. A única coisa que resolve de verdade é **trocar as senhas**. Depois de trocadas, as antigas viram inúteis e o histórico deixa de importar.

Essas trocas são feitas em painéis externos, por isso dependem de você. Faça nesta ordem:

- [ ] **1. Chave do Backblaze B2** — Painel do B2 → App Keys → apagar a atual e criar outra
      *É a mais urgente: essa chave dá acesso a todas as cópias do banco de dados, que contêm tudo.*
- [ ] **2. Senha do e-mail** — Painel do Titan Email
- [ ] **3. Chave do Stripe** — Dashboard Stripe → Developers → API keys
- [ ] **4. Segredo do webhook do Stripe** — Dashboard Stripe → Webhooks
- [ ] **5. Senha do banco de dados** — me avise quando quiser, eu faço
- [ ] **6. Senha do admin** — pela interface do sistema. O travamento já foi removido, então a troca agora persiste de verdade

Você não precisa saber onde colar cada valor novo. É só passar o valor que eu atualizo no lugar certo, ou peço para você editar uma linha específica.

### 🔐 Duas chaves novas que você precisa guardar FORA do servidor

Isto é o item mais importante desta lista. A criptografia criou duas chaves, que estão em `backend/.env`:

| Chave | Se você perder |
|---|---|
| `SESSION_ENC_KEY` | As sessões de WhatsApp viram ilegíveis. Recuperável, mas exige **reescanear o QR de cada número**. |
| `BACKUP_ENC_KEY` | **Os backups na nuvem viram lixo. Não há recuperação.** |

O problema é justamente o cenário para o qual o backup existe: **se o servidor morrer, as chaves morrem junto com ele**, e aí os backups na nuvem não servem para nada.

- [ ] **Copie essas duas linhas do `backend/.env` para um gerenciador de senhas** (ou qualquer lugar seguro que não seja este servidor). Leva um minuto e é o que garante que o backup funcione no dia em que você precisar dele.

Enquanto isso não for feito, você está numa situação pior do que antes em termos de recuperação — antes o backup era legível por qualquer um, agora ele depende de uma chave que só existe numa máquina.

### Sobre a senha do admin

Existe um comportamento que atrapalha hoje: a senha do administrador é **reaplicada toda vez que o sistema reinicia**, a partir do valor guardado no arquivo de configuração. Ou seja, se você trocar a senha pela interface, ela volta ao valor antigo no próximo restart.

Depois que essa configuração for removida (Passo 2), a troca pela interface passa a funcionar de verdade.

---

## 📌 O que mudou na rotina

**Os arquivos `.env` saem do Git.** Na prática nada muda no dia a dia, porque eles já estão no servidor e continuam sendo lidos normalmente. Só importa em duas situações:

1. **Instalação numa máquina nova** — o `git clone` não vai mais trazer o `.env`. Você precisa copiar o arquivo do servidor atual na mão.
2. **Existe agora um segundo `.env`, na raiz do projeto** (junto do `docker-compose.yml`), com as senhas do banco e da fila. Isso é uma exigência do Docker, que só lê variáveis de um `.env` que esteja na mesma pasta do `docker-compose.yml` — ele não enxerga o `backend/.env`. Esse arquivo também fica fora do Git.

**Sobre restart:** rodar `bash deploy/restart.sh` continua seguro. Os dados do banco e da fila ficam em volumes do Docker, separados dos containers, e as sessões de WhatsApp ficam numa tabela do banco. Nada disso se perde quando os containers reiniciam.

---

## ⚠️ Avisos enquanto as mudanças não forem commitadas

As alterações foram deixadas **sem commit**, para você revisar antes. Enquanto estiverem assim:

- **Não rode `bash deploy/update.sh`.** Ele faz `git pull --ff-only`, que pode reclamar de mudanças não commitadas. O `deploy/restart.sh` não tem esse problema.
- **Não rode `git reset --hard` nem `git checkout .`.** Esses comandos restaurariam a versão antiga do `backend/.env`, apagando a senha nova do Redis e derrubando a conexão do sistema com a fila.

Se algum desses comandos for rodado por engano, é só me avisar que eu recoloco a senha.

---

## Achados que continuam em aberto

Todos os achados da auditoria foram corrigidos, com três exceções, que ficam registradas aqui para não se perderem:

| Achado | Gravidade | Por que ficou em aberto |
|---|---|---|
| `protobufjs` com falha crítica conhecida | Média | Chega junto com a biblioteca do WhatsApp e **não existe versão corrigida publicada**. Sair disso exigiria a versão 7 do Baileys, que ainda é versão de testes — decisão sua, não faria isso sem combinar. |
| Chromium roda sem isolamento (`--no-sandbox`) e como root | Média | O risco caiu bastante com o buscador de links agora restrito a domínios de loja. Corrigir de verdade significa rodar o sistema com um usuário comum em vez de root, que é uma mudança de infraestrutura maior. |
| Backup para o Google Drive enviaria sem criptografia | Baixa | **Não está ativo** (rclone não instalado). Deixei aviso no script com a instrução de como ligar com criptografia. |

Fora da segurança, notei duas coisas que valem atenção quando sobrar tempo:

- **Há 48 testes automatizados quebrados**, e isso **já era assim antes** deste trabalho — confirmei rodando a suíte no código anterior, em cópia separada. Parecem todos ligados à mesma causa: os usuários de teste não estão recebendo assinatura ativa, então caem em erro de pagamento. Não mexi neles.
- **O disco está com 92% de uso** (1,5 GB livres). Os backups locais ocupam 132 MB e há três agendadores de backup diferentes configurados ao mesmo tempo (um por hora no cron, mais um diário no PM2).

---

## Arquivos alterados (para a sua revisão)

Nada foi commitado — está tudo como alteração solta, esperando você revisar.

**Arquivos novos:**

| Arquivo | O que é |
|---|---|
| `SEGURANCA.md` | Este documento |
| `backend/scraping/urlGuard.js` | Validação de link antes de o servidor buscar qualquer coisa |
| `backend/scripts/backup-crypto.js` | Criptografia dos backups |
| `backend/scripts/encrypt-baileys-auth.js` | Script que converteu as sessões (já rodado, guardado para referência) |
| `backend/.env.example` | Modelo de configuração — não existia |
| `backend/prisma/migrations/20260728124500_user_token_version/` | Coluna nova para invalidar sessões |

**Configuração e infraestrutura:** `docker-compose.yml`, `deploy/nginx.conf`, `deploy/install.sh`, `deploy/update.sh`, `.gitignore`, `fresh_install.md`

**Código do backend:** `server.js`, `auth/pg.js`, `auth/mailer.js`, `auth/baileys-pg.js`, `backup/api.js`, `repasse/capture.js`, `scraping/scraper.js`, os quatro scripts de backup, `prisma/schema.prisma`

**Frontend:** `src/data/api.js` (guarda o token novo após troca de senha) — o build já foi refeito e está no ar

**Testes:** `tests/integration/whatsapp.test.js`

> A configuração do nginx que está rodando (`/etc/nginx/sites-available/nimbus`) foi alterada direto, porque ela não fica no repositório. O backup dela está em `/etc/nginx/sites-available/nimbus.bak-20260728`.

---

## O que já estava bem feito

Vale registrar, porque são justamente os pontos onde a maioria dos sistemas erra:

- **Cada cliente só enxerga os próprios dados.** Todas as rotas foram conferidas, sem exceção encontrada.
- **As 47 telas de administrador estão protegidas**, todas.
- **Ninguém consegue se dar um plano pago de graça** — a integração com o Stripe valida a assinatura do webhook e é resistente a repetição.
- **As senhas são guardadas com bcrypt** e nunca aparecem nas respostas do sistema.
- **Sem brecha de SQL injection e sem XSS** — os dois ataques mais comuns em sistemas web.
- **Limite de tentativas de login** bem configurado, por usuário e não por IP.
- **A chave de segurança do login (JWT) não está escrita no código** — é gerada aleatoriamente e guardada no banco.
- **SSH com fail2ban** e em porta não-padrão.
- **HTTPS do servidor bem configurado**, com renovação automática do certificado.
