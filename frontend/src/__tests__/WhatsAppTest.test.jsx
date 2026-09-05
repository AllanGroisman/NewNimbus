// Task 35: botão "Testar" no card de cada número conectado. O backend dispara
// duas mensagens de verdade — uma do próprio número pra ele mesmo (prova que a
// sessão está ENVIANDO, coisa que o status "Conectado" da tela não prova) e uma
// DM do WhatsNimbus — e devolve o veredito de cada perna. Aqui checamos a UI:
// o botão só existe em card conectado, o estado de carregando, e as duas linhas
// de resultado (inclusive a perna pulada, que NÃO é falha).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act, screen, fireEvent } from "@testing-library/react";

vi.mock("../data/api", () => ({
  // errText é helper puro (não faz rede) — usa a implementação de verdade.
  errText: (err, fallback) => err?.message || fallback,
  deleteWASession: vi.fn().mockResolvedValue({ ok: true }),
  deleteWASessionKeepalive: vi.fn(),
  testWASession: vi.fn(),
}));

import { testWASession } from "../data/api";
import PageWhatsApp from "../pages/WhatsApp.jsx";

const NUM = { id: "5511999999999", label: "Num A", phone: "+5511999999999", status: "connected" };

function renderPage(live = { liveStatus: { [NUM.id]: "connected" }, stuckIds: {}, liveLoaded: true }) {
  return render(
    <PageWhatsApp
      numbers={[NUM]}
      setNumbers={vi.fn()}
      whatsappGroups={[]}
      onRemoveNumber={vi.fn()}
      onRelinkNumber={vi.fn()}
      {...live}
    />
  );
}

const testBtn = () => screen.queryByRole("button", { name: "Testar" });

describe("WhatsApp — botão 'Testar'", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("aparece só no card conectado", async () => {
    await act(async () => { renderPage(); });
    expect(testBtn()).not.toBeNull();
  });

  it("não aparece em número desconectado nem conectando", async () => {
    let view;
    await act(async () => {
      view = renderPage({ liveStatus: { [NUM.id]: "disconnected" }, stuckIds: {}, liveLoaded: true });
    });
    expect(testBtn()).toBeNull();

    await act(async () => {
      view.rerender(
        <PageWhatsApp
          numbers={[NUM]} setNumbers={vi.fn()} whatsappGroups={[]}
          onRemoveNumber={vi.fn()} onRelinkNumber={vi.fn()}
          liveStatus={{ [NUM.id]: "connecting" }} stuckIds={{}} liveLoaded
        />
      );
    });
    expect(testBtn()).toBeNull();
  });

  it("as duas pernas passam → duas linhas de ok", async () => {
    testWASession.mockResolvedValue({ ok: true, self: { ok: true }, whatsnimbus: { ok: true } });
    await act(async () => { renderPage(); });

    await act(async () => { fireEvent.click(testBtn()); });

    expect(testWASession).toHaveBeenCalledWith(NUM.id);
    expect(screen.getByText(/Envio pelo próprio número: ok/)).toBeTruthy();
    expect(screen.getByText(/DM do WhatsNimbus: ok/)).toBeTruthy();
  });

  it("aparelho pediu reenvio → o card avisa em vez de fingir sucesso", async () => {
    testWASession.mockResolvedValue({
      ok: true,
      self: { ok: true, retried: true, retries: 1, deliveryKnown: true },
      whatsnimbus: { ok: true },
    });
    await act(async () => { renderPage(); });
    await act(async () => { fireEvent.click(testBtn()); });

    expect(screen.getByText(/não conseguiu ler a mensagem de primeira/)).toBeTruthy();
  });

  it("sem pedido de reenvio → diz que entregou", async () => {
    testWASession.mockResolvedValue({
      ok: true,
      self: { ok: true, retried: false, retries: 0, deliveryKnown: true },
      whatsnimbus: { ok: true },
    });
    await act(async () => { renderPage(); });
    await act(async () => { fireEvent.click(testBtn()); });

    expect(screen.getByText(/entregue, sem pedido de reenvio/)).toBeTruthy();
  });

  it("sem informação de entrega → não afirma nada sobre o aparelho", async () => {
    testWASession.mockResolvedValue({
      ok: true,
      self: { ok: true, deliveryKnown: false },
      whatsnimbus: { ok: true },
    });
    await act(async () => { renderPage(); });
    await act(async () => { fireEvent.click(testBtn()); });

    expect(screen.queryByText(/entregue, sem pedido de reenvio/)).toBeNull();
    expect(screen.queryByText(/não conseguiu ler a mensagem/)).toBeNull();
  });

  it("mostra 'Testando...' e desabilita o botão enquanto roda", async () => {
    let resolve;
    testWASession.mockReturnValue(new Promise(r => { resolve = r; }));
    await act(async () => { renderPage(); });

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Testar" })); });

    const busy = screen.getByRole("button", { name: /Testando/ });
    expect(busy.disabled).toBe(true);

    await act(async () => {
      resolve({ ok: true, self: { ok: true }, whatsnimbus: { ok: true } });
    });
    expect(screen.queryByRole("button", { name: /Testando/ })).toBeNull();
  });

  it("WhatsNimbus não conectado é informativo — não vira falha", async () => {
    testWASession.mockResolvedValue({
      ok: true,
      self: { ok: true },
      whatsnimbus: { ok: false, skipped: true, error: "WhatsNimbus não está conectado." },
    });
    await act(async () => { renderPage(); });
    await act(async () => { fireEvent.click(testBtn()); });

    expect(screen.getByText(/Envio pelo próprio número: ok/)).toBeTruthy();
    expect(screen.getByText(/DM do WhatsNimbus: WhatsNimbus não está conectado/)).toBeTruthy();
  });

  it("perna do próprio número falhando → mostra a mensagem do servidor", async () => {
    testWASession.mockResolvedValue({
      ok: false,
      self: { ok: false, error: "Sessão não está conectada (status: disconnected)." },
      whatsnimbus: { ok: true },
    });
    await act(async () => { renderPage(); });
    await act(async () => { fireEvent.click(testBtn()); });

    expect(screen.getByText(/Envio pelo próprio número: Sessão não está conectada/)).toBeTruthy();
    expect(screen.getByText(/DM do WhatsNimbus: ok/)).toBeTruthy();
  });

  it("requisição inteira falhando (ex.: cooldown 429) → mostra o erro e nada mais", async () => {
    testWASession.mockRejectedValue(new Error("Aguarde 42s antes de testar este número de novo."));
    await act(async () => { renderPage(); });
    await act(async () => { fireEvent.click(testBtn()); });

    expect(screen.getByText(/Aguarde 42s antes de testar/)).toBeTruthy();
    expect(screen.queryByText(/Envio pelo próprio número/)).toBeNull();
    // Botão volta ao normal — dá pra tentar de novo depois do cooldown.
    expect(testBtn()).not.toBeNull();
  });

  it("o × fecha o resultado", async () => {
    testWASession.mockResolvedValue({ ok: true, self: { ok: true }, whatsnimbus: { ok: true } });
    await act(async () => { renderPage(); });
    await act(async () => { fireEvent.click(testBtn()); });
    expect(screen.getByText(/Envio pelo próprio número: ok/)).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Fechar resultado do teste" }));
    });
    expect(screen.queryByText(/Envio pelo próprio número/)).toBeNull();
  });
});
