// Task: avisar quando o WhatsApp trava em "connecting". A lista mostra só o spinner
// "Conectando..."; quando o BACKEND marca a sessão como `stuck` (reconexão presa
// além da graça ~90s), revela um botão "Reconectar" ao lado. O frontend só lê o
// flag `stuck` — a fonte da verdade é o backend (não depende da tela aberta).
//
// O poll em si mora no App.jsx (um único GET /api/whatsapp/sessions pra app toda);
// esta página recebe `liveStatus`/`stuckIds`/`liveLoaded` prontos por prop.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act, screen } from "@testing-library/react";

vi.mock("../data/api", () => ({
  // errText é helper puro (não faz rede) — usa a implementação de verdade.
  errText: (err, fallback) => err?.message || fallback,
  deleteWASession: vi.fn().mockResolvedValue({ ok: true }),
  deleteWASessionKeepalive: vi.fn(),
}));

import PageWhatsApp from "../pages/WhatsApp.jsx";

const NUM = { id: "111", label: "Num A", phone: "+55 11", status: "connecting" };

function renderPage(live = {}) {
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

// Só o botão de ação "Reconectar" (evita casar o <span> pai que também contém o texto).
const reconnectBtn = () => screen.queryByRole("button", { name: "Reconectar" });

describe("WhatsApp — botão 'Reconectar' vem do flag `stuck` do backend", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("connecting sem stuck → só spinner; com stuck → revela 'Reconectar'", async () => {
    let view;
    await act(async () => {
      view = renderPage({ liveStatus: { 111: "connecting" }, stuckIds: {}, liveLoaded: true });
    });

    expect(screen.getAllByText(/Conectando\.\.\./).length).toBeGreaterThan(0);
    expect(reconnectBtn()).toBeNull(); // backend ainda não marcou stuck

    // Backend passa a reportar stuck=true.
    await act(async () => {
      view.rerender(
        <PageWhatsApp
          numbers={[NUM]}
          setNumbers={vi.fn()}
          whatsappGroups={[]}
          onRemoveNumber={vi.fn()}
          onRelinkNumber={vi.fn()}
          liveStatus={{ 111: "connecting" }}
          stuckIds={{ 111: true }}
          liveLoaded
        />
      );
    });

    expect(reconnectBtn()).not.toBeNull();
    expect(screen.getAllByText(/Conectando\.\.\./).length).toBeGreaterThan(0); // spinner segue
  });
});

// Conexão fantasma na TELA: o número tem status "connected" gravado no estado
// salvo (escrito otimisticamente quando conectou), mas o servidor não tem sessão
// nenhuma pra ele. Enquanto o poll não respondeu, mantemos o status salvo (não
// piscar vermelho no carregamento); depois que respondeu, ausência = desconectado.
describe("WhatsApp — número sem sessão no servidor não pode aparecer conectado", () => {
  const CONECTADO = { id: "222", label: "Num B", phone: "+55 22", status: "connected" };

  const renderB = (props) => render(
    <PageWhatsApp
      numbers={[CONECTADO]}
      setNumbers={vi.fn()}
      whatsappGroups={[]}
      onRemoveNumber={vi.fn()}
      onRelinkNumber={vi.fn()}
      {...props}
    />
  );

  it("antes do primeiro poll → ainda mostra o status salvo", async () => {
    await act(async () => { renderB({ liveStatus: {}, liveLoaded: false }); });
    expect(screen.queryByText("Conectado")).not.toBeNull();
  });

  it("poll carregou e o número não veio → Desconectado", async () => {
    await act(async () => { renderB({ liveStatus: {}, liveLoaded: true }); });
    expect(screen.queryByText("Conectado")).toBeNull();
    expect(screen.queryByText("Desconectado")).not.toBeNull();
  });
});
