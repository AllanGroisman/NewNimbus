
1. [] Quero conferir se o ambiente mobile esta condizente e bem construido para utilizacao do usuario.

2. [] Quero fazer um resumo geral do sistema e criar um arquivo na raiz do projeto que explique didaticamente como esta funcionando. Náo sei exatamente tudo que quero no resumo, mas as tecnologias usadas, onde estao os banco de dados, o que tenho guardado em cada um, quais sao minhas camadas de seguranca, como funciona, como esta arquitetado para expansao caso cresca o numero de usuario, onde e como sao feitos os backups e o que tem neles, um resumo do custo computacional das diferentes partes da arquitetura, etc...

3. [] Verificar brechas de segurança pelos endpoints do site.

4. [x] Revisar login com google. Segue o que aparece: Acesso bloqueado: erro de autorização

allangroisman@gmail.com

Não é possível fazer login no app porque ele não obedece à política do OAuth 2.0 do Google.

Se você é o desenvolvedor do app, registre a origem JavaScript no Console do Google Cloud.
Saiba mais sobre o erro
Se você é um desenvolvedor desse app, consulte os detalhes do erro.
Erro 400: origin_mismatch

5. [x] Como ele detecta os cupons no repasse? Por texto? Se sim, quero poder editar essa lista de textos.

6. [x] Quero analisar os testes e ver quanto demora cada um. Quando estou fazendo novas implementações, ta demorando mt por conta dos testes. Quero entender bem e deixar salvo aqui para que quando implementar, apenas fazer os testes necessários.

7. [x] Quero adicionar um aviso de notificacao para quando o claude termina alguma tarefa ou requer alguma escolha ou ação minha.

8. [x] Na aba de usuários do ADMIN, o que quer dizer o card de ATIVAS exatamente? Que está sendo pago? Que está funcionando seus grupos? Quero saber mais dados sobre os usuarios nesta aba, se as campanhas estão ativas, quais numeros conectados, pode oferecer sugestões do que aparecer. Quero que apareçam estas informações ao clicar no usuário extendendo para baixo. 

9. [] Quero exigir telefone dos usuários. Como tu sugere que seja feito?

10. [x] Na aba de busca de produtos, quero que tire aquele salvar alterações que aparece na parte debaixo da tela.

11. [] Na aba busca de produtos o que mais que tu acha que da pra melhorar nesta tela? Ta meio ruim ficar salvando as alterações toda hora, quanto menos precisar desse botão, melhor.

12. [] Teste de cupom não está funcionando, me parece que é por causa do captcha do ML ou pq a pagina ali mudou. Revisa a forma como se faz e as paginas do ML.

13. [x] A parte superior esquerda da página, onde tem a marca, escrito Nimbus e painel admistrativo. Quero que tire o escrito "painel admistrativo" e quero que a junção da marca com o escrito seja clicável para ir para a Home do Sistema (a home pode ser o menu de campanhas)

14. [] Quero arrumar o scrap dos produtos de um cupom no ML.

15. [] Nos cupons, quero que exclua os antigos que já não funcionam mais.

16. [] Nos cupons, quero que todos os cupons que são detectados no repasse sejam adicionados na lista e que se não estiverem, seja feito o scraping de seus produtos.

17. [x] Revise a tela de busca de produtos, por exemplo, diz que vai preencher so ate 20 produtos, mas passou do limite. Verifica se ta tudo certo. também, o que mais que tu acha que da pra melhorar nesta tela?

18. [x] Tira a parte "Produtos com cupom do Mercado Livre
Tanto faz
Preferir com cupom
Só com cupom
Vale no preenchimento automático da fila. Os cupons vêm de Admin › Cupom › Cupons do ML; com “só com cupom”, a fila pode vir vazia se nenhum produto da campanha estiver num cupom." da aba de busca de produtos.

19. [] O que da pra melhorar de UI na aba de busca de produtos das campanhas?

20. [x] Ta mt estranho a adição de produtos na fila, vai um numero, aparece outro, ta mt confuso, preciso que tu revise.

21. [] Nos USUARIOS de ADMIN, mostrar sempre, antes de expandir, os numeros dos whats conectados.

22. [] Nos USUARIOS de ADMIN, adicionar um filtro de cancelados além de pagando, nbao verificados, suspensos, etc...
