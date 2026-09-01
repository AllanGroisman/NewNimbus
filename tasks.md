
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
