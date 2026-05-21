# docs/

Pasta reservada pra documentos do projeto. Hoje só contém este README — todo o material técnico vivo está em outros lugares.

## Onde está cada coisa

- **`CLAUDE.md`** (raiz) — *mapa técnico*: arquitetura, comandos, env vars, fluxos críticos (auth, scheduler, catálogo, afiliado, WhatsApp, billing, fila). Atualizado junto com o código.
- **`README.md`** (raiz) — visão geral do projeto pra quem chega agora.
- **`PLANO.md`** (raiz) — backlog/TODO informal de coisas a fazer (não é roadmap formal).
- **`backend/README.md`** — overview de cada pasta do backend.
- Cada subpasta com lógica relevante tem o próprio `README.md` (ex.: `backend/scraping/`, `backend/billing/`, `frontend/src/pages/`).
- **`deploy/README.md`** — instalação na VPS Ubuntu.
- **`tests/README.md`** — cobertura de testes (~287 testes em 3 camadas).

## Quando faz sentido adicionar um doc aqui

Doc longo, de leitura única (post-mortem, RFC, estudo de capacidade). Pra material que descreve o estado atual do sistema, prefira mexer no README da pasta certa — fica mais perto do código e envelhece junto com ele.
