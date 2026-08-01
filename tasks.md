
1. [x] Assinatura e Stripe: Hoje o stripe já ta funcionando, consegui realizar um pagamento ficticio com a parte de testes dele em uma conta da nimbus. Porém contratei a conta Business e ele continuou na Pro, é preciso revisar isto. 

2. [x] Conta nova Assinatura: Quero tirar esses 7 dias grátis de conta PRO iniciais.

3. [x] Quero conferir que se o número de WhatsApps, número de campanhas e número de grupos por campanha, categorias de produtos por campanha, está sendo respeitado de acordo com a assinatura do cliente. Por enquanto as diferenças entre os usuários é a seguinte:

Básico: 69,90; 1 número de WhatsApp; 1 campanha; 3 grupos por campanha; 2 categorias por grupo.

Pro: 99,90; 3 número de WhatsApp; 5 campanhas; 15 grupos por campanha; quantas categorias quiser por grupo.

Business: 14,90; 5 número de WhatsApp; campanhas ilimitadas; grupos ilimitados por campanha; quantas categorias quiser por grupo.

4. [x] As notificações de Admin estão sendo enviadas pelo whats da conta do usuario, quero que seja enviado pelo WhatsNimbus em um grupo específico informado pelo ADMIN a partir dos grupos que o WhatsNimbus faz parte. Inclusive adicione aqui pesquisa do grupo pelo nome.

5. [x] Quero poder editar as mensagens de notificações que são enviadas através de um menu Modelos Notificações no painel de Admin. Inicialmente elas podem estar escritas como estão, ai faço as alterações por cima.

6. [x] Criar extensão no chrome para pegar as credenciais e cookie do ML automaticamente.

7. [x] Verificar onde é necessário e está faltando pooling para atualizar a página em tempo real. Nas campanhas de repasse por exemplo, é avisado que tem produto a ser aprovado pelo Whats, mas preciso dar F5 na página. Imagino que aconteça para campanhas normais também.

8. [x] Campanha de Repasse:
    8.1. [x] Trocar o aba de Repasse para antes da aba Grupos.
    8.2. [x] Tirar explicação "Esta é uma campanha de repasse. ....". Talvez fazer isso aparecer na primeira vez que uma pessoa c ria uma campanha de repasse e expandir para outros setores do sistema para primeiras vezes. Pode ter ainda um botãozinho de ajuda que informa o que é a página.
    8.3. [x] Ao procurar o grupo líder em uma campanha já existente, acrescentar pesquisa por nome
    8.4. [x] Acrescentar pesquisa por nome também na hora da criação da campanha de repasse para achar o grupo líder mais fácil.

9. [x] Ao criar grupos de Whats, tirar opção de criar com o WhatsNimbus. Se o usuário tentar criar sem passar nenhum outro número (sozinho), basta criar um número passando o próprio número do usuário como se fossem 2 números, mas na realidade são iguais. Se não ficou claro, me pergunte.

10. [x] Quando o usuário tem uma assinatura ativa, mude a tela de assinatura para aparecer seus benefícios junto com a informação do plano atual e também deixe os planos maiores, se existirem, com menos destaque. Quero que puxe informações do stripe para dizer até quando vai ficar ativo, mesmo se for cancelado. Da uma olhada em como ta, me faça perguntas para alterar como funciona a página para fazer um plano e ter a melhor forma possível.

11. [x] Repasse -> as vezes o link do produto vem como afiliado, em uma página diferente, como em https://www.mercadolivre.com.br/social/oreidapromobr?matt_word=orpcami&matt_tool=37515304&forceInApp=true&ref=BMzx%2BB%2BJzXYiDBLAlICsACrMd3anZ%2B1VMHKghql01swINfTi6PEffWt4EMfbJoNSx1oZhOaPpSaqKCDJ6shB5b8rPFSRFvoRarzrlDxIUvHGDPyy9VkBIm1uKfmvR1aA8saDF5BPM82is0k4tds%2B2IBDXCKN%2BWwadJFE1Um5zgkijOE5J%2FLIR1EWUY3wJfhs8OrSoA%3D%3D, ver as possibilidades
    

12. [x] Quero alterar os campos das lojas especificas no menu admin para editar manualmente, esta bugado.

13. [x] Quero separar a qtd maxima de produtos por loja no scraper

14. [x] Na aba Shopee, Invés de App Scret escreva Senha. E o site onde pego tanto App ID quanto a Senha é  affiliate.shopee.com.br/openapi, pode colocar como clicavel direto e nao precisa ter o caminho do site home como esta agora.

15. [x] Quero Ter um botao em cada aba de loja no ADMIN onde eu altero os filtros do scraping para trancar o acesso à aba daquela loja e esconder trancar a escolha delas dentro das campanhas. Quando o usario tenta acessar ou clica para escolher aparece uma mensagem que vira em breve ou em manutencao (quero poder escolher e editar essa mensagem tambem no menu de cada uma do ADMIN). 

16. [x] Scraping mercado livre buscar todas as infos

17. [x] nas camapanhas adicionar link manual deve ser movido da aba de busca de produtos direto para a aba de fila e tb quero que ele busque avaliacao e numero de vendidos.

18. [x] verificador scraper de x em x tempo

19. [x] Adicione filtro de desconto minimo no filtro scraping ML na aba de ADMIN, hoje so tem desconto maximo.

20. [x] Filtro de scraping das lojas é mantido com queda e volta do sistema? Tem persistencia? Arrumar se nao tiver.

21. [x] Faz um restart.sh na pasta deploy para rodar o stop.sh e depois o start.sh em seguida, respondendo sempre N para a requisicao de atualizar o blackbaze que tem no start.

22. [x] Na fila adiciona um botao em todos os produtos que nao sao o primeiro, para mover ele direto para o primeiro a ser enviado, tipo um trazer para frente, trazer para primeiro, ou algo do tipo.

23. [x] Ao clicar em sair para fazer logout quero que apareca um popup perguntando se tem certeza

24. [x] Na aba do Mercado Livre, Para pegar o cookie é necessario utilizar uma extensao do chrome disponivel em https://chromewebstore.google.com/detail/extrator-nimbus/jppbabekibjgclmbacibonalflchgdlh?authuser=0&hl=pt-BR . Substitui ali no escrito do Como Pegar uma breve explicacao com emcaminhamento para a baixar a extensao. 

25. [x] Adicione um atalho para ir ate o tutorial nas abas das lojas onde se configura os afiliados ML, amazon e shopee.

26. [x] Exemplos de preenchimento dos afiliados todos fakes. Conferir para nao ter nada real.

27. [x] O menu lateral escreve "Plano Pro" fixo pra todo usuario, mesmo quem esta no Basico ou sem plano nenhum. Puxar o plano de verdade da assinatura. E quando eu salvo alguma coisa na campanha aparece "✓ Salvo!" na hora, mas se der erro no servidor nao avisa nada e eu perco a alteracao achando que salvei - quero um aviso na tela com botao de tentar de novo. Tirar tambem os alertas feios do navegador (window.alert/confirm) que sobraram no WhatsApp e no Limpar catalogo do admin, trocar por aviso e popup do proprio sistema.

28. [x] Melhorias de teclado e nos popups:
    28.1. [x] ESC fecha o popup, e travar o scroll da pagina de tras enquanto o popup esta aberto.
    28.2. [x] Ao abrir o popup o cursor ja tem que ir pro primeiro campo.
    28.3. [x] Se eu clicar fora sem querer num popup de formulario (nova campanha, adicionar numero, salvar modelo) ele nao pode fechar e jogar fora o que eu digitei. Nos popups so de confirmar pode continuar fechando.
    28.4. [x] Enter no formulario de nova campanha tem que criar a campanha, hoje nao faz nada.
    28.5. [x] Navegando de Tab nao da pra ver onde eu estou, nao tem nenhuma marcacao de foco. E os botoes nao dao nenhum retorno quando passo o mouse. Arrumar os dois.
    28.6. [x] Botoes que so tem icone (lapis de editar apelido, X de fechar, menu ☰) nao tem nome nenhum pra leitor de tela.

29. [x] Tema escuro: os avisos amarelos e vermelhos foram feitos com cor fixa clara e viram manchas claras no meio da tela escura. Trocar por cores que mudam junto com o tema. Os badges pequenos podem ficar como estao.

30. [x] O sistema inteiro fica no mesmo endereco, entao nao da pra usar o botao voltar do navegador nem mandar link de uma campanha pra alguem. Quero cada pagina com seu proprio endereco e /campanha/id pras campanhas. O voltar do navegador tem que continuar perguntando se tem alteracao nao salva. Conferir que dar F5 numa campanha nao da 404 no servidor.

31. [x] Quero que os valores dos planos de assinatura sejam atualizados automaticamente com o que vem so stripe. Verifique se precisa e adicione um teste pra isso.
    ATENCAO: os precos no Stripe HOJE sao 49,00 / 99,00 / 199,00 — diferentes dos 69,90 / 99,90 / 149,90 que o site mostrava. Depois do restart do backend o site passa a mostrar os do Stripe. Se os valores certos sao os antigos, corrija no painel do Stripe.

32. [x] Verificar se o backup ta sendo o ideal em tempo e espaco, ate quanto tempo de armazenamento de um backup esta disponivel, etc...
    Achado principal: o envio horario pra nuvem estava quebrado (cron usava node v12) — so o job diario das 3h funcionava. Consolidado num cron horario unico, retencao remota de 30 dias e alerta no WhatsApp se o backup parar.
    PENDENTE (manual): guardar a BACKUP_ENC_KEY fora do servidor; `pm2 delete nimbus-backup-remote && pm2 save`.

33. [x] Verificar se a infraestrutura atual consegue atender a demanda.

34. [x] Quero decidir o que acontece se o usuario cancelar a assinatura ou fazer downgrade de plano
    Decisao: nada e apagado. O que passa do limite fica "pausado pelo plano" — continua
    na tela e editavel, mas nao envia e nao conta no limite. O cliente escolhe o que fica
    ativo (botao Ativar troca com um dos ativos). Cartao que falha ganha 3 dias de carencia
    antes de pausar. Numeros de WhatsApp excedentes seguem conectados, so pausados.
    Retencao: dados guardados enquanto a conta existir (tirado o texto que prometia 30 dias). 

35. [x] Trocar aba grupos para depois da fila e janelas de envio para depois do modelo de mensagem.
    Nova ordem das abas: Visão geral · Gerenciar · Busca de Produtos · Fila · Grupos · Modelos Mensagens · Janelas de envio · Histórico.

36. [x] Na primeira configuracao de uma campanha quero que o front va guiando a pessoa na configuracao.
    Decisao: sem passo a passo dentro da campanha. Quem faz esse papel e o tour da campanha (task 38),
    que explica pra que serve cada aba e comeca sozinho na primeira campanha aberta.

37. [x] Quero que ao criar a conta o usuario seja guiado tomando as decisoes do que vai utilizar e va configurando o sistema.
    Decisao: sem tela de boas-vindas com perguntas e sem lista de pendencias. Quem recebe a conta nova
    e o tour do painel (task 38), que roda sozinho no primeiro acesso e mostra onde fica cada coisa —
    inclusive o plano, os afiliados e o WhatsApp, que sao o que precisa ser configurado.

38. [x] Quero ter um tour de highlights que mostre ao usuario onde fica cada coisa.
    Tour de holofote sobre a tela real (escurece tudo e ilumina um item por vez, com um balao explicando).
    Dois roteiros: painel e campanha (o do WhatsApp foi removido a pedido). No do painel, o passo das lojas
    ilumina Mercado Livre, Amazon e Shopee juntos. O da campanha entra em cada aba e explica os componentes
    principais dela (31 passos). Setas e ESC no teclado; passo cujo alvo nao existe naquela tela e pulado
    sozinho — no mesmo sentido em que a pessoa esta andando —, entao o tour nunca trava. O balao so aparece
    colado no alvo, nunca no meio da tela. Painel e campanha comecam sozinhos na primeira vez.

39. [x] Quero que os guias de configuração do sistema das tasks 36, 37 e 38 estejam disponiveis para serem realizados novamente se o usuario requerir.
    Secao "Tours guiados" no topo de Tutoriais (com selo de concluido e botao Refazer) + botao "?" fixo
    no canto, que oferece o tour da tela atual. O que ja foi visto fica na conta (settings.onboarding),
    nao no navegador. PENDENTE: validar no navegador depois do deploy.

40. [x] Quero adicionar a marca nimbus como icone na aba do navegador e onde geralmente é utilizado. Quero tb que a marca esteja no topo do site. É o N de Nimbus, posso colocar o png em uma pasta que tu sugerir para adicionar esse tipo de asset.

41. [] Quero conferir se o ambiente mobile esta condizente e bem construido para utilizacao do usuario.

42. [x] Quero buscar o nome dos produtos do stripe direto de la para ficar condizente assim como o preco. Tb, quero ter um botao em uma nova aba de ADMIN para trocar entre os produtos em ambiente de teste e ambiente de producao do stripe.
    Nome do produto vem do Stripe junto com o preco (cards da Assinatura, "plano atual" e rotulo da
    sidebar); limits.js so entra como reserva. Nova aba ADMIN > Stripe mostra o modo ativo, o que cada
    modo tem no .env e os produtos em uso, e troca teste<->producao em dois cliques, sem reiniciar.
    Assinatura guarda o modo em que nasceu (coluna stripeMode) e fica inerte enquanto o sistema esta no
    outro modo. Fecha tambem a task 44. PENDENTE: preencher STRIPE_*_LIVE no .env da VPS e validar a
    troca no navegador depois do deploy.

43. [] Todos os erros estao sendo tratados e mostrados ao usuario de maneira apropriada? Por exemplo, quando sistema ta off e o usuario ta em uma pagina fica aparecendo bad gateway ou algo do tipo, preferiria que aparecesse uma mensagem de offline, tente mais tarde ou algo do tipo. Revise bem o sistema.

44. [x] Quero uma maneira facil de trocar entre os produtos do modo teste do stripe e os produto de producao. Ja criei os produtos na producao do stripe.
    Feito junto com a task 42: botao na aba ADMIN > Stripe.

45. [] Quero que os grupos de whatsapp sejam criados com a possibilidade de mandar msg apenas pelos admins do grupo.

46. [] Quero fazer um resumo geral do sistema e criar um arquivo na raiz do projeto que explique didaticamente como esta funcionando. Náo sei exatamente tudo que quero no resumo, mas as tecnologias usadas, onde estao os banco de dados, o que tenho guardado em cada um, quais sao minhas camadas de seguranca, como funciona, como esta arquitetado para expansao caso cresca o numero de usuario, onde e como sao feitos os backups e o que tem neles, um resumo do custo computacional das diferentes partes da arquitetura, etc...

47. [] Pack 3meses ,6 meses e 1 ano nos planos

48. [] 

49. [] Fluxo de pagamento com stripe test

50. [x] Limitar usuario por cpf. Acrescentar essa info em todo fluxo de compra.
    Uma conta = um CPF (`users.cpf` UNIQUE). Os botões da landing abrem um popup
    pedindo e-mail e CPF, e o sistema decide antes do Stripe: CPF de outra conta
    ou plano ativo bloqueiam e mandam entrar na conta. Contas antigas informam o
    CPF na primeira entrada. O teste de R$ 1,00 continua só no Bronze — o texto
    da landing que prometia "todos os planos" foi corrigido.

51. [x] Adicionar o cpf la no stripe na hora que vai pro pagamento.
    O CPF agora é gravado como documento fiscal do cliente no Stripe (tax ID
    br_cpf), e não só como anotação interna — aparece no cadastro, nas faturas e
    nos recibos. Como o cliente do Stripe passou a ser criado ANTES do pagamento,
    o CPF já vale na primeira fatura. Vale para os dois caminhos: quem vem da
    landing e quem assina por dentro do sistema.

52. [x] Na LP (index.php) ao tentar assinar o plano de 1 real ou qualquer um dos outros 3, no popup, se entrar com mesmo email e cpf de uma conta ja criada e com assinatura, aparece botoes com as opcoes de assinar os planos maiores. Se for o plano maior apenas informa.
    O popup mostra os planos maiores que o atual com nome e preço; quem já está
    no maior plano só recebe a informação e o botão de entrar. A mesma tela vale
    em /assinar. Quem decide quais planos aparecem é o backend, então a regra
    mora num lugar só.

53. [x] Na LP (index.php) ao tentar assinar o plano de 1 real ou qualquer um dos outros 3, se entrar com mesmo email e cpf de uma conta ja criada e com assinatura, mas ta tentando assinar uma assinatura maior do que a ativa, aparece mensagem explicando a situacao e um botao "Quero assinar o plano mesmo assim" ou algo do tipo como tu sugerir melhor.
    Botão "Quero assinar o {plano} mesmo assim": leva pro login e cai na tela de
    Assinatura com o plano escolhido em destaque, onde a troca cobra só a
    diferença. Não abre um segundo pagamento — duas assinaturas no mesmo CPF
    seriam cobrança dupla. A confirmação é sempre um clique da pessoa.
