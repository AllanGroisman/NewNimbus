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

4. [] Quantas pessoas entraram/sairam do grupo. Estatisticas dos grupos. Automaticamente os utilizados entram la.

5. [] Quero que na aba do ML seja necessario apenas colocar o cookie. A tag de afiliado manual tu tira fora completamente. Com o cookie pronto quero que ao testa-lo, vá em busca das etiquetas da conta. As etiquetas vão aparecer individualmente nas campanhas onde é possivel escolher a etiqueta a ser utilizada em cada uma delas.