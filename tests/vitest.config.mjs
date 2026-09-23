import { defineConfig } from "vitest/config";
import { readdirSync, readFileSync } from "fs";
import path from "path";

// Config dos testes UNITÁRIOS. As camadas que precisam de Postgres
// (integration/ e journey/) rodam pela vitest.integration.config.mjs.
//
// Nenhum arquivo de unit/ importa helpers/app.js ou pg-helpers.js — são funções
// puras com IO mockado. Sem PG, também não há estado compartilhado, então os
// arquivos rodam em paralelo.
//
// Os unitários rodam em DUAS passadas (é o que `npm run test:unit` faz, via
// scripts/unit.mjs):
//
//   1. esta config — isolate: false. Os arquivos de um worker dividem o
//      processo e o cache de módulos, então o backend carrega uma vez por
//      worker e não uma vez por arquivo. ~5 s em vez de ~28 s.
//   2. vitest.unit-isolated.config.mjs — isolate: true, só os arquivos que
//      trocam módulos no require.cache, usam vi.mock ou fake timers. Sem
//      processo próprio eles contaminam quem roda depois no mesmo worker
//      (medido: 12 arquivos quebravam, um conjunto diferente a cada execução).
//
// A separação é calculada lendo cada arquivo: teste novo que mexe em estado
// global cai sozinho na passada isolada, sem lista manual pra esquecer.
//
// Por que não uma workspace com dois projetos: no vitest 2.1 o `isolate` vale
// pro pool inteiro, então os dois projetos precisariam de pools de tipos
// diferentes. Com `threads` o sharp/Prisma (nativos) derrubaram a execução com
// segfault; com `vmForks` o require.cache continuou vazando. Duas passadas em
// série custam o mesmo (~12 s) e não têm nenhum desses problemas.
//
// Tempos por arquivo e o mapa "mudei X -> rode Y": tests/TIMING.md

const UNIT_DIR = path.join(import.meta.dirname, "unit");
const POLLUTES = /require\.cache|vi\.(do)?[mM]ock\(|useFakeTimers/;

export const ISOLATED_UNIT_FILES = readdirSync(UNIT_DIR)
  .filter(f => f.endsWith(".test.js"))
  .filter(f => POLLUTES.test(readFileSync(path.join(UNIT_DIR, f), "utf8")))
  .map(f => `unit/${f}`);

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["unit/**/*.test.js"],
    exclude: ["**/node_modules/**", ...ISOLATED_UNIT_FILES],
    testTimeout: 20000,
    hookTimeout: 60000,
    pool: "forks",
    poolOptions: { forks: { isolate: false } },
    setupFiles: ["./helpers/setup-unit.js"],
    reporters: ["default"],
  },
});
