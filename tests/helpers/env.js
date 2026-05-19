// Setup de ambiente — DEVE ser importado ANTES de qualquer modulo do backend.
// A suite roda contra um database Postgres separado (`nimbus_test`) na mesma
// instância da do dev.
//
// Pré-requisitos:
//   - Postgres rodando em localhost:5432 (docker compose up -d)
//   - Database `nimbus_test` criada com schema migrado (npm test cuida disso
//     via prisma migrate deploy no setup global)
//
// Isolamento: cada arquivo de teste roda em worker isolado (vitest pool=forks +
// isolate=true). O helper `truncateAll()` em pg-helpers.js limpa todas as
// tabelas antes de cada teste pra garantir que workers paralelos não vejam
// dados uns dos outros. Único compartilhado é o schema.

const TEST_DATABASE_URL =
  process.env.NIMBUS_TEST_DATABASE_URL ||
  "postgresql://nimbus:nimbus_dev@localhost:5432/nimbus_test?schema=public";

process.env.NODE_ENV = "test";
process.env.QUEUE_BACKEND = "memory";
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-only-for-tests";
process.env.LOG_LEVEL = process.env.LOG_LEVEL || "error";

export { TEST_DATABASE_URL };
