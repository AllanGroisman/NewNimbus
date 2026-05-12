# Nimbus

Plataforma de automação de ofertas no WhatsApp. Faz scraping de produtos (Mercado Livre, Amazon), organiza campanhas por categoria e dispara mensagens em grupos no horário que você quiser.

## Pastas principais

- **`backend/`** — servidor Node.js (Express). Onde fica toda a lógica: login, scraping, scheduler, envio pelo WhatsApp.
- **`frontend/`** — site React que o usuário usa. Conecta no backend pela rota `/api`.
- **`tests/`** — bateria automatizada de testes (Vitest). Roda com `test.bat`.
- **`docs/`** — documentos do projeto (arquitetura, plano, status). Não tem código aqui.
- **`start.bat` / `stop.bat`** — sobem e param tudo (backend, frontend, ngrok) em janelas separadas no Windows.
- **`test.bat`** — atalho pra rodar a bateria de testes.
- **`docker-compose.yml`** — sobe Postgres + Redis em containers locais (só precisa se for usar o modo PG).

## Por onde começar

1. Leia `CLAUDE.md` na raiz — é o "mapa" técnico do projeto.
2. Pra entender a estrutura interna do backend, leia `backend/README.md`.
3. Pra rodar tudo localmente, dê `start.bat`.

## Documentação extra

Veja `docs/` pra documentos de arquitetura, plano de escala e status do projeto.
