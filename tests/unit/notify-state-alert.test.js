// stateAlert — núcleo do debounce/recuperação dos avisos de QUEDA (Task 2).
// Puro, sem IO: só a mecânica de timer. Uma queda só vira aviso após o grace; se
// recuperar antes, silêncio. Se o aviso saiu, a recuperação dispara onRecover.

import "../helpers/env.js";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const notifier = require(path.resolve(__dirname, "..", "..", "backend", "notifications", "user-notifier.js"));
const { stateAlert, __clearAlertState } = notifier;

const GRACE = 60_000;

// Conta chamadas de onDown/onRecover por chave.
function makeSpies() {
  return { down: vi.fn(), recover: vi.fn() };
}
function opts(spies) {
  return { graceMs: GRACE, onDown: spies.down, onRecover: spies.recover };
}

beforeEach(() => {
  vi.useFakeTimers();
  __clearAlertState();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("stateAlert", () => {
  it("queda que recupera ANTES do grace → nenhum aviso (falso alarme suprimido)", async () => {
    const s = makeSpies();
    stateAlert("k1", true, opts(s));
    await vi.advanceTimersByTimeAsync(GRACE - 1);
    stateAlert("k1", false, opts(s)); // voltou dentro do grace
    await vi.advanceTimersByTimeAsync(GRACE);
    expect(s.down).not.toHaveBeenCalled();
    expect(s.recover).not.toHaveBeenCalled();
  });

  it("queda que persiste além do grace → 1 aviso de queda; depois recupera → 1 aviso de volta", async () => {
    const s = makeSpies();
    stateAlert("k2", true, opts(s));
    await vi.advanceTimersByTimeAsync(GRACE);
    expect(s.down).toHaveBeenCalledTimes(1);
    expect(s.recover).not.toHaveBeenCalled();

    stateAlert("k2", false, opts(s)); // recuperou depois de já ter avisado
    await vi.advanceTimersByTimeAsync(1);
    expect(s.recover).toHaveBeenCalledTimes(1);
    expect(s.down).toHaveBeenCalledTimes(1);
  });

  it("chamadas de queda repetidas dentro do grace armam só 1 timer (sem spam)", async () => {
    const s = makeSpies();
    stateAlert("k3", true, opts(s));
    await vi.advanceTimersByTimeAsync(GRACE / 3);
    stateAlert("k3", true, opts(s)); // tick do scheduler ainda caído
    await vi.advanceTimersByTimeAsync(GRACE / 3);
    stateAlert("k3", true, opts(s));
    await vi.advanceTimersByTimeAsync(GRACE); // ultrapassa o grace do 1º disparo
    expect(s.down).toHaveBeenCalledTimes(1);
  });

  it("após avisar a queda, novas chamadas de queda não re-notificam", async () => {
    const s = makeSpies();
    stateAlert("k4", true, opts(s));
    await vi.advanceTimersByTimeAsync(GRACE);
    expect(s.down).toHaveBeenCalledTimes(1);
    stateAlert("k4", true, opts(s)); // ainda caído em ticks seguintes
    stateAlert("k4", true, opts(s));
    await vi.advanceTimersByTimeAsync(GRACE);
    expect(s.down).toHaveBeenCalledTimes(1);
  });

  it("recuperação sem queda prévia não faz nada", async () => {
    const s = makeSpies();
    stateAlert("k5", false, opts(s));
    await vi.advanceTimersByTimeAsync(GRACE);
    expect(s.down).not.toHaveBeenCalled();
    expect(s.recover).not.toHaveBeenCalled();
  });

  it("ciclo completo repetível: queda→volta→queda→volta gera 2 pares de avisos", async () => {
    const s = makeSpies();
    // 1º episódio
    stateAlert("k6", true, opts(s));
    await vi.advanceTimersByTimeAsync(GRACE);
    stateAlert("k6", false, opts(s));
    await vi.advanceTimersByTimeAsync(1);
    // 2º episódio
    stateAlert("k6", true, opts(s));
    await vi.advanceTimersByTimeAsync(GRACE);
    stateAlert("k6", false, opts(s));
    await vi.advanceTimersByTimeAsync(1);
    expect(s.down).toHaveBeenCalledTimes(2);
    expect(s.recover).toHaveBeenCalledTimes(2);
  });
});
