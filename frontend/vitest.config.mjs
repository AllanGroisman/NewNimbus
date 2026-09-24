import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react({ jsxRuntime: "automatic" })],
  esbuild: {
    jsx: "automatic",
  },
  test: {
    // happy-dom em vez de jsdom: a suíte inteira passou igual e caiu de ~105 s
    // pra ~55 s (o jsdom custava ~3 s por arquivo só pra montar). Ver
    // tests/TIMING.md.
    environment: "happy-dom",
    // Os .test.js são lógica pura (sem render) e não precisam de DOM nenhum.
    // api.test.js é a exceção: usa window/localStorage. A primeira regra que
    // casa vence.
    environmentMatchGlobs: [
      ["src/__tests__/api.test.js", "happy-dom"],
      ["src/**/*.test.js", "node"],
    ],
    globals: false,
    setupFiles: ["./src/__tests__/setup.js"],
    include: ["src/**/*.test.js", "src/**/*.test.jsx"],
    testTimeout: 10000,
    // No máximo 2 processos. A máquina de desenvolvimento é um notebook de 4 threads
    // e 3,7 GB, e desligou sozinho com a suíte ocupando os 4 núcleos junto com o
    // backend e o editor. Fica mais lenta, mas sobra CPU para o resto. Para uma
    // rodada pontual mais rápida: `npx vitest run --maxWorkers=4`.
    maxWorkers: 2,
    minWorkers: 1,
    reporters: ["default"],
  },
});
