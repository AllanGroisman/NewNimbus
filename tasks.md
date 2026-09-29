1. [] Quero acrescentar para poder repassar Canais e não somente grupos do WhatsApp.

2. [x] Quero acrescentar para puxar dados de afiliados para saber os desempenhos. Pode começar pelo do ML. Mas quero fazer pela api nada de scraping de pagina. (ML e Shopee feitos; na Shopee, vendas por grupo via sub_id do link)
 

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




