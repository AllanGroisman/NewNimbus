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
    // Os arquivos rodam em PARALELO: cada worker tem o seu próprio database
    // (nimbus_test_<VITEST_POOL_ID>), criado pelo globalSetup a partir do molde
    // nimbus_test. Sem isso o truncateAll() de um worker apagaria as linhas
    // semeadas por outro. Ver helpers/env.js e tests/TIMING.md.
    //
    // isolate: false — os arquivos de um worker dividem o processo, então o
    // server.js + Prisma carregam uma vez por worker, não uma por arquivo (era
    // ~2 s por arquivo; a suíte caiu de ~120 s pra ~65 s). O preço: estado em
    // memória vaza de um arquivo pro seguinte. O helpers/setup-each.js zera o
    // que é conhecido no começo de cada arquivo; cache novo em módulo do
    // backend precisa entrar lá.
    pool: "forks",
    poolOptions: { forks: { isolate: false } },
    fileParallelism: true,
    maxWorkers: Number(process.env.NIMBUS_TEST_SHARDS || 4),
    // Sem isto, NIMBUS_TEST_SHARDS abaixo do nº de CPUs quebrava: o minWorkers
    // padrão do vitest sai das CPUs e ficava maior que o maxWorkers.
    minWorkers: 1,
    // Dentro de um arquivo os testes continuam sequenciais.
    sequence: { concurrent: false },
    globalSetup: ["./helpers/global-setup.js"],
    setupFiles: ["./helpers/setup-each.js"],
    reporters: ["default"],
  },
});
