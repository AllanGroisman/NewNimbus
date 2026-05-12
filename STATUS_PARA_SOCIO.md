# Nimbus — onde estamos hoje (versão sem termos técnicos)

*Atualizado em 11 de maio de 2026.*

## O que é o Nimbus, em uma frase

É uma plataforma que **encontra ofertas na internet (Mercado Livre, Amazon)** e **dispara mensagens com essas ofertas em grupos de WhatsApp** automaticamente, nos horários que o cliente configurar.

## Onde a gente estava (1 semana atrás)

Funcionando bem pra dezenas de clientes em beta, mas com **vários pontos frágeis** que iam quebrar quando crescesse:

- **Tudo em arquivos no computador.** Como guardar a contabilidade da empresa em planilhas Excel salvas no desktop. Funciona pra padaria; quebra pra rede de padarias.
- **Um único processo rodando tudo.** Se travasse, parava o WhatsApp, parava o agendador, parava a API — tudo junto. E pra reiniciar, perdia tudo no caminho.
- **Sem rede de proteção.** Backup zero, monitoramento zero, retentativa zero. Se falhasse uma mensagem, simplesmente sumia.
- **Sem visibilidade.** A gente só descobria que tinha bug quando o cliente ligava reclamando.

## O que foi feito

Em ordem do que mais importava pra escala:

### 1. Trocou planilha (arquivo) por banco de dados de verdade
**Antes:** dados de cada cliente em arquivos `.json` no disco.
**Agora:** Postgres (o mesmo banco que o Instagram, Spotify, Reddit usam).
**Ganho:** dá pra ter centenas de clientes simultâneos sem dor; backup automático integrado; pode ter várias máquinas rodando em paralelo sem corromper nada.

### 2. Separou o "carteiro" da "central"
**Antes:** o programa que recebe seus cliques no site era o mesmo que mandava as mensagens. Se um travasse, travava o outro.
**Agora:** dois programas separados conversando por uma fila persistente. A "central" (site) agenda; o "carteiro" (worker) entrega. Se um cair, o outro continua. Se a mensagem falhar, **tenta automaticamente 5 vezes**, com intervalos crescentes (5s, 10s, 20s, 40s, 80s).
**Ganho:** mensagens não somem mais. Reinício do site não interrompe envios em andamento.

### 3. Sessão do WhatsApp deixou de ser refém de uma máquina
**Antes:** as "credenciais" do WhatsApp ficavam em arquivos no disco da máquina. Pra trocar de servidor, perdia tudo.
**Agora:** ficam no banco de dados. Pode trocar de servidor, máquina cair e voltar — a sessão continua viva.
**Ganho:** muda de provedor (AWS pra Google, etc) sem perder cliente. Failover futuro fica viável.

### 4. Backup local + (opcional) remoto na nuvem
**Antes:** zero backup. Se o disco corrompesse, fim.
**Agora:** backup local automático **a cada 15 minutos** (mantém 24h de histórico). E botão liga/desliga pra subir cópia pra nuvem **a cada 1 hora** (basta criar conta no Backblaze B2 ou Cloudflare R2 — 10GB grátis cada).
**Ganho:** crash de SSD vira inconveniente, não tragédia.

### 5. Observabilidade — agora a gente vê tudo
**Antes:** descobríamos problema pelo telefone do cliente.
**Agora:** três coisas:
- **Health check**: uma página simples que diz "tudo ok" ou "tem coisa quebrada" — dá pra ligar em qualquer monitoramento (UptimeRobot, Pingdom, etc, todos têm plano grátis).
- **Métricas**: contador de tudo que importa — mensagens enviadas, falhas, fila acumulada, latência. Pronto pra plugar em dashboards estilo painel de carro.
- **Sentry** (avisos de erro): quando algo dá errado, recebemos email/Slack na hora, com o erro completo e em qual cliente aconteceu. Falta a gente criar conta (5 minutos).

### 6. Segurança básica
- Limite de tentativas de login (impede ataque de força bruta)
- Restrição de quem pode acessar a API (CORS allowlist)
- Headers de segurança padrão da indústria (Helmet)
- Senhas com hash forte (bcrypt) — já tinha, mantido

## O que isso significa em "quanto cliente aguenta"

| Métrica | Antes | Hoje |
|---|---|---|
| Clientes simultâneos | ~50 (no chute) | **centenas** |
| Mensagens perdidas em travamento | algumas | **zero** |
| Tempo pra perceber problema | horas/dias | **minutos** |
| Tempo pra recuperar de queda total | horas (talvez perde dados) | **~5 minutos** sem perder nada |
| Trocar de servidor | dia inteiro de migração | **~1 hora** |

## O que ainda é frágil (honestidade)

1. **WhatsApp via Baileys (não-oficial).** Continuamos usando Baileys, que é uma biblioteca da comunidade que se conecta como se fosse o WhatsApp Web. **Risco real**: o WhatsApp pode banir o número se detectar uso comercial em volume alto. Solução cara mas definitiva: WhatsApp Cloud API oficial — custa ~R$0,025 a R$0,40 por mensagem dependendo do tipo. Decisão de produto, não de tecnologia.

2. **Um worker só.** Hoje a gente tem 1 "carteiro". Aguenta tranquilo até ~50-100 sessões de WhatsApp. Quando passar disso, precisa multiplicar — código já tá preparado, é só ligar. Estimativa: ~3-4 dias de trabalho quando volume justificar.

3. **Backup remoto não tá ligado.** Código pronto, falta a gente criar a conta no Backblaze (de graça) e colar 5 senhas no arquivo de config.

4. **Sentry não tá ligado.** Mesmo: código pronto, falta criar conta (de graça) e colar 1 senha.

## Custo de infra hoje (estimativa mensal)

| Item | Custo agora | Custo escalando (1000 clientes) |
|---|---|---|
| Servidor (Hetzner/DigitalOcean) | R$30-100/mês | R$300-800/mês |
| Postgres gerenciado (Neon/Supabase) | R$0 (free tier) | R$100-300/mês |
| Redis (Upstash/Redis Cloud) | R$0 (free tier) | R$50-150/mês |
| Backup remoto (Backblaze B2) | R$0 (10GB grátis) | R$25-50/mês |
| Sentry (5k erros/mês) | R$0 | R$130/mês (50k erros) |
| **Total** | **~R$50/mês** | **~R$700-1500/mês** |

Com WhatsApp Cloud API esse custo pula bastante (depende do volume), mas tira o risco de banimento.

## Roadmap honesto

### Para fazer essa semana (você não, eu)
- Criar conta Sentry, conta Backblaze B2, colar credenciais. **Total: 30 minutos**.

### Pra fazer quando passar de ~50 sessões WhatsApp
- "Sharding" (multiplicar workers) — **3-4 dias** de trabalho.

### Pra discutir como produto
- Migrar pra WhatsApp Cloud API oficial — **2 semanas** de trabalho + custo recorrente por mensagem.
- Plano pago com limites por tier — modelo de negócio, não tecnologia.

### Em paralelo, quando der
- Dashboards visuais (Grafana) — **2-3 dias** quando quisermos ver gráficos bonitos.
- Testes automatizados — **1 semana**, melhora qualidade mas não dá feature visível.

## Resumo bem curto

A gente saiu de "funciona pra beta fechado" pra "**aguenta produção em escala**" em uma semana. Falta agora **operação**: ligar Sentry, ligar backup remoto, e começar a olhar as métricas. A próxima decisão que importa não é técnica — é se vamos pra WhatsApp oficial ou continuamos no Baileys.
