// Trava: a suíte não roda na máquina onde o Nimbus está no ar.
//
// Por quê: os testes usam o MESMO Postgres de localhost:5432 que o sistema
// (criam nimbus_test e nimbus_test_1..4 nele), abrem até 4 processos node de
// ~250 MB cada e, no E2E, sobem um segundo backend. Numa VPS pequena isso
// disputa CPU, RAM e disco com o backend, o worker e o Chrome do Puppeteer, e a
// máquina trava. O lugar dos testes é o CI (.github/workflows/tests.yml roda a
// cada push) ou a máquina de desenvolvimento com o sistema parado.
//
// Sinal usado: o PM2 deste usuário com nimbus-backend ou nimbus-worker
// "online". Para rodar mesmo assim (ex.: dev com o PM2 local no ar):
//   NIMBUS_TESTS_ALLOW_PROD=1 npm test
//
// Só módulos nativos: é importado também pela frontend/vitest.config.mjs.

import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const APPS = ["nimbus-backend", "nimbus-worker"];

function pm2DaemonAlive() {
  // `pm2 jlist` SOBE o daemon se ele não estiver rodando. Conferir o pid antes
  // evita que a trava ligue o PM2 numa máquina onde ele estava parado.
  const home = process.env.PM2_HOME || path.join(os.homedir(), ".pm2");
  try {
    const pid = Number(fs.readFileSync(path.join(home, "pm2.pid"), "utf8").trim());
    if (!pid) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function nimbusAppsOnline() {
  if (!pm2DaemonAlive()) return [];
  let out;
  try {
    out = execFileSync("pm2", ["jlist"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return []; // sem pm2 no PATH (CI) → nada a proteger
  }
  // O pm2 às vezes imprime avisos antes do JSON, e eles também começam com "["
  // ("[PM2][WARN] ..."). Por isso tenta linha a linha, de baixo pra cima.
  for (const line of out.trim().split("\n").reverse()) {
    try {
      const list = JSON.parse(line);
      if (!Array.isArray(list)) continue;
      return list
        .filter(p => APPS.includes(p.name) && p.pm2_env?.status === "online")
        .map(p => p.name);
    } catch { /* não era o JSON */ }
  }
  return [];
}

export function assertNotProduction(what = "os testes") {
  if (process.env.NIMBUS_TESTS_ALLOW_PROD === "1") return;
  const online = nimbusAppsOnline();
  if (!online.length) return;
  throw new Error(
    `\n[prod-guard] ${what} NÃO rodam com o Nimbus no ar nesta máquina ` +
    `(PM2: ${online.join(", ")} online).\n` +
    `  Eles dividem o Postgres com o sistema e ocupam CPU/RAM até travar o servidor.\n` +
    `  Rode no CI (push no GitHub) ou numa máquina de desenvolvimento.\n` +
    `  Para forçar mesmo assim: NIMBUS_TESTS_ALLOW_PROD=1\n`
  );
}
