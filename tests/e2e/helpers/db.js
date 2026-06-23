// Helpers de DB pro E2E. Apontam o prisma do backend pro banco isolado de E2E
// (nimbus_test_e2e) — o MESMO que o servidor de teste usa. Carregamos os módulos
// CJS do backend via createRequire (este arquivo é ESM).

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..", "..");
// require resolvido a partir do backend → acha @prisma/client em backend/node_modules.
const backendRequire = createRequire(path.join(repoRoot, "backend", "package.json"));

export const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ||
  "postgresql://nimbus:nimbus_dev@localhost:5432/nimbus_test_e2e?schema=public";

let _backend = null;

// Carrega catalog + prisma do backend, fixando DATABASE_URL no banco de E2E.
// (Setar process.env aqui só afeta ESTE processo de teste, não o servidor.)
export function backend() {
  if (!_backend) {
    const catalog = backendRequire(path.join(repoRoot, "backend", "catalog"));
    const { prisma, disconnect } = backendRequire(path.join(repoRoot, "backend", "db"));
    // IMPORTANTE: requerer o backend dispara, em cadeia, o config/loadEnv que faz
    // dotenv override:true e REESCREVE DATABASE_URL com o .env (dev). Por isso
    // fixamos o DB de E2E DEPOIS dos requires e ANTES do primeiro prisma()
    // instanciar o client — senão o seed iria pro banco de dev.
    process.env.DATABASE_URL = E2E_DATABASE_URL;
    _backend = { catalog, prisma, disconnect };
  }
  return _backend;
}

// Cliente prisma avulso pra um DATABASE_URL arbitrário (ex.: ler o DB de dev).
export function prismaFor(url) {
  const { PrismaClient } = backendRequire("@prisma/client");
  return new PrismaClient({ datasources: { db: { url } } });
}
