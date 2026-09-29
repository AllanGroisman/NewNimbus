# Nimbus

Sistema que automatiza a postagem de ofertas de afiliado em grupos de WhatsApp. Está em produção em [nimbuspromocoes.com](https://nimbuspromocoes.com).

[![Testes](https://github.com/AllanGroisman/NewNimbus/actions/workflows/tests.yml/badge.svg)](https://github.com/AllanGroisman/NewNimbus/actions/workflows/tests.yml)

## O que é

Quem trabalha como afiliado costuma passar o dia procurando promoção, gerando link e postando nos grupos à mão. O Nimbus faz isso no automático: pega as ofertas do Mercado Livre, da Amazon e da Shopee, troca o link pelo link de afiliado do usuário, monta a mensagem com a foto do produto e envia nos grupos nos horários que ele escolheu.

Desenvolvi o projeto sozinho, do código ao servidor. Ele tem cadastro, assinatura pelo Stripe (com 7 dias de teste), painel do cliente, painel de administração e backup automático.

## Funcionalidades

- Campanhas por categoria, cada uma com sua fila de produtos, aprovação manual ou automática e horário de envio.
- Conexão do WhatsApp por QR code ou por código de pareamento.
- Repasse: o sistema acompanha grupos de referência, pega os links de produto postados lá e reposta nos grupos do usuário com o link de afiliado dele.
- Cupons do Mercado Livre: lista os cupons disponíveis e os produtos de cada um, e testa códigos no checkout.
- Relatório de desempenho do afiliado (cliques, pedidos e comissão) pelas APIs do Mercado Livre e da Shopee, com as vendas separadas por grupo.
- Download de vídeos de produtos do YouTube, TikTok e Shopee, usando yt-dlp e ffmpeg.
- Painel de administração para usuários, lojas, cupons, notificações, tutoriais e backups.
- Planos com limite de números, campanhas e grupos.
- Funciona no celular e tem tema claro e escuro.

## Tecnologias

| Camada | Tecnologias |
|---|---|
| Backend | Node.js, Express, PostgreSQL (Prisma), Redis (BullMQ), Baileys, Puppeteer, Stripe |
| Frontend | React e Vite |
| Extensão | Chrome (Manifest V3) |
| Infra | VPS Ubuntu, nginx, PM2, Docker Compose, Backblaze B2 |
| Monitoramento | Sentry e Prometheus |
| Testes | Vitest, React Testing Library, Playwright e GitHub Actions |

## Alguns detalhes técnicos

- O site e o WhatsApp rodam em processos separados e se comunicam por uma fila no Redis. Se o processo do WhatsApp reiniciar, o site continua no ar.
- A conexão com o WhatsApp volta sozinha quando cai e não deixa abrir duas sessões no mesmo número, o que faria o WhatsApp desconectar o aparelho.
- Algumas páginas do Mercado Livre bloqueiam navegador automatizado, então essa parte roda por uma extensão do Chrome.
- O banco tem backup de hora em hora, criptografado e enviado para a nuvem. Se o backup atrasar, chega um aviso no WhatsApp.
- São cerca de 2.500 testes automatizados (backend, frontend e ponta a ponta), que rodam no GitHub Actions a cada push.

## Estrutura do repositório

| Pasta | Conteúdo |
|---|---|
| [`backend/`](backend/README.md) | API, worker do WhatsApp, agendador de envios, scraping e pagamentos |
| [`frontend/`](frontend/README.md) | Painel do cliente e do admin |
| [`extension/`](extension/README.md) | Extensão do Chrome para os cupons do Mercado Livre |
| [`tests/`](tests/README.md) | Testes automatizados |
| [`deploy/`](deploy/README.md) | Scripts de instalação e operação na VPS |
| [`docs/`](docs/README.md) | Guia de operação e estudo de capacidade |

## Como rodar

Instalação local, deploy na VPS e backup estão explicados em [`docs/operacao.md`](docs/operacao.md).
