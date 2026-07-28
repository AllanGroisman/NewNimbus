# Capacidade da infraestrutura — a VPS atual aguenta a demanda?

*Levantamento feito em 28/07/2026, direto na VPS de produção (task 33).*

**Resposta curta: para a demanda de hoje (8 usuários), sim, com folga — depois da limpeza feita nesta data. Para a meta de ~100 usuários, não: será preciso fazer upgrade da VPS e, mais adiante, dividir o worker do WhatsApp.**

---

## 1. Foto da infraestrutura hoje

| Recurso | Valor |
|---|---|
| CPU | 1 núcleo (vCPU) |
| Memória RAM | 2 GB (≈ 1 GB já em uso no dia a dia, e o sistema já recorre a 1 GB de swap*) |
| Disco | 19 GB — estava **92% cheio**; após limpeza de 28/07/2026 ficou em **66%** (6 GB livres) |
| Processos | `nimbus-backend` (~70 MB), `nimbus-worker` (~145 MB com 3 sessões de WhatsApp), `nimbus-backup-remote` (~26 MB), Postgres (~50 MB), Redis (~5 MB) |

*Swap = "memória de emergência" no disco, muito mais lenta. Uso constante de swap é sinal de que a RAM está no limite.*

## 2. Demanda hoje

- 8 usuários cadastrados, 2–3 números de WhatsApp conectados
- Banco de dados com apenas 35 MB
- Filas de envio vazias na maior parte do tempo (envios dão conta do recado)

Ou seja: a carga atual é pequena. O risco real encontrado **não era carga, era o disco encher** — o log do worker tinha 1,3 GB e crescia sem limite. Isso foi corrigido (ver seção 5).

## 3. Até onde a VPS atual vai?

Os dois consumidores que crescem com o número de usuários:

1. **Sessões de WhatsApp (Baileys)** — cada número conectado vive dentro do processo `nimbus-worker` e gasta memória (estimativa: 20–30 MB por número, além dos ~100 MB de base do worker). O worker reinicia sozinho se passar de 1 GB (`max_memory_restart`), o que derrubaria *todas* as sessões de uma vez.
2. **Scraping com Chrome invisível (Puppeteer)** — cada varredura de loja abre um navegador Chrome, que consome 300–500 MB de RAM e monopoliza a única CPU enquanto roda.

Fazendo a conta com a RAM disponível (~800 MB de folga real):

- **Limite estimado da VPS atual: ~20 a 30 usuários** com 1–2 números cada (≈ 30–40 sessões de WhatsApp), desde que o scraping não rode junto com picos de envio.
- **100 usuários não cabem**: com média de 2 números por usuário seriam ~200 sessões → só de WhatsApp, mais de 5 GB de RAM, fora Chrome, banco e sistema.

## 4. O que é preciso para ~100 usuários

Em ordem — o item 1 é obrigatório, os outros entram conforme o crescimento:

1. **Upgrade da VPS** (obrigatório): referência mínima **4 vCPU, 8 GB de RAM, 40+ GB de disco**. Na maioria dos provedores é só redimensionar o plano, sem reinstalar nada.
2. **Dividir o worker do WhatsApp** quando passar de ~50 sessões: hoje um único processo cuida de todos os números; a "Fase 2.2" (já prevista nos comentários do `backend/ecosystem.config.js`) divide os números entre vários workers. Além de repartir a memória, evita que um problema derrube todas as sessões juntas.
3. **Scraping** já roda um Chrome por vez (bom). Ao crescer, considerar mover o scraping para horários de menor uso ou para uma máquina separada.
4. **Postgres e Redis** aguentam 100 usuários tranquilamente nesse porte de banco (35 MB hoje); só ganharão mais RAM automaticamente com o upgrade.

## 5. O que já foi corrigido em 28/07/2026

- **Rotação de logs instalada** (`pm2-logrotate`: arquivos até 50 MB, guarda 14, comprimidos). O log de 1,3 GB do worker não volta a acontecer.
- **Disco liberado de 92% → 66%**: logs zerados (1,4 GB), cache do npm (1,7 GB), cópia antiga órfã `/NewNimbus` (623 MB), caches diversos e perfis temporários do Chrome.

## 6. Roteiro para dividir o sistema e escalar

O sistema já foi desenhado com a divisão certa nas costuras: o backend não fala direto com o WhatsApp — ele coloca pedidos numa fila no Redis, e o worker (dono das sessões) consome essa fila. Por isso, escalar aqui é **replicar peças, não reescrever o sistema**. As etapas, na ordem em que a dor aparece:

### Etapa 1 — Crescer a máquina (até ~30 usuários)
Só o upgrade da VPS (4 vCPU / 8 GB). Nada de dividir ainda: dividir cedo demais adiciona complexidade sem ganho. Tudo continua como está.

### Etapa 2 — Dividir o worker do WhatsApp (a partir de ~50 números conectados)
Hoje um único processo `nimbus-worker` carrega *todas* as sessões — é o ponto mais frágil: se ele cair ou estourar memória, todos os clientes desconectam juntos. O ideal é rodar vários workers, cada um dono de uma fatia dos números (ex.: 4 workers com ~25 números cada, decidido por uma conta simples em cima do número de telefone), cada um escutando só a fila da sua fatia. É a "Fase 2.2" já prevista nos comentários do `backend/ecosystem.config.js`. Bônus: um worker cair derruba só 1/4 dos clientes, não todos.

### Etapa 3 — Tirar o scraping do caminho
O Chrome do Puppeteer é o maior consumidor de CPU/RAM e hoje roda dentro do mesmo backend que atende os usuários. O ideal é ele virar um processo separado (um "worker de scraping" consumindo uma fila própria), que pode até morar em outra máquina barata. Assim uma varredura de loja nunca compete com o envio de mensagens — que é o que o cliente sente.

### Etapa 4 — Dividir em máquinas (rumo aos 100+)

| Máquina | O que roda | Por quê |
|---|---|---|
| VPS "web" | nginx + `nimbus-backend` | O backend não guarda estado (pode ter várias cópias em modo redis, como os comentários do código já indicam) — é a parte fácil de replicar |
| VPS "workers" (1 ou mais) | workers de WhatsApp + scraping | São os que gastam RAM/CPU; adicionar máquina = adicionar capacidade |
| Banco gerenciado | Postgres + Redis | Contratar como serviço do provedor tira das suas costas backup, disco e atualização |

O que **não** precisa dividir tão cedo: Postgres e Redis aguentam centenas de usuários nesse porte de dados (35 MB hoje), e o frontend já é só arquivo estático no nginx.

**Resumo da ordem:** upgrade da VPS agora → shard do worker quando passar de ~50 sessões → scraping separado quando o envio começar a "engasgar" durante varreduras → máquinas separadas quando uma só não der mais. Cada etapa só se paga quando o gatilho dela chega — e a arquitetura atual permite todas sem reescrever nada grande.

## 7. Sinais de alerta para acompanhar

Checar de vez em quando (ou quando algo parecer lento):

| Comando | O que olhar | Alerta se... |
|---|---|---|
| `df -h /` | uso do disco | acima de **80%** |
| `free -h` | linha "Swap" | uso de swap crescendo semana a semana |
| `pm2 list` | coluna `↺` (restarts) | worker reiniciando sozinho (falta de memória) |
| `curl -s localhost:3001/healthz` | `connectedSessions` e filas | sessões conectadas < números cadastrados; filas `waiting` acumulando |

Quando qualquer alerta desses aparecer com frequência, é hora de executar o upgrade da seção 4.
