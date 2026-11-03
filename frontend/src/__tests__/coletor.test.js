// @vitest-environment happy-dom
// O "muro" no meio de um pedido à extensão: a tela avisa o servidor (WhatsApp com
// o link do VNC) e estica o relógio do pedido, porque a extensão agora espera o
// humano por até 25 min.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../data/api", () => ({ avisarMuro: vi.fn(() => Promise.resolve({ ok: true })) }));

import { avisarMuro } from "../data/api";
import { pedirAoColetor, TIMEOUT_APOS_MURO_MS } from "../data/coletor";

// O que a extensão mandaria pela ponte: só o `id` muda de pedido para pedido.
function idDoPedido() {
  const chamada = window.postMessage.mock.calls.find(([m]) => m?.de === "nimbus-admin");
  return chamada[0].id;
}
function daExtensao(data) {
  window.dispatchEvent(new MessageEvent("message", { source: window, data: { de: "nimbus-coletor", ...data } }));
}

describe("pedirAoColetor com muro", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(window, "postMessage").mockImplementation(() => {});
    avisarMuro.mockClear();
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("avisa o servidor e não desiste no timeout curto enquanto espera o humano", async () => {
    const onProgresso = vi.fn();
    const p = pedirAoColetor("raspar", { containerUrl: "x" }, { onProgresso, timeoutMs: 60_000 });
    const id = idDoPedido();

    daExtensao({ tipo: "progresso", id, evento: { tipo: "muro", muro: "captcha" } });
    expect(avisarMuro).toHaveBeenCalledWith({ muro: "captcha", onde: "raspar" });
    expect(onProgresso).toHaveBeenCalledWith({ tipo: "muro", muro: "captcha" });

    // Passou bem do timeout original (60s) e o pedido segue vivo.
    vi.advanceTimersByTime(20 * 60_000);
    daExtensao({ tipo: "resultado", id, ok: true, produtos: [1] });
    await expect(p).resolves.toEqual({ produtos: [1] });
  });

  it("depois do muro, o relógio estendido ainda acaba", async () => {
    const p = pedirAoColetor("lista", {}, { timeoutMs: 60_000 });
    daExtensao({ tipo: "progresso", id: idDoPedido(), evento: { tipo: "muro", muro: "captcha" } });
    vi.advanceTimersByTime(TIMEOUT_APOS_MURO_MS + 1);
    await expect(p).rejects.toThrow("não respondeu a tempo");
  });

  it("progresso comum não avisa ninguém", () => {
    pedirAoColetor("raspar", {}, { timeoutMs: 60_000 }).catch(() => {});
    daExtensao({ tipo: "progresso", id: idDoPedido(), evento: { tipo: "pagina", n: 1 } });
    expect(avisarMuro).not.toHaveBeenCalled();
  });
});
