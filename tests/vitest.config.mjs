import { defineConfig } from "vitest/config";

// Config dos testes UNITÁRIOS. As camadas que precisam de Postgres
// (integration/ e journey/) rodam pela vitest.integration.config.mjs.
//
// Nenhum arquivo de unit/ importa helpers/app.js ou pg-helpers.js — são funções
// puras com IO mockado. Antes eles herdavam o setup global do banco e pagavam
// uma limpeza de tabelas antes de cada teste, sem usar o banco pra nada. Sem PG,
// também não há estado compartilhado, então os arquivos rodam em paralelo.
//
// Tempos por arquivo e o mapa "mudei X -> rode Y": tests/TIMING.md

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["unit/**/*.test.js"],
    testTimeout: 20000,
    hookTimeout: 60000,
    pool: "forks",
    setupFiles: ["./helpers/setup-unit.js"],
    reporters: ["default"],
  },
});
