// Setup carregado por vitest em CADA arquivo de teste (setupFiles).
// Garante que o estado do PG é limpo entre testes e que o mock do WhatsApp
// é resetado, sem precisar repetir beforeEach em todo lugar.
//
// Opt-out: arquivos de teste que rodam steps sequenciais (ex: journey) podem
// chamar `globalThis.__NIMBUS_SKIP_TRUNCATE_BETWEEN_TESTS = true` em beforeAll
// e fazer um truncate manual no início. Os hooks aqui então só resetam o
// mock do WhatsApp.

import { beforeEach, beforeAll, afterAll } from "vitest";
import "./env.js";
import { truncateAll, disconnectDb } from "./pg-helpers.js";
import { reset as resetWa } from "./wa-mock.js";
import { reset as resetStripe } from "./stripe-mock.js";

beforeAll(() => {
  // Reset do flag a cada arquivo — workers compartilham processo? Não, com
  // pool=forks + isolate cada arquivo tem processo próprio. Mas zera por garantia.
  globalThis.__NIMBUS_SKIP_TRUNCATE_BETWEEN_TESTS =
    globalThis.__NIMBUS_SKIP_TRUNCATE_BETWEEN_TESTS || false;
});

beforeEach(async () => {
  if (!globalThis.__NIMBUS_SKIP_TRUNCATE_BETWEEN_TESTS) {
    await truncateAll();
  }
  resetWa();
  resetStripe();
});

afterAll(async () => {
  await disconnectDb();
});
