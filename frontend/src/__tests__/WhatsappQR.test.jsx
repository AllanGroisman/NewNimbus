// Testa o fix de closure do WhatsappQR: o polling roda dentro de um único
// useEffect (deps [sessionId, autoStart]) que NÃO reinicia quando o parent
// re-renderiza com um onConnected novo (ex. usuário digitando o apelido do
// número). Sem os refs, o tick chamaria a versão de onConnected capturada no
// mount. Estes testes garantem que a versão ATUAL do callback é a chamada.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, screen } from "@testing-library/react";

vi.mock("../data/api", () => ({
  // errText é helper puro (não faz rede) — usa a implementação de verdade.
  errText: (err, fallback) => err?.message || fallback,
  startWASession: vi.fn().mockResolvedValue({ ok: true }),
  getWASession: vi.fn(),
  deleteWASession: vi.fn().mockResolvedValue({ ok: true }),
}));

import { getWASession, startWASession } from "../data/api";
import WhatsappQR from "../components/WhatsappQR.jsx";

describe("WhatsappQR — usa o callback mais recente (fix de closure)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    startWASession.mockResolvedValue({ ok: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("chama o onConnected ATUAL ao conectar, não o do mount", async () => {
    // 1º poll: ainda aguardando QR; 2º poll: conectado.
    getWASession
      .mockResolvedValueOnce({ status: "awaiting_qr", qr: "data:image/png;base64,x", info: null, lastError: null })
      .mockResolvedValueOnce({ status: "connected", qr: null, info: { phone: "5511999999999", name: "Zé" }, lastError: null });

    const cbMount = vi.fn();
    const cbAtual = vi.fn();

    let rerender;
    await act(async () => {
      ({ rerender } = render(<WhatsappQR sessionId="num-1" onConnected={cbMount} />));
    });
    // Deixa run() (startSession) + 1º tick (awaiting_qr) completarem.
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });

    expect(startWASession).toHaveBeenCalledWith("num-1");
    expect(cbMount).not.toHaveBeenCalled(); // ainda não conectou

    // Parent re-renderiza com um callback novo (mesmo sessionId → efeito não reinicia).
    await act(async () => {
      rerender(<WhatsappQR sessionId="num-1" onConnected={cbAtual} />);
    });

    // Próximo poll (1500ms) retorna connected.
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });

    expect(cbAtual).toHaveBeenCalledTimes(1);
    expect(cbAtual).toHaveBeenCalledWith({ phone: "5511999999999", name: "Zé" });
    expect(cbMount).not.toHaveBeenCalled(); // o callback velho NUNCA é chamado
  });

  it("status 'connecting' pós-scan mostra 'Conectando...' e NÃO 'Erro de conexão'", async () => {
    // Após escanear o QR o backend passa por um close normal (restartRequired) que
    // agora vira "connecting" — a tela deve mostrar o spinner de sincronização, nunca erro.
    getWASession.mockResolvedValue({ status: "connecting", qr: null, info: null, lastError: null });

    await act(async () => {
      render(<WhatsappQR sessionId="num-3" onConnected={vi.fn()} />);
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });

    expect(screen.getByText(/Conectando\.\.\./)).toBeTruthy();
    expect(screen.queryByText(/Erro de conexão/)).toBeNull();
  });

  it("lastError residual durante 'connecting' não dispara o bloco de erro", async () => {
    // Defesa em profundidade: mesmo que um lastError antigo chegue enquanto o status
    // ainda é "connecting", o branch de erro (só terminal) não deve aparecer.
    getWASession.mockResolvedValue({ status: "connecting", qr: null, info: null, lastError: "Stream Errored (restart required)" });

    await act(async () => {
      render(<WhatsappQR sessionId="num-4" onConnected={vi.fn()} />);
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });

    expect(screen.queryByText(/Erro de conexão/)).toBeNull();
  });

  it("chama onError quando o start da sessão falha", async () => {
    startWASession.mockRejectedValueOnce(new Error("falha ao iniciar"));

    const onError = vi.fn();
    await act(async () => {
      render(<WhatsappQR sessionId="num-2" onConnected={vi.fn()} onError={onError} />);
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
  });
});
