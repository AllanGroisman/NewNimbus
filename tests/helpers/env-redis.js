// Setup de ambiente — variante REDIS. Importar ANTES de qualquer módulo do backend.
// Cobre os testes que rodam contra BullMQ real (QUEUE_BACKEND=redis).
// O DB ainda é o nimbus_test do env.js.

import "./env.js";

// Sobrescreve só o queue backend. Vitest com pool=forks dá processo separado por
// arquivo, então essa override fica isolada a este test file.
process.env.QUEUE_BACKEND = "redis";
process.env.REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
