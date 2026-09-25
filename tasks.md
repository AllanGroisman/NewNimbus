1. [] Quero acrescentar para poder repassar Canais e não somente grupos do WhatsApp.

2. [] Os cupons estão demorando muito, como posso otimizar?

3. [x] Quero poder programar cada etapa das 3 de captura de cupons para horas especificas do dia.

4. [x] Quero receber notificações no grupo de whats de admin assim como recebo do scraping, dos cupons.

5. [x] Na aba dos cupons no card onde tem us cupons guardados, ta mt ruim de visualizar eles, tenho que ficar rolando lateralmente. Talvez pq a categoria e o tipo serem muito largos? Da uma olhada e sugira como resolver para ficar melhor de ver.

6. [x] Quando saio e volto para a aba onde faco a busca de cupons, desaparece a barra e as indicações que ta rodando algo. Quero que volte normalmente onde esta. 

7. [x] Quero corrigir a captura de cupons pelo repasse. No momento todos os cupons estão dando que o ML não respondeu. Quero que pegue o link de produto que chegou, tente utilizar o cupom e verifique se ele é válido ou não.

FLUXO

1) Página do produto
   - Abrir a URL do produto (usuário já logado).
   - Clicar no botão azul "Comprar agora" (coluna da direita, abaixo de "Quantidade").

2) Checkout — tela "Finalize sua compra"
   - URL: https://www.mercadolivre.com.br/checkout/review/onestep
   - Na coluna direita, caixa "Resumo da compra", clicar no link azul
     "Cupons (X/Y em uso)" (ex.: "Cupons (1/1 em uso)"). Ele fica na linha abaixo de "Frete".
   - NUNCA clicar em "Pagar e finalizar".

3) Modal "Cupons" (abre por cima da página)
   ATENÇÃO: o conteúdo está dentro de um IFRAME:
     iframe#bf_coupons_iframe  (src: https://www.mercadolivre.com.br/cupons/cho)
   Todos os seletores abaixo devem ser buscados DENTRO desse iframe.

   Elementos:
   - Campo de código:  input#inputcode-textfield-inline  (placeholder "Insira seu código aqui")
   - Botão:            button com texto "Inserir" (classe andes-button--quiet), à direita do campo
   - Resumo:           texto "Você está economizando R$ XX,XX com N cupom"
   - Lista:            seção "Cupons do Mercado Livre", com um cartão por cupom
   - Fechar:           "X" no canto superior direito do modal

4) VERIFICAR SE O CUPOM JÁ ESTÁ APLICADO
   Na lista "Cupons do Mercado Livre", procurar um cartão cujo texto contenha "Com MELIKIDS".
   Ele está aplicado quando:
     - o cartão tem um ícone com check verde, E
     - o botão do cartão mostra "Aplicado" e está desabilitado
       (classe andes-button--disabled / disabled=true).
   → Se já está aplicado: pular para o passo 6.

5) SE NÃO ESTIVER: ATIVAR PELO CÓDIGO
   - Clicar no input#inputcode-textfield-inline, limpar o campo e digitar o código
     (simular digitação real, com eventos input/change).
   - Clicar em "Inserir" e aguardar ~2s.
   - Checar se o contêiner do campo (.andes-form-control) tem a classe
     "andes-form-control--error". Se tiver, ler o texto de erro abaixo do campo:

     • "Este cupom já foi adicionado, mas ainda pode ser usado em produtos selecionados."
         → status "ja_aplicado". Ir ao passo 6.
     • "O cupom não está mais disponível."
         → é a resposta para código INEXISTENTE ou esgotado/expirado
           (o site não diferencia). Status "falha". Registrar a mensagem e encerrar.
     • Qualquer outro texto → status "falha", registrar o texto exato.

   - Se NÃO tiver erro: confirmar que surgiu na lista "Cupons do Mercado Livre"
     um cartão com "Com <CÓDIGO>" e botão "Aplicado" desabilitado,
     e que "Cupons (N/M em uso)" e o total no Resumo da compra mudaram.
     → status "aplicado_agora". Ir ao passo 6.

6) EXTRAIR AS CONDIÇÕES DO CARTÃO DO CUPOM
   Exemplo real do cartão MELIKIDS:
     - Nome/código:      "Com MELIKIDS"
     - Desconto:         "15% OFF"
     - Compra mínima:    "Compra mínima R$ 59"
     - Limite:           "Limite de R$ 50"
     - Validade:         "Venc. 27/09/2026"
     - Alerta:           "Está esgotando!" (texto laranja, opcional)
     - Status:           "Aplicado" (botão desabilitado)
   Os campos da linha de condições vêm separados por " | ".
   Pegar também, fora do iframe, no "Resumo da compra":
     - "Cupons (N/M em uso)" e o valor de desconto (ex.: "- R$ 40,48")
     - Total com desconto (ex.: "R$ 229,42"; o preço riscado é o valor sem desconto)

   Saída sugerida (JSON):
   {
     "codigo": "MELIKIDS",
     "status": "ja_aplicado" | "aplicado_agora" | "falha",
     "desconto": "15% OFF",
     "compra_minima": 59.00,
     "limite_desconto": 50.00,
     "vencimento": "2026-09-27",
     "alerta": "Está esgotando!",
     "desconto_no_pedido": 40.48,
     "total_final": 229.42,
     "mensagem_site": "<texto de erro/sucesso, se houver>"
   }

7) Fechar o modal no "X". Não finalizar a compra.

8. [] Quero que toda essa função de abrir o chrome com a extensão ativa e que ele busque os cupons seja feita na vps e não necessariamente no meu computador. Quero ter as duas opções de rodar no navegador onde estou ou na propria vps. Até agora rodei e rodei e não precisei fazer nada de captcha. Mesmo assim, quero ter notificação no whats de admin quando acontecer e a possibilidade de resolver o captcha manualmente para liberar a continuidade. Eu hosteio na hostgator a vps se isso ajuda, acredito poder entrar manualmente por la.

9. [] Quero um historico expansivel em cada um dos botões de captura de cupons e seus produtos. Dessa forma consigo ver de onde vieram as coisas.

10. [] Pq os cupons de loja estão sendo puxados mesmo marcando para ignorar cupom de loja? quando marco em "tudo o que o ML tiver", ele ignora a marcação que está la nos limites desta etapa?

11. [] Nos cupons que chegam no repasse quero que o sistema tire prints da pagina final que chegou dos cupons que não derem certo para que eu possa verificar as situações depois. 

12. [x] Nos cupons guardados, quando abro os produtos, se o link é muito grande, tenho que arrastar pra direita pra chegar nos botões do cupom. Deidxa o tamanho fixo nas coisas aqui, se cortar os textos não tem problema, só tem que aparecer tudo na tela. 


DOWNLOADER:

13. [] Filtro mais vistos
14. [] Shopee
15. [] Como editar os templates padrão
16. [] O link pode ser do perfil ou de um video especifico. Se for de perfil, pede quantidade de videos, se é pra trazer os mais vistos e se é pra trazer só os que tem produtos vinculados. Se for individual, cria uma lista no qual da pra acrescentar mais links de videos, assim consegue-se pegar varios videos de contas diferentes e plataformas diferentes (não necessariamente precisa ser todos do youtube, pode ser misturado com os do tiktok.)


Geral:

16. [] Site com as promoções

17. [] Quero criar uma aba de Cupons logo após a aba Produtos que tem na area de ADMIN onde eu consigo ver todos os cupons, navegar entre eles, ver um resumo, os produtos de cada um, filtrar os cupons, filtrar depois dentro nos seus produtos, etc... Pensa em algo legal e de fácil utilização. 

18. [] Cria um botão na extensão que busca os cupons para limpar meu carrinho do mercado livre.