// Jobs da fila `control` não tinham validade. Com o worker fora, o server seguia
// enfileirando (cada POST de QR, cada envio) e TUDO executava de uma vez quando
// ele voltava — abrindo sessão que ninguém está mais olhando e falhando envios
// cujo HTTP expirou minutos antes (log real: "sendText … Sessão não está
// conectada (status: connecting)" logo depois de um restart).

import "../helpers/env.js";
import { describe, it, expect } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { isControlJobExpired } =
  require(path.resolve(__dirname, "..", "..", "backend", "infra", "queue.js"));

const NOW = 1_700_000_000_000;

describe("isControlJobExpired", () => {
  it("job sem carimbo (enfileirado por uma versão anterior) nunca é descartado", () => {
    expect(isControlJobExpired(null, NOW, 30000)).toBe(false);
    expect(isControlJobExpired(undefined, NOW, 30000)).toBe(false);
  });

  it("recém-enfileirado → executa", () => {
    expect(isControlJobExpired(NOW - 500, NOW, 30000)).toBe(false);
  });

  it("dentro do timeout do chamador → executa", () => {
    expect(isControlJobExpired(NOW - 29_000, NOW, 30000)).toBe(false);
  });

  it("na borda (timeout + graça) ainda executa — a graça absorve latência", () => {
    expect(isControlJobExpired(NOW - 35_000, NOW, 30000)).toBe(false);
  });

  it("passou do timeout + graça → descarta", () => {
    expect(isControlJobExpired(NOW - 35_001, NOW, 30000)).toBe(true);
    expect(isControlJobExpired(NOW - 10 * 60 * 1000, NOW, 30000)).toBe(true);
  });

  it("respeita o timeout de cada op (listGroups usa 60s no proxy)", () => {
    expect(isControlJobExpired(NOW - 50_000, NOW, 60000)).toBe(false);
    expect(isControlJobExpired(NOW - 50_000, NOW, 15000)).toBe(true);
  });
});
