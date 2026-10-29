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

2. [x] Ao clicar em editar descrição dos grupos do whats, aparece escreita a descrição atual? Queria uma forma fácil de poder copiar tb a mesma descrição para todos os grupos de uma campanha, pode ser no proprio popup de editar a descricao, inclusive quando apertar pra salvar apareça para salvar apenas para esse ou aplicar em todos os grupos da campanha.

3. [x] Quero que a aba desempenho da shopee se aproxime o maximo possivel da aba do ML.

4. [] O twitter react ta legal, mas não to conseguindo upar a imagem pra fotinho de perfil, quero tb que tenha um retangulo por tras do "tweet" que eu possa mudar a cor e o contorno. Tb quero poder mudar o tamanho de todo o tweet e de todo o video. Tb quero poder expandir o preview para ver como esta fincando o template, ta muitop pequeno e nao da pra ver nada hoje.

