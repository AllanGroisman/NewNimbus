// Setup carregado por vitest em CADA arquivo de teste (setupFiles).
// Garante que o estado do PG é limpo entre testes e que o mock do WhatsApp
// é resetado, sem precisar repetir beforeEach em todo lugar.
//
// Opt-out: arquivos de teste que rodam steps sequenciais (ex: journey) podem
// chamar `globalThis.__NIMBUS_SKIP_TRUNCATE_BETWEEN_TESTS = true` em beforeAll
// e fazer um truncate manual no início. Os hooks aqui então só resetam o
// mock do WhatsApp.

import { beforeEach, beforeAll, afterAll } from "vitest";
import { createRequire } from "module";
import "./env.js";
import { truncateAll, disconnectDb } from "./pg-helpers.js";
import { reset as resetWa } from "./wa-mock.js";
import { reset as resetStripe } from "./stripe-mock.js";
import { reset as resetEmail } from "./email-mock.js";

const require = createRequire(import.meta.url);
const appConfig = require("../../backend/config");
// Índice em memória dos grupos cadastrados (aba Grupos): com o banco limpo entre
// testes, um índice velho mandaria gravar pra grupo que não existe mais.
const groupStatsCapture = require("../../backend/group-stats/capture");

// A integração roda com isolate: false — os arquivos de um worker dividem o
// processo (ver vitest.integration.config.mjs). Então o que um arquivo deixa em
// memória chega no próximo, e cada um precisa começar como se o processo fosse
// novo. Este beforeAll roda antes dos hooks do próprio arquivo.
beforeAll(async () => {
  // O journey liga o flag; sem zerar, o arquivo seguinte pararia de limpar o banco.
  globalThis.__NIMBUS_SKIP_TRUNCATE_BETWEEN_TESTS = false;
  // Cache do app_config (travas de loja, filtros do scraper...): o banco é
  // limpo entre testes, o cache não.
  await appConfig.resetForTests();
});

beforeEach(async () => {
  if (!globalThis.__NIMBUS_SKIP_TRUNCATE_BETWEEN_TESTS) {
    await truncateAll();
  }
  resetWa();
  groupStatsCapture._resetIndex();
  resetStripe();
  // O mock do mailer NÃO é resetado aqui de propósito: testes de jornada com
  // truncate manual contam com os envios acumulados entre os passos.
  resetEmail();
});

afterAll(async () => {
  globalThis.__NIMBUS_SKIP_TRUNCATE_BETWEEN_TESTS = false;
  await disconnectDb();
});
