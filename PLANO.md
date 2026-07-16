* FRONT
    * ajustar validacao do token de auth (x)
    * Quando fizer alterações, se quiser mudar de aba -> Alerta para salvar alterações (x)
    * Dentro da campanha:
        * alterar ordem das abas: Visão Geral - Gerencial - Buscar Produtos (alterar nome) - Fila - Janelas de envio - Modelos de Mensagens - Histórico (x)
    * Visão Geral:
        * Melhorar as métricas: 
            * envios esta semana com números por dia; (x)
    * Modelos de mensagem:
        * Não ser por Aba, mas sim por lista suspensa (O padrão fica escrito Padrão, mas é o que fica de titular na lista) (x)
    * Busca de Produtos:
        * Alterar nome para Busca de Produtos (x)
        * Adicionar produto manualmente:
            - Categoria ser pega automatica ( )
            - Adicionar lista de links (separados por vírgula? por /n? etc...) ( )
            - Fila de envio do ML ( )
    
    * Fila de Envio: 
        * Troca de ordem não ta funcionando (x)


* NIMBUS (Whats) COMO SISTEMA ADMIN
    * Criar grupos com o Nimbus (x)
    * Notificações com o Nimbus (x)

* NOTIFICAÇÕES DE USUÁRIO
    - Whats Nimbus (x)
    - Criar menu (x)
        * Whats desconectado (x)
        * Campanha desativada (x)
        * Campanha reativada (x)
        * Campanha parada (incluindo o motivo) (x)
        * Busca de produtos 
            * X Produtos a serem aprovados (x)
            * X Produtos buscados e já aprovados  (x)
        * Fila vazia (x)
        

* AFILIADOS
    * Mercado Livre:
        - Tag de afiliado - mercadolivre.com.br/afiliados (X)
        - Cookie -> requisição para gerar link reduzido e depois procura o cookie no f12 ( )
            * refazer para pegar tutorial ( )
            * Extensão pro chrome? ( )
    * Amazon:
        - Tag de afiliado (X)
    * Shopee
        - App ID ( )
        - App Secret -> Pega em affiliate.shopee.com.br → painel do programa de afiliados → API Open. ( )
    
* ASSINATURA
    - Testar Front ( )
    - Testar Real com cartão de crédito fake so Stripe ( )

* SCRAPING

    * Mercado Livre:
    - Testar Filtros( )
    - Tempo de Scraping Aceitável? ( X )
    - Qualidade dos produtos aceitáveis? ( X )
    - Produtos:
        * Nome ( X )
        * Imagem ( X )
        * Preço ( X )
        * Desconto (  ) - Tem preço antigo -> calcular o desconto de fallback
        * Avaliação ( X )
        * Núm de Vendas ( )

    * Shopee:
        - Testar Filtros ( )
        - Tempo de Scraping Aceitável? ( X )
        - Qualidade dos produtos aceitáveis? ( )
        - Produtos:
            * Nome ( X )
            * Imagem ( X )
            * Preço ( X )
            * Desconto ( X ) 
            * Avaliação ( X )
            * Núm de Vendas ( X )

    * Amazon:
        - Testar Filtros( )
        - Tempo de Scraping Aceitável? ( )
        - Qualidade dos produtos aceitáveis? ( )
        - Produtos:
            * Nome ( X )
            * Imagem ( X )
            * Preço ( X )
            * Desconto ( X ) 
            * Avaliação ( X )
            * Núm de Vendas ( )
        

* REPASSE WHATS ( ) REPASSE
    * Criar Campanha de Repasse? Criando vários Grupos e etc, mas tendo o líder que é simplesmente replicado nos outros?
    * Repassar de mais de um grupo? SÓ UM GRUPO
    * Capturar links de produtos -> transformar de afiliado para normal -> transformar pro nosso afiliado
    * Capturar os links dos produtos para alimentar a fila (aprovados auto ou não)


* TESTES
    * Busca de Produtos:
        * Filtros:
        - Faixa de preço: mínimo (X); máximo (X)
        - Desconto mínimo (X)
        - Avaliação mínima (X)
        - Vendas mínimas ( )
        - Pesquisa por palavras chave: única (x); paralelas (x);
    * Configurações
    - Trocar Senha ( )
    - Excluir conta ( )
    - Notificações ( )
    - Sair da conta ( )
    - Alterar informações ( )
    * Todo o Assinatura ( )
        * Implementar 

    
* TUTORIAIS
    * Criar e gerenciar campanhas ( )
    * Afiliados ( )
    - ML ( )
    - Shoppee ( )
    - Amazon  ( )

* DESIGN
    * Adicionar a Marca ( )

* SEGURANÇA
    * Dados -> Stripe? Supabase
    * Análise de Segurança como um todo