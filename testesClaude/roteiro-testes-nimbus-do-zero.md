# Roteiro de testes "do zero" — Nimbus

Script reprodutível pra rodar comigo (ou qualquer testador) num ambiente limpo: **sem conta logada, sem WhatsApp conectado, sem afiliados configurados**. Baseado nos fluxos reais do app (conferidos no código-fonte, `tests/e2e/`) — não é só um "clique aqui, clique ali" genérico.

## Como usar este arquivo

Cada bloco tem: **Pré-condição** (o que precisa estar limpo antes), **Passos**, **Resultado esperado**, e **Precisa de você** (quando um passo exige ação sua — celular, e-mail real, cartão de teste, etc.). Marque `[x]` conforme for rodando.

Pra reproduzir num ambiente 100% limpo: um usuário novo (não o admin `allangroisman@gmail.com`), sem números de WhatsApp, sem afiliados salvos, sem campanhas.

---

## 1. Cadastro (registro de novo usuário)

- [ ] **Passos**: Tela inicial → botão "Cadastrar" → preencher Nome completo, Email (novo, nunca usado), Senha, Confirmar senha → "Criar conta".
- [ ] **Esperado**: NÃO loga direto. Cai na tela "Confirme seu email" com o texto "Enviamos um link de confirmação".
- **Precisa de você**: acesso à caixa de entrada do e-mail usado no cadastro, pra clicar no link de confirmação.

## 2. Confirmação de e-mail

- [ ] **Passos**: Abrir o link de confirmação recebido por e-mail.
- [ ] **Esperado**: conta vira "verificada", consegue fazer login em seguida.

## 3. Login inválido (caso negativo)

- [ ] **Passos**: Tela de login → email que não existe (`naoexiste@test.local`) + senha qualquer → "Entrar".
- [ ] **Esperado**: mensagem de erro visível (algo como "credenciais inválidas").

## 4. Recuperar senha

- [ ] **Passos**: Tela de login → "Esqueci minha senha".
- [ ] **Esperado**: tela "Recuperar acesso" com botão "Enviar link de reset".
- **Precisa de você**: se quiser testar o fluxo completo, checar o e-mail com o link de reset.

## 5. Primeiro login (usuário novo, confirmado)

- [ ] **Passos**: Login com o email + senha cadastrados.
- [ ] **Esperado**: entra no app, sidebar aparece com "Visão Geral" visível. Como é usuário comum (não admin), a seção **ADMIN** do sidebar (Produtos, Scraping, Usuários, Backups, etc.) **não deve aparecer** — isso é o gating de admin.

## 6. Dashboard vazio (estado inicial)

- [ ] **Passos**: Ficar em "Visão Geral" logo após o primeiro login.
- [ ] **Esperado**: CTA de "Crie sua primeira campanha" (sem campanhas listadas ainda).

## 7. Conectar WhatsApp do zero

- [ ] **Passos**: Sidebar → WhatsApp → "+ Adicionar número" → preencher apelido → aguardar.
- [ ] **Esperado**: modal mostra "Conectando ao WhatsApp..." e depois exibe o QR code (expira em ~30s, dá pra pedir novo QR clicando em "cancele e tente novamente").
- **Precisa de você**: escanear o QR com um WhatsApp real (celular → Menu → Dispositivos vinculados → Vincular dispositivo) pra validar que a conexão completa (status vira "Conectado").

## 8. Configurar afiliados (Mercado Livre, Amazon, Shopee)

Repetir pra cada uma das 3 lojas (Mercado Livre, Amazon, Shopee no menu principal, não no admin):

- [ ] **Mercado Livre**: preencher TAG de afiliado + cookie de sessão (`document.cookie` de mercadolivre.com.br/afiliados) → "Salvar" → deve aparecer botão "Apagar" (= configurado). Testar "Apagar" depois pra confirmar que volta ao estado vazio.
- [ ] **Amazon**: preencher TAG de afiliado (ex: termina em `-20`) → "Salvar" → mesma verificação de "Apagar".
- [ ] **Shopee**: preencher App ID + App Secret → "Salvar" → mesma verificação.
- **Precisa de você**: se quiser testar com dados reais (não só valores fictícios), as credenciais de afiliado de cada plataforma são suas (pegar em mercadolivre.com.br/afiliados, afiliados.amazon.com.br, affiliate.shopee.com.br).

## 9. Criar primeira campanha (fluxo completo — Original)

- [ ] **Passos**: "+ Nova campanha" → modal mostra escolha de tipo ("🔎 Original" vs "🔁 Repasse") → escolher "Original" → nome da campanha → selecionar 1+ categorias → "Criar campanha".
- [ ] **Esperado**: entra direto no painel da campanha (GroupDashboard), aba "Visão geral" visível, nome da campanha aparece.
- [ ] **Navegar pelas abas**: Gerenciar, Grupos, Busca de Produtos, Fila, Janelas de envio, Modelos Mensagens, Histórico — todas devem renderizar sem erro.
- [ ] **Persistência de aba ao recarregar**: ficar numa aba que não seja a primeira (ex: "Fila") → F5 → confirmar que volta pra mesma campanha e mesma aba (não reseta pra "Visão geral").
- [ ] **Vincular grupo do WhatsApp — grupo existente**: aba Grupos → "+ Adicionar grupo" / "Adicionar primeiro grupo" → modal "Adicionar grupo" com 2 opções ("Criar grupo novo" / "Adicionar grupo existente") → escolher "Adicionar grupo existente" → selecionar número → escolher um grupo real do WhatsApp conectado no passo 7.
- [ ] **Vincular grupo do WhatsApp — criar grupo novo**: repetir o "+ Adicionar grupo", agora escolhendo "Criar grupo novo" → preencher nome do grupo, número de origem, participantes (telefones com DDD, separados por linha/vírgula) → "Criar" → conferir que o grupo aparece na aba Grupos e foi realmente criado no WhatsApp real.
- [ ] **Criar grupo usando o WhatsNimbus como participante**: no mesmo formulário "Criar grupo novo", se o checkbox "Usar o WhatsNimbus como participante" aparecer (só aparece se o WhatsNimbus estiver conectado — ver passo 19), marcar ele e deixar o campo de participantes vazio → "Criar" → deve funcionar sem exigir telefone extra (o WhatsApp exige ao menos +1 participante além de você, e o número do sistema supre isso).
- **Precisa de você**: ter um grupo de WhatsApp real (do número conectado) pra vincular, e confirmar que o "grupo novo" criado pelo Nimbus realmente aparece no seu WhatsApp de verdade.

## 10. Criar campanha de Repasse (fluxo alternativo, sensível — envolve grupo real)

Repasse é o outro tipo de campanha: em vez de buscar produtos no catálogo, o sistema escuta um **grupo líder** do WhatsApp e captura automaticamente links de produto (Mercado Livre/Shopee/Amazon) postados nele, re-afiliando com a sua TAG.

- [ ] **Criar**: "+ Nova campanha" → escolher "🔁 Repasse" → dar nome à campanha → escolher se quer "Aprovação automática" ligada (links capturados vão direto pra fila) ou desligada (ficam pendentes de revisão) → "Criar campanha".
- [ ] **Esperado**: entra no painel da campanha; a aba que seria "Busca de Produtos" agora se chama **"Repasse"** e mostra: banner explicando o funcionamento, seletor de **grupo líder** (escolher número → escolher um dos grupos reais dele → "Selecionar"), e o card de "Aprovação automática" com toggle.
- [ ] **Trocar grupo líder**: depois de selecionado, botão "Trocar" deve permitir escolher outro grupo líder.
- [ ] **Vincular grupos que recebem as ofertas**: aba Grupos → vincular 1+ grupos (iguais ao fluxo do passo 9) que vão replicar o que o líder posta — pode ser um grupo diferente do líder.
- [ ] **Testar captura de verdade** (precisa de ação sua): poste um link real de produto (Mercado Livre, Shopee ou Amazon) no grupo líder configurado, usando o WhatsApp real. Aguarde alguns segundos.
- **Precisa de você**: confirmar — o link postado no grupo líder apareceu na aba "Fila" (se aprovação automática) ou na lista de pendentes pra aprovar (se aprovação manual) da campanha de Repasse? O produto capturado veio com nome/preço/imagem preenchidos e o link já re-afiliado com sua TAG?
- Nota: só funciona pra links das 3 lojas com afiliado configurado (passo 8) — links de outras lojas ou sem afiliado configurado são ignorados silenciosamente.

## 11. Buscar produtos e fila de envio (campanha Original)

- [ ] **Passos**: aba "Busca de Produtos" → (opcional) mostrar filtros avançados → "Buscar produtos".
- [ ] **Esperado**: produtos do catálogo central que batem com os filtros da campanha entram na fila (aba "Fila").
- Nota: como o catálogo é populado pelo scraping automático (roda em intervalo configurado), pode não ter produtos ainda num ambiente 100% do zero — tudo bem, o esperado aqui é só que a busca não quebre.

## 12. Janelas de envio e modelo de mensagem

- [ ] **Janelas de envio**: "+ Adicionar janela" → definir início/fim/intervalo → "Salvar configurações".
- [ ] **Modelos de Mensagens**: editar o modelo padrão (ou criar um novo com "+ Novo modelo") → conferir que a prévia (lado direito) atualiza ao digitar.
- [ ] **Guard de alterações não salvas**: editar o modelo de mensagem (ou uma janela de envio) SEM clicar em salvar → tentar trocar de aba (ex: ir pra "Fila") ou sair da campanha → deve aparecer um modal perguntando se quer salvar/descartar as alterações antes de sair. Testar as 3 saídas do modal (salvar e continuar, descartar, cancelar) e confirmar que cada uma se comporta como esperado.

## 13. Envio real de uma oferta (opcional, mais sensível)

- [ ] Com WhatsApp conectado + grupo vinculado + produto na fila + dentro da janela de envio ativa: aguardar o envio automático (ou usar alguma ação manual de "enviar agora" se existir).
- **Precisa de você**: confirmar no grupo do WhatsApp que a mensagem chegou formatada corretamente.
- ⚠️ Isso manda uma mensagem de verdade pro grupo — só rodar se você topar receber uma mensagem de teste lá.

## 14. Tutoriais

- [ ] **Passos**: sidebar → "Tutoriais".
- [ ] **Esperado**: página renderiza sem erro, com o conteúdo de tutorial/onboarding disponível pra usuário comum.

## 15. Configurações

- [ ] **Conta**: editar nome completo → "Salvar alterações" → recarregar página (F5) → confirmar que o nome persistiu.
- [ ] **Aparência**: alternar entre Claro/Escuro/Automático → conferir visualmente se a interface muda de cor (no teste anterior tive um resultado inconclusivo aqui — vale reconferir com atenção).
- [ ] **Segurança**: conferir que a opção de troca de senha aparece.
- [ ] **Notificações no WhatsApp (WhatsNimbus)**: seção "Notificações" → ligar o toggle "Notificações no WhatsApp" → selecionar um número conectado como destino → conferir que a lista de avisos aparece, cada um com toggle próprio: Whats desconectado, Campanha desativada, Campanha reativada, Campanha parada (com motivo), Busca de produtos (X a aprovar / X já aprovados), Fila vazia. Desligar 1-2 avisos específicos e recarregar (F5) pra confirmar que a escolha persistiu (mensagem da tela diz "salva automaticamente", vale conferir se é verdade).
  - **Testar de verdade** (precisa de você): com o toggle ligado e destino escolhido, force um dos eventos (ex: derrubar o WhatsApp desconectando o número no celular, ou deixar a fila esvaziar) e confirmar que a mensagem de aviso chegou no WhatsApp real do número escolhido.
- [ ] **Preferências de notificação** (email / push / produtos aguardando revisão / relatório semanal): conferir que os toggles existem e não quebram a tela — vale anotar se parecem só de fachada (sem efeito real observável) ou se de fato disparam algo, já que isso não ficou claro na rodada anterior.

## 16. Assinatura / Billing (usuário comum, sem trial ainda usado)

- [ ] **Passos**: sidebar → Assinatura.
- [ ] **Esperado**: os 3 planos (Básico R$69,90, Pro R$99,90, Business R$149,90) aparecem, com preços e benefícios corretos.
- [ ] **Testar assinar um plano** (opcional, mexe com pagamento real): clicar "Assinar" no Pro → deve abrir o checkout do Stripe.
- **Precisa de você**: se for testar até o fim, usar um **cartão de teste do Stripe** (ex: `4242 4242 4242 4242`, qualquer data futura, qualquer CVC) — nunca um cartão real, a menos que você realmente queira assinar.

## 17. Excluir a campanha de teste

- [ ] **Passos**: dentro da campanha → aba "Gerenciar" → "Excluir campanha" → confirmar no modal.
- [ ] **Esperado**: volta pra lista de campanhas, e ao recarregar (F5) ela não aparece mais.
- ⚠️ Nota de bug já visto: o modal de confirmação mostra o título "Excluir grupo?" em vez de "Excluir campanha?" — texto errado, vale conferir se ainda está assim.

## 18. Logout

- [ ] **Passos**: Configurações → Conta → "Sair da conta" → confirmar.
- [ ] **Esperado**: volta pra tela de login.

## 19. (Só com conta admin) Área administrativa

Repetir os passos 1-5 logado como o admin (`allangroisman@gmail.com`) pra testar o que só admin vê:

- [ ] **Gating**: sidebar mostra a seção ADMIN (Produtos, Scraping, Mercado Livre/Amazon/Shopee admin, Usuários, Backups, Notificações, WhatsNimbus) — usuário comum não deve ver nada disso.
- [ ] **Usuários**: lista deve mostrar o admin + os usuários criados nos testes anteriores.
- [ ] **Produtos**: catálogo (visão de vitrine) lista/filtra por categoria/loja/busca por nome/desconto mínimo, com ordenação e paginação — conferir que os filtros combinados não quebram a lista.
- [ ] **Scraping**: aba de configuração do scraper — "Rodar agora" dispara scraping e (se demorar) mostra botão "Cancelar scraping"; ao terminar volta pro estado "Rodar agora". Tem sua própria visão de catálogo com filtro por categoria/loja/nome, e botão "Limpar catálogo" (⚠️ apaga o catálogo central de verdade — cuidado antes de clicar, só testar se aceitar reconstruir via novo scraping depois).
- [ ] **Filtros por loja (admin Mercado Livre/Amazon/Shopee)**: mudar valores de filtro de qualidade → "Salvar filtros" → recarregar → confirmar que persistiu. Testar também "Aplicar recomendados".
- [ ] **Backups**: conferir lista local + Backblaze (se configurado); **não clicar em "Restaurar"** num teste — isso sobrescreve o banco de dados de verdade.
- [ ] **Notificações (admin)**: configurar grupo de destino pra alertas do sistema.
- [ ] **WhatsNimbus (admin)**: aba "WhatsNimbus" → "Conectar" → aguardar QR Code → escanear com um WhatsApp real **dedicado ao sistema** (não o mesmo número usado nas campanhas, pra não misturar sessões) → confirmar que o status vira "Conectado" com nome/telefone exibidos. Este é o número que envia os avisos configurados no passo 15 pra todos os usuários. Testar "Desconectar" depois e confirmar que volta ao estado "Não configurado".
- **Precisa de você**: um número de WhatsApp real e dedicado só pra isso, pra escanear o QR do WhatsNimbus.

## 20. Zona de perigo (cuidado extra)

- [ ] Conferir que a seção "Zona de perigo" existe em Configurações, mas **não executar** a exclusão de conta a menos que seja proposital — ação irreversível.

---

## Observações gerais pra próxima rodada

- O projeto já tem uma bateria grande de testes automatizados (`tests/` — unit, integration, journey, Playwright e2e) que cobrem boa parte disso de forma isolada (banco de teste, WhatsApp e Stripe mockados). Rodar `windows\test.bat` ou `cd tests && npm test` é mais rápido pra regressão geral; este roteiro aqui é pro que só dá pra validar com gente de verdade (WhatsApp real, e-mail real, pagamento real).
- Bugs encontrados na rodada anterior (17/07/2026), que vale reconferir: toggle de tema "Claro" sem efeito visual aparente (possível artefato do navegador de teste, não confirmado como bug real) e texto "Excluir grupo?" no modal de exclusão de campanha (deveria dizer "Excluir campanha?").
- Passos 9, 10, 12 e 15 foram adicionados/expandidos numa revisão posterior (criar grupo de WhatsApp direto pelo Nimbus + opção WhatsNimbus como participante, campanha de Repasse completa, guard de alterações não salvas, persistência de aba, notificações do WhatsNimbus por evento) — ainda não rodados nenhuma vez, então tratar como prioridade na próxima passada.
