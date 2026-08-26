// Setup de ambiente — DEVE ser importado ANTES de qualquer modulo do backend.
// A suite roda contra um database Postgres separado (`nimbus_test`) na mesma
// instância da do dev.
//
// Pré-requisitos:
//   - Postgres rodando em localhost:5432 (docker compose up -d)
//   - Database `nimbus_test` criada com schema migrado (o globalSetup cuida
//     disso via prisma migrate deploy)
//
// ISOLAMENTO ENTRE WORKERS
// integration/ e journey/ rodam em paralelo, e cada worker precisa do seu
// próprio banco — senão o truncateAll() de um worker apagaria as linhas que
// outro acabou de semear. O globalSetup cria N cópias (`nimbus_test_1`, `_2`,
// ...) a partir de `nimbus_test`, e cada worker escolhe a sua pelo
// VITEST_POOL_ID (o vitest numera os forks a partir de 1).
//
// Sem VITEST_POOL_ID (globalSetup, scripts avulsos) cai no `nimbus_test`, que é
// o molde. Os unitários não usam banco nenhum — ver helpers/setup-unit.js.

const BASE_URL =
  process.env.NIMBUS_TEST_DATABASE_URL ||
  "postgresql://nimbus:nimbus_dev@localhost:5432/nimbus_test?schema=public";

// Quantos bancos-shard existem. Mantido em sync com o globalSetup.
const SHARDS = Number(process.env.NIMBUS_TEST_SHARDS || 4);

function shardUrl(baseUrl, poolId) {
  if (!poolId) return baseUrl;
  const n = Number(poolId);
  if (!Number.isFinite(n) || n < 1) return baseUrl;
  // Distribui em N shards mesmo se o vitest abrir mais forks que o esperado.
  const idx = ((n - 1) % SHARDS) + 1;
  return baseUrl.replace(/\/nimbus_test(\?|$)/, `/nimbus_test_${idx}$1`);
}

const TEST_DATABASE_URL = shardUrl(BASE_URL, process.env.VITEST_POOL_ID);

process.env.NODE_ENV = "test";
process.env.QUEUE_BACKEND = "memory";
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-only-for-tests";
process.env.LOG_LEVEL = process.env.LOG_LEVEL || "error";

export { TEST_DATABASE_URL, BASE_URL, SHARDS, shardUrl };
