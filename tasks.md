
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

41. [x] Quero buscar o nome dos produtos do stripe direto de la para ficar condizente assim como o preco. Tb, quero ter um botao em uma nova aba de ADMIN para trocar entre os produtos em ambiente de teste e ambiente de producao do stripe.
    Nome do produto vem do Stripe junto com o preco (cards da Assinatura, "plano atual" e rotulo da
    sidebar); limits.js so entra como reserva. Nova aba ADMIN > Stripe mostra o modo ativo, o que cada
    modo tem no .env e os produtos em uso, e troca teste<->producao em dois cliques, sem reiniciar.
    Assinatura guarda o modo em que nasceu (coluna stripeMode) e fica inerte enquanto o sistema esta no
    outro modo. Fecha tambem a task 43. PENDENTE: preencher STRIPE_*_LIVE no .env da VPS e validar a
    troca no navegador depois do deploy.

42. [x] Todos os erros estao sendo tratados e mostrados ao usuario de maneira apropriada? Por exemplo, quando sistema ta off e o usuario ta em uma pagina fica aparecendo bad gateway ou algo do tipo, preferiria que aparecesse uma mensagem de offline, tente mais tarde ou algo do tipo. Revise bem o sistema.
    Erro agora passa por 4 camadas e todas devolvem português: o nginx responde JSON
    ({error, code:"server_offline"}) no lugar da página "502 Bad Gateway"; o Express ganhou
    tratador global + 404 JSON e os 47 `res.status(500).json({error: err.message})` viraram
    mensagem genérica + requestId (não vaza mais "Can't reach database server at localhost:5432");
    o http() do api.js normaliza tudo num NimbusError com mensagem pronta pra tela e ganhou
    timeout; e apareceu a faixa "Sem conexão com o Nimbus. Tentando reconectar", que some sozinha
    quando o servidor volta (sonda no /healthz, sem F5). Também: ErrorBoundary (fim da tela
    branca), offline.html quando nem o build carrega, os 6 alert() do navegador viraram faixa
    padrão (AlertBanner), fila que falhava calada agora avisa, form de filtros do ADMIN não
    carrega mais defaults falsos quando o GET falha, e backend fora no boot não joga mais o
    usuário no login. Infra: Redis fora não pendura mais o boot (timeout de 5s + backoff no PM2)
    e o update.sh passou a aplicar o nginx.conf (preservando o HTTPS do certbot).
    PENDENTE: rodar deploy/update.sh na VPS e validar o roteiro manual (pm2 stop nimbus-backend
    com a tela aberta).

43. [x] Quero uma maneira facil de trocar entre os produtos do modo teste do stripe e os produto de producao. Ja criei os produtos na producao do stripe.
    Feito junto com a task 41: botao na aba ADMIN > Stripe.

44. [x] Quero que os grupos de whatsapp sejam criados com a possibilidade de mandar msg apenas pelos admins do grupo.
    Todo grupo criado pelo Nimbus ja nasce com "Enviar mensagens: somente administradores"
    (groupSettingUpdate announcement logo apos o groupCreate). Vale so para grupos novos; se o
    WhatsApp recusar a restricao o grupo e criado do mesmo jeito e o modal avisa pra ajustar na mao.

45. [x] Hoje quais emails sao enviados? Quais estao faltando?

    ANTES existiam 4 e-mails, todos ligados a token: confirmar e-mail no cadastro
    (mais reenvio manual e pelo admin), redefinir senha, "assinatura ativa — crie
    sua senha" (compra pela landing) e confirmar novo e-mail na troca. Ficavam
    todos em backend/auth/mailer.js.

    FALTAVA tudo de cobranca e tudo de seguranca. `invoice.payment_failed` so
    virava log: o cliente com cartao recusado perdia o acesso depois da carencia
    de 3 dias sem nunca ter sido avisado. E nenhuma mexida sensivel na conta
    (senha trocada, admin resetando senha, conta suspensa) avisava o dono.

    AGORA foram acrescentados 16 e-mails, num modulo novo
    (backend/notifications/email/):
      Cobranca — pagamento falhou (com a data limite da carencia), pagamento
      recuperado, plano alterado (dizendo o que foi pausado), cancelamento
      agendado, cancelamento desfeito, assinatura encerrada, teste acabando
      (3 dias antes), carencia acabando (24h antes) e acesso pausado.
      Seguranca — senha alterada, senha redefinida por link, admin redefiniu sua
      senha, conta suspensa, conta reativada, e dois avisos ao e-mail ANTIGO na
      troca de e-mail (pedido e troca efetivada).

    Como nao repete: os de cobranca saem so na TRANSICAO de estado da assinatura
    (backend/billing/notify.js), e toda mensagem passa por uma chave unica na
    tabela email_log — reentrega de webhook do Stripe e o job de lembretes
    rodando 4x por dia nao geram e-mail duplicado.
    Os avisos de "teste acabando" e "carencia acabando" vem de um job proprio
    (backend/billing/reminders.js) que roda de 6 em 6 horas.
    Recibo de pagamento nao foi feito de proposito — o Stripe ja manda.

    FICOU DE FORA (vale virar task nova): e-mail de produto espelhando as
    notificacoes de WhatsApp (sessao caiu, campanha pausada, limite do plano) —
    hoje so por WhatsApp, e inutil quando o numero que caiu e o de destino; e
    alertas de admin (backup falhou, erro de sistema) por e-mail como canal
    reserva, ja que hoje dependem do proprio WhatsApp estar de pe.

46. [x] Limitar usuario por cpf. Acrescentar essa info em todo fluxo de compra.
    Uma conta = um CPF (`users.cpf` UNIQUE). Os botões da landing abrem um popup
    pedindo e-mail e CPF, e o sistema decide antes do Stripe: CPF de outra conta
    ou plano ativo bloqueiam e mandam entrar na conta. Contas antigas informam o
    CPF na primeira entrada. O teste de R$ 1,00 continua só no Bronze — o texto
    da landing que prometia "todos os planos" foi corrigido.

47. [x] Adicionar o cpf la no stripe na hora que vai pro pagamento.
    O CPF agora é gravado como documento fiscal do cliente no Stripe (tax ID
    br_cpf), e não só como anotação interna — aparece no cadastro, nas faturas e
    nos recibos. Como o cliente do Stripe passou a ser criado ANTES do pagamento,
    o CPF já vale na primeira fatura. Vale para os dois caminhos: quem vem da
    landing e quem assina por dentro do sistema.

48. [x] Na LP (index.php) ao tentar assinar o plano de 1 real ou qualquer um dos outros 3, no popup, se entrar com mesmo email e cpf de uma conta ja criada e com assinatura, aparece botoes com as opcoes de assinar os planos maiores. Se for o plano maior apenas informa.
    O popup mostra os planos maiores que o atual com nome e preço; quem já está
    no maior plano só recebe a informação e o botão de entrar. A mesma tela vale
    em /assinar. Quem decide quais planos aparecem é o backend, então a regra
    mora num lugar só.

49. [x] Na LP (index.php) ao tentar assinar o plano de 1 real ou qualquer um dos outros 3, se entrar com mesmo email e cpf de uma conta ja criada e com assinatura, mas ta tentando assinar uma assinatura maior do que a ativa, aparece mensagem explicando a situacao e um botao "Quero assinar o plano mesmo assim" ou algo do tipo como tu sugerir melhor.
    Botão "Quero assinar o {plano} mesmo assim": leva pro login e cai na tela de
    Assinatura com o plano escolhido em destaque, onde a troca cobra só a
    diferença. Não abre um segundo pagamento — duas assinaturas no mesmo CPF
    seriam cobrança dupla. A confirmação é sempre um clique da pessoa.

50. [x] Quero Uma aba de ADMIN onde eu possa editar todos os emails que mandamos no sistema.
    Admin › E-mails lista os 17 e-mails do sistema (links de conta, segurança e
    cobrança) e deixa editar assunto, título, saudação, parágrafos, texto do
    botão e rodapé, com pré-visualização do e-mail de verdade ao lado e botão
    pra mandar um teste pro seu endereço. O visual não é editável de propósito —
    cor, botão e largura vêm de um lugar só, então não dá pra quebrar um e-mail
    escrevendo texto. Variáveis entre chaves ({nome}, {prazo}...) e *negrito*
    com asterisco, igual aos modelos de WhatsApp. Os 13 avisos podem ser
    desligados um a um; os 4 com link (confirmar conta, redefinir senha,
    boas-vindas, trocar e-mail) não, senão ninguém consegue entrar. De brinde,
    esses 4 deixaram de montar HTML na mão e agora escapam o nome do usuário.

51. [x] Quero buscar itens e fazer scraping tb na pagina de ofertas para afiliados do mercado livre em https://www.mercadolivre.com.br/afiliados/hub. Quero que tenha na aba Mercado livre opcoes para por minhas credenciais e fazer login para que seja possivel acessar a pagina. Caso seja necessario logar para ti ter acesso e ver como fazer o scraping, podemos dividir essa tarefa em 2, primeiro logar e te dar acesso utilizando essa aba do MErcado livre e depois uma outra tarefa para implementar o scraping da pagina!
    Esta é a parte 1 — o acesso. Admin › Mercado Livre ganhou o card "Conta do
    Mercado Livre do sistema": você cola o cookie de uma conta ML nossa e clica
    em "Testar acesso ao Hub", que abre a página num navegador de verdade e diz
    se entrou, se pediu login de novo ou se caiu num CAPTCHA. Esse cookie fica
    guardado em lugar separado do cookie que cada cliente cola na aba dele — um
    não enxerga o outro, e o robô nunca raspa usando a conta de um cliente. Sem
    usuário/senha de propósito: login automático no ML esbarra em CAPTCHA e
    código de verificação. Junto veio o comando `node scripts/ml-hub-dump.js`,
    que salva o HTML, um print e as chamadas de dados da página numa pasta —
    é o que me deixa escrever o scraping olhando a página real (tarefa 52).

52. [x] Fazer o scraping das ofertas do Hub de Afiliados do Mercado Livre e mandar
    pro catálogo, usando a sessão da conta do sistema já configurada na 51.
    Feito: o robô agora coleta também as ofertas do Hub e joga no mesmo catálogo,
    junto com as da vitrine pública, sem repetir produto (quem aparece nos dois
    lugares entra uma vez só). A captura da página mostrou que o Hub serve as
    ofertas por uma API interna em JSON — então em vez de "ler a tela" a gente lê
    os dados prontos: preço, preço antigo, desconto, nota, vendas e até a comissão
    que aquele produto paga ("GANHOS 12%"), que fica guardada junto do produto.
    A separação por categoria funciona porque o Hub usa os mesmos códigos de
    categoria do Mercado Livre que a gente já usava. No card da conta do sistema
    tem um checkbox pra desligar isso; e se a sessão expirar, o robô segue
    coletando a vitrine normalmente em vez de parar.

53. [x] Adicione um marcador assim como o "incluir ofertas do HUB no scraping do Mercado Livre" para incluir ofertas da pagina de ofertas padrao que ja existe, assim consigo desativar tb o scraping antigo. Alem disso queria alterar tb a prioridade ali nas configuracoes do ML, se hoje busco 1000 produtos, quero que comece por um ou por outro dando prioridade e o resto é preenchido pelo segundo na prioridade.
    Admin › Mercado Livre ganhou o card "De onde vêm as ofertas": um marcador
    para a vitrine pública (a coleta de sempre) e outro para o Hub, mais a
    escolha de por qual começar. A fonte escolhida enche a cota primeiro — se o
    limite é 1000 e ela trouxe 400, a outra completa os 600 que faltam, sem
    repetir produto. Se a primeira já encher, a segunda nem chega a abrir o
    navegador (economia na VPS). Desligar as duas é barrado: sem fonte o Mercado
    Livre não teria o que coletar — pra isso existe desligar a loja no
    admin-scraper. Uma fonte que falhar (sessão expirada, por exemplo) é pulada
    com aviso no log e a outra segue normalmente.

54. [x] Inclui no teste do scraper, teste para os produtos que vem do hub e tb um teste de qualidade da foto do produto, tem algumas campanhas de repasse aqui que estao enviando fotos de baixa qualidade.

    O ScrapTester agora tem uma coluna só do Hub, ao lado de Mercado Livre,
    Amazon e Shopee (liga/desliga no chip "Fontes testadas"). Ela testa o Hub
    direto, mesmo que ele esteja desligado no admin — se a sessão do sistema
    caiu, a coluna fica vermelha dizendo o motivo. Como o card do Hub não traz
    vendedor, nº de avaliações nem frete, esses campos não são cobrados dele; em
    compensação entrou a linha "Comissão", que é o dado que só existe no Hub.
    Entrou também a linha "Qualidade da foto": o teste baixa cada foto da amostra
    e mede a resolução de verdade — abaixo do mínimo (500px por padrão, editável)
    vira alerta amarelo, e aparece um resumo tipo "8 de 10 fotos boas · 1 pequena
    · 1 que não abriu" com as piores lado a lado pra clicar e conferir. Dá pra
    desligar a conferência se quiser o teste mais rápido.
    Tem também um card separado "Testar um link": cola o endereço de um produto
    (ML, Amazon ou Shopee), clica em Testar link e na hora aparece o que o
    scraper conseguiu tirar dele — campo por campo com ✓ ou ✕, a foto com o
    tamanho real em pixels e os dados crus pra conferir. É avulso: não mexe no
    teste de amostra e não grava nada no catálogo.
    Sobre a foto ruim no repasse: a Shopee e os links de loja genérica vinham com
    a miniatura crua (o `_tn` da CDN), enquanto ML e Amazon já subiam pra alta.
    Agora todos passam pelo mesmo ajuste, inclusive na hora de enviar pro
    WhatsApp — então item antigo que já estava no catálogo também sai nítido.

55. [x] Quero na aba WhatsNimbus que seja possivel mandar msg. Bem simples, escolhe um grupo, escreve a mensagem e botao enviar.

    Feito. Com o WhatsNimbus conectado, aparece na aba um card "Enviar
    mensagem": lista dos grupos do número (com botão pra atualizar a lista),
    caixa de texto e botão Enviar. O botão só habilita com grupo escolhido e
    texto escrito; depois do envio aparece "Mensagem enviada" e o campo limpa.
    Se der erro (sessão caída, por exemplo) a mensagem de erro aparece ali
    mesmo. Rota nova no backend: POST /api/admin/whatsnimbus/send (só admin).

56. [x] Quero que os grupos de repasse tenham ate 5 líderes

    Feito. A campanha de repasse deixou de ter um líder só: na aba Repasse o
    card virou "Grupos líderes", com a lista de todos os grupos escutados, um
    botão Remover em cada linha e o seletor de número/grupo continuando
    disponível enquanto sobrar vaga. Grupo que já é líder aparece marcado como
    "Já é líder" e não dá pra escolher duas vezes. Os líderes podem ser de
    números diferentes.
    Quantos cabem depende do plano: Básico 1, Pro 3, Business 5. O contador
    aparece ao lado do título e também na tela de Assinatura ("Grupos líderes
    por campanha de repasse"); ao bater no teto o seletor some e explica que é
    preciso remover um ou subir de plano. Quem estiver acima do limite depois de
    um downgrade não perde nada — a campanha fica pausada pelo plano, igual já
    acontece com grupos e categorias.
    Na captura, uma mensagem postada em qualquer um dos líderes cai na mesma
    fila da campanha; o mesmo link vindo de dois líderes entra uma vez só.
    Campanha antiga não precisa de nada: o líder único que já estava salvo
    continua funcionando e é convertido pro formato novo no primeiro salvamento.

57. [x] Como tu acha que dava pra melhorar as abas das campanhas, para simplificar a utilizacao por parte do usuario? Por exemplo, a busca dos produtos podia ser parecida com a aba produtos que tenho no ADMIN, onde eu consigo filtrar e ver todos os produtos ali, ordenando como eu quero, se eu quiser pegar automaticamente, apenas deixo salvo esses filtros e ordem e adiciono o numero de produto que quero buscar e ele vai buscar na ordem que deixei ate completar este numero.

    A aba "Busca de Produtos" foi refeita do zero, no formato da aba Produtos do
    ADMIN. Antes a pessoa mexia nos filtros no escuro: clicava em "Buscar
    produtos" e só descobria o que tinha vindo depois, quando os produtos já
    estavam na fila — e ainda tinha que ir na aba Gerenciar pra trocar loja ou
    categoria. Agora tudo que decide quais produtos entram está numa tela só,
    em quatro blocos:
    1. Onde buscar — as lojas (com cadeado nas que o admin trancou) e as
       categorias, com o contador do plano. Este bloco não esconde: fica sempre
       aberto. À mostra ficam só as categorias ligadas, cada uma com um X pra
       tirar (menos a última, que a campanha precisa ter); o botão "Adicionar
       categoria" abre a lista das que faltam pra marcar várias e confirmar de
       uma vez — e ao chegar no limite do plano as não marcadas ficam apagadas
       explicando que precisa tirar uma ou subir de plano.
    2. Busca por palavras-chave — o campo fica sozinho e sempre à vista, e o
       resto dos filtros (preço mínimo e máximo, desconto, avaliação e vendas)
       mora atrás do botão "Filtros", à direita da busca, que mostra quantos
       estão ligados. Trocamos os sliders (que era chute no arrasto) por campos
       e listas com o valor escrito, e mesmo com o painel fechado ficam à vista
       os selos do que está filtrando, cada um com um X pra tirar.
    3. Preenchimento automático — a chave de ligar/desligar, o resumo do que
       está valendo e o botão "Preencher fila agora" ficam sempre à vista; o
       botão "Configurar" (igual ao dos filtros) abre quando o preenchimento
       acontece, quantos produtos entram por vez (1 a 50) e em que ordem
       escolher (maior desconto, menor/maior preço, melhor avaliação, mais
       recentes). Antes pegava até 100 de uma vez, sempre pelo maior desconto,
       e não tinha como desligar.
    4. Produtos encontrados — a lista de verdade do catálogo, com paginação e
       contador, na mesma ordem que o preenchimento usa. Cada card tem
       "Adicionar à fila" pra escolher a dedo, e marca o que já está na fila,
       aguardando revisão ou já enviado.
    A ordem na tela é: Onde buscar, Preenchimento automático, Busca por
    palavras-chave e Produtos encontrados — primeiro o que se configura uma vez,
    depois o que se mexe a toda hora, colado na lista que ele muda. Nada mais
    esconde por bloco inteiro: o que sai da frente são só os ajustes finos, nos
    painéis dos botões "Filtros" e "Configurar", e cada um lembra se ficou
    aberto ou fechado.
    Na lista há duas chaves: "Enviados recentemente" mostra ou esconde os
    produtos enviados dentro do tempo de espera para reenvio (escondidos por
    padrão, que é o que o preenchimento faz), e "Já na fila" faz o mesmo com os
    que já estão na campanha. Passado o tempo de espera o produto volta pra lista
    e pode ser mandado de novo.
    O encontro com fila/histórico é pela chave do produto, não pelo link: o que
    está salvo guarda o link já afiliado, então comparar link nenhum produto
    batia — nem o selo "já enviado", nem a chave de esconder.
    Quando o produto pedido já foi enviado há pouco, a pergunta "adicionar mesmo
    assim?" aparece dentro do próprio card, no lugar do botão. Antes ia pro topo
    da página, longe de onde a pessoa clicou. O mesmo vale pro "Foi pra fila":
    ele ocupa o lugar do botão pelos segundos em que fica na tela, e quando sai
    o botão volta já dizendo "Já na fila".
    No catálogo, "maior desconto" abria com os produtos sem desconto: no Postgres
    o ORDER BY DESC coloca os nulos na frente. Agora as ordenações por desconto,
    preço e avaliação mandam os sem informação pro fim.
    A aprovação automática deixou de existir na campanha de catálogo: ela virava
    uma segunda coisa pra entender sem motivo, já que o produto vem dos filtros
    que a própria pessoa montou. O preenchimento automático agora faz exatamente
    o que o botão faz, e o resultado vai direto pra fila; a revisão continua só
    no repasse, onde o link vem de outro grupo. O que já estava aguardando
    revisão continua na tela até ser aprovado ou rejeitado.
    O preenchimento automático tem dois gatilhos: quando faltarem menos de X
    produtos na fila (X escolhido, dentro das janelas de envio), ou em horários
    fixos do dia, que rodam uma vez cada, mesmo fora das janelas.
    Com o preenchimento automático desligado, a campanha só recebe produto por
    ação sua — e o "Enviar agora" com fila vazia avisa isso em vez de buscar
    escondido. A aba Gerenciar ficou só com nome e tempo de espera para reenvio
    (no repasse, as lojas continuam lá).
    De quebra: subir "vendas mínimas" agora limpa da fila os produtos que não
    passam mais nesse filtro — antes esse critério só valia na hora de buscar —
    e as chavinhas liga/desliga do sistema inteiro passaram a funcionar pelo
    teclado e a ter nome no leitor de tela.

58. [x] Conferir se dá pra furar os limites da assinatura (campanhas, WhatsApps, grupos, líderes) usando o próprio sistema.

    A base estava certa: o plano vem do Stripe (ninguém consegue se promover
    sozinho) e quem passa do limite fica pausado em vez de perder as coisas.
    Mas achei três brechas e fechei todas.
    A pior: quem baixava de Pro pra Básico e "limpava a lista de números"
    continuava enviando pelos três WhatsApps. O sistema só conseguia pausar
    número que estava na lista — apagou da lista, virou intocável. Agora é o
    contrário: só envia por número que está cadastrado na lista e não pausado.
    A segunda: dava pra criar grupos de WhatsApp sem limite nenhum e disparar
    pra todos eles de uma vez, ignorando o limite de grupos por campanha. Agora
    a criação tem teto conforme o plano e o disparo em massa só aceita grupos
    que estão cadastrados no número.
    A terceira: conta cancelada continuava rodando a busca de produtos (o pior
    caso era a captura dos grupos líderes, que ficava buscando cada link para
    sempre). Não chegava a enviar nada, mas gastava máquina à toa. Agora
    "Adicionar link", "Reabastecer fila", aprovar pendentes e a captura de
    repasse pedem assinatura ativa.
    Efeito colateral esperado: quem está sem plano ativo agora vê aviso de
    assinatura ao tentar mexer na fila — antes conseguia mexer, só não enviava.

59. [x] Quando clico em uma campanha la no menu da esquerda para abrir direto sua pagina, quero que suba ate o topo da pagina.

60. [x] Revise os itens da amazon. Busquei 10 itens de cada categoria nele e por exemplo https://www.amazon.com.br/God-War-Hits-PlayStation-4/dp/B07YT1GLV9 ta com o valor errado, aconteceu com 

    O preço da Amazon vinha copiado da vitrine de ofertas, nunca da página do
    produto — por isso o valor mudava quando você clicava no link. Agora o robô
    abre a página de cada produto e só guarda o item com o preço confirmado lá;
    o que não puder ser conferido simplesmente não entra.
    Achei também um erro maior enquanto testava: na página do produto a Amazon
    parou de escrever o preço no lugar onde o sistema lia, e ele acabava pegando
    o preço de OUTRO bloco da página (os "produtos similares", "comprados
    juntos"). O God of War é o exemplo: o certo é R$ 59,90 (de R$ 114,90, 47%).
    Isso valia também pro link avulso e pro repasse — os três estavam errados.
    De quebra: o desconto agora só sai do selo de oferta (antes qualquer
    "10% off" de cupom ou leve-2 virava o desconto do produto), o link salvo é
    sempre o /dp/ASIN limpo, produtos repetidos com URLs diferentes viraram um
    só, e quando a Amazon bloqueia o robô o alerta diz isso em vez de "0
    produtos, deve ser o filtro".
    Efeito colateral esperado: o catálogo da Amazon fica menor (teto de 60
    produtos por categoria, ajustável em Admin → Amazon) e a coleta demora mais
    (~27 min pra todas as categorias, contra ~4 min antes).

61. [x] Adicionar botão de misturar os itens da fila na aba de fila. Adicionar a opcao no preenchimento automatico para executar a mistura depois de adicionar os itens na fila.

    A aba Fila ganhou o botão "🔀 Misturar" (aparece com 2 ou mais produtos):
    embaralha a ordem e já recalcula os horários de cada envio. E no
    "Preenchimento automático" (Configurar) tem a chave "Misturar a fila depois
    de preencher" — desligada por padrão; ligada, ela embaralha a fila inteira
    a cada preenchimento, pra não sair uma sequência de ofertas parecidas na
    ordem em que o robô achou.

62. [x] Por padrão a campanha vem com a janela de envio zerada. Quando a janela de envio é zerada as campanhas ficam pausadas. O horário padrão quando adiciona uma janela de envio é de 00:00 ate 23:59.

    Campanha nova nasce sem nenhuma janela (antes vinha com 09:00–12:00 e
    14:00–18:00 já prontas) e por isso nasce pausada — o modal de criação avisa
    isso. Sem janela ela para de verdade: não envia e também não busca produtos
    novos. No painel aparece o selo "Pausada · sem janela de envio", e clicar no
    card abre direto a aba Janelas de envio. Agora dá pra remover até a última
    janela (era bloqueado), e a janela criada pelo "+ Adicionar janela" vem das
    00:00 às 23:59. Exceção: com o envio automático ligado ela continua rodando,
    porque ele ignora as janelas de propósito.

63. [x] Colocar o toggle de envio automatico ignorando a janela de envio para dentro da aba da fila e náo no repasse, assim o usuario consegue mexer nisso direto na fila.

    A chave saiu da aba Repasse e foi pro topo da aba Fila, e passou a se chamar
    "Envio instantâneo". Continua só nas campanhas de repasse. Ela salva na hora,
    sem botão de salvar. A aba Janelas de envio avisa quando ela está ligada, pra
    ninguém achar que os horários pararam de funcionar sozinhos.

64. [x] Tira a os grupos lideres a aba de repasse e coloca eles na aba grupos, assim todos os grupos do whats relacionados ficam la. o toggle de aprovacao automatica tb. Depois pode excluir a aba de repasse.

    A aba Repasse não existe mais. Os grupos líderes e a chave de aprovação
    automática foram pra aba Grupos (junto dos grupos que recebem as ofertas), e
    a lista "Aguardando revisão" foi pra aba Fila — onde ela agora vale pros dois
    tipos de campanha, num lugar só (a cópia que existia na aba de busca virou um
    aviso apontando pra Fila). O tour guiado e os textos que mandavam pra "aba
    Repasse" foram atualizados; quem estava com a aba Repasse aberta cai na Visão
    geral.

65. [x] Faltam emails como os de confirmação de pagamento, por exemplo:fiz uma compra teste la com o trial de 1 real, mas não recebi nada.

    Não era falha de entrega: o e-mail não existia. Todos os avisos de cobrança
    falavam de coisa ruim (cartão recusado, cancelamento, teste acabando) e
    nenhum dizia "recebemos seu pagamento". Quem assinava por dentro do sistema
    caía num vão: o único e-mail de pagamento confirmado era o "crie sua senha",
    que só vai pra quem assina pela landing e ainda não tem conta.

    Agora todo evento de dinheiro gera exatamente um e-mail: "Assinatura
    confirmada" na primeira cobrança (no teste de R$ 1,00 ele diz quando acaba o
    teste e quanto será a mensalidade), "Recibo do seu pagamento" a cada
    renovação mensal, com valor e link da fatura, e "Reembolso processado" nos
    estornos — que o sistema nem escutava antes. Quem vem da landing continua
    recebendo um e-mail só. Os três são editáveis em Admin › E-mails, como os
    outros, e podem ser desligados.

    Também caiu o bloqueio que impedia contas admin de receber aviso de
    cobrança — era ele que fazia o teste parecer que nada tinha sido enviado.
    Falta ligar o evento `charge.refunded` no painel do Stripe (nos dois modos). 

66. [] Quero conferir se o ambiente mobile esta condizente e bem construido para utilizacao do usuario.

67. [] Quero fazer um resumo geral do sistema e criar um arquivo na raiz do projeto que explique didaticamente como esta funcionando. Náo sei exatamente tudo que quero no resumo, mas as tecnologias usadas, onde estao os banco de dados, o que tenho guardado em cada um, quais sao minhas camadas de seguranca, como funciona, como esta arquitetado para expansao caso cresca o numero de usuario, onde e como sao feitos os backups e o que tem neles, um resumo do custo computacional das diferentes partes da arquitetura, etc...

70. [x] Quero poder escolher horarios especificos para fazer scraping inves de colocar um intervalo.

    O Scraping global e o ScrapTester agora têm duas opções em "Quando rodar":
    "a cada X minutos" (como era) ou "em horários do dia" — a mesma lista de
    horários que as campanhas já usavam no preenchimento automático, até 12 por
    dia. No modo horários o scraping roda uma vez em cada horário marcado, no
    fuso do servidor, e o card "Próximo run" mostra qual é o próximo.

    Se o backend estiver fora do ar na hora marcada, ele ainda roda se voltar em
    até 15 minutos; passou disso, espera o próximo horário em vez de correr atrás
    do dia inteiro. Trocar de modo não apaga o intervalo que estava configurado.

71. [x] Quero um botão para buscar quantos GB ainda estão sobrando no computador que esta rodando o sistema.

    O botão "Espaço em disco" ficou em Admin › Backups, ao lado de "Atualizar" —
    é ali que a pergunta aparece na prática, na hora de criar mais um backup. Ele
    mostra quantos GB estão livres, o total do disco e a porcentagem em uso (as
    mesmas contas do `df`), mais quanto os backups locais e o banco de dados
    ocupam. Acima de 90% em uso o painel fica vermelho e avisa pra limpar
    backups antigos.

    O painel também mostra o Backblaze, mas só o que está ocupado lá (quantos GB
    e quantos arquivos): o B2 não tem "espaço livre" — não existe limite fixo, é
    cobrado por GB guardado, e o cap de armazenamento da conta não aparece na API
    S3 que o sistema usa.

72. [] Verificar brechas de segurança pelos endpoints do site.

73. [x] Como funcionam os cupons no ML e na Shopee? Como poderia buscar e integrar eles no sistema? Tem algums grupos de whats que enviam o produto com o cupom a ser utilizado.

74. [x] Reorganiza a aba de Grupos nas campanhas de repasse, os lideres devem aparecer primeiro, so depois os grupos de envio. Depois da uma olhada e ve o que tu acha que da pra melhorar.

    A aba agora segue o caminho do link: primeiro a captura (grupos líderes +
    aprovação automática + salvar) e só depois os grupos de envio, separados por
    um divisor. O bloco de envio se chama "Grupos de envio" no repasse. Campanha
    de busca não mudou nada.

    Junto vieram quatro coisas que faltavam ali:

    - Cada grupo líder agora mostra se o número que escuta ele está conectado
      (bolinha + selo, igual aos grupos de envio) e avisa que nada é capturado
      enquanto ele estiver fora — antes a captura parava em silêncio.
    - Campanha de repasse sem nenhum líder ganha uma faixa laranja explicando
      que assim ela nunca captura nada.
    - Grupo que é destino e líder ao mesmo tempo ganha o selo "👑 Também é
      líder", e no seletor de líderes os grupos que já são destino aparecem
      marcados — evita escolher o grupo errado sem perceber.
    - O tour passa nos líderes antes do "+ Adicionar grupo", seguindo a nova
      ordem da tela.

75. [x] Ao criar uma nova campanha, tirar a mensagem "Já vamos preencher os defaults.... Tudo isso pode ser ajustado depois.". Tire tb a mensagem  "Ela começa pausada... ela começa a enviar".

76. [x] Enquanto rola o tour na página, os avisos de "Campanha pausada pq ...." não aparecem, só depois que o tour termina, assim o usuario consegue ver os elementos certinhos.

77. [x] Diminua o tour da campanha, 34 pontos é mt longo, quero só os principais e essenciais.

78. [] Onde eu escolho qual número de whats que vai enviar as mensagens? É o próprio dono do grupo quando adicionado?

79. [x] Quero na edicao dos modelos de mensagem ter uma opcao para que se o item nao estiverm em promocao não apareca "de" ou "desconto", o que tu sugere?

80. [x] Tira o cupom fixo da campanha no modelo de mensagem

    O campo "🎟️ Cupom fixo da campanha" saiu da aba Modelos Mensagens e o
    recurso deixou de existir: o {cupom} agora vem só do cupom capturado na
    legenda do grupo líder, no repasse. Sem cupom, a linha inteira que tem
    {cupom} some da mensagem, como já acontecia. Na prévia, a campanha de
    repasse mostra um cupom de exemplo e a de busca mostra a linha sumindo —
    que é o que realmente vai acontecer nela.
    Efeito colateral esperado: campanha de busca não manda mais cupom nenhum.
    O valor que estava salvo em campanhas antigas fica inerte (ninguém lê).

81. [x] Campanha de repasse não precisa de categoria, pode tirar.

    Campanha de repasse já nascia sem categoria e não usa categoria em nada —
    o que sobrava era ela aparecer na tela e contar no plano. Agora: o card da
    Visão geral vira "Lojas do repasse" e mostra só as lojas (sem categorias e
    sem filtro de desconto, que não valem ali), os selos de categoria do
    cabeçalho não aparecem, e ao salvar o backend zera a categoria de qualquer
    campanha de repasse — então repasse antigo para de consumir cota de
    "categorias por campanha" do plano.

82. [x] Na campanha de repasse, mesmo com uma loja bloqueada, quero que o repasse ignore os bloqueios. O bloquieio é apenas para campanhas normais onde pode-se buscar produtos no próprio sistema.

    A trava de loja do admin passou a valer só onde faz sentido: na busca de
    produtos no catálogo. No repasse o link chega pronto do grupo líder, então
    ela é ignorada — antes, trancar a única loja da campanha de repasse pausava
    a campanha com a mensagem de manutenção e todo link daquela loja era
    descartado em silêncio. Agora a captura entra normalmente, a campanha não
    pausa por causa da trava, os chips de loja da aba Gerenciar continuam
    clicáveis (sem cadeado) e a campanha de repasse nova nasce com todas as
    lojas. A exigência de afiliado configurado continua valendo, porque o
    repasse precisa dela pra reafiliar o link.

83. [x] Nos grupos, quero que mude de "Grupos do WhatsApp" para "Grupos Destino".

    O bloco agora se chama "Grupos Destino" nos dois tipos de campanha (no
    repasse ele se chamava "Grupos de envio"), o que também deixa claro o
    contraste com os "Grupos líderes" logo acima. Junto foram os textos que
    falavam do mesmo bloco: o selo "Sem grupos destino" no cabeçalho, o
    "Nenhum grupo destino vinculado" da lista vazia e o passo do tour. Onde
    "grupos do WhatsApp" quer dizer os grupos de verdade do número (o seletor
    de vincular, por exemplo) o texto ficou como estava.

84. [x] No Modelos Mensagens, quero que troque e tenha 2 botões para salvar, o "Salvar" que apenas salva a alteração feita e o "Salvar Como" que salva como um diferente modelo com outro nome. Tira o "Criar a partir deste". Sempre que for salvar abra um popup perguntando se já quer ativar o modelo.

    "Criar a partir deste" não existe mais, e o modal que perguntava "novo ou
    substituir" a cada salvamento também não. Ficaram dois botões: "Salvar",
    que grava por cima do modelo aberto sem perguntar nada, e "Salvar Como",
    que pede um nome e cria outro modelo com o que está no editor. No modelo
    "Padrão", que é inalterável, o Salvar cai no Salvar Como já explicando o
    porquê.
    Depois de salvar aparece o popup "Ativar este modelo?", com "Agora não" e
    "Ativar". Exceção: se o modelo salvo já era o que a campanha usa, ele
    continua em uso com o texto novo sem perguntar — senão a campanha seguiria
    mandando a versão antiga (o "em uso" é casado pelo texto).
    De quebra: só trocar de modelo na lista não conta mais como "alteração não
    salva" (o aviso agora fala do que você editou e não salvou), e o Salvar das
    outras abas parou de ativar sem querer o modelo que estivesse aberto no
    editor.

85. [x] Na aba de Busca de Produtos faça o seguinte:

No botão de preencher a fila quero que apareça um pop up informando que vai preencher com os X primeiros itens da lista.

No Onde buscar quando clicar em alterar que abre as opções, quero que abra com uma animação zinha de transição aparecendo abrindo. Tb quero que fique mais integrado.

No preenchimento automatico mesma coisa ao clicar em configurar. Em ambos, quando apertar pra configurar um, esconde o outro.

86. [x] Na aba de busca de produtos troca a busca de produtos para ser por páginas. Sempre quero que fique preenchido automaticamente. Tb o que tu acha que da pra melhorar e tirar das coisas escritas pra ficar mais clean? Vai me perguntando pra fazermos um plano legal.

    O "Carregar mais" virou paginação de verdade ("← Anterior · 3 / 17 ·
    Próxima →"), e a página vem sempre cheia. Pra isso o corte de "já na fila"
    e "enviado há pouco" saiu do navegador e foi pro /api/ofertas, que agora
    recebe o groupId da campanha — antes os cards eram escondidos DEPOIS de
    receber, o que com páginas numeradas deixaria a página 3 com 4 de 24
    produtos e ainda faria o contador incluir o que a tela escondia. As duas
    chaves continuam ali, agora ligando/desligando o filtro no servidor. De
    quebra, a lista virou exatamente o que o preenchimento vai pegar.

    Limpeza de texto: o seletor de ordem existia em dois lugares (painel de
    Preenchimento e em cima da lista) — ficou só o de cima; a explicação do
    "Preencher fila agora" saiu da tela porque o pop-up de confirmação já diz
    a mesma coisa; as três menções à "ordem que o preenchimento usa" viraram
    uma; e as dicas longas do painel viraram uma linha cada.

    Os controles de página viraram um componente (ui/Pagination), trocando as
    três cópias que existiam no /produtos, no admin de repasse e no admin do
    scraper.

87. [x] Na aba de busca de produtos quero um botão para salvar os filtros. Quero que os filtros também sejam mais editaveis, que de pra escrever os numeros. Também quero que a ordem de maior desconto, preço etc fique ao lado e antes do preencher fila agora. Tira o selecionar todos e tira o quadradinho de selecionar deles.

    Desconto, avaliação e vendas deixaram de ser listas fechadas: agora são
    campos onde se digita o número (dá pra pedir 35%, nota 4,2). Ao sair do
    campo o valor encosta no teto quando passa dele — 50 na nota viraria uma
    lista vazia sem dizer por quê.

    O painel de Filtros ganhou o próprio "Salvar filtros", com uma linha
    dizendo se há alteração pendente. É o mesmo salvar da aba, só que ali em
    cima: os filtros ficam no topo e a barra de salvar mora depois da lista
    inteira.

    A "Ordem" saiu do cabeçalho da lista e foi pra linha do "Preencher fila
    agora", logo antes do botão — encostada nele, não precisa mais da legenda
    "também é a ordem que o preenchimento usa" (virou title).

    Saiu a seleção múltipla: a barra de "Selecionar todos", os quadradinhos dos
    cards e o "Adicionar N à fila" (com o resumo e o aviso de cooldown do
    lote). Junto foram o `addCatalogProducts` do GroupDashboard e a prop
    `select` do ProductGridCard, que não tinham outro uso.

88. [x] Na busca de produtos testa se todos os filtros e ordenação estão funcionando. Tem mais algo pra testar ali?

    Estão funcionando — os seis filtros, as lojas, as categorias, as duas
    chaves de visibilidade e as cinco ordens. O que faltava era teste: preço
    mínimo/máximo, nota, vendas, as ordens "menor preço", "melhor avaliação" e
    "mais recentes" e as combinações não tinham nenhum. Agora cada um tem, com
    o produto que passa, o que não passa e o que tem o campo vazio — é onde
    filtro costuma escorregar (o "até R$ 200" não pode trazer junto quem não
    diz o preço).

    Testando apareceram dois defeitos de paginação, os dois corrigidos:

    Nenhuma das ordens tinha critério de desempate, e empate é a regra aqui
    (dezenas de produtos com 50%, a cauda inteira sem desconto). Sem desempate
    o Postgres não promete a mesma ordem em duas consultas, então a página 2
    podia repetir um produto da 1 — e sumir com outro. A key entrou como último
    critério nas cinco.

    O "vendas mínimas" era filtrado em JavaScript depois da consulta, porque o
    número de vendas só existia como texto ("+1,5 mil vendidos"). O contador
    rodava no banco e não enxergava esse corte: com o filtro ligado, o total
    contava produtos que a lista não mostrava e as últimas páginas vinham
    vazias. O número de vendas virou coluna (`soldCount`, preenchida na
    gravação e retroativa por migração), o filtro voltou pro SQL e o total é
    exato de novo — saiu junto o "~" que avisava que o número era chute.

    Do que mais valia testar ali, ficou coberto:

    - A busca (SQL) e a limpeza da fila (JavaScript) implementam a mesma regra
      de filtro em dois lugares. Um teste agora exige que as duas concordem —
      senão o produto entra na fila pela busca e é expulso no tick seguinte.
    - A lista de ordens existe em três arquivos (aba, rota, preenchimento).
      Renomear um id em um só devolveria "maior desconto" calado no lugar do que
      foi pedido; agora cada id é conferido nos três.
    - Exclusão por campanha somada a filtro, no total também.
    - Na tela: teto do desconto (100) e das vendas (0) ao sair do campo, aviso
      de preço mínimo maior que o máximo, a página de 24, e que trocar a ordem
      não arrasta junto o filtro digitado que ainda não foi buscado.

89. [x] Pense como se tu fosse um usuário, o que da pra melhorar na aba de busca de produtos? Em tudo, incluindo cores, destaques

    O card agora diz de onde veio a oferta: um selo com cor por loja (Mercado
    Livre âmbar, Amazon índigo, Shopee laranja) no lugar do cinza de 11px que
    misturava loja e vendedor. Com as três lojas ligadas ao mesmo tempo, dava
    pra ler a lista inteira sem saber quem vendia o quê.

    O desconto virou faixa no canto da imagem (verde forte a partir de 40%, com
    🔥 a partir de 60%) e o preço riscado ganhou embaixo "Economize R$ X" — a
    ordem padrão é "Maior desconto" e ele morava num selinho no rodapé. Produto
    que entrou no catálogo nas últimas 24h ganha selo "Novo" (o `firstSeenAt` já
    vinha do /api/ofertas e não aparecia em lugar nenhum). Os dois destaques são
    props do ProductGridCard, desligadas por padrão: o /produtos segue igual.

    A faixa dos selos passou a ser reservada em todo card que tem botão —
    só quem tinha selo ficava 26px mais baixo, e a grade nascia serrilhada.

    O cabeçalho da lista, as chaves e a linha "Ordem + Preencher fila agora"
    viraram um card com os mesmos cantos arredondados dos outros blocos da tela.
    Chegaram a ser uma barra grudada no topo, mas no meio da rolagem ela ficava
    achatada nas pontas e destoava de tudo em volta — e o `.main-content` tinha
    um `overflowY: auto` num bloco de altura automática, ou seja, um contêiner
    de rolagem parado que desativava todo `position: sticky` de dentro dele (a
    barra de salvar do rodapé desta mesma aba incluída). O `overflowY` saiu; a
    barra grudada, também. A contagem virou "24 de 1.234 no catálogo · página 2
    de 52 · buscando...", em vez de só o total. As chaves agora dizem "Mostrar
    já na fila" e "Mostrar enviados recentemente" — ligada, a chave mostra.
    Virar de página leva a tela de volta pro topo.

    A busca deixou de acontecer sozinha. Antes cada tecla digitada no campo ou
    num filtro disparava uma request depois de 350ms, e a lista se refazia
    debaixo do dedo. Agora existe um botão "Buscar" (e Enter, tanto no campo de
    palavras-chave quanto nos filtros): o que está escrito só vira lista quando
    se pede. Por dentro são dois estados — os filtros que estão na tela e os que
    a lista reflete —, e enquanto os dois diferem a dica embaixo do campo avisa
    que falta buscar. O que é um clique só continua valendo na hora: ordem,
    chaves, lojas, categorias, e tirar um filtro pelo chip ✕ ou pelo "Tirar
    <filtro>" da lista vazia. No campo de busca: ✕ pra limpar (e já rebuscar) e
    Esc pra limpar o texto sem mexer na lista.

    A lista vazia deixou de ser só texto: cada filtro ligado vira um botão
    "Tirar <filtro>", então dá pra afrouxar um critério de cada vez sem abrir o
    painel e adivinhar qual está apertado. Enquanto a próxima página não chega,
    a atual fica apagada e sem clique, e o esqueleto da primeira carga passou de
    8 pra 12 cards.

    Cores: os selos (ui/Badge) tinham hex claros fixos e no tema escuro viravam
    pastilhas claras — os 11 pares foram pro index.css, com conjunto próprio por
    tema, como já era com --warn-bg/--danger-bg. O "Já na fila" ganhou fundo
    neutro em vez de transparente, e os rótulos/dicas/avisos da aba subiram de
    11 pra 12px.

90. [x] Tem alguma forma de testar cupons nos produtos do Mercado livre? Se precisa de login, da pra usar o cookie que nem no scraping do hub.

    Tem, e são dois cupons diferentes. O que a loja oferece na própria página (o
    "clipado") dá pra ler direto na PDP: num produto do catálogo o teste achou
    "R$113 com Cupom" — o mesmo dado que o scraper joga fora de propósito, pra
    "10% com cupom" não virar o desconto do item. Já o CÓDIGO que vem na legenda do
    grupo líder não existe em lugar nenhum da página: a única forma de saber se ele
    vale naquele produto é levar o item ao checkout e aplicar lá.

    Virou uma aba nova, Admin › Cupom: cola o link e o código, escolhe "Só leitura"
    ou "Leitura + checkout" e vê o veredito na hora. Não grava nada na fila, não
    envia nada e nunca finaliza compra — o fluxo para antes de pagar, o navegador
    fecha no finally e, se tiver passado pelo carrinho (plano B), o item sai de lá.
    Por baixo é o mesmo caminho do Hub: Chrome de verdade + o cookie da conta do
    sistema, agora num `withMLSessionPage` que os dois compartilham.

    O veredito é função pura (`classifyCouponResult`), com desfechos válido,
    inválido, expirado, usado, não-aplicável, mínimo-não-atingido, login,
    verificação-de-conta, captcha e indeterminado. A prova mais forte é o TOTAL DO PEDIDO CAIR: "cupom aplicado"
    escrito na tela sem o total mudar vira indeterminado, não aprovação. O
    indeterminado existe de propósito — fingir veredito aqui é cupom morto indo pro
    grupo lá na frente (95).

    O que a sonda (`scripts/ml-coupon-dump.js`, irmã do ml-hub-dump) ensinou, cada
    lição custando uma tentativa na conta de verdade:

    - "Comprar agora" não é link nem botão comum: é o submit de um `<form
      method=get>` com item_id, quantity e _csrf ocultos e o alvo no `formaction`.
      Montar a URL a partir do form é firme; clicar por texto não é.
    - Produto com variação (tamanho/cor) tem esse botão DESABILITADO, e clicar nele
      não faz nada nem dá erro. Agora é detectado, e a resposta manda colar o link
      já com a variação escolhida.
    - `/gz/checkout/buy` não é a tela de compra: é um interstitial ("Preparando tudo
      para sua compra"). Conferir só a URL fazia a ferramenta fotografar uma tela de
      carregamento achando que tinha chegado.
    - O rádio da forma de entrega é um `<input>` escondido atrás do desenho do
      Andes: quem recebe o clique é o `<label for=...>`. Clicar no input marca a
      bolinha sem avisar o React, o "Continuar" vai sem forma de entrega e o
      checkout morre com "Ocorreu um problema".

    O teste do Allan (18/08, 17:30) andou mais que a sonda: chegou no checkout de
    verdade, via form-compra, e parou depois de 4 passos sem achar o campo. Daí
    saíram mais três coisas:

    - "Parei depois de 4 passo(s)" não serve de diagnóstico. Agora cada passo é
      anotado (tela, se marcou opção, o que clicou, por que parou) e essa trilha
      aparece no resultado do admin — "Escolha a forma de entrega → Como você quer
      pagar?" diz onde consertar; um número não diz.
    - "Continuar COMPRANDO" casava com a regex de avançar. Esse é o link de VOLTAR
      pra loja: clicar nele joga a automação pra fora do checkout gastando um passo.
      A regex agora aceita "Continuar" e "Continuar para o pagamento", e o teto
      subiu de 4 pra 6 telas.
    - `/gz/` sozinho estava valendo como muro de login, mas `/gz/checkout` e
      `/gz/cart` são o caminho normal da compra — um veredito bom podia ser lido
      como "sessão caiu". Só as telas de identificação contam agora.

    Com a trilha ligada, o caminho apareceu inteiro: Escolha a forma de entrega →
    Escolha quando sua compra chegará → Escolha como pagar. O cupom mora na última,
    e são DUAS telas — "Inserir código do cupom" leva pra outra, onde se digita e se
    confirma em "Adicionar". Daí saíram mais três correções: esperar até 12s a tela
    do cupom montar (1,5s fotografava a anterior), subir até 4 ancestrais atrás de
    quem escuta o clique (o texto fica num <span> no fundo, que não escuta nada), e
    ler os dois totais NA MESMA TELA — o "antes" vinha da tela de entrega e o
    "depois" da de pagamento, números de coisas diferentes (com e sem frete), e uma
    queda dessas viraria "cupom válido" sem cupom nenhum ter entrado.

    18/08 (3a rodada): a sonda gastou os 6 passos na PRIMEIRA tela — "Escolha a
    forma de entrega" quatro vezes, mesma URL. O "Continuar" do ML fica desabilitado
    enquanto o frete recalcula: o clique não fazia nada e era contado como avanço.
    Agora um passo só conta quando a TELA MUDA de verdade (foto do texto antes e
    depois, até 15s), com uma segunda tentativa de clique antes de desistir, e o
    clickByPattern ignora elementos disabled/aria-disabled. O motivo novo
    "tela-nao-mudou" diz isso em português no resultado. Confirmado pelo uso manual:
    nas duas primeiras telas o endereço e a data já vêm escolhidos (é só continuar) e
    o cupom abre um POPUP na tela de pagar, com o botão "Inserir" — que entrou na
    regex de confirmar (ancorada, pra não casar com a linha "Inserir código do
    cupom", que só abre o popup).

    18/08 (prints das 3 telas): as telas de entrega e de data já vêm com tudo
    escolhido — só "Continuar". O "Inserir código do cupom" fica no RESUMO DA COMPRA,
    coluna da direita, abaixo do frete (não na lista de meios de pagamento). E o
    resumo dessa tela não diz "Total", diz "VOCÊ PAGARÁ", com o preço riscado ao lado
    do que se paga: extractCheckoutTotal aprendeu o rótulo novo e fica com o último
    valor do par. Sem isso o antes/depois vinha null bem na única tela onde o cupom
    entra — a prova mais forte do veredito ia pro lixo —, e lendo o riscado o total
    "não mudaria" nem com o cupom pegando.

    18/08 (prints em toda rodada): o teste do admin passou a salvar print de cada
    etapa em backend/logs/ml-coupon/<ts>/, com o caminho no resultado, guardando as
    5 rodadas mais novas. Antes só o dump manual salvava — e ele é rodado DEPOIS que
    o teste já falhou, quando a tela pode estar outra. Agora dá pra olhar a tela que
    o robô viu na rodada que deu errado, sem repetir o teste (cada repetição gasta
    atrito com a conta do ML).

    18/08 (checkout caiu): com os prints deu pra ver o que aconteceu. As duas
    primeiras telas andaram certo (entrega → data), e no clique da segunda o ML
    devolveu a tela "Ocorreu um problema" (CHS37-BTYRGHDTKEOZ) — checkout DELES
    caindo, não falta de botão. Duas correções: (a) espera a tela parar de se mexer
    antes de clicar em Continuar, porque marcar entrega dispara recálculo de frete e
    clicar no meio disso é o que derruba o checkout; (b) a tela de erro é reconhecida,
    a sonda recarrega e tenta mais uma vez, e se cair de novo o motivo é
    "checkout-quebrou" com o código do erro, em vez do diagnóstico errado de antes
    ("não existe botão Continuar"). Outro detalhe do print: nessa rodada o checkout
    abriu com NENHUMA opção de entrega marcada — não dá pra assumir que já vem
    escolhido.
    O print da PDP também mostrou o cupom saindo como "com Cupom", sem número: o
    texto mais curto da página é só isso, e o valor ("R$ 486,70 23% OFF com Cupom")
    é IRMÃO, não pai. Dentro do mesmo cupom, agora o mais curto COM valor ganha.

    FALTA CONFIRMAR: digitar o código e ler a resposta do ML ainda não foi visto de
    ponta a ponta. O ML pediu verificação de CONTA (`/gz/account-verification`) de
    novo, logo depois desse teste — e agora já na página do produto. Isso não é
    cookie vencido: o cookie está bom, a conta é que ficou de castigo por parecer
    robô, e virou um status próprio (`verificacao`) pra ninguém sair caçando cookie
    novo à toa. Como é a MESMA conta do scraping do Hub, vale conferir se o Hub
    ainda entra. É o atrito esperado, e a razão de a ferramenta ser manual, um teste
    por vez, e não um loop — o que também explica por que a 95 não sai junto.
    Quando a conta liberar: rodar o dump num produto SEM variação e olhar os
    `passo-N.png` (um print por tela do checkout) pra ver onde o cupom aparece.

91. [x] O cupom capturado no repasse não aparece em lugar nenhum antes do envio. Quero ver ele no card da fila e na revisão de pendentes, e poder editar ou apagar antes de sair.

    O cupom virou um campo CUPOM no card da fila, junto de Loja/Preço/Desconto, e
    um selo 🎟️ na linha de "Aguardando revisão". Os dois abrem no ✎: dá pra
    escrever outro código, salvar no ✓ (ou Enter), desistir no ✕ (ou Esc) e apagar
    no 🗑 — sem cupom o campo mostra "—" e a linha do {cupom} some da mensagem,
    como já acontecia. O que é digitado sai em maiúscula, igual ao que o repasse
    captura da legenda.

    Vale nas duas campanhas: no repasse o campo já nasce com o código pescado do
    grupo líder, e na busca nasce vazio e pode ser preenchido à mão — o envio
    sempre leu o {cupom} do item, então isso passou a funcionar sem mais nada.

    Por baixo é um PATCH por item (`/api/state/groups/:gid/queue|pending/:iid/coupon`)
    que faz read-modify-write no servidor, e não o PUT que regrava a fila inteira:
    no repasse a captura escreve nessas listas o tempo todo, e mandar a lista de
    volta apagaria o que entrou enquanto a tela estava aberta. Quando o servidor
    recusa, a edição continua aberta com o texto digitado e o aviso aparece no topo.

93. [] Deixar colocar cupom à mão: no "adicionar produto" da campanha e na edição de um item que já está na fila.

94. [] Cupom que a loja aplica sozinha na página (o "clipado" do ML e da Shopee) não é detectado. Ver se dá pra pegar no scraping — anda junto com o 90.

95. [] Validar o cupom antes de enviar, pra não mandar cupom morto pro grupo. No mínimo marcar como suspeito/expirado. Depende do 90 e do 94.

96. [x] Guardar o cupom no log de captura do repasse. Hoje o logCapture não salva o campo, então não dá pra auditar depois o que foi enviado.

    O log de captura (Admin → Repasse) agora mostra "cupom: JBL20" em cada linha,
    ou "—" quando a mensagem do líder não trazia código nenhum. Os dois casos
    aparecem de propósito: saber que NÃO veio cupom é metade da resposta.

    O cupom é gravado nos cinco desfechos do logCapture — fila, revisão, cooldown,
    duplicata/erro e descarte. O descarte é o que mais importa: link de loja não
    suportada ou sem afiliado não vira produto nenhum, então o log é o único lugar
    onde o cupom daquela mensagem pode aparecer.

    Achado no caminho: os bancos de dev e de teste desta máquina JÁ tinham as
    colunas coupon, couponStatus e couponReason em repasse_capture_log, criadas em
    12/08/2026 pelas migrations 20260812135540_ml_coupons e 20260812200229_ml_coupon_codes
    — que constam como aplicadas mas ficaram com a pasta vazia (o migration.sql
    sumiu e nunca entrou no git). O dev ainda tem 10 linhas antigas com cupom
    preenchido. A migration nova usa ADD COLUMN IF NOT EXISTS pra funcionar nos
    dois casos, e o schema.prisma só declara `coupon` — couponStatus/couponReason
    seguem existindo no banco sem ninguém ler (provável esboço da validação da 95).

97. [] Revisar a regex do extractCoupon com mensagens de verdade dos grupos líderes. Hoje ela exige gatilho (cupom/código/voucher) e passa batido em coisas tipo "CUPOM10" solto ou o código sozinho numa linha.

98. [] Revisar login com google.

99. [] Como ele detecta os cupons? Por texto? Se sim, quero poder editar essa lista de textos.

100. [x] Quero puxar os cupons que tem no ML para o sistema a partir da aba de cupons que tem la. Pode usar a credencial do cookie do ML. Os cupons que tem lá conseguem ser ativados pela palavra CUPOM100 por exemplo? Se sim, como descobro a palavra de cada um? Tb, queria fazer um scraping dos produtos de cada um para poder vincular cupom com o produto.

    Sim e não — e a diferença é o coração da tarefa. **Os cupons dessa aba não têm
    palavra.** Cada um é "Eu quero" (o cliente clica e ele entra na conta dele) ou
    automático; o `code` que vem no JSON da página é um token base64 de ativação
    amarrado à conta logada, não um CUPOM100. Não existe lista de palavras pra puxar.

    A palavra existe em OUTRO lugar: o campo "Inserir código do cupom" da mesma
    página. Ela não pode ser enumerada, só TESTADA — e aí o ML responde de qual
    campanha ela é (`campaign_id` + `response_code`). Virou o botão "Descobrir a
    campanha de uma palavra", e é o que fecha o ciclo com a 95/97: a palavra que veio
    na legenda do grupo líder vira uma campanha, e a campanha já tem a lista de
    produtos. As respostas ficam em `ml_coupon_codes` (com contador), e quando a
    palavra resolve, ela é carimbada no cupom.

    O puxão: Admin › Cupom ganhou a aba "Cupons do ML". A rodada lê a página com a
    conta do sistema (a mesma do Hub), abre a vitrine de cada cupom e guarda quais
    produtos ele cobre. Como demora minutos, roda solta — a rota responde na hora e a
    tela acompanha pelo status, com botão de cancelar.

    O que a página ensinou (tudo em backend/scraping/README.md):
    - ela não é raspada do DOM: o conteúdo inteiro vem num JSON dentro da página
      (`_n.ctx.r.appProps.pageProps`), com campanha, valor, mínimo, teto, validade e
      a URL da vitrine de cada cupom;
    - o "Ver mais 368 cupons" não abre modal nem busca por XHR: NAVEGA para
      `/cupons/filter?all=true&<categoria>=true`, que pagina de 30 em 30 com
      `&page=N`. É por aí que se passa dos ~42 da vitrine inicial pros ~2.600 da
      conta — e é por isso que o limite por categoria existe;
    - **só cupom ATIVADO tem vitrine.** O não ativado não traz URL nenhuma, e a URL
      não é montável: usa um slug do ML (`_Container_toys-e-babys`), não o id da
      campanha — montar na mão devolve lista vazia (testado). Ver a vitrine dele
      exigiria clicar "Eu quero", o que ATIVA o cupom na conta do sistema. O robô não
      faz isso; o cupom fica registrado sem produtos, com o motivo à mostra.

    Duas armadilhas que custaram sonda: aba nova não herda o disfarce do Chrome (sem
    `applyAmazonStealth` a vitrine responde "Hubo un error accediendo a esta pagina" e
    a rodada leria 0 produtos numa página que no navegador mostra 48), e a paginação
    do `lista.mercadolivre.com.br` é `_Desde_49` no caminho, não `?page=`.

    O vínculo cupom↔produto vale em três lugares: a tela do admin (quantos produtos
    cada cupom cobre, quantos já estão no catálogo, com "raspar" por linha), o
    catálogo (coluna `couponCampaignId` em `catalog_products` — coluna, e não payload,
    porque o upsert do scraping reescreve o payload inteiro e apagaria o cupom na
    rodada seguinte) e a fila do repasse: a campanha ganhou "Produtos com cupom do
    Mercado Livre" com três opções — tanto faz (default, nada muda), preferir com
    cupom, só com cupom.

    Sobre as tabelas: `ml_coupons`, `ml_coupon_products` e `ml_coupon_codes` já
    existiam no banco desta máquina, criadas pelas duas migrations de 12/08 que
    ficaram com a pasta vazia (o mesmo caso da 96). A migration nova recria tudo com
    `CREATE TABLE IF NOT EXISTS`: funciona no banco limpo e não encosta nos 1.122
    vínculos antigos do dev.

101. [x] Quero que no modelo msg tenha o preço_com_cupom que aparece o preço com o desconto do cupom. Caso não seja valido o cupom quero que ele seja automaticamente substituido pelo preco normal.

    O modelo de mensagem ganhou a variável `{preco_com_cupom}` — sem acento e em
    snake_case, como o `{preco_antigo}`: o mirror da prévia no front casa `\{(\w+)\}`,
    então um token acentuado nunca substituiria nada.

    A conta em si mora num arquivo novo e puro, `backend/coupons/price.js`
    (`precoComCupom(price, rule)`): recebe o preço e uma linha de `ml_coupons` e
    devolve o preço final — ou `null`. **O `null` é a tarefa.** Ele é a resposta
    quando o cupom venceu, quando ainda não começou (`startsAt` estava gravado no
    banco desde sempre e não era conferido em lugar nenhum), quando o produto está
    abaixo da **compra mínima**, ou quando o `kind` veio `unknown`/`desconhecido` —
    e aí o `{preco_com_cupom}` sai **igual ao `{preco}`**, sem apagar a linha e sem
    "—". Anunciar desconto que o ML não daria é cliente clicando e pagando mais
    caro; preço normal em silêncio é a resposta certa. O teto do cupom
    (`maxDiscount`) entra como `Math.min` no desconto, não no preço.

    O dado pra fazer a conta já existia inteiro e estava sendo jogado fora: o
    `couponsForKeys` (`coupons/pg.js`) devolve `kind`, `value`, `minPurchase`,
    `maxDiscount` e `expiresAt` por produto, e o refill guardava no item só a
    palavra, o `couponCampaignId` e um `couponLabel` que **ninguém lia**.

    A leitura passou a ser no **envio** (`scheduler.js:couponRuleForItem`, chamado
    pelo `sendItem`), não no refill. O motivo: o item fica dias em `group.queue` e
    o cupom vence nesse meio-tempo — guardar valor e validade no payload da fila
    seria anunciar promessa velha. Custa uma consulta por envio, contra os 4s de
    espera que já existem entre um grupo e outro. A ordem é palavra →
    `couponCampaignId` → chave do produto: a palavra vem primeiro porque é ela que
    a mensagem manda o cliente digitar (no repasse ela vem da legenda do grupo
    líder, ou digitada à mão na fila), e `findCouponByCode` acha o valor dela em
    `ml_coupons.code`. Nada disso roda fora do Mercado Livre: `ml_coupons` é a aba
    de cupons do ML, e sem essa trava um produto da Amazon com a palavra "SAVE10"
    na legenda do grupo líder colidiria com um cupom do ML de mesmo nome e a
    mensagem anunciaria um preço que não existe.

    O terceiro passo da ordem acima não é redundância: `couponCampaignId` só é
    preenchido quando `couponBoost` ≠ `off`, e `off` é o **default** — sem ele a
    variável nunca calcularia nada na campanha comum, que é a maioria.

    O `renderTemplate` continua **síncrono e puro**: recebe o número já pronto em
    `priceWithCoupon` e cai no `p.price` quando ele é `null`. E o `.replace` de
    `{preco}` não come o `{preco_com_cupom}` porque a regex exige a chave fechando
    logo depois (`/\{preco\}/g`) — tem teste pra isso.

    Os modelos prontos (`MESSAGE_PRESETS`, `DEFAULT_MESSAGE_TEMPLATE`) não mudaram:
    a variável entra só na lista de "Inserir:" e na prévia, e nenhuma campanha que
    já existe muda de comportamento sozinha. 


    102. [x] Quero adicionar 2 links nos tutoriais. Cria uma aba de ADMIN de "EDITAR TUTORIAIS", onde eu consigo editar a pagina de tutoriais que aparece para todo mundo. La quero editar os topicos que ja tem, poder excluir e criar novos e adicionar os respectivos vídeos.

    103. [x] No modelo de mensagem das campanhas quero que de pra apertar ctrl z para desfazer as coisas

    Ctrl+Z desfaz e Ctrl+Shift+Z (ou Ctrl+Y) refaz dentro do editor de modelo.
    O undo nativo do navegador não servia: os botões de "Formatar:" e "Inserir:"
    reescrevem o texto por fora do `onChange`, e o React zerava o histórico do
    textarea a cada clique. Então o histórico agora é nosso —
    `frontend/src/data/textHistory.js` (`useTextHistory`), pilhas em `useRef`,
    limite de 100 passos, com o cursor voltando junto com o texto.

    Digitação corrida vira um passo só (junta o que for digitado em menos de
    600 ms); espaço, quebra de linha, colar e apagar seleção fecham o passo. Os
    botões da barra sempre entram como passo próprio. Trocar de modelo, criar
    modelo novo, ativar na campanha ou "Descartar" zeram o histórico — Ctrl+Z
    não traz de volta o texto de outra aba.

    Nada mudou no backend nem no formato salvo: o histórico só existe em memória
    enquanto o editor está aberto. Testes em
    `frontend/src/__tests__/TemplateUndo.test.jsx`. 