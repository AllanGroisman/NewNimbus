// netStatus — decide quando a faixa "Sem conexão com o Nimbus" aparece e some.
//
// Regra de negócio: uma falha isolada não acende o aviso (wifi piscando, aba
// dormindo); duas seguidas sim. E o app volta sozinho — sem F5 — quando a
// sonda do /healthz encontra o servidor de novo.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { isOnline, subscribe, reportSuccess, reportFailure, __resetNetStatus } from "../data/netStatus.js";

const offlineErr = () => ({ offline: true, code: "server_offline" });
const backendErr = () => ({ offline: false, status: 500, code: "internal" });

beforeEach(() => {
  vi.useFakeTimers();
  __resetNetStatus();
  globalThis.fetch = vi.fn();
});
afterEach(() => {
  __resetNetStatus();
  vi.useRealTimers();
});

describe("netStatus — quando fica offline", () => {
  it("uma falha isolada NÃO derruba o status", () => {
    reportFailure(offlineErr());
    expect(isOnline()).toBe(true);
  });

  it("duas falhas seguidas de conexão marcam offline", () => {
    reportFailure(offlineErr());
    reportFailure(offlineErr());
    expect(isOnline()).toBe(false);
  });

  it("erro do backend (500) não conta — o servidor está de pé", () => {
    reportFailure(backendErr());
    reportFailure(backendErr());
    reportFailure(backendErr());
    expect(isOnline()).toBe(true);
  });

  it("um sucesso no meio zera a contagem", () => {
    reportFailure(offlineErr());
    reportSuccess();
    reportFailure(offlineErr());
    expect(isOnline()).toBe(true);
  });

  it("avisa quem assinou, e só quando o estado muda", () => {
    const cb = vi.fn();
    subscribe(cb);
    reportFailure(offlineErr());
    expect(cb).not.toHaveBeenCalled();   // ainda online
    reportFailure(offlineErr());
    expect(cb).toHaveBeenCalledWith(false);
    reportFailure(offlineErr());
    expect(cb).toHaveBeenCalledTimes(1); // continua offline: não repete o aviso
    reportSuccess();
    expect(cb).toHaveBeenCalledWith(true);
  });
});

describe("netStatus — recuperação automática", () => {
  it("a sonda do /healthz devolve o app ao ar sem recarregar a página", async () => {
    const cb = vi.fn();
    subscribe(cb);
    reportFailure(offlineErr());
    reportFailure(offlineErr());
    expect(isOnline()).toBe(false);

    fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: "ok" }) });
    await vi.advanceTimersByTimeAsync(5000);   // primeira sonda

    expect(fetch).toHaveBeenCalledWith("/healthz", { cache: "no-store" });
    expect(isOnline()).toBe(true);
    expect(cb).toHaveBeenLastCalledWith(true);
  });

  it("503 com code server_offline (nginx) mantém offline e tenta de novo", async () => {
    reportFailure(offlineErr());
    reportFailure(offlineErr());

    fetch.mockResolvedValue({ ok: false, json: async () => ({ code: "server_offline" }) });
    await vi.advanceTimersByTimeAsync(5000);
    expect(isOnline()).toBe(false);

    await vi.advanceTimersByTimeAsync(10000);  // intervalo cresce: 5s → 10s
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(isOnline()).toBe(false);
  });

  it('503 "degraded" do próprio backend conta como online — ele respondeu', async () => {
    reportFailure(offlineErr());
    reportFailure(offlineErr());

    fetch.mockResolvedValueOnce({ ok: false, json: async () => ({ status: "degraded" }) });
    await vi.advanceTimersByTimeAsync(5000);
    expect(isOnline()).toBe(true);
  });
});
