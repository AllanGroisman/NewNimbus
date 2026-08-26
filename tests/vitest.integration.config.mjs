import { defineConfig } from "vitest/config";

// Config das camadas que precisam de Postgres: integration/ e journey/.
// Os unitários rodam pela vitest.config.mjs (sem banco, em paralelo).
// Tempos por arquivo e o mapa "mudei X -> rode Y": tests/TIMING.md

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["integration/**/*.test.js", "journey/**/*.test.js"],
    testTimeout: 20000,
    hookTimeout: 60000,
    // Pool=forks com isolate=true (default) = cada arquivo em worker próprio.
    // Os arquivos rodam em PARALELO: cada worker tem o seu próprio database
    // (nimbus_test_<VITEST_POOL_ID>), criado pelo globalSetup a partir do molde
    // nimbus_test. Sem isso o truncateAll() de um worker apagaria as linhas
    // semeadas por outro. Ver helpers/env.js e tests/TIMING.md.
    pool: "forks",
    fileParallelism: true,
    maxWorkers: Number(process.env.NIMBUS_TEST_SHARDS || 4),
    // Dentro de um arquivo os testes continuam sequenciais.
    sequence: { concurrent: false },
    globalSetup: ["./helpers/global-setup.js"],
    setupFiles: ["./helpers/setup-each.js"],
    reporters: ["default"],
  },
});
