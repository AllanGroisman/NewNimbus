// Validação da configuração do ScrapTester (writeConfig).
// O módulo de config (Postgres) é trocado por um fake em memória via require.cache,
// então o teste roda sem banco.

import "../helpers/env.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const backend = path.resolve(__dirname, "..", "..", "backend");

const store = new Map();
const cfgPath = require.resolve(path.join(backend, "config"));
require.cache[cfgPath] = {
  id: cfgPath, filename: cfgPath, loaded: true,
  exports: {
    get: (k) => (store.has(k) ? store.get(k) : null),
    set: (k, v) => store.set(k, v),
    del: (k) => store.delete(k),
  },
};

const tester = require(path.join(backend, "scraping", "tester.js"));

beforeAll(() => store.clear());
afterAll(() => tester.stop());

describe("writeConfig", () => {
  it("aceita o Hub como fonte e descarta fonte inexistente", () => {
    const cfg = tester.writeConfig({ sources: ["ml", "ml-hub", "loja-que-nao-existe"] });
    expect(cfg.sources).toEqual(["ml", "ml-hub"]);
  });

  it("guarda a conferência de fotos e limita a resolução mínima", () => {
    expect(tester.writeConfig({ checkImages: false }).checkImages).toBe(false);
    expect(tester.writeConfig({ checkImages: true, imageMinPx: 800 }).imageMinPx).toBe(800);
    expect(tester.writeConfig({ imageMinPx: 99999 }).imageMinPx).toBe(4000);   // teto
    expect(tester.writeConfig({ imageMinPx: 1 }).imageMinPx).toBe(100);        // piso
  });

  it("aceita limiar do Hub (nome com hífen) e ignora chave desconhecida", () => {
    const cfg = tester.writeConfig({
      thresholds: { "ml-hub.commission": 40, "ml-hub.naoexiste": 10, "loja.price": 5 },
    });
    expect(cfg.thresholds).toEqual({ "ml-hub.commission": 40 });
  });

  it("o padrão vem com a conferência de fotos ligada", () => {
    expect(tester.DEFAULT_CONFIG.checkImages).toBe(true);
    expect(tester.DEFAULT_CONFIG.imageMinPx).toBe(500);
    // O Hub fica de fora por padrão: quem não usa não leva coluna vermelha.
    expect(tester.DEFAULT_CONFIG.sources).not.toContain("ml-hub");
  });
});
