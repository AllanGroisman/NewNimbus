# docs/

Documentos do projeto. Nada aqui é executado — é só texto pra você consultar.

## Arquivos

- **`ARQUITETURA_COMPLETA.md`** — visão técnica detalhada de como o sistema funciona por dentro. Bom pra consultar quando você quer entender um fluxo (ex.: como o envio acontece de ponta a ponta).
- **`PLANO_ESCALA.md`** — plano em fases pra escalar o sistema (Fase 0 hardening, Fase 1 Postgres, Fase 2 fila Redis, Fase 2.1 worker dedicado, Fase 3 sessões no PG, etc). Mostra o que já foi feito e o que vem depois.
- **`STATUS_PARA_SOCIO.md`** — resumo do estado do projeto, em linguagem de negócio. Pra mostrar pro sócio sem entrar em detalhe técnico.

## Onde está o "mapa técnico" rápido?

Na raiz do projeto, em `CLAUDE.md`. É o doc que o Claude Code (IA) lê automaticamente quando você abre o projeto, mas também serve pra humano. É mais curto que `ARQUITETURA_COMPLETA.md` e tem comandos prontos.
