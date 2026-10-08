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


1. [] Quero acrescentar para poder repassar Canais e não somente grupos do WhatsApp.

2. [x] Quero acrescentar a opção nos modelos de mensagens de utilizar imagem do produto ou apenas a imagem do proprio link que o whats puxa.

3. [] Ao clicar em editar descrição dos grupos do whats, aparece escreita a descrição atual? Queria uma forma fácil de poder copiar tb a mesma descrição para todos os grupos de uma campanha, pode ser no proprio popup de editar a descricao, inclusive quando apertar pra salvar apareça para salvar apenas para esse ou aplicar em todos os grupos da campanha.

4. [x] Quantas pessoas entraram/sairam do grupo, filtrar por campanhas, quantidade de membros, quantidade de cliques é possivel? o que mais?. Estatisticas dos grupos. Automaticamente os utilizados nas campanhas entram la. Quero que me ajude a pensar nisso. Quero que seja uma aba Grupos. 

5. [x] Quero que na aba do ML seja necessario apenas colocar o cookie. A tag de afiliado manual tu tira fora completamente. Com o cookie pronto quero que ao testa-lo, vá em busca das etiquetas da conta. As etiquetas vão aparecer individualmente nas campanhas onde é possivel escolher a etiqueta a ser utilizada em cada uma delas.

6. [x] Quero que na hora de criar e duplicar um grupo do whats, tenha um campo de numero. Quando a pessoa cria, ele vem como padrão 1, se ela quiser mudar pra qual;quer numero pode. Depois, se ele for duplicado, soma-se 1 ali. Assim Fica Ofertas Tech #1, #2, .... 

7. [x] Olhando a lógica dos modelos de mensagem, o que da pra melhorar ali? Quais linhas não aparecem se não tem aquele parametro? Se o preço com cupom não tem aparece o preço normal? Revisa toda essa logica e faça sugestoes de como melhorar. Inclusive faça sugestão de como deve ser o modelo padrão que vem.

8. [] Quero que ao criar um grupo de whatApp, o exemplo padrão para nome do grupo seja o proprio nome da campanha e só. Gostei de como ele está hoje que fica só de fundo e consigo escrever por cima, porém quero que se eu apertar TAB ele preencha a escrita com o exemplo. Assim acelara o processo.O que tu acha?

9. [] Excluo grupos no whats, mas nas campanhas eles ainda aparecem como conectados.Queria que tivesse uma verificação e que se eles não forem detectados seja sugerido a exclusão deles da campanhas com um botão de excluir em cada um.

10. [x] Separa A conta de afiliado que busca coisas na API da shopee, esse é DE ADMIN e geral pro sistema. Pros usuarios, que tem na aba Shopee só precisa do App ID para fazer o link de afiliado, certo?