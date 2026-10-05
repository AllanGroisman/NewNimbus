1. [] Quero acrescentar para poder repassar Canais e não somente grupos do WhatsApp.

2. [x] Quero acrescentar para puxar dados de afiliados para saber os desempenhos. Pode começar pelo do ML. Mas quero fazer pela api nada de scraping de pagina. (ML e Shopee feitos; na Shopee, vendas por grupo via sub_id do link)
 
3. [x] Quero um botão para baixar (se for possivel instalar direto?) a ultima versão da extensão que pega os cupons pelo proprio sistema. Pode colocar  ele em uma aba nova de Extensão na sessão de admin. (Admin › Extensão: baixa o zip e compara a versão do Chrome com a do servidor. Instalar direto não dá: fora da Chrome Web Store o Chrome só aceita "Carregar sem compactação".)

4. [x] Quero uma função nova nas campanhas que é mandar mensagem no privado para todos os membros de um grupo do whatsapp especifico ou para todos de uma campanha. Pode acrescentar o botão nos ... de cada grupo lá na aba de grupos ou acrescentar um botão geral ali para fazer em todos os grupos. Deve-se abrir um popup e a partir dali ser possível escrever a mensagem que será enviada. (Só admin. Envio em segundo plano: 20–45s entre mensagens, até 200 por número por dia, para depois de 5 falhas seguidas.)

5. [x] No mobile ta esquisito de usar, o menu hamburguer ta em cima na direita e abre na esquerda, as paginas geralmente são abertas com um zoom e preciso tirar pra usar, etc.. Quero que tu de uma boa revisada e me apresente um plano para deixar o sistema adaptado e redondo no mobile também. (O zoom tinha duas causas: todo input era 13px, e o iPhone amplia ao focar campo com menos de 16px — o modal focava o 1º campo ao abrir; e telas mais largas que o celular — pendentes, QR, E-mails, gráfico do repasse, tabelas. Agora: ☰ à esquerda com o nome da página e a gaveta deslizando do mesmo lado; inputs 16px no celular; modal cabe na tela, com título e ✕ fixos, e no toque não abre o teclado sozinho; fila reordena com ↑ ↓ no toque; WhatsApp abre direto no código de 8 dígitos no celular; alvos de toque maiores; motivos de botão travado viram texto no toque. `tests/e2e/mobile.spec.js` passa por todas as telas a 360px.)

6. [x] A funcao que manda mensagens para os membros do grupo, quero que rode sempre em segundo plano, com o progresso pequeno no proprio grupo, podendo cancelar no meio. Assim fico livre pra fazer outras coisas. (Enviar fecha o popup e o cartão de cada grupo destino mostra o andamento, com um cancelar que para só aquele grupo. Números diferentes enviam ao mesmo tempo; no mesmo número, o envio novo espera na fila.)

Rodar o Claude na VPS e desligar o computador (via tmux):

1. Instalar na VPS: `sudo apt install -y tmux`
2. Abrir uma sessão tmux e iniciar o Claude dentro dela:
   ```
   tmux new -s claude
   cd ~/NewNimbus
   claude --continue   # retoma a última conversa, ou só "claude" para uma nova
   ```
3. Passar a tarefa e confirmar que começou a rodar. Depois pode fechar o VS Code e desligar o PC — o tmux mantém o processo vivo na VPS.
4. No dia seguinte, conectar pelo túnel, abrir um terminal e rodar: `tmux attach -t claude`

7. [x] SÓ PARA QUEM É ADMIN: acrescente na aba em que coloca o cookie do mercado livre, a opção de trocar a Etiqueta em uso. (Configurações › Mercado Livre, só para admin: "Trocar etiqueta" busca no ML as etiquetas da conta (as do Administrador de etiquetas) e "Usar esta etiqueta" troca a em uso no ML e a TAG salva aqui — se o ML recusar, nada muda. Avisa quando a TAG salva não é da conta. O worker agora relê a config de afiliado a cada 30s: antes, trocar TAG ou cookie só valia nos envios depois de reiniciá-lo.) 

8. [x] No buscar produtos dos cupons tem uns que não puxam nada na vitrine, quero poder filtrar ali pra ver eles na propria pagina de scraper de cupons, tb quero que eles não contem como produtos sem cupons normais, que contem como vitrine vazia, saindo da conta e da busca de "só os que não tem nenhum produto". (A vitrine que abre sem card nenhum agora fica gravada no cupom — muro não conta. Ela tem número próprio, "Vitrine vazia", no resumo do card 2 e sai das duas filas do botão 2; só o "buscar produtos" da linha tenta de novo. Na tabela, o novo filtro de estado separa completa / parcial / sem nenhum produto / vitrine vazia. Se a vitrine trouxer produto depois, a marca some.) 

9. [x] Cria um botão de apagar todos os cupons vencidos e todos os produtos que vieram por eles. Cuide para não apagar os produtos que apenas foram vinculados ao cupom, mas que tiveram outra origem que não a vitrine. (Card de cima, "🗑 Apagar vencidos": antes de apagar, mostra quantos produtos saem e quantos ficam. Produto só sai se nasceu da vitrine e não tem mais nada: nem scraping, nem repasse, nem checkout, nem cupom ainda válido. O catálogo agora marca quem nasceu da vitrine (`soDaVitrine`). Os produtos colhidos ANTES desta versão não têm a marca e não são apagados pelos botões — continuam saindo pelo purge diário do scraping.)

10. [x] Cria um botão em cada cupom para apagar seus produtos (somente os que vieram pela vitrine). ("apagar produtos" na linha do cupom: saem os vínculos de vitrine (completa e parcial) e os produtos que só existiam por ela. Ficam os de checkout e repasse e os que estão em outro cupom. O cupom fica na lista e volta para a fila do botão 2.)

12. [] O buscar produtos individual de cada cupom tem qual filtro? Quantos produtos traz?

