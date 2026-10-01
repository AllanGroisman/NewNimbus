// Testa o fix de closure do WhatsappQR: o polling roda dentro de um único
// useEffect (deps [sessionId, autoStart]) que NÃO reinicia quando o parent
// re-renderiza com um onConnected novo (ex. usuário digitando o apelido do
// número). Sem os refs, o tick chamaria a versão de onConnected capturada no
// mount. Estes testes garantem que a versão ATUAL do callback é a chamada.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, screen, fireEvent } from "@testing-library/react";

vi.mock("../data/api", () => ({
  // errText é helper puro (não faz rede) — usa a implementação de verdade.
  errText: (err, fallback) => err?.message || fallback,
  startWASession: vi.fn().mockResolvedValue({ ok: true }),
  getWASession: vi.fn(),
  deleteWASession: vi.fn().mockResolvedValue({ ok: true }),
  requestWAPairingCode: vi.fn(),
}));

import { getWASession, startWASession, requestWAPairingCode, deleteWASession } from "../data/api";
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

// ── Código de pareamento (8 dígitos) ────────────────────────────────────────
// A alternativa ao QR roda na MESMA sessão e no mesmo socket: trocar de modo é só
// renderização, o polling e o onConnected seguem os mesmos. O que estes testes
// fixam é o contrato da tela — validar antes de bater na rede, mandar o telefone
// já normalizado, e oferecer a regeneração quando o prazo acaba.
describe("WhatsappQR — modo código de pareamento", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    startWASession.mockResolvedValue({ ok: true });
    deleteWASession.mockResolvedValue({ ok: true });
    getWASession.mockResolvedValue({ status: "awaiting_qr", qr: "data:image/png;base64,x", info: null, lastError: null });
  });
  afterEach(() => { vi.useRealTimers(); });

  async function abrirModoCodigo(sessionId = "num-pair") {
    await act(async () => { render(<WhatsappQR sessionId={sessionId} onConnected={vi.fn()} />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    await act(async () => { screen.getByText("Código de 8 dígitos").click(); });
  }

  it("no celular (toque) já abre no código: não dá pra escanear o QR na própria tela", async () => {
    const original = window.matchMedia;
    window.matchMedia = (q) => ({ matches: q === "(pointer: coarse)", media: q, addEventListener() {}, removeEventListener() {} });
    try {
      await act(async () => { render(<WhatsappQR sessionId="num-touch" onConnected={vi.fn()} />); });
      await act(async () => { await vi.advanceTimersByTimeAsync(10); });
      expect(screen.getByPlaceholderText("(11) 99999-9999")).toBeTruthy();
      expect(screen.queryByAltText("QR Code WhatsApp")).toBeNull();
    } finally {
      window.matchMedia = original;
    }
  });

  it("trocar de modo revela o campo de telefone", async () => {
    await abrirModoCodigo();
    expect(screen.getByPlaceholderText("(11) 99999-9999")).toBeTruthy();
    // O QR sai de cena — os dois modos dividem a mesma caixa.
    expect(screen.queryByAltText("QR Code WhatsApp")).toBeNull();
  });

  it("telefone inválido mostra erro inline e NÃO chama a API", async () => {
    await abrirModoCodigo();
    const input = screen.getByPlaceholderText("(11) 99999-9999");
    await act(async () => {
      fireEvent.change(input, { target: { value: "1199" } });
      fireEvent.click(screen.getByText("Gerar código"));
    });
    expect(requestWAPairingCode).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/celular válido/i);
  });

  it("telefone válido pede o código com o número normalizado e o mostra formatado", async () => {
    requestWAPairingCode.mockResolvedValue({
      ok: true, code: "ABCD1234", formatted: "ABCD-1234",
      phone: "5511999999999", expiresAt: Date.now() + 110_000,
    });
    await abrirModoCodigo();
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText("(11) 99999-9999"), { target: { value: "(11) 99999-9999" } });
      fireEvent.click(screen.getByText("Gerar código"));
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });

    // O backend recebe 55 + DDD + 9 dígitos, nunca a máscara.
    expect(requestWAPairingCode).toHaveBeenCalledWith("num-pair", "5511999999999");
    expect(screen.getByText("ABCD-1234")).toBeTruthy();
    expect(screen.getByText(/Vincular com número de telefone/)).toBeTruthy();
  });

  it("passado o prazo, o código vira 'Gerar novo código'", async () => {
    requestWAPairingCode.mockResolvedValue({
      ok: true, code: "ABCD1234", formatted: "ABCD-1234",
      phone: "5511999999999", expiresAt: Date.now() + 5_000,
    });
    await abrirModoCodigo();
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText("(11) 99999-9999"), { target: { value: "(11) 99999-9999" } });
      fireEvent.click(screen.getByText("Gerar código"));
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(screen.queryByText("Gerar novo código")).toBeNull();

    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
    expect(screen.getByText("Gerar novo código")).toBeTruthy();
  });

  it("regerar pede outro código sem apagar a sessão", async () => {
    // O DELETE daqui era destrutivo: numa sessão que tivesse ACABADO de parear ele
    // vira sock.logout() e desvincula o aparelho. Quem garante que o pedido parte de
    // credencial limpa é o backend (auth de pareamento incompleta, whatsapp/local.js).
    requestWAPairingCode.mockResolvedValue({
      ok: true, code: "ABCD1234", formatted: "ABCD-1234",
      phone: "5511999999999", expiresAt: Date.now() + 5_000,
    });
    await abrirModoCodigo();
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText("(11) 99999-9999"), { target: { value: "(11) 99999-9999" } });
      fireEvent.click(screen.getByText("Gerar código"));
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });

    await act(async () => { fireEvent.click(screen.getByText("Gerar novo código")); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });

    expect(deleteWASession).not.toHaveBeenCalled();
    expect(requestWAPairingCode).toHaveBeenCalledTimes(2);
    expect(requestWAPairingCode).toHaveBeenLastCalledWith("num-pair", "5511999999999");
  });

  it("sessão que cai com o código na tela mostra o motivo ali, sem beco sem saída", async () => {
    // O painel genérico "Erro de conexão" esconde os botões de modo, e a única saída
    // seria o link de cancelar. O classifyClose já manda o texto certo pro caso do
    // código — ele aparece junto do botão de gerar outro.
    requestWAPairingCode.mockResolvedValue({
      ok: true, code: "ABCD1234", formatted: "ABCD-1234",
      phone: "5511999999999", expiresAt: Date.now() + 110_000,
    });
    await abrirModoCodigo();
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText("(11) 99999-9999"), { target: { value: "(11) 99999-9999" } });
      fireEvent.click(screen.getByText("Gerar código"));
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });

    getWASession.mockResolvedValue({
      status: "disconnected", qr: null, info: null,
      lastError: "O código não foi usado a tempo. Gere um novo.",
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });

    expect(screen.getByText("O código não foi usado a tempo. Gere um novo.")).toBeTruthy();
    expect(screen.getByText("Gerar novo código")).toBeTruthy();
    expect(screen.queryByText("Erro de conexão")).toBeNull();
    expect(screen.getByText("Código de 8 dígitos")).toBeTruthy();

    // E o código NOVO não pode nascer marcado como morto pelo erro do anterior: o
    // polling está pausado durante o pedido e só traria o estado fresco depois.
    requestWAPairingCode.mockResolvedValue({
      ok: true, code: "WXYZ5678", formatted: "WXYZ-5678",
      phone: "5511999999999", expiresAt: Date.now() + 110_000,
    });
    getWASession.mockResolvedValue({ status: "awaiting_qr", qr: null, info: null, lastError: null });
    await act(async () => { fireEvent.click(screen.getByText("Gerar novo código")); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });

    expect(screen.getByText("WXYZ-5678")).toBeTruthy();
    expect(screen.getByText(/Vincular com número de telefone/)).toBeTruthy();
    expect(screen.queryByText("Gerar novo código")).toBeNull();
  });
});
