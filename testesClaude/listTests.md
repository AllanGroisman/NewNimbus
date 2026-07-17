# Visão geral dos testes — Nimbus

Tabela resumo do `roteiro-testes-nimbus-do-zero.md`. Detalhes completos (passos, resultado esperado) estão lá — aqui é só pra visualizar rápido o que está coberto.

| # | Seção | O que testa | Precisa de ação externa sua? | Sensível |
|---|---|---|---|---|
| 1 | Cadastro | Criar conta nova, não loga direto, cai em "confirme seu email" | E-mail real | |
| 2 | Confirmação de e-mail | Link de confirmação verifica a conta | E-mail real | |
| 3 | Login inválido | Erro de credenciais com email inexistente | | |
| 4 | Recuperar senha | Fluxo "esqueci minha senha" | E-mail real (opcional) | |
| 5 | Primeiro login | Login funciona, gating de admin (sidebar sem seção ADMIN) | | |
| 6 | Dashboard vazio | CTA de criar primeira campanha, sem campanhas listadas | | |
| 7 | Conectar WhatsApp | Adicionar número, QR Code, status "Conectado" | WhatsApp real (escanear QR) | |
| 8 | Afiliados (ML/Amazon/Shopee) | Salvar/apagar credenciais das 3 lojas | Credenciais reais (opcional) | |
| 9 | Criar campanha Original | Criação, abas, persistência de aba no F5, vincular grupo existente, criar grupo novo, opção WhatsNimbus como participante | Grupo de WhatsApp real | |
| 10 | Criar campanha Repasse | Grupo líder, aprovação automática, vincular grupos que recebem, captura real de link postado no líder | Postar link real no grupo líder | |
| 11 | Buscar produtos e fila | Busca no catálogo preenche a fila da campanha Original | | |
| 12 | Janelas de envio e modelo de mensagem | Criar janela, editar modelo com prévia, guard de alterações não salvas ao trocar de aba | | |
| 13 | Envio real de oferta | Confirma envio automático formatado no grupo real | Confirmar recebimento no WhatsApp | ⚠️ manda mensagem de verdade |
| 14 | Tutoriais | Página renderiza | | |
| 15 | Configurações | Conta (nome persiste), Aparência (tema), Segurança, Notificações WhatsNimbus por evento, Preferências de notificação | Confirmar aviso real no WhatsApp (opcional) | |
| 16 | Assinatura / Billing | Planos exibidos corretamente, checkout Stripe | Cartão de teste Stripe (opcional) | mexe com pagamento |
| 17 | Excluir campanha | Campanha some da lista após excluir | | |
| 18 | Logout | Volta pra tela de login | | |
| 19 | Área administrativa | Gating, Usuários, Produtos, Scraping (+ limpar catálogo), filtros por loja, Backups, Notificações admin, conexão WhatsNimbus | WhatsApp real dedicado (QR do WhatsNimbus) | ⚠️ não clicar "Restaurar" backup |
| 20 | Zona de perigo | Seção existe em Configurações (disponível pra qualquer conta, não só admin) | | ⚠️ não executar exclusão de conta |

## Legenda rápida
- **Precisa de ação externa sua**: passo não dá pra validar 100% só clicando na tela — precisa de celular, e-mail ou cartão reais.
- **Sensível**: ação que manda mensagem de verdade, mexe com pagamento real, ou é destrutiva/irreversível — rodar com cuidado e de propósito.

## Cobertura por área
- **Onboarding/conta**: 1–6, 18, 20
- **WhatsApp**: 7, 9 (criar grupo), 19 (WhatsNimbus)
- **Afiliados**: 8
- **Campanhas — Original**: 9, 11, 12, 13
- **Campanhas — Repasse**: 10
- **Configurações/Notificações**: 15
- **Billing**: 16
- **Admin-only**: 19

## Ainda não rodado (prioridade pra próxima passada)
Passos 9, 10, 12 e 15 foram expandidos numa revisão recente (criar grupo direto pelo Nimbus + WhatsNimbus como participante, campanha de Repasse completa, guard de alterações não salvas, notificações do WhatsNimbus por evento) e ainda não foram executados nenhuma vez.
