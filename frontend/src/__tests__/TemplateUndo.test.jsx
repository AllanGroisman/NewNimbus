// Task 103: Ctrl+Z no editor de modelo de mensagem.
// O undo nativo do textarea não funciona aqui (o React reescreve o value a cada
// clique dos botões de formatar/inserir), então o histórico é nosso —
// frontend/src/data/textHistory.js. Estes testes cobrem o que o usuário faz:
// digitar, clicar nos chips, formatar, desfazer, refazer e trocar de modelo.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("../data/api", () => ({
  errText: (err, fallback) => err?.message || fallback,
  createWAGroup: vi.fn(),
  leaveWAGroup: vi.fn(),
  revokeWAInvite: vi.fn(),
  sendNextNow: vi.fn(),
  loadAppOps: vi.fn().mockResolvedValue({ groups: [] }),
  listWAGroups: vi.fn().mockResolvedValue([]),
  refillQueueNow: vi.fn(),
  clearGroupHistory: vi.fn(),
  approvePendingItem: vi.fn(),
  rejectPendingItem: vi.fn(),
  fetchUrlMetadata: vi.fn(),
  manualAddToQueue: vi.fn(),
  clearGroupQueue: vi.fn(),
  saveGroupQueue: vi.fn().mockResolvedValue({}),
  saveItemCoupon: vi.fn(),
  approveAllPending: vi.fn(),
  rejectAllPending: vi.fn(),
}));

import GroupDashboard from "../components/GroupDashboard.jsx";

function makeGroup(overrides = {}) {
  return {
    id: 1,
    name: "Campanha Teste",
    paused: false,
    categories: ["gamer"],
    whatsappGroupIds: [],
    messageTemplate: "Oferta",
    scraping: { auto: true, sources: ["Amazon"], filters: {} },
    schedule: { windows: [{ id: 1, from: "08:00", to: "22:00", interval: 30 }], cooldownValue: 24, cooldownUnit: "horas" },
    queue: [],
    pending: [],
    history: [],
    sentToday: 0, sentWeek: 0, weekData: [0,0,0,0,0,0,0],
    lastSend: "—", avgDiscount: "—",
    ...overrides,
  };
}

function renderMessagesTab(overrides = {}) {
  const { group: groupOver, ...rest } = overrides;
  const props = {
    group: makeGroup(groupOver),
    numbers: [],
    whatsappGroups: [],
    customTemplates: [],
    affiliateConfigured: { ml: true, amazon: true, shopee: true },
    affiliateStatus: { ml: { configured: true }, amazon: { configured: true }, shopee: { configured: true } },
    onBack: vi.fn(),
    onUpdate: vi.fn(),
    onDelete: vi.fn(),
    onCreateWhatsappGroup: vi.fn(),
    onDeleteWhatsappGroup: vi.fn(),
    onUpdateWhatsappGroup: vi.fn(),
    onAddCustomTemplate: vi.fn(() => "t2"),
    onUpdateCustomTemplate: vi.fn(),
    onDeleteCustomTemplate: vi.fn(),
    onGoToAffiliate: vi.fn(),
    onGoToSettings: vi.fn(),
    ...rest,
  };
  const out = render(<GroupDashboard {...props} />);
  fireEvent.click(screen.getByRole("button", { name: /Modelos/ }));
  return { props, ...out, textarea: out.container.querySelector("textarea") };
}

const undo = (ta) => fireEvent.keyDown(ta, { key: "z", ctrlKey: true });
const redo = (ta) => fireEvent.keyDown(ta, { key: "z", ctrlKey: true, shiftKey: true });

// Cada digitação separada por mais de COALESCE_MS (600ms) vira uma entrada do
// histórico. Sem isso, digitar duas vezes seguidas conta como um lance só.
function typeApart(ta, value) {
  vi.setSystemTime(new Date(Date.now() + 5000));
  fireEvent.change(ta, { target: { value } });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-08-20T12:00:00Z"));
});

describe("Editor de modelo — desfazer/refazer", () => {
  it("Ctrl+Z desfaz o que foi digitado", () => {
    const { textarea } = renderMessagesTab();
    typeApart(textarea, "Oferta nova");
    expect(textarea.value).toBe("Oferta nova");

    undo(textarea);
    expect(textarea.value).toBe("Oferta");
  });

  it("Ctrl+Z desfaz um passo de cada vez", () => {
    const { textarea } = renderMessagesTab();
    typeApart(textarea, "Oferta A");
    typeApart(textarea, "Oferta A B");

    undo(textarea);
    expect(textarea.value).toBe("Oferta A");
    undo(textarea);
    expect(textarea.value).toBe("Oferta");
  });

  it("Ctrl+Z desfaz a variável inserida pelo chip", () => {
    const { textarea } = renderMessagesTab();
    fireEvent.click(screen.getByRole("button", { name: "{produto}" }));
    expect(textarea.value).toContain("{produto}");

    undo(textarea);
    expect(textarea.value).toBe("Oferta");
  });

  it("Ctrl+Z desfaz o botão de formatação (negrito)", () => {
    const { textarea } = renderMessagesTab();
    fireEvent.click(screen.getByRole("button", { name: "B" }));
    expect(textarea.value).not.toBe("Oferta");

    undo(textarea);
    expect(textarea.value).toBe("Oferta");
  });

  it("Ctrl+Shift+Z refaz o que foi desfeito", () => {
    const { textarea } = renderMessagesTab();
    typeApart(textarea, "Oferta nova");
    undo(textarea);
    expect(textarea.value).toBe("Oferta");

    redo(textarea);
    expect(textarea.value).toBe("Oferta nova");
  });

  it("digitar depois de desfazer descarta o refazer", () => {
    const { textarea } = renderMessagesTab();
    typeApart(textarea, "Oferta nova");
    undo(textarea);
    typeApart(textarea, "Outra coisa");

    redo(textarea);
    expect(textarea.value).toBe("Outra coisa");
  });

  it("Ctrl+Z sem histórico não muda nada nem quebra", () => {
    const { textarea } = renderMessagesTab();
    undo(textarea);
    expect(textarea.value).toBe("Oferta");
  });

  it("trocar de modelo zera o histórico — Ctrl+Z não ressuscita o texto anterior", () => {
    const { textarea, container } = renderMessagesTab({
      customTemplates: [{ id: "t1", name: "Meu modelo", template: "Texto salvo" }],
    });
    typeApart(textarea, "Oferta editada");
    fireEvent.change(container.querySelector("select"), { target: { value: "custom:t1" } });
    expect(textarea.value).toBe("Texto salvo");

    undo(textarea);
    expect(textarea.value).toBe("Texto salvo");
  });

  it("a prévia acompanha o desfazer", () => {
    const { textarea, container } = renderMessagesTab({ group: { messageTemplate: "Só {loja}" } });
    typeApart(textarea, "Só {desconto}");
    expect(container.querySelector(".wa-preview").textContent).toContain("24%");

    undo(textarea);
    expect(container.querySelector(".wa-preview").textContent).toContain("Mercado Livre");
  });
});
