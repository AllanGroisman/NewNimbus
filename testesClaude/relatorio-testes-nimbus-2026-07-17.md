# Relatório de testes — Nimbus (17/07/2026)

Rodada "do zero" executada com usuário novo (`allangroisman+teste1@gmail.com`), sem WhatsApp conectado, sem afiliados. Base: `roteiro-testes-nimbus-do-zero.md`.

## Resumo

| # | Teste | Resultado |
|---|-------|-----------|
| 1 | Cadastro | ✅ Passou |
| 2 | Confirmação de e-mail | ✅ Passou (gating de login sem verificação também funciona) |
| 3 | Login inválido | ✅ Passou ("Email ou senha incorretos") |
| 4 | Recuperar senha | ✅ Passou (tela "Recuperar acesso" + "Enviar link de reset") |
| 5 | Primeiro login | ✅ Passou (sidebar sem seção ADMIN) |
| 6 | Dashboard vazio | ✅ Passou (CTA "Crie sua primeira campanha") |
| 7 | Conectar WhatsApp | ✅ Passou (QR → "Conectado" +555596168060) — mas ver BUG-2 |
| 8 | Afiliados ML/Amazon/Shopee | ✅ Passou (salvar, badge, "Apagar" e reconfigurar OK nas 3) |
| 9 | Campanha Original completa | ✅ Passou (criação, 7 abas, persistência de aba, vincular grupo existente, criar grupo novo real "TesteClaude") |
| 9c | Checkbox WhatsNimbus como participante | ➖ N/A (WhatsNimbus não conectado — só admin; checkbox corretamente ausente) |
| 10 | Campanha Repasse | ⚠️ Parcial (criação, grupo líder, "Trocar", aprovação automática OK; **captura de link bloqueada pelo BUG-1**) — ver DIV-1 |
| 11 | Busca de produtos | ✅ Passou (não quebra com catálogo vazio) |
| 12 | Janelas + modelos + guard | ✅ Passou (janela 19:00–21:00/15min salva; prévia ao vivo; modal do guard com Cancelar/Descartar/Salvar corretos) — ver BUG-4 |
| 13 | Envio real | ⛔ Bloqueado (BUG-1 derruba número/grupos antes de haver fila) |
| 14 | Tutoriais | ✅ Passou (13 tutoriais, vídeos "Em breve") |
| 15 | Configurações | ✅ Passou (nome persiste; tema Claro/Escuro FUNCIONA — bug da rodada anterior não se reproduz; segurança OK; notificações WhatsNimbus com 6 avisos e persistência real do "salva automaticamente") |
| 16 | Assinatura | ✅ Passou (3 planos com preços corretos; trial Pro 7d explicando o "Plano Pro" de usuário novo; "Assinar" abre checkout Stripe em modo teste — não preenchi nada) |
| 17 | Excluir campanha | ✅ Passou — mas BUG-5 (título "Excluir grupo?") ainda presente |
| 18 | Logout | ✅ Passou (modal de confirmação → tela de login) |
| 19 | Área admin | ➖ Não rodado (fora do escopo desta rodada, por decisão sua) |
| 20 | Zona de perigo | ✅ Existe, não executada |

## Bugs encontrados (por prioridade)

### BUG-1 — CRÍTICO: perda de estado no servidor após reload (intermitente, reproduzido 2x)
Ao dar F5, o estado do servidor às vezes é sobrescrito por uma versão desatualizada. Evidências:
- 1ª ocorrência: campanha "Campanha Teste Original" + número de WhatsApp conectado sumiram após F5.
- 2ª ocorrência: campanha de Repasse inteira sumiu, "Campanha Teste 2" perdeu os 2 grupos vinculados e o número desconectou.
- `GET /api/state` já retornava o estado sem a campanha de Repasse **minutos após a criação**, com vários `PUT /api/state` 200 no meio — ou seja, os PUTs não persistiram essas mudanças (ou foram sobrescritos).
- O `updatedAt` do estado fica com o timestamp do reload → no load o cliente faz PUT do que tem em memória, "carimbando" o estado velho.
- Padrão observado: mudanças feitas **enquanto há sessão de WhatsApp ativa/conectando** são as que se perdem. Hipóteses: race entre GET/PUT no boot; ou múltiplos workers no backend com estado em memória divergente (PUT num worker, GET noutro).
- Consequência direta: teste de captura do Repasse nunca funcionou (config de líder não estava no servidor).

### BUG-2 — Apelido do número de WhatsApp não persiste
No modal "Adicionar novo número", o apelido digitado ("Numero Teste") reverteu pra "Novo número" quando o QR carregou, e ficou assim após conectar.

### BUG-3 — Contagem de membros inconsistente
Grupo "TesteClaude" aparece com 2 membros na aba Grupos e 1 membro no seletor de grupo líder.

### BUG-4 — Seletor de modelo dessincroniza após salvar via guard
Ao salvar edição do modelo pelo modal "Alterações não salvas", o conteúdo salva no servidor, mas o seletor muda de "Padrão — em uso" para "Padrão (modelo pronto)" com botão "Ativar este modelo", como se o modelo tivesse deixado de estar ativo. F5 normaliza.

### BUG-5 — Título errado no modal de exclusão de campanha (já conhecido, reconfirmado)
Modal diz "Excluir grupo?" — deveria ser "Excluir campanha?". Corpo do texto está correto.

### Observações menores / UX
- "Desvincular" grupo da campanha não pede confirmação (um clique e já era).
- Texto do empty-state da Fila em campanha Repasse menciona "aba Busca de Produtos", que não existe nesse tipo de campanha.
- Segurança → Dispositivos conectados mostra "Chrome • macOS" para uma sessão em Windows (user-agent mal detectado ou dado mock).
- Tema "Claro" da rodada anterior: **não é bug** — funcionou normalmente nesta rodada.

## Divergência do roteiro
- **DIV-1**: o roteiro esperava aba "Repasse" no lugar de "Busca de Produtos". Na UI atual não existe essa aba: a config de repasse (banner, fontes, grupo líder com "Trocar", aprovação automática) fica na aba **Gerenciar**. Funcionalmente equivalente — atualizar o roteiro.

## Pendências pra próxima rodada
- Reteste de Repasse (captura de link) e envio real (teste 13) **após corrigir o BUG-1**.
- Passo 19 (admin) e WhatsNimbus (inclui checkbox "usar como participante" do passo 9).
- Teste real dos avisos do WhatsNimbus (forçar evento com número conectado).
- Fluxos completos de e-mail de reset de senha e checkout Stripe com cartão de teste.

## Estado deixado no ambiente
- Conta `allangroisman+teste1@gmail.com` (senha de teste que combinamos) ativa, em trial Pro (7d), sem campanhas, sem número conectado (o vínculo pode ainda aparecer no celular — remover em Dispositivos vinculados).
- Afiliados com credenciais FICTÍCIAS salvas nas 3 lojas (limpar antes de usar de verdade).
- Grupo real "TesteClaude" criado no seu WhatsApp (pode apagar).
- Nome da conta ficou "Sim Testador Editado".
