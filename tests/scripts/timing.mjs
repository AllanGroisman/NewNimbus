#!/usr/bin/env node
// Mede quanto tempo cada ARQUIVO de teste leva e imprime uma tabela markdown.
//
// Uso (de dentro de tests/):
//   npm run test:timing                # backend (unit + integration + journey)
//   npm run test:timing -- --frontend  # a suite do frontend
//   npm run test:timing -- --unit      # só unit
//   npm run test:timing -- --json out.json   # guarda o JSON bruto do vitest
//
// O reporter JSON do vitest devolve um assertionResult por teste, cada um com
// `duration` (ms) e o arquivo de origem. Somamos por arquivo — a soma fica
// levemente abaixo do wall clock do arquivo (não inclui import/setup), por isso
// também mostramos o total real da execução no rodapé.

import { spawnSync } from "child_process";
import { readFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const flagValue = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : null;
};

const frontend = has("--frontend");
const only = has("--unit") ? "unit" : has("--integration") ? "integration" : has("--journey") ? "journey" : null;

const testsDir = path.resolve(import.meta.dirname, "..");
const cwd = frontend ? path.resolve(testsDir, "..", "frontend") : testsDir;

const tmp = mkdtempSync(path.join(tmpdir(), "nimbus-timing-"));
const outFile = path.join(tmp, "report.json");

const vitestArgs = ["vitest", "run", "--reporter=json", `--outputFile=${outFile}`];
if (!frontend) {
  // backend: cada camada tem sua config (ver tests/README.md)
  if (only === "unit") vitestArgs.push("-c", "vitest.config.mjs");
  else if (only) vitestArgs.push("-c", "vitest.integration.config.mjs", only);
}

const label = frontend ? "frontend" : only || "backend (tudo)";
console.error(`> medindo ${label} em ${cwd} ...`);

const started = Date.now();
const run = spawnSync("npx", vitestArgs, { cwd, stdio: ["ignore", "ignore", "inherit"] });
const wall = Date.now() - started;

let report;
try {
  report = JSON.parse(readFileSync(outFile, "utf8"));
} catch {
  console.error("Falhou ao ler o relatório JSON do vitest. A suite quebrou?");
  rmSync(tmp, { recursive: true, force: true });
  process.exit(run.status || 1);
}
rmSync(tmp, { recursive: true, force: true });

const repoRoot = path.resolve(testsDir, "..");
const byFile = new Map();
for (const suite of report.testResults || []) {
  const file = path.relative(repoRoot, suite.name).replaceAll("\\", "/");
  const entry = byFile.get(file) || { file, ms: 0, tests: 0, skipped: 0 };
  // `endTime - startTime` do suite inclui import + hooks; é o que realmente custa.
  const suiteMs = suite.endTime && suite.startTime ? suite.endTime - suite.startTime : 0;
  entry.ms += suiteMs;
  for (const t of suite.assertionResults || []) {
    entry.tests += 1;
    if (t.status === "pending" || t.status === "skipped") entry.skipped += 1;
  }
  byFile.set(file, entry);
}

const rows = [...byFile.values()].sort((a, b) => b.ms - a.ms);
const totalMs = rows.reduce((s, r) => s + r.ms, 0);
const totalTests = rows.reduce((s, r) => s + r.tests, 0);
const totalSkipped = rows.reduce((s, r) => s + r.skipped, 0);

const fmt = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);

console.log(`\n| Arquivo | Testes | Tempo |`);
console.log(`|---|---:|---:|`);
for (const r of rows) {
  const skip = r.skipped ? ` (${r.skipped} skip)` : "";
  console.log(`| \`${r.file}\` | ${r.tests}${skip} | ${fmt(r.ms)} |`);
}
console.log(`\n**${rows.length} arquivos · ${totalTests} testes${totalSkipped ? ` (${totalSkipped} pulados)` : ""} · soma dos arquivos ${fmt(totalMs)} · wall clock ${fmt(wall)}**`);

const jsonOut = flagValue("--json");
if (jsonOut) {
  const { writeFileSync } = await import("fs");
  writeFileSync(jsonOut, JSON.stringify({ label, wall, rows }, null, 2));
  console.error(`> JSON salvo em ${jsonOut}`);
}

process.exit(run.status || 0);
