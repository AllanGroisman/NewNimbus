# docs/

Pasta reservada pra documentos do projeto.

- **[`operacao.md`](operacao.md)** — instalação local (Windows), VPS de produção, scripts e backup em nuvem.
- **[`infra-capacidade.md`](infra-capacidade.md)** — levantamento de capacidade da VPS e roteiro de escala.

## Onde está cada coisa

- **`README.md`** (raiz) — visão geral do projeto: o que faz, stack, arquitetura e decisões técnicas.
- **`backend/README.md`** — overview de cada pasta do backend.
- Cada subpasta com lógica relevante tem o próprio `README.md` (ex.: `backend/scraping/`, `backend/billing/`, `frontend/src/pages/`).
- **`deploy/README.md`** — instalação na VPS Ubuntu.
- **`tests/README.md`** — cobertura de testes (~2.500 testes em 3 camadas).

## Quando faz sentido adicionar um doc aqui

Doc longo, de leitura única (post-mortem, RFC, estudo de capacidade). Pra material que descreve o estado atual do sistema, prefira mexer no README da pasta certa — fica mais perto do código e envelhece junto com ele.
