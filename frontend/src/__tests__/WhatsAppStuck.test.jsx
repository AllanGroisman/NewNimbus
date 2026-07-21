// Task: avisar quando o WhatsApp trava em "connecting". A lista mostra só o spinner
// "Conectando..."; quando o BACKEND marca a sessão como `stuck` (reconexão presa
// além da graça ~90s), revela um botão "Reconectar" ao lado. O frontend só lê o
// flag `stuck` do poll — a fonte da verdade é o backend (não depende da tela aberta).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, screen } from "@testing-library/react";

vi.mock("../data/api", () => ({
  listWASessions: vi.fn(),
  deleteWASession: vi.fn().mockResolvedValue({ ok: true }),
}));

import { listWASessions } from "../data/api";
import PageWhatsApp from "../pages/WhatsApp.jsx";

function renderPage() {
  return render(
    <PageWhatsApp
      numbers={[{ id: "111", label: "Num A", phone: "+55 11", status: "connecting" }]}
      setNumbers={vi.fn()}
      whatsappGroups={[]}
      onRemoveNumber={vi.fn()}
      onRelinkNumber={vi.fn()}
    />
  );
}

// Só o botão de ação "Reconectar" (evita casar o <span> pai que também contém o texto).
const reconnectBtn = () => screen.queryByRole("button", { name: "Reconectar" });

describe("WhatsApp — botão 'Reconectar' vem do flag `stuck` do backend", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });
  afterEach(() => { vi.useRealTimers(); });

  it("connecting sem stuck → só spinner; com stuck → revela 'Reconectar'", async () => {
    listWASessions.mockResolvedValue([{ numberId: "111", status: "connecting", stuck: false }]);
    await act(async () => { renderPage(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });

    expect(screen.getAllByText(/Conectando\.\.\./).length).toBeGreaterThan(0);
    expect(reconnectBtn()).toBeNull(); // backend ainda não marcou stuck

    // Backend passa a reportar stuck=true; próximo poll (8s) revela o botão.
    listWASessions.mockResolvedValue([{ numberId: "111", status: "connecting", stuck: true }]);
    await act(async () => { await vi.advanceTimersByTimeAsync(8000); });

    expect(reconnectBtn()).not.toBeNull();
    expect(screen.getAllByText(/Conectando\.\.\./).length).toBeGreaterThan(0); // spinner segue
  });
});
