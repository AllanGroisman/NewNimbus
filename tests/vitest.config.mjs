import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["unit/**/*.test.js", "integration/**/*.test.js", "journey/**/*.test.js"],
    testTimeout: 20000,
    hookTimeout: 30000,
    // Pool=forks com isolate=true (default) = cada arquivo de teste em worker proprio.
    // singleFork: false permite paralelismo entre arquivos; cada arquivo recebe seu
    // proprio NIMBUS_DATA_DIR via helpers/env.js (worker isolado).
    pool: "forks",
    fileParallelism: true,
    sequence: { concurrent: false },
    reporters: ["default"],
  },
});
