
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

14. [] Quero exigir telefone dos usuários. Como tu sugere que seja feito?

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

29. [] Na busca dos cupons quero ver o progresso da raspagem dos cupons.

30. [] Como funciona o vinculo dos produtos dos cupons com os produtos que ja fiz scraping, o sistema percebe quando sao o mesmo produto e ja vincula? Os cupons ficam vinculados?

31. [] Quando coloco a palavra para descobrir palavra dos cupoms diz que reconheceu e que é da campanha de numero 14193894 por exemplo. Queria que as campanhas quando forem buscadas, tivessem esse numero associado para que seja facil vincular campanha a palavra. Por exemplo, no link do cupom https://lista.mercadolivre.com.br/_CustId_2903552873?coupon_campaign_id=13495993 tem ali o ID, não seria este mesmo? NAO PRECISA FAZER TODOS OS TESTES DO SISTEMA NOVAMENTE, SÓ ESPECIFICOS PARA O QUE FOI ALTERADO.

32. [] Consigo buscar um cupom pelo ID dele?

33. [] Consigo entrar no PC da VPS que tem linux, instalar o chrome com a extensão e fazer o captcha manualmente quando necessario? Para automatizar a busca por cupom ou as coisas que precisam de captcha

34. [x] Quero trocar o ? que tem embaixo das telas por um simbolo do whatsapp para contatar o suporte que encaminhe para https://wa.me/55997140686

35. [] Adiciona um botão para testar se o Whats esta conectado la no card de cada numero conectado do Whatsapp. Nele dispara uma mensagem teste do WhatsNimbus do sistema que envia para o numero no privado, assim consigo testar se esta conectando e funcionando na pratica.

36. [] Quero tornar obrigatório registrar um telefone ao se cadastrar no sistema.

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

38. [] na aba de Usuarios de ADMIN, acrescenta mais um filtro ali para os "Operando".

39. [] deu alguns problemas com alguns usuarios na conexão dos whats. De uma boa revisada para deixar bem redondo e funcionando certinho, sem criar conexoes fantasma, sem dar erros, é uma parte bem importante do sistema.
