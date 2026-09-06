
1. [x] Revisar login com google. Segue o que aparece: Acesso bloqueado: erro de autorização

allangroisman@gmail.com

Não é possível fazer login no app porque ele não obedece à política do OAuth 2.0 do Google.

Se você é o desenvolvedor do app, registre a origem JavaScript no Console do Google Cloud.
Saiba mais sobre o erro
Se você é um desenvolvedor desse app, consulte os detalhes do erro.
Erro 400: origin_mismatch

2. [x] Como ele detecta os cupons no repasse? Por texto? Se sim, quero poder editar essa lista de textos.

3. [x] Quero analisar os testes e ver quanto demora cada um. Quando estou fazendo novas implementações, ta demorando mt por conta dos testes. Quero entender bem e deixar salvo aqui para que quando implementar, apenas fazer os testes necessários.

4. [x] Quero adicionar um aviso de notificacao para quando o claude termina alguma tarefa ou requer alguma escolha ou ação minha.

5. [x] Na aba de usuários do ADMIN, o que quer dizer o card de ATIVAS exatamente? Que está sendo pago? Que está funcionando seus grupos? Quero saber mais dados sobre os usuarios nesta aba, se as campanhas estão ativas, quais numeros conectados, pode oferecer sugestões do que aparecer. Quero que apareçam estas informações ao clicar no usuário extendendo para baixo. 

6. [x] Na aba de busca de produtos, quero que tire aquele salvar alterações que aparece na parte debaixo da tela.

7. [x] A parte superior esquerda da página, onde tem a marca, escrito Nimbus e painel admistrativo. Quero que tire o escrito "painel admistrativo" e quero que a junção da marca com o escrito seja clicável para ir para a Home do Sistema (a home pode ser o menu de campanhas)

8. [x] Revise a tela de busca de produtos, por exemplo, diz que vai preencher so ate 20 produtos, mas passou do limite. Verifica se ta tudo certo. também, o que mais que tu acha que da pra melhorar nesta tela?

9. [x] Tira a parte "Produtos com cupom do Mercado Livre
Tanto faz
Preferir com cupom
Só com cupom
Vale no preenchimento automático da fila. Os cupons vêm de Admin › Cupom › Cupons do ML; com “só com cupom”, a fila pode vir vazia se nenhum produto da campanha estiver num cupom." da aba de busca de produtos.

10. [x] Ta mt estranho a adição de produtos na fila, vai um numero, aparece outro, ta mt confuso, preciso que tu revise.

11. [] Quero conferir se o ambiente mobile esta condizente e bem construido para utilizacao do usuario.

12. [] Quero fazer um resumo geral do sistema e criar um arquivo na raiz do projeto que explique didaticamente como esta funcionando. Náo sei exatamente tudo que quero no resumo, mas as tecnologias usadas, onde estao os banco de dados, o que tenho guardado em cada um, quais sao minhas camadas de seguranca, como funciona, como esta arquitetado para expansao caso cresca o numero de usuario, onde e como sao feitos os backups e o que tem neles, um resumo do custo computacional das diferentes partes da arquitetura, etc...

13. [] Verificar brechas de segurança pelos endpoints do site.

14. [x] Quero exigir telefone dos usuários. Como tu sugere que seja feito?

    **Feito:** é a mesma coisa do item 36 — resolvido lá.

15. [] Nos cupons, quero que todos os cupons que são detectados no repasse sejam adicionados na lista e que se não estiverem, seja feito o scraping de seus produtos.

16. [] O que da pra melhorar de UI na aba de busca de produtos das campanhas?

17. [x] Nos USUARIOS de ADMIN, mostrar sempre, antes de expandir, os numeros dos whats conectados.

18. [x] Nos USUARIOS de ADMIN, adicionar um filtro de cancelados além de pagando, nao verificados, suspensos, etc...

19. [x] Melhora a parte do cupom: 
    Uma aba Config Test do lado de testar cupom e cupons do ML, onde verifica se tem a extensao ativa e tag/cookie de afiliado necessarios para fazer tudo, dessa forma consigo testar e editar/adicioanr o que falta ali mesmo.

20. [x] Melhora a parte do cupom:
    Quero que apareça o que ta acontecendo quando clico para buscar a colheita das vitrines. No final da busca quero tb um resumo do que foi buscado.

21. [x] Melhora a parte do cupom: Os cupons são separados por Categoria, certo? Quero que ali onde consigo visualizar eles, apareça assim aqui também.

22. [x] Melhora a parte do cupom: Separa a parte de Descobrir uma palavra para outra aba ao lado de Testar Cupom e Cupons do ML.

23. [x] Melhora a parte do cupom: Cria mais uma aba ao lado de Testar cupom e cupons do ML com o nome "Repasse", nela quero que apareça todos os cupons capturados pelo repasse e o teste se eles são de alguma campanha ou não. Se um cupom é caputado no repasse, ele deve ser testado e integrado no sistema.

24. [x] Na aba Repasse do Cupom, quero um botão de excluir o cupom que esta ali individualmente e um botão para limpar todos os cupons dali.

25. [x] Quero usar a extensao do chrome para fazer tudo nos cupons, assim não pega o captcha.

26. [x] Ta puxando só de brinquedos e hobbies, quero que puxe de tudo.

    **Causa:** a config salva no banco (`app_config['ml-cupons-config']`) estava com
    `groupings: ["tb_vertical"]` — "Brinquedos, Hobbies e Bebês". O default do código
    é "todas", mas o valor salvo sempre vence, e **não existia tela nenhuma que
    escrevesse `groupings`**: o painel de limites re-gravava o valor escondido a cada
    "salvar". Junto disso, "todas as categorias" era uma passada só na lista geral —
    e nessa passada o ML não diz a categoria de cada cupom, então 1.211 dos 1.231
    cupons do banco tinham entrado sem categoria nenhuma (e o upsert ainda apagava a
    categoria que uma rodada por vertical tivesse aprendido).

    **Agora:** sem categoria escolhida, a rodada varre **cada vertical, uma de cada
    vez** (`categoriasDaRodada`, em `backend/coupons/sync.js`), então cada cupom entra
    carimbado; o teto passou a ser 100 por categoria; o painel de limites ganhou o
    seletor de categorias com um "varrer todas"; e `backend/scripts/cupons-todas-categorias.js`
    destrava a config já salva (rodar com `--apply` na VPS).

27. [x] Aparece o seguinte:

"O ML reconheceu a palavra SITETODO0109 e disse que ela é da campanha 14193848 — mas esse cupom nunca foi raspado, então não sabemos o título dele, o desconto nem quais produtos ele cobre. Dá pra ir buscar essa campanha agora, sem rodar a coleta inteira.

Trazer também os produtos da vitrine
Sem isto a campanha entra sem lista de produtos — dá pra puxar depois no “Sincronizar produtos” da linha dela na tabela.
O ML não devolveu essa campanha na lista da conta."

Como que acha a campanha, mas não consegue puxar ela?

    **Resposta:** são duas superfícies diferentes do ML, e só uma delas é uma lista.
    Quem responde à PALAVRA é o validador de cupom do checkout: ele conhece qualquer
    campanha que exista e devolve só o `campaign_id` dela — sem título, sem desconto,
    sem vitrine. Quem responde à CAMPANHA é a lista de ofertas *desta conta*
    (`/cupons/filter`), que é segmentada, e que a busca tem de paginar até topar com o
    id. Não existe endpoint "campanha por id" em lugar nenhum — nem no ML, nem aqui.
    Então uma campanha real pode estar fora da lista por segmentação, por ter vencido
    ou por já ter sido usada.

    Só que, além disso, a busca pela extensão tinha três defeitos que a faziam perder
    a campanha mesmo quando ela ESTAVA na lista (corrigidos em `backend/coupons/sync.js`):
    ela herdava as categorias da config da rodada (só brinquedos/hobbies — é a task 26),
    descartava cupom de loja antes de comparar o id, e gastava o teto de ativações nos
    vizinhos em vez de dar o "Eu quero" no alvo (sem o qual o ML não revela a vitrine).
    A mensagem de "não achei" agora diz quantas páginas foram varridas e explica o
    motivo de fundo.

28. [x] Nos cupons:

    Reformula o Cupons do ML para:

    Lá quero um botão para que a extensão acesse essa pagina https://www.mercadolivre.com.br/cupons/filter?all=true&page=1 onde tem TODOS os cupons e que faça o scraping de TODOS os cupons que estão ali em um primeiro momento com seus nomes e suas condições.

    Se no nome do cupom tem "com X" como "com QUEROPROMO" por exemplo,  QUEROPROMO é a palavra de ativação deste cupom, já deixa vinculado.

    Se tem "Em produtos de X" como "Em produtos de Agrotrator", é um cupom especifico de uma loja, então deve ser separado nesta categoria.

    Depois quero outro botão que busque os produtos de cada cupom, tanto no proprio cupom para buscar individualmente, quanto um botão geral para buscar todos os produtos de todos os cupons que ainda não foram buscados.

    Quero configurações para modificar todos os parâmetros e limites de quantidade de cupons/produtos por cupom.

    Quero que continue o botão de apagar todos os cupons e que tenha botão individual de apagar também.

29. [] Na busca dos cupons quero ver o progresso da raspagem dos cupons, exatamente o que esta sendo feito na hora, pra saber o que acontece, pq demora, e etc...

30. [] Como funciona o vinculo dos produtos dos cupons com os produtos que ja fiz scraping, o sistema percebe quando sao o mesmo produto e ja vincula? Os cupons ficam vinculados?

31. [] Quando coloco a palavra para descobrir palavra dos cupoms diz que reconheceu e que é da campanha de numero 14193894 por exemplo. Queria que as campanhas quando forem buscadas, tivessem esse numero associado para que seja facil vincular campanha a palavra. Por exemplo, no link do cupom https://lista.mercadolivre.com.br/_CustId_2903552873?coupon_campaign_id=13495993 tem ali o ID, não seria este mesmo? NAO PRECISA FAZER TODOS OS TESTES DO SISTEMA NOVAMENTE, SÓ ESPECIFICOS PARA O QUE FOI ALTERADO.

32. [] Consigo buscar um cupom pelo ID dele?

33. [] Consigo entrar no PC da VPS que tem linux, instalar o chrome com a extensão e fazer o captcha manualmente quando necessario? Para automatizar a busca por cupom ou as coisas que precisam de captcha

34. [x] Quero trocar o ? que tem embaixo das telas por um simbolo do whatsapp para contatar o suporte que encaminhe para https://wa.me/55997140686

35. [x] Adiciona um botão para testar se o Whats esta conectado la no card de cada numero conectado do Whatsapp. Nele dispara uma mensagem teste do WhatsNimbus do sistema que envia para o numero no privado, assim consigo testar se esta conectando e funcionando na pratica. Teste somente os testes necessarios para essa mudanca especifica, não rpecisa rodar tooodos os testes novamente.

    **Feito:** botão "Testar" no card de cada número **conectado** (Página WhatsApp).
    Dispara `POST /api/whatsapp/sessions/:id/test`, que roda **duas pernas
    independentes** e devolve o veredito de cada uma:
    1. **auto-DM** — o próprio número manda uma mensagem pra ele mesmo. É o único
       jeito de provar que aquela sessão Baileys está *enviando*: o "Conectado" da
       tela não prova (snapshot velho no Redis, socket trocado por conflito).
    2. **DM do WhatsNimbus** — o WhatsApp do sistema manda pro número, provando que
       o remetente das notificações está de pé. WhatsNimbus desconectado vira
       `skipped` (informativo), **não** reprova o teste.
    Resultado aparece no próprio card em duas linhas ✓/✗/—. Falha de perna volta
    200 com o motivo nos campos (resultado parcial é diagnóstico, não erro 500);
    telefone é resolvido no servidor (sessão viva → estado → numberId canônico),
    nunca vem do cliente. Cooldown de 60s por número, porque cada clique manda duas
    mensagens de verdade e martelar o botão é vetor de ban.

36. [x] Quero tornar obrigatório registrar um telefone ao se cadastrar no sistema.
    (Responde também o item 14.)

    **Feito:** o campo `users.phone` já existia e era dado morto — nascia `""`
    nos quatro caminhos de criação de conta e ninguém lia. Agora é celular
    obrigatório, no mesmo trilho que o CPF já usa: util espelhado
    (`backend/utils/phone.js` ↔ `frontend/src/data/phone.js`), flag
    `phoneRequired` no `/me` e uma tela na entrada pra quem está sem número.
    Sem migration: `phone` continua `String?` e **não** é unique — o mesmo
    número pode ser de mais de uma conta.

    **Formato:** guarda só dígitos com o 55 na frente (`5511999999999`), que é o
    que `jidFromPhone` consome e o que a UI já assumia ao mostrar `+${phone}`.
    Aceita digitado de quatro jeitos ("(11) 99999-9999", "11999999999",
    "5511999999999", "+55 11 …"). Valida DDD contra a lista real e exige o nono
    dígito 9: **fixo é recusado de propósito**, o número existe pra virar
    conversa de WhatsApp. DDD 55 (RS) não se confunde com o 55 do país porque a
    poda só acontece em string de 13 dígitos.

    **Onde é coletado:** cadastro por e-mail/senha, popup da landing
    (`lead-modal.php`) e `/assinar` — nesses dois é aqui ou nunca, porque a conta
    nasce do pagamento aprovado e não existe "primeira entrada" antes de cobrar.
    Google fica de fora do formulário (o Google não devolve telefone).

    **Quem já tinha conta:** vê a tela "Confirme seu telefone" na entrada, com um
    **"Agora não"** que libera o painel e volta a pedir na entrada seguinte. O
    pulo vive em `sessionStorage`, não no banco — sessão de navegador é
    exatamente a janela do "próxima entrada", e não precisou de coluna nova.
    Admin é isento, igual ao CPF.

    **O pulo não vale pra pagar:** `/api/billing/checkout` recusa com
    `phone_required` enquanto a conta estiver sem número, e a página de
    Assinatura mostra o campo pra resolver ali mesmo (antes do `window.open`, que
    senão deixaria uma aba em branco pendurada). Configurações também passou a
    mascarar e validar o campo — era por `PATCH /api/auth/me` que entrava
    qualquer texto no telefone.

37. [x] Quero poder ativar um trial de X dias gratuito no plano em que eu escolher manualmente lá na aba de usuarios de ADMIN. Pode ser um botão "Adicionar Trial" que vira "Desativar Trial" se já estiver ativo, quando clico no botão quero que apareça as opções de quantos dias e qual plano. Esse trial não tem NADA a ver com o trial de 1 real. O trial de 1 real e as assinaturas pagas sobrepoem este trial manual. Quero fazer isso para poder ter controle sobre as contas dos usuarios e dar beneficios/fazer testes.

    **Feito:** botão "Adicionar trial" / "Desativar trial" em Admin › Usuários, com
    modal de plano + duração (presets 7/14/30/60 ou livre) e observação. Vive nas
    colunas `manualTrial*` da própria `subscriptions`, então `limits.effectivePlanId`
    e `billing.isActive` resolvem tudo — nenhum ponto de gating precisou mudar.
    Assinatura paga (e o trial de R$1) vencem a cortesia; ela fica dormente e
    reassume sozinha se a assinatura cair antes da data de fim. Não consome
    `trialUsedAt`. O usuário vê "Cortesia Nimbus Pro até dd/mm" na aba Assinatura
    (e os cards de plano continuam clicáveis, inclusive o da cortesia) mais um aviso
    no topo do app nos 3 últimos dias. Filtro "Cortesia" novo na lista de usuários.

    **Cobrança:** quem assina durante a cortesia escolhe num modal o que fazer.
    "Manter a cortesia" (default) segue no plano da cortesia até a data de fim sem
    pagar nada, e o plano contratado entra junto com a primeira cobrança.
    "Começar agora" encerra a cortesia, cobra hoje e o plano contratado vale na
    hora — a cortesia é consumida e não volta. Nenhum dos dois queima o teste de
    R$1, que deixa de ser oferecido enquanto a cortesia corre. Cortesia acabando
    em menos de 48h cobra normal (piso do Stripe pro `trial_end`).

38. [x] na aba de Usuarios de ADMIN, acrescenta mais um filtro ali para os "Operando".

    **Feito:** dois chips novos na fileira de filtros, logo depois de "Pagando".
    **Operando** usa o mesmo critério do card que já existia (campanha ativa — nem o
    usuário nem o plano pausaram — E pelo menos um número de WhatsApp conectado agora),
    então o número do chip e o do card nunca divergem. **Parados** é o complemento
    acionável: está pagando ou em cortesia e NÃO está operando — quem paga e não usa.
    Quem não tem plano nem cortesia não entra em "Parados". Só frontend
    (`AdminUsers.jsx`): a lista já vinha inteira do backend com `counts.activeGroups` e
    `counts.connectedNumbers`, e a filtragem desta tela sempre foi no cliente. Os dois
    chips carregam a definição no `title`, como os cards.

39. [x] deu alguns problemas com alguns usuarios na conexão dos whats. De uma boa revisada para deixar bem redondo e funcionando certinho, sem criar conexoes fantasma, sem dar erros, é uma parte bem importante do sistema.

    **Causa raiz:** o sistema abria MAIS DE UM socket Baileys pro mesmo número.
    `startSession` só era idempotente pra sessão já `connected`, então uma chamada
    durante o QR/reconexão criava um segundo socket sem fechar o primeiro — os dois
    mutavam a mesma sessão e gravavam chaves Signal conflitantes na mesma linha de
    `baileys_auth` (daí os `Bad MAC` no `worker-error.log`). O WhatsApp trata duas
    conexões do mesmo número como conflito, remove o device, e aí sim o usuário cai
    de verdade. Somava-se a isso o timer de reconexão não rastreado: `deleteSession`
    apagava a sessão e o timer pendente a recriava segundos depois com credenciais
    novas, emitindo QR pra ninguém — a "conexão fantasma".

    **Feito:**
    - **Um socket por número.** `startSession` virou single-flight (chamadas
      concorrentes compartilham a mesma abertura), curto-circuita por *socket vivo*
      e não mais por status, encerra e desregistra o socket anterior antes de abrir
      outro, e cada socket carrega uma geração (`isCurrentGen`) que faz o handler de
      um socket substituído virar no-op. `fetchLatestBaileysVersion` passou a ser
      cacheada (6h) com timeout — era a chamada de rede que fazia o job da fila
      passar de 30s, virar "stalled" no BullMQ e ser reexecutado, dobrando o socket.
    - **Timers de reconexão rastreados**, com jitter, cancelados no `deleteSession`,
      na canonicalização e no `closeAll`. Sessão apagada não ressuscita mais.
    - **401 nem sempre é logout.** Depois de um close por conflito, a reconexão volta
      um 401 seco; `classifyClose` agora só chama de logout o 401 fora de uma janela
      de 60s do último conflito (com teto de tentativas) e em sessão já registrada.
      No logout REAL as credenciais mortas são apagadas — antes ficavam e o worker
      re-tentava a cada boot, enchendo o log de 401 e de erros de decrypt. O snapshot
      `logged_out` fica 7 dias no Redis só pra tela mostrar "Desconectado (relogar)".
    - **Status obsoleto parou de contar como conectado.** Se o worker morre sem
      `closeAll` (OOM, SIGKILL), o snapshot no Redis ficava "connected" por 24h e o
      painel, o card "Operando" e o `counts.connectedNumbers` mentiam. Agora toda
      leitura passa por `decaySnapshot` (sem heartbeat de worker vivo, ou snapshot
      parado além de 180s → `disconnected`), o `local.js` republica de 60 em 60s pra
      essa idade significar algo, e o `restoreSessions` reconcilia as chaves órfãs no
      boot. `connectedNumbers` passou a contar números do painel, não sessões.
    - **Fila `control` não executa job velho.** Com o worker fora, os pedidos se
      acumulavam e disparavam todos juntos na volta. Agora cada job leva `enqueuedAt`
      e é descartado se o chamador já desistiu; o worker do BullMQ ganhou
      `lockDuration`/`stalledInterval` de 60s (o default de 30s era menor que ops
      legítimas de 60s).
    - **Frontend.** Número ausente do poll passou a significar "sem sessão no
      servidor" em vez de cair no status salvo (quase sempre "connected") — a tela
      mostrava conectado o que não estava. O poll agora é um só, no `App.jsx` (a
      página repetia o mesmo GET a cada 8s, sem recuo em 429), e `GroupDashboard` e
      `Configurações` passaram a receber os números com status ao vivo. A sessão
      provisória do QR é apagada no `beforeunload`/troca de página com `keepalive`,
      com uma varredura de órfãs no backend como rede de segurança.
    - **Restore de backup não sequestra mais as sessões de produção.** O
      `deploy/start.sh` oferece restaurar o dump da nuvem no banco local; junto vinham
      as credenciais de device dos usuários reais, e subir o worker aqui abria um
      device duplicado que derrubava o WhatsApp deles. `restore-remote.js` agora
      pergunta à parte se traz o `baileys_auth` junto: responda S só na máquina DONA
      das sessões (recuperar a própria produção), N (padrão) quando o banco é cópia.
      Sem terminal, o padrão é não trazer. Flags: `--keep-sessions` / `--drop-sessions`.

    **Isso NÃO exige reconectar os números.** Um deploy normal (pull + restart) não
    apaga credencial nenhuma: restart do worker, queda de rede, 515 pós-scan, conflito
    e timeout continuam preservando a auth. Só apagam credencial o logout REAL
    (device removido no aparelho — a sessão já estava morta de qualquer jeito), a
    sessão que nunca chegou a parear, e o `deleteSession` que o próprio usuário pede.
    O único caminho que derrubaria todo mundo é responder "S" no restore de backup
    numa máquina que não é a dona das sessões — que é justamente o que a pergunta nova
    passou a evitar.
    - **Testes:** `whatsapp-ghost-session` (socket único + timer cancelado, com
      Baileys stubado — falha em 5 dos 6 casos contra o código antigo),
      `whatsapp-session-guard`, `whatsapp-status-decay`, `whatsapp-control-expiry`,
      mais os casos de eco de conflito no `whatsapp-close` e o caso de tela do
      `WhatsAppStuck`. O filtro do `npm run test:whatsapp` foi alargado de
      `whatsapp-close` pra `whatsapp`.

    **Fora do escopo (decidido):** trava de dono de sessão entre instâncias no
    Postgres. Se o problema voltar, o passo barato é uma claim
    `SET nimbus:worker:heartbeat NX` pro worker recusar boot com outro vivo.

40. [x] pq da "Aguardando mensagem. Essa ação pode levar alguns instantes" nas msg que a nimbus envia no sistema, no privado? No grupo de config quando envio o teste fica normal. Tb teve um usuario que mandava msgs no grupo dele e fica aparecendo isso tb

    **Causa raiz:** esse texto é o WhatsApp do DESTINATÁRIO dizendo que recebeu o
    pacote mas não conseguiu decriptar (sessão Signal nova ou com o ratchet
    dessincronizado — os 325k `Bad MAC` do `worker-error.log`). Nessa hora o celular
    dele manda um *retry receipt* de volta pedindo o reenvio, e o Baileys sabe
    atender: `sendMessagesAgain` recupera a mensagem original chamando o callback
    `getMessage(key)` do `makeWASocket` e a repassa forçando sessão nova. **Nós não
    passávamos esse callback**, então valia o default do Baileys
    (`async () => undefined`): o reenvio nunca saía e o placeholder ficava no celular
    do usuário pra sempre. Falhar a decriptação é normal no WhatsApp; o bug nosso era
    o retry ficar sem resposta.

    O privado sofre mais que o grupo de config porque uma DM precisa de sessão
    par-a-par com cada dispositivo do destinatário, e a primeira mensagem de uma
    sessão nova é justo a que falha — o grupo de config já tem a *sender key*
    estabelecida e reusada. O caso do outro usuário no grupo dele é o mesmo
    mecanismo: quando a sender key roda (alguém entra/sai, aparelho novo, socket
    reiniciado), a próxima mensagem renegocia, falha igual e o retry morre igual.

    **Feito:**
    - **`backend/whatsapp/msg-store.js`** (novo): as últimas mensagens que este
      processo enviou, em memória, chaveadas pelo `id` puro — o `remoteJid` do
      receipt pode vir na forma LID enquanto gravamos a PN, então casar por jid
      perderia justo os casos que interessam. Teto de 1000 (evicção FIFO) e TTL de
      1h, ambos por env; expira na leitura, sem timer segurando o processo vivo.
    - **`getMessage` no socket** (`local.js`), servido pelo store, e `sendText`/
      `sendImage` alimentando o store com o proto como veio — no caso da imagem o
      reenvio reaproveita as media keys em vez de subir o arquivo de novo.
    - Só em memória e no mesmo processo do socket que recebe o receipt: a janela real
      de retry é de segundos a poucos minutos (`maxMsgRetryCount` do Baileys é 5).
      Um restart do worker perde os pendentes daquele instante — trade-off aceito em
      troca de zero infra nova. Nada muda no modo Redis: o socket só existe dentro do
      `local.js`, e o `worker.js` segue reduzindo o retorno do envio a `{ ok, key }`.
    - Testes: `unit/whatsapp-msg-store.test.js` (teto, TTL, retorno malformado) e
      `unit/whatsapp-retry-getmessage.test.js`, que trava as duas pontas — o socket
      nasce com o callback e o que sai por `sendText`/`sendImage` volta por ele.

    **Não feito (atacam a FREQUÊNCIA das falhas de decriptação, não o sintoma):**
    `cachedGroupMetadata` (hoje todo envio em grupo dispara um IQ de `groupMetadata`);
    `keys.set` atômico em `auth/baileys-pg.js` (hoje é `Promise.all` de upserts
    soltos — morrer no meio grava metade do ratchet e o peer nunca mais decripta);
    `makeCacheableSignalKeyStore` (hoje cada mensagem decriptada custa um SELECT por
    chave Signal no PG; só é seguro enquanto um único worker for dono de cada sessão).

41. [x] Quero que o nome da conexao que aparece no whats seja diferente no modo ngrok, quero que aparece TESTE ou algo do tipo. Hoje aparece Google Chrome (Nimbus) quero que no modo ngrok de testes apareca Google Chrome (Teste).

    **Feito:** o rótulo do device saiu do hardcode e virou `deviceLabel()` em
    `backend/whatsapp/local.js`: `NIMBUS_MODE=prod` (ou ausente) → "Nimbus",
    qualquer outro modo (ngrok, e2e) → "Teste". `WHATSAPP_DEVICE_LABEL` sobrepõe,
    se um dia uma segunda máquina de teste precisar de nome próprio. Só o
    `browser[0]` muda: `browser[1]` ("Chrome") é o que o Baileys passa pro
    `getPlatformType`, então mexer ali mudaria o TIPO do device em vez do texto
    entre parênteses.

    **Vale só pra pareamento NOVO.** O campo viaja no registro do device
    (`generateRegistrationNode`, que manda `browser[0]` como `os`); sessão que já
    tem credencial reconecta por `generateLoginNode`, que não reenvia isso. Então
    número já conectado continua "Google Chrome (Nimbus)" na lista do celular até
    ser removido e escanear um QR novo — que é justamente o fluxo do modo ngrok,
    porque ele sobe com banco local e o `restore-remote.js` pergunta à parte antes
    de trazer o `baileys_auth` (task 39).

    **Por que importa:** a máquina de testes pareia no MESMO celular que a
    produção, e com os dois devices chamados "(Nimbus)" não havia como saber qual
    desconectar.

    **Teste:** `unit/whatsapp-device-label.test.js` — captura o config entregue ao
    `makeWASocket` e trava os quatro casos (prod, ngrok, modo qualquer, override),
    mais a guarda de que `browser[1]`/`browser[2]` não mudam.

42. [x] Tenho um usuario do sistema que disse que as mensagens no whats ficam no "Aguardando...", quero que tu analise as melhorias possiveis de serem feitas para evitar ao maximo isso em todas as situacoes. Tem que refazer algo na sessao quando isso acontece? Quero saber todos os motivos e todas as possiveis solucoes.

    **Resposta curta: NÃO precisa refazer a sessão** — e refazer é o remédio
    errado. O que precisa ser refeito é a sessão **Signal daquele destinatário**,
    e o Baileys já faz isso sozinho ao receber o retry receipt
    (`assertSessions(..., true)` + limpeza do `sender-key-memory` do grupo, em
    `sendMessagesAgain`). Apagar a auth e reler o QR (o que o botão "Reconectar"
    faz) não conserta o ratchet do outro lado e ainda derruba o usuário. O único
    caso em que reparear ajuda é credencial NOSSA corrompida — e aí o sintoma é
    desconexão, não placeholder.

    **O que o diagnóstico da task 40/41 revelou.** O log mostrou a mesma
    mensagem sendo reenviada quatro vezes, com `forced new session` no meio, e o
    aparelho continuando a pedir:

        [wa] retry pedido id=3EB0E69FA61D6A5F9E1344 hit #1 … #2 … #3 … #4

    Ou seja: o `getMessage` **funcionava** e o reenvio **saía**. Reenvio que não
    gruda é assinatura de estado Signal que não está sendo persistido. E o motivo
    apareceu no log do dia 02/09: `failed to commit 3 mutations, tries left=9…6`
    junto de `Timed out fetching a new connection from the connection pool` e
    `Can't reach database server`. Quando a gravação falha, o
    `addTransactionCapability` do Baileys tenta 10× e **desiste em silêncio** —
    enquanto isso o `relayMessage` já tinha posto o texto cifrado na rede
    (`messages-send.js` envolve o envio inteiro na transação). O ratchet avança
    na memória e não no banco, e a partir daí aquele peer não decripta mais nada.

    **Todos os motivos, em dois grupos.**

    *Por que a decriptação falha (frequência):*
    1. gravação do key store falhando sem ninguém reagir (o caso acima);
    2. gravação **parcial** — `keys.set` era `Promise.all` de upserts soltos, e
       meio ratchet gravado é pior que nenhum;
    3. envios concorrentes no mesmo socket: a fila `control` roda concurrency 4 e
       o `addTransactionCapability` usa `transactionCache`/`mutations`
       compartilhados com um contador simples — a transação que fecha primeiro
       limpa o cache no meio da outra;
    4. key store lento: um `findUnique` por chave Signal contra um pool de 5
       conexões, sem `makeCacheableSignalKeyStore`;
    5. um IQ de `groupMetadata` ao vivo por envio em grupo, dentro da transação;
    6. pre-key reusada quando o `deleteKey` engolia o erro de gravação
       ("Key used already or never filled");
    7. duas máquinas com a mesma auth (dump de prod na máquina de teste) —
       mitigado na task 39, o `restore-remote.js` trunca `baileys_auth` por padrão;
    8. restaurar dump do banco rebobina o ratchet de todos os peers de uma vez;
    9. device novo do destinatário (trocou de celular, abriu o WhatsApp Web,
       entrou no grupo) fora do cache de devices — normal, o retry resolve;
    10. primeira mensagem para um contato novo falha de vez em quando por
        natureza (pre-key) — normal, o retry resolve;
    11. rajada de envio: a campanha espaça 4s, mas `/broadcast` aceita o intervalo
        do cliente e as notificações não espaçam nada.

    *Por que o placeholder ficava PARA SEMPRE (permanência):*
    12. `getMessage` dando miss depois de um restart — o store era só memória,
        teto 1000, TTL 1h: todo `pm2 reload` de deploy, todo `max_memory_restart`
        e todo crash matavam os retries pendentes;
    13. receipt chegando com o socket em backoff (até 30s) se perde;
    14. teto de 5 reenvios por (id, participante) no Baileys;
    15. erro dentro do `sendMessagesAgain` vira só um `logger.error`;
    16. mensagens enviadas antes da task 40 nunca terão reenvio (histórico).

    **Ruído, não falha:** todos os `miss` recentes do log eram de mensagens
    `category:"peer"` — pedidos internos que o próprio Baileys gera
    (`sendRetryRequest`), que nunca passam por `sendText` e cuja key vem sem
    `remoteJid`. Nunca estariam no store, e reenviá-las não faria sentido.

    **Feito** (1 a 6 e 12 da lista; o resto está registrado abaixo):

    - `auth/baileys-pg.js`: `keys.set` agora é **uma** `$transaction` — tudo ou
      nada; `keys.get` virou **uma** `findMany` com `keyId: { in: ids }` no lugar
      do fan-out de N `findUnique` que estourava o pool; `deleteKey` só engole
      P2025 (linha inexistente) e propaga o resto; e um callback `onPersistError`
      leva a falha pra quem abriu a sessão em vez de ela sumir dentro do retry
      silencioso do Baileys. O `saveCreds` também avisa — é nele que vive o
      contador de pre-keys.
    - `whatsapp/local.js`: o `onPersistError` **derruba o socket** (debounce de
      30s) para que a reconexão releia o estado do banco, em vez de continuar
      enviando com um ratchet que só existe na memória — este é o "refazer" que
      de fato precisa acontecer, e é por sessão, não por QR. As chaves Signal
      passam por `makeCacheableSignalKeyStore`; entrou `cachedGroupMetadata` com
      TTL de 5 min, invalidado em `groups.update`/`group-participants.update`; e
      todo envio de uma mesma sessão passa por uma fila (`withSendLock`), de modo
      que a concurrency 4 da fila `control` nunca coloque dois `relayMessage` no
      mesmo socket. De quebra, quando a **abertura** da sessão falha (Postgres
      fora, que é justamente quando isso acontece) o backoff é reagendado — antes
      a sessão ficava parada pra sempre, porque quem marca o próximo backoff é o
      handler de "close" e não houve socket.
    - `whatsapp/msg-store.js`: ganhou uma camada durável no Redis (só em
      `QUEUE_BACKEND=redis`), `nimbus:wamsg:<id>` com TTL de 24h, e o `get` virou
      async: memória primeiro, Redis no miss, reidratando a memória. Retry
      receipt que chega depois de um restart do worker volta a ser atendível.
      `stats()` diz de onde veio o hit (`memoria`/`redis`), e o `getMessage`
      ignora em silêncio o retry `peer` (sem `remoteJid`).

    **Fica para depois** (nada disso é bloqueio, mas está registrado):
    métricas Prometheus de retry receipt e de decrypt fail (hoje só há
    `console.log`); trava `NX` de dono do worker no heartbeat, que fecharia o
    cenário "duas máquinas com a mesma auth" de uma vez (é a mesma sugestão
    guardada na task 39); espaçamento no `/broadcast` e nas notificações; e uma
    recomendação de ops que não é código: subir o `connection_limit` do
    `DATABASE_URL`, hoje no default 5 do Prisma — o `findMany` e o cache de
    chaves reduzem muito a demanda, mas 5 é apertado para worker + scheduler +
    Baileys no mesmo processo.

    **Testes:** `unit/baileys-auth-atomic.test.js` (transação única, query única,
    `onPersistError` avisando e propagando), `unit/whatsapp-send-mutex.test.js`
    (dois envios da mesma sessão não se sobrepõem, envio que falha não trava a
    fila, sessões diferentes seguem em paralelo),
    `unit/whatsapp-msg-store-redis.test.js` (sobrevive ao restart, revive pra
    memória, Redis fora do ar não derruba envio nem busca) e as extensões em
    `unit/whatsapp-retry-getmessage.test.js` (chaves embrulhadas em cache,
    `cachedGroupMetadata` com invalidação, retry `peer` em silêncio).

43. [] Além do QRCode, da pra entrar no whats com codigo tb, certo?  Quero acrescentar esta opção.

44. [x] Fiz o teste de whats e a msg pra mim mesmo fica só em "Aguardando mensagem". Da uma olhada no pq.

    **A causa que faltava na task 42: o endereço LID.** O WhatsApp migrou o
    endereço interno de cada aparelho do telefone (**PN**, `555596168060`) para
    um número opaco novo (**LID**, `4269197504618`). O Baileys 6.7.23 não tem o
    mapa PN↔LID — ele compara a identidade própria só contra `creds.me.id`, que
    é sempre PN. A task 42 concluiu que "reenvio que não gruda = estado Signal
    não persistido"; era só metade. A outra metade é que o reenvio saía **montado
    errado**.

    **Evidências (produção, 06/09 ~10:51).** O teste de conexão manda duas
    mensagens: o auto-DM (`3EB0209FB184CAFC09533E`) e a perna do WhatsNimbus
    (`3EB0CAD58ED9813E31AE78`). A segunda pediu reenvio 4 vezes (`hit #1`..`#4`,
    o teto do Baileys é 5) e nunca colou. O envio sai por
    `jidFromPhone()` → `…@s.whatsapp.net` (PN), mas **todos** os retry receipts
    chegaram em LID (`4269197504618:47@lid`). E o `worker-error.log` mostra que
    nós também não decriptamos o que vem de volta: `Bad MAC` em
    `async 4269197504618.47` — o endereço LID, não o PN. No banco, a prova
    direta: `baileys_auth` tem `555596168060.47` **e** `4269197504618.47` lado a
    lado — dois ratchets independentes para o mesmo celular (21 pares assim).

    **Os quatro pontos quebrados**, todos em
    `lib/Socket/messages-send.js` do Baileys:
    1. `const isMe = user === meUser` compara o user LID do device com o nosso
       user PN → dá `false`, e **o celular do próprio usuário cai em `otherJids`**,
       recebendo a cópia sem o envelope `deviceSentMessage`. É *este* o motivo de
       o auto-DM ficar em "Aguardando mensagem": o aparelho recebe uma mensagem
       que não consegue interpretar como enviada por ele mesmo.
    2. o fanout empurra `{ user: meUser }` (PN) num destino LID; o `jidEncode`
       seguinte monta `<telefone>@lid`, um endereço que não existe.
    3. no caminho de retry, `areJidsSameUser(participant.jid, meId)` falha com o
       participante em LID e o stanza de reenvio sai sem o atributo `recipient`.
    4. `extractDeviceJids` exclui o nosso device comparando com o id PN; em LID
       a exclusão falha e o socket entra na própria lista de destinatários.

    **Feito.**
    - `patches/@whiskeysockets+baileys+6.7.23.patch` (via `patch-package`, com
      `postinstall` e a dependência em **produção** porque o deploy roda
      `npm install --omit=dev`): helpers `selfPnUser`/`selfLidUser`/`isSelfUser`
      no escopo do socket, e os quatro pontos acima passam a enxergar os dois
      espaços de endereço. De quebra, `authState.creds?.me?.lid.split(':')[0]`
      deixa de estourar quando a conta ainda não tem `lid`.
    - `scripts/fix-lid-sessions.js`: apaga os pares PN×LID que já divergiram
      (o patch impede novos, não desfaz os antigos). Dry-run por padrão; só
      apaga com `--apply`; nunca toca em `creds`. Pareia por device mas **só
      confia** no mapeamento visto em 2+ devices ou provado por algum
      `creds.me` — o número do device é por conta, e sem essa trava ele apagaria
      sessões de contatos que só coincidem no device (aconteceu no dry-run:
      `555596168060.41 ↔ 155439312412685.41`, corretamente listado como ambíguo).

    **Fica para depois:** migrar para o pacote `baileys` 7.x, que tem
    `LIDMappingStore` nativo e resolve isso na raiz. Hoje está em release
    candidate (7.0.0-rc14), muda o nome do pacote, exige adaptar o auth-state
    (novo tipo de chave `lid-mapping`) e provavelmente reler o QR de todos os
    números. O patch acima é a ponte até a versão estável.

    **Testes:** `unit/whatsapp-lid-patch.test.js` (alarme para o caso de um
    `npm install` desfazer o patch em silêncio — é a falha mais provável daqui
    pra frente) e `unit/whatsapp-lid-sessions.test.js` (o pareamento PN×LID:
    números antigos de 8 dígitos contam como PN, LIDs reais de produção não,
    candidato de um device só é ambíguo e fica de fora).

45. [] O que foi feito para não ter mais o aguarde das msg no whats, que rodei o script manualmente, roda regularmente para acabar com isso? Como faço para rodar? Um botão na aba de usuarios no ADMIN por exemplo?
