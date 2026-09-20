1. [] Quero conferir se o ambiente mobile esta condizente e bem construido para utilizacao do usuario.

2. [] Quero fazer um resumo geral do sistema e criar um arquivo na raiz do projeto que explique didaticamente como esta funcionando. Náo sei exatamente tudo que quero no resumo, mas as tecnologias usadas, onde estao os banco de dados, o que tenho guardado em cada um, quais sao minhas camadas de seguranca, como funciona, como esta arquitetado para expansao caso cresca o numero de usuario, onde e como sao feitos os backups e o que tem neles, um resumo do custo computacional das diferentes partes da arquitetura, etc...

3. [] Verificar brechas de segurança pelos endpoints do site.

4. [] Nos cupons, quero que todos os cupons que são detectados no repasse sejam adicionados na lista e que se não estiverem, seja feito o scraping de seus produtos.

5. [] O que da pra melhorar de UI na aba de busca de produtos das campanhas?

6. [] Na busca dos cupons quero ver o progresso da raspagem dos cupons, exatamente o que esta sendo feito na hora, pra saber o que acontece, pq demora, e etc...

7. [] Como funciona o vinculo dos produtos dos cupons com os produtos que ja fiz scraping, o sistema percebe quando sao o mesmo produto e ja vincula? Os cupons ficam vinculados?

8. [] Quando coloco a palavra para descobrir palavra dos cupoms diz que reconheceu e que é da campanha de numero 14193894 por exemplo. Queria que as campanhas quando forem buscadas, tivessem esse numero associado para que seja facil vincular campanha a palavra. Por exemplo, no link do cupom https://lista.mercadolivre.com.br/_CustId_2903552873?coupon_campaign_id=13495993 tem ali o ID, não seria este mesmo? NAO PRECISA FAZER TODOS OS TESTES DO SISTEMA NOVAMENTE, SÓ ESPECIFICOS PARA O QUE FOI ALTERADO.

9. [] Consigo buscar um cupom pelo ID dele?

10. [] Consigo entrar no PC da VPS que tem linux, instalar o chrome com a extensão e fazer o captcha manualmente quando necessario? Para automatizar a busca por cupom ou as coisas que precisam de captcha

11. [x] Além do QRCode, da pra entrar no whats com codigo tb, certo?  Quero acrescentar esta opção.

12. [] Quero que os produtos do sistema tenham os cupons os quais é possível aplicar. O que falta? Qual a forma mais facil de descobrir qual cupom funciona nos produtos? Da uma olhada no que o sistema ja faz e no que é possivel
   Faltava DADO, não código: 4.035 produtos e UM com cupom. Agora uma varredura sem
   navegador (card no topo de Cupom › Cupons do ML) traz os produtos de cada cupom e as
   amostras dos cards pro catálogo, já carimbados — 1ª rodada: 1 → 270. Aba nova
   "Cupons do produto" responde quais cupons valem num link, e a sonda do checkout
   (extensão 2.2.5) já lê a lista que o ML oferece PARA AQUELE carrinho — inclusive o
   desconto que ele calculou — e grava como origem "checkout". FALTA: rodar isso em
   LOTE, produto a produto (é a task 15), e concluir "este cupom não vale aqui" pela
   ausência, que só depois de mais sondas. E cupom sem palavra ainda não sai na
   mensagem (task 13).


13. [] Quero adicionar o desconto_cupom como possivel de mandar na mensagem e também o desconto_total que junta o desconto da promoção + o desconto do cupom, assim consigo mostrar o preço original e o preço final a ser pago depois de todos os descontos.

14. [x] Os cupons estão sendo puxados somente de Brinquedos, Hobbies e Bebês
Eletrônicos, Áudio e Vídeo, moda e acessorios? Somente essas 3 categorias?
   Eram essas 3 porque a fila de categorias saía de um dicionário no banco que nada
   em produção escrevia desde o commit 37a81d0 — e como só se aprende uma categoria
   visitando-a, a rodada nunca sairia dali sozinha. Agora ela lê a lista completa que
   o ML manda em toda página (`availableGroupingsKeys`), carimba até o fim de cada
   vertical (o carimbo passou a contar como progresso) e grava a cada categoria.

15. [] Quero um botão para testar os cupons disponiveis nos produtos que estão no sistema. Faça um plano de como implementar isso.