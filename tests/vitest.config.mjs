import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["unit/**/*.test.js", "integration/**/*.test.js", "journey/**/*.test.js"],
    testTimeout: 20000,
    hookTimeout: 60000,
    // Pool=forks com isolate=true (default) = cada arquivo em worker próprio.
    // fileParallelism: false — a partir da migração pro PG, os testes compartilham
    // um único database (nimbus_test) e usam truncateAll() entre cada teste.
    // Rodar arquivos em paralelo causaria corridas; o custo de serializar
    // arquivos é pequeno (suite total ~30s).
    pool: "forks",
    fileParallelism: false,
    sequence: { concurrent: false },
    globalSetup: ["./helpers/global-setup.js"],
    setupFiles: ["./helpers/setup-each.js"],
    reporters: ["default"],
  },
});
