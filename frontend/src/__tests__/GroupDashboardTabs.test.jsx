// Abas críticas do GroupDashboard que não estavam cobertas:
// - Fila: reordenar ("Enviar primeiro") e remover item, com persistência via saveGroupQueue
// - Janelas de envio: adicionar/remover janela e salvar
// - Modelos Mensagens: prévia substitui as variáveis pelos dados de exemplo
// Complementa GroupDashboard.test.jsx (header/pausa/banners).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

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
  saveGroupQueue: vi.fn().mockResolvedValue({}),
  approveAllPending: vi.fn(),
  rejectAllPending: vi.fn(),
}));

import { saveGroupQueue } from "../data/api";
import GroupDashboard from "../components/GroupDashboard.jsx";

function makeItem(overrides = {}) {
  return {
    id: overrides.id,
    key: overrides.id,
    name: "Produto",
    store: "Amazon",
    category: "gamer",
    price: 100,
    originalPrice: 200,
    discount: 50,
    link: "https://amzn.to/x",
    ...overrides,
  };
}

function makeGroup(overrides = {}) {
  return {
    id: 1,
    name: "Campanha Teste",
    paused: false,
    categories: ["gamer"],
    whatsappGroupIds: [],
    messageTemplate: "{produto} por {preco}",
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

function renderDashboard(overrides = {}) {
  const { group: groupOver, ...rest } = overrides;
  const props = {
    group: makeGroup(groupOver),
    numbers: [],
    whatsappGroups: [],
    affiliateConfigured: { ml: true, amazon: true, shopee: true },
    affiliateStatus: { ml: { configured: true }, amazon: { configured: true }, shopee: { configured: true } },
    onBack: vi.fn(),
    onUpdate: vi.fn(),
    onDelete: vi.fn(),
    onCreateWhatsappGroup: vi.fn(),
    onDeleteWhatsappGroup: vi.fn(),
    onUpdateWhatsappGroup: vi.fn(),
    onGoToAffiliate: vi.fn(),
    onGoToSettings: vi.fn(),
    ...rest,
  };
  return { props, ...render(<GroupDashboard {...props} />) };
}

beforeEach(() => {
  saveGroupQueue.mockClear();
});

describe("GroupDashboard — aba Fila com itens", () => {
  function renderQueueTab() {
    const out = renderDashboard({
      group: {
        queue: [
          makeItem({ id: "q1", name: "Mouse Gamer" }),
          makeItem({ id: "q2", name: "Teclado Mecânico" }),
        ],
      },
    });
    fireEvent.click(screen.getByRole("button", { name: /Fila/ }));
    return out;
  }

  it("mostra os produtos na ordem, com posição #1 e #2", () => {
    renderQueueTab();
    expect(screen.getByText("Mouse Gamer")).toBeInTheDocument();
    expect(screen.getByText("Teclado Mecânico")).toBeInTheDocument();
    expect(screen.getByText("#1")).toBeInTheDocument();
    expect(screen.getByText("#2")).toBeInTheDocument();
  });

  it("'⬆ Enviar primeiro' só aparece pra quem NÃO é o primeiro da fila", () => {
    renderQueueTab();
    expect(screen.getAllByRole("button", { name: /Enviar primeiro/ })).toHaveLength(1);
  });

  it("'Enviar primeiro' move o item pro topo e persiste a nova ordem", async () => {
    const { props } = renderQueueTab();
    fireEvent.click(screen.getByRole("button", { name: /Enviar primeiro/ }));

    // onUpdate recebe a fila reordenada (Teclado antes do Mouse)
    const call = props.onUpdate.mock.calls.find(([, patch]) => patch.queue);
    expect(call).toBeTruthy();
    expect(call[1].queue.map(i => i.name)).toEqual(["Teclado Mecânico", "Mouse Gamer"]);

    // e persiste no servidor (sem isso o próximo poll reverte a ordem)
    await waitFor(() => expect(saveGroupQueue).toHaveBeenCalledTimes(1));
    const [gid, persisted] = saveGroupQueue.mock.calls[0];
    expect(gid).toBe(1);
    expect(persisted.map(i => i.name)).toEqual(["Teclado Mecânico", "Mouse Gamer"]);
  });

  it("'Remover' pede confirmação e, confirmado, tira o item da fila e persiste", async () => {
    const { props } = renderQueueTab();
    // 2 itens → 2 botões Remover; remove o primeiro (Mouse)
    fireEvent.click(screen.getAllByRole("button", { name: /^Remover$/ })[0]);

    // Abre modal de confirmação — nada mudou ainda
    expect(screen.getByText(/Remover produto da fila\?/)).toBeInTheDocument();
    expect(props.onUpdate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Sim, remover/ }));
    const call = props.onUpdate.mock.calls.find(([, patch]) => patch.queue);
    expect(call[1].queue.map(i => i.name)).toEqual(["Teclado Mecânico"]);
    await waitFor(() => expect(saveGroupQueue).toHaveBeenCalledTimes(1));
  });

  it("'Enviar próximo agora' fica liberado numa campanha com janela e grupo vinculado", () => {
    renderDashboard({
      group: {
        whatsappGroupIds: ["wa-1"],
        queue: [makeItem({ id: "q1", name: "Mouse Gamer" })],
      },
      whatsappGroups: [{ id: "wa-1", name: "Grupo", numberId: "n1", jid: "g@g.us", status: "connected", members: 10 }],
    });
    fireEvent.click(screen.getByRole("button", { name: /Fila/ }));
    expect(screen.getByRole("button", { name: /Enviar próximo agora/ })).toBeEnabled();
  });

  it("sem janela de envio, 'Enviar próximo agora' fica travado e diz o porquê", () => {
    renderDashboard({
      group: {
        whatsappGroupIds: ["wa-1"],
        schedule: { windows: [], cooldownValue: 24, cooldownUnit: "horas" },
        queue: [makeItem({ id: "q1", name: "Mouse Gamer" })],
      },
      whatsappGroups: [{ id: "wa-1", name: "Grupo", numberId: "n1", jid: "g@g.us", status: "connected", members: 10 }],
    });
    fireEvent.click(screen.getByRole("button", { name: /Fila/ }));
    const btn = screen.getByRole("button", { name: /Enviar próximo agora/ });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute("title", expect.stringMatching(/janela de envio/i));
  });

  it("sem janela de envio a campanha se mostra pausada e o aviso leva pra aba Janelas de envio", () => {
    renderDashboard({
      group: {
        whatsappGroupIds: ["wa-1"],
        schedule: { windows: [], cooldownValue: 24, cooldownUnit: "horas" },
      },
      whatsappGroups: [{ id: "wa-1", name: "Grupo", numberId: "n1", jid: "g@g.us", status: "connected", members: 10 }],
    });
    // Selo no cabeçalho e botão de pausa refletindo o estado real
    expect(screen.getByText(/Pausada · sem janela de envio/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Retomar/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Pausar/ })).not.toBeInTheDocument();
    // Faixa de aviso com botão que abre a aba de janelas
    expect(screen.getByText(/pausada porque não tem janela de envio/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Adicionar janela de envio/ }));
    expect(screen.getByText(/Defina os intervalos do dia/)).toBeInTheDocument();
  });

  it("com janela configurada não aparece nem selo nem faixa de 'sem janela'", () => {
    renderDashboard({
      group: { whatsappGroupIds: ["wa-1"] },
      whatsappGroups: [{ id: "wa-1", name: "Grupo", numberId: "n1", jid: "g@g.us", status: "connected", members: 10 }],
    });
    expect(screen.queryByText(/sem janela de envio/)).not.toBeInTheDocument();
    expect(screen.queryByText(/pausada porque não tem janela de envio/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Pausar/ })).toBeInTheDocument();
  });

  it("'Misturar' embaralha e persiste a fila (só aparece com 2+ itens)", async () => {
    const { props } = renderQueueTab();
    fireEvent.click(screen.getByRole("button", { name: /Misturar/ }));

    const call = props.onUpdate.mock.calls.find(([, patch]) => patch.queue);
    expect(call[1].queue.map(i => i.name).sort()).toEqual(["Mouse Gamer", "Teclado Mecânico"]);
    await waitFor(() => expect(saveGroupQueue).toHaveBeenCalledTimes(1));
    expect(saveGroupQueue.mock.calls[0][1]).toHaveLength(2);
  });

  it("'Misturar' não aparece com menos de 2 itens na fila", () => {
    renderDashboard({ group: { queue: [makeItem({ id: "q1", name: "Mouse Gamer" })] } });
    fireEvent.click(screen.getByRole("button", { name: /Fila/ }));
    expect(screen.queryByRole("button", { name: /Misturar/ })).not.toBeInTheDocument();
  });

  it("o envio instantâneo mora na aba Fila do repasse e salva na hora", () => {
    const { props } = renderDashboard({
      group: { scraping: { kind: "repasse", auto: true, sources: [], filters: {} } },
    });
    fireEvent.click(screen.getByRole("button", { name: /Fila/ }));
    fireEvent.click(screen.getByRole("switch", { name: /Envio instantâneo/i }));
    const call = props.onUpdate.mock.calls.find(([, patch]) => patch.scraping?.autoSend === true);
    expect(call).toBeTruthy();
  });

  it("campanha de busca não tem envio instantâneo na Fila", () => {
    renderQueueTab();
    expect(screen.queryByRole("switch", { name: /Envio instantâneo/i })).not.toBeInTheDocument();
  });

  it("'Aguardando revisão' aparece na aba Fila", () => {
    renderDashboard({ group: { pending: [makeItem({ id: "p1", name: "Fone Pendente" })] } });
    fireEvent.click(screen.getByRole("button", { name: /Fila/ }));
    expect(screen.getByText(/Aguardando revisão/)).toBeInTheDocument();
    expect(screen.getByText("Fone Pendente")).toBeInTheDocument();
  });
});

describe("GroupDashboard — aba Janelas de envio", () => {
  function renderScheduleTab(overrides) {
    const out = renderDashboard(overrides);
    fireEvent.click(screen.getByRole("button", { name: /Janelas/ }));
    return out;
  }

  it("mostra a janela existente com horários; dá pra remover até a última", () => {
    renderScheduleTab();
    expect(screen.getByText("Janela 1")).toBeInTheDocument();
    expect(screen.getByDisplayValue("08:00")).toBeInTheDocument();
    expect(screen.getByDisplayValue("22:00")).toBeInTheDocument();
    // Sem janela nenhuma a campanha fica pausada — por isso remover a última é permitido.
    fireEvent.click(screen.getByRole("button", { name: /^Remover$/ }));
    expect(screen.queryByText("Janela 1")).not.toBeInTheDocument();
    expect(screen.getByText(/nenhuma janela de envio/i)).toBeInTheDocument();
  });

  it("botão salvar começa desabilitado (sem alterações)", () => {
    renderScheduleTab();
    expect(screen.getByRole("button", { name: /Salvar configurações/ })).toBeDisabled();
  });

  it("'+ Adicionar janela' cria Janela 2 e habilita salvar; salvar manda as 2 janelas", () => {
    const { props } = renderScheduleTab();
    fireEvent.click(screen.getByRole("button", { name: /Adicionar janela/ }));

    expect(screen.getByText("Janela 2")).toBeInTheDocument();
    // Agora com 2 janelas cada uma pode ser removida
    expect(screen.getAllByRole("button", { name: /^Remover$/ })).toHaveLength(2);

    const saveBtn = screen.getByRole("button", { name: /Salvar configurações/ });
    expect(saveBtn).toBeEnabled();
    fireEvent.click(saveBtn);

    const call = props.onUpdate.mock.calls.find(([, patch]) => patch.schedule);
    expect(call).toBeTruthy();
    expect(call[1].schedule.windows).toHaveLength(2);
  });

  it("editar horário habilita salvar e persiste o novo valor", () => {
    const { props } = renderScheduleTab();
    fireEvent.change(screen.getByDisplayValue("08:00"), { target: { value: "09:30" } });

    const saveBtn = screen.getByRole("button", { name: /Salvar configurações/ });
    expect(saveBtn).toBeEnabled();
    fireEvent.click(saveBtn);

    const call = props.onUpdate.mock.calls.find(([, patch]) => patch.schedule);
    expect(call[1].schedule.windows[0].from).toBe("09:30");
  });
});

describe("GroupDashboard — aba Modelos Mensagens (prévia)", () => {
  function renderMessagesTab(overrides) {
    const out = renderDashboard(overrides);
    fireEvent.click(screen.getByRole("button", { name: /Modelos/ }));
    return out;
  }

  it("prévia substitui as variáveis pelos dados de exemplo", () => {
    renderMessagesTab(); // template: "{produto} por {preco}"
    expect(screen.getByText(/Smartphone Samsung Galaxy A55 256GB por R\$ 1\.899/)).toBeInTheDocument();
  });

  it("editar o template atualiza a prévia na hora", () => {
    const { container } = renderMessagesTab();
    const textarea = container.querySelector("textarea");
    fireEvent.change(textarea, { target: { value: "Só {desconto} na {loja}!" } });
    expect(screen.getByText(/Só 24% na Mercado Livre!/)).toBeInTheDocument();
  });

  it("formatação do WhatsApp: *texto* vira negrito na prévia", () => {
    const { container } = renderMessagesTab({ group: { messageTemplate: "oferta *imperdível* hoje" } });
    const bold = container.querySelector(".wa-preview strong");
    expect(bold).not.toBeNull();
    expect(bold.textContent).toBe("imperdível");
  });

  it("variável desconhecida fica literal na prévia (não vira undefined)", () => {
    const { container } = renderMessagesTab();
    const textarea = container.querySelector("textarea");
    fireEvent.change(textarea, { target: { value: "{produto} {naoexiste}" } });
    // Busca restrita à prévia — o texto cru também existe dentro do editor (textarea)
    const preview = container.querySelector(".wa-preview");
    expect(preview.textContent).toContain("{naoexiste}");
    expect(preview.textContent).toContain("Smartphone Samsung Galaxy A55 256GB");
    expect(preview.textContent).not.toContain("undefined");
  });
});
