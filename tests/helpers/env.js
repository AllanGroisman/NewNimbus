// Setup de ambiente — DEVE ser importado ANTES de qualquer modulo do backend.
// Cada arquivo de teste roda em worker isolado (vitest pool=forks + isolate=true),
// entao cada arquivo recebe seu proprio NIMBUS_DATA_DIR temporario.

import os from "os";
import path from "path";
import fs from "fs";
import crypto from "crypto";

const TMP_ROOT = path.join(os.tmpdir(), `nimbus-test-${crypto.randomBytes(6).toString("hex")}`);
fs.mkdirSync(TMP_ROOT, { recursive: true });
fs.mkdirSync(path.join(TMP_ROOT, "state"), { recursive: true });

process.env.NODE_ENV = "test";
process.env.STORAGE_BACKEND = "json";
process.env.QUEUE_BACKEND = "memory";
process.env.NIMBUS_DATA_DIR = TMP_ROOT;
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-only-for-tests";
process.env.LOG_LEVEL = process.env.LOG_LEVEL || "error";

export { TMP_ROOT };
