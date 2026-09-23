#!/usr/bin/env node
// Roda os testes unitários nas duas passadas descritas na vitest.config.mjs:
// primeiro os que podem dividir processo, depois os isolados.
//
// Uso (de dentro de tests/):
//   node scripts/unit.mjs                 # todos
//   node scripts/unit.mjs scraper ml-     # filtro por nome, como no vitest
//   node scripts/unit.mjs --watch         # watch (todos isolados, uma config só)

import { spawnSync } from "child_process";
import path from "path";

const args = process.argv.slice(2);
const cwd = path.resolve(import.meta.dirname, "..");
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

function vitest(vitestArgs, env = {}) {
  const r = spawnSync(npx, ["vitest", ...vitestArgs], {
    cwd, stdio: "inherit", env: { ...process.env, ...env }, shell: process.platform === "win32",
  });
  return r.status ?? 1;
}

if (args.includes("--watch")) {
  const rest = args.filter(a => a !== "--watch");
  process.exit(vitest(["-c", "vitest.unit-isolated.config.mjs", ...rest], { NIMBUS_UNIT_ALL: "1" }));
}

// Com filtro, uma das passadas pode não ter arquivo nenhum — não é falha.
const shared = vitest(["run", "-c", "vitest.config.mjs", "--passWithNoTests", ...args]);
const isolated = vitest(["run", "-c", "vitest.unit-isolated.config.mjs", "--passWithNoTests", ...args]);
process.exit(shared || isolated);
