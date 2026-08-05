// Travas de loja no lado do usuário: helpers de constants, cadeado no sidebar
// e chip de fonte bloqueado dentro da campanha.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { storeLockMessage, unlockedSources, allSources } from "../data/constants";

vi.mock("../data/api", () => ({
  // errText é helper puro (não faz rede) — usa a implementação de verdade.
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
  saveGroupQueue: vi.fn(),
  approveAllPending: vi.fn(),
  rejectAllPending: vi.fn(),
  browseCatalog: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 24 }),
}));

import Sidebar from "../components/Sidebar.jsx";
import GroupDashboard from "../components/GroupDashboard.jsx";
import StoreLockedNotice from "../components/ui/StoreLockedNotice.jsx";

const LOCKED_SHOPEE = { shopee: { locked: true, message: "Shopee volta em breve" } };

describe("constants — helpers de trava", () => {
  it("storeLockMessage aceita id e label da loja", () => {
    expect(storeLockMessage(LOCKED_SHOPEE, "shopee")).toBe("Shopee volta em breve");
    expect(storeLockMessage(LOCKED_SHOPEE, "Shopee")).toBe("Shopee volta em breve");
  });

  it("loja liberada (ou ausente do mapa) devolve null", () => {
    expect(storeLockMessage(LOCKED_SHOPEE, "Mercado Livre")).toBe(null);
    expect(storeLockMessage({ ml: { locked: false, message: "x" } }, "ml")).toBe(null);
    expect(storeLockMessage({}, "amazon")).toBe(null);
    expect(storeLockMessage(undefined, "amazon")).toBe(null);
  });

  it("unlockedSources tira só as trancadas", () => {
    expect(unlockedSources(LOCKED_SHOPEE)).toEqual(["Mercado Livre", "Amazon"]);
    expect(unlockedSources({})).toEqual(allSources);
  });
});

describe("Sidebar — aba de loja trancada", () => {
  const props = {
    page: "dashboard",
    selectedGroup: null,
    groups: [],
    whatsappGroups: [],
    numbers: [],
    affiliateStatus: { ml: true, amazon: true, shopee: true },
    user: { role: "user" },
    onNavigate: vi.fn(),
    onSelectGroup: vi.fn(),
    onLogout: vi.fn(),
    mobileOpen: false,
    onToggleMobile: vi.fn(),
  };

  it("mostra cadeado na aba da loja trancada e não nas outras", () => {
    render(<Sidebar {...props} storeLocks={LOCKED_SHOPEE} />);
    const shopeeBtn = screen.getAllByRole("button", { name: /Shopee/ })[0];
    expect(shopeeBtn.textContent).toContain("🔒");
    const mlBtn = screen.getAllByRole("button", { name: /Mercado Livre/ })[0];
    expect(mlBtn.textContent).not.toContain("🔒");
  });

  it("sem travas, nenhuma aba tem cadeado", () => {
    render(<Sidebar {...props} storeLocks={{}} />);
    const shopeeBtn = screen.getAllByRole("button", { name: /Shopee/ })[0];
    expect(shopeeBtn.textContent).not.toContain("🔒");
  });

  it("a aba trancada continua clicável (leva pra tela com a mensagem)", () => {
    const onNavigate = vi.fn();
    render(<Sidebar {...props} onNavigate={onNavigate} storeLocks={LOCKED_SHOPEE} />);
    fireEvent.click(screen.getAllByRole("button", { name: /Shopee/ })[0]);
    expect(onNavigate).toHaveBeenCalledWith("shopee");
  });
});

describe("StoreLockedNotice", () => {
  it("mostra a mensagem vinda do admin", () => {
    render(<StoreLockedNotice storeLabel="Shopee" message="Shopee volta em breve" />);
    expect(screen.getByText("Shopee volta em breve")).toBeInTheDocument();
    expect(screen.getByText(/Shopee indisponível/)).toBeInTheDocument();
  });
});

describe("GroupDashboard — fonte de loja trancada", () => {
  // As lojas da campanha de busca ficam na aba "Busca de Produtos" (no repasse
  // elas seguem na aba Gerenciar).
  function makeGroup(overrides = {}) {
    return {
      id: 1,
      name: "Campanha Teste",
      paused: false,
      categories: ["gamer"],
      whatsappGroupIds: [],
      messageTemplate: "{produto} por {preco}",
      scraping: { auto: true, sources: ["Mercado Livre"], filters: {} },
      schedule: { windows: [{ from: "08:00", to: "22:00", interval: 30 }], cooldownValue: 24, cooldownUnit: "horas" },
      queue: [], pending: [], history: [],
      sentToday: 0, sentWeek: 0, weekData: [0, 0, 0, 0, 0, 0, 0],
      lastSend: "—", avgDiscount: "—",
      ...overrides,
    };
  }

  function renderSourcesTab(storeLocks, groupOver = {}) {
    const props = {
      group: makeGroup(groupOver),
      numbers: [],
      whatsappGroups: [],
      affiliateConfigured: { ml: true, amazon: true, shopee: true },
      affiliateStatus: { ml: { configured: true }, amazon: { configured: true }, shopee: { configured: true } },
      storeLocks,
      onBack: vi.fn(), onUpdate: vi.fn(), onDelete: vi.fn(),
      onCreateWhatsappGroup: vi.fn(), onDeleteWhatsappGroup: vi.fn(), onUpdateWhatsappGroup: vi.fn(),
      onGoToAffiliate: vi.fn(), onGoToSettings: vi.fn(),
    };
    const utils = render(<GroupDashboard {...props} />);
    fireEvent.click(screen.getByRole("button", { name: /Busca de Produtos/i }));
    return { props, ...utils };
  }

  it("chip da loja trancada mostra cadeado e não entra na campanha ao clicar", () => {
    const { props } = renderSourcesTab(LOCKED_SHOPEE);
    const chip = screen.getByRole("button", { name: /🔒 Shopee/ });
    fireEvent.click(chip);
    // Abre a explicação em vez de selecionar
    expect(screen.getByText("Shopee volta em breve")).toBeInTheDocument();
    expect(props.onUpdate).not.toHaveBeenCalled();
  });

  it("campanha que já usa a loja trancada mostra aviso de que ela é ignorada", () => {
    renderSourcesTab(LOCKED_SHOPEE, { scraping: { auto: true, sources: ["Mercado Livre", "Shopee"], filters: {} } });
    expect(screen.getByText(/ignorada e a campanha segue buscando nas outras/i)).toBeInTheDocument();
  });

  it("sem travas, o chip alterna normalmente", () => {
    renderSourcesTab({});
    expect(screen.queryByText(/🔒 Shopee/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Shopee" }));
    expect(screen.getByRole("button", { name: "✓ Shopee" })).toBeInTheDocument();
  });
});
