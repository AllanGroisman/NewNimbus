// Setup dos testes UNITÁRIOS (setupFiles da vitest.config.mjs).
//
// Diferença pro setup-each.js (usado por integration/journey): aqui NÃO tocamos
// no Postgres. Nenhum arquivo de unit/ importa helpers/app.js ou pg-helpers.js,
// então pagar `truncateAll()` (TRUNCATE de ~25 tabelas) num beforeEach de cada
// teste unitário era custo puro — além de carregar o Prisma Client em cada
// worker. Sem PG, os unitários também podem rodar em paralelo.
//
// Se algum teste de unit/ passar a precisar de banco, ele pertence a
// integration/ — mova o arquivo em vez de reimportar pg-helpers aqui.

import { beforeEach } from "vitest";
import "./env.js";
import { reset as resetWa } from "./wa-mock.js";
import { reset as resetStripe } from "./stripe-mock.js";
import { reset as resetEmail } from "./email-mock.js";

beforeEach(() => {
  resetWa();
  resetStripe();
  resetEmail();
});
