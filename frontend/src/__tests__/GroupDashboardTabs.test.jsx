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
  saveItemCoupon: vi.fn(),
  approveAllPending: vi.fn(),
  rejectAllPending: vi.fn(),
}));

import { saveGroupQueue, saveItemCoupon } from "../data/api";
import GroupDashboard from "../components/GroupDashboard.jsx";
import { DEFAULT_MESSAGE_TEMPLATE, CLASSIC_MESSAGE_TEMPLATE, LEGACY_DEFAULT_MESSAGE_TEMPLATE } from "../data/mockData";

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
  // A aba aberta é lembrada por grupo no navegador: sem limpar, um teste que
  // abriu a Fila faz o seguinte começar nela em vez da visão geral.
  localStorage.clear();
});

// "Na fila" é um número só em todo lugar: fila + aguardando revisão. É o buffer
// que o backend usa pro teto e pro limiar do preenchimento — separar os dois na
// tela dava "Fila (0)" com produtos parados esperando aprovação.
describe("GroupDashboard — a fila conta os que aguardam revisão", () => {
  it("a aba Fila soma os pendentes no número", () => {
    renderDashboard({ group: {
      queue: [makeItem({ id: "q1" }), makeItem({ id: "q2" })],
      pending: [makeItem({ id: "p1" })],
    } });
    expect(screen.getByRole("button", { name: /Fila \(3\)/ })).toBeInTheDocument();
  });

  it("o card da visão geral mostra o total sobre o máximo, com a quebra embaixo", () => {
    renderDashboard({ group: {
      queue: [makeItem({ id: "q1" }), makeItem({ id: "q2" })],
      pending: [makeItem({ id: "p1" })],
      scraping: { auto: true, sources: ["Amazon"], filters: {}, batchSize: 10 },
    } });
    expect(screen.getByText("3 de 10")).toBeInTheDocument();
    expect(screen.getByText("1 aguardando revisão")).toBeInTheDocument();
  });

  it("sem máximo escolhido, usa o padrão de 20", () => {
    renderDashboard({ group: { queue: [makeItem({ id: "q1" })] } });
    expect(screen.getByRole("button", { name: /Fila \(1\)/ })).toBeInTheDocument();
    expect(screen.getByText("1 de 20")).toBeInTheDocument();
  });
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

  it("no toque o card não arrasta: ↑ ↓ reordenam a fila e persistem", async () => {
    const original = window.matchMedia;
    window.matchMedia = (q) => ({ matches: q === "(pointer: coarse)", media: q, addEventListener() {}, removeEventListener() {} });
    try {
      const { props } = renderQueueTab();
      expect(screen.queryByText(/Arraste os cards/)).toBeNull();
      expect(screen.getAllByRole("button", { name: "Subir uma posição" })[0]).toBeDisabled();
      expect(screen.getAllByRole("button", { name: "Descer uma posição" })[1]).toBeDisabled();

      fireEvent.click(screen.getAllByRole("button", { name: "Descer uma posição" })[0]);
      const call = props.onUpdate.mock.calls.find(([, patch]) => patch.queue);
      expect(call[1].queue.map(i => i.name)).toEqual(["Teclado Mecânico", "Mouse Gamer"]);
      await waitFor(() => expect(saveGroupQueue).toHaveBeenCalledTimes(1));
    } finally {
      window.matchMedia = original;
    }
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

// Task 91: o cupom capturado no repasse não aparecia em lugar nenhum antes do
// envio, e não dava pra corrigir um código errado sem descartar o produto.
describe("GroupDashboard — cupom na fila e na revisão", () => {
  beforeEach(() => {
    saveItemCoupon.mockReset();
    saveItemCoupon.mockImplementation(async (_gid, _list, _id, coupon) => ({
      ok: true, coupon: coupon ? coupon.toUpperCase() : null,
    }));
  });

  function renderWithCoupon(overrides = {}) {
    const out = renderDashboard({ group: overrides });
    fireEvent.click(screen.getByRole("button", { name: /Fila/ }));
    return out;
  }

  it("mostra o cupom do item no card da fila", () => {
    renderWithCoupon({ queue: [makeItem({ id: "q1", name: "Mouse Gamer", coupon: "JBL20" })] });
    expect(screen.getByText("JBL20")).toBeInTheDocument();
  });

  it("editar e salvar manda só o cupom daquele item pro servidor", async () => {
    const { props } = renderWithCoupon({ queue: [makeItem({ id: "q1", name: "Mouse Gamer", coupon: "JBL20" })] });
    fireEvent.click(screen.getByRole("button", { name: "✎" }));
    fireEvent.change(screen.getByLabelText("Cupom"), { target: { value: "novo10" } });
    fireEvent.click(screen.getByRole("button", { name: "✓" }));

    await waitFor(() => expect(saveItemCoupon).toHaveBeenCalledTimes(1));
    expect(saveItemCoupon).toHaveBeenCalledWith(1, "queue", "q1", "NOVO10");
    // A fila do App também acompanha, senão o card volta ao valor velho no re-render.
    const call = props.onUpdate.mock.calls.reverse().find(([, patch]) => patch.queue);
    expect(call[1].queue[0].coupon).toBe("NOVO10");
    await waitFor(() => expect(screen.getByText("NOVO10")).toBeInTheDocument());
  });

  it("o 🗑 apaga o cupom (salva vazio)", async () => {
    renderWithCoupon({ queue: [makeItem({ id: "q1", name: "Mouse Gamer", coupon: "JBL20" })] });
    fireEvent.click(screen.getByRole("button", { name: "✎" }));
    fireEvent.click(screen.getByRole("button", { name: "🗑" }));
    await waitFor(() => expect(saveItemCoupon).toHaveBeenCalledWith(1, "queue", "q1", ""));
  });

  it("item sem cupom mostra o campo vazio e deixa escrever um à mão", async () => {
    renderWithCoupon({ queue: [makeItem({ id: "q1", name: "Mouse Gamer" })] });
    fireEvent.click(screen.getByRole("button", { name: "✎" }));
    // Sem cupom não tem o que apagar — o 🗑 só aparece depois que existe um código.
    expect(screen.queryByRole("button", { name: "🗑" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Cupom"), { target: { value: "PROMO15" } });
    fireEvent.click(screen.getByRole("button", { name: "✓" }));
    await waitFor(() => expect(saveItemCoupon).toHaveBeenCalledWith(1, "queue", "q1", "PROMO15"));
  });

  it("na revisão de pendentes o cupom aparece e salva na lista certa", async () => {
    renderWithCoupon({ pending: [makeItem({ id: "p1", name: "Pendente A", coupon: "TECH-10" })] });
    fireEvent.click(screen.getByRole("button", { name: /TECH-10/ }));
    fireEvent.change(screen.getByLabelText("Cupom"), { target: { value: "BLACK25" } });
    fireEvent.click(screen.getByRole("button", { name: "✓" }));
    await waitFor(() => expect(saveItemCoupon).toHaveBeenCalledWith(1, "pending", "p1", "BLACK25"));
  });

  it("quando o servidor recusa, avisa e devolve o cupom antigo", async () => {
    // Erro sem mensagem própria — o errText do mock cai no texto de fallback.
    saveItemCoupon.mockRejectedValue(new Error(""));
    renderWithCoupon({ queue: [makeItem({ id: "q1", name: "Mouse Gamer", coupon: "JBL20" })] });
    fireEvent.click(screen.getByRole("button", { name: "✎" }));
    fireEvent.change(screen.getByLabelText("Cupom"), { target: { value: "NOVO10" } });
    fireEvent.click(screen.getByRole("button", { name: "✓" }));

    await waitFor(() => expect(screen.getByText(/Não foi possível salvar o cupom/)).toBeInTheDocument());
    // A edição segue aberta pra tentar de novo, com o valor digitado no campo.
    expect(screen.getByLabelText("Cupom")).toHaveValue("NOVO10");
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

  it("não tem mais campo de cupom fixo da campanha", () => {
    renderMessagesTab();
    expect(screen.queryByText(/Cupom fixo da campanha/)).toBeNull();
  });

  // A prévia usa o mesmo algoritmo do envio (src/data/messageTemplate.js, conferido
  // contra o scheduler.js em tests/unit/template-parity.test.js) — inclusive os
  // centavos, que antes a prévia não mostrava.
  it("{preco_com_cupom} mostra o preço com o desconto do cupom, com centavos", () => {
    const { container } = renderMessagesTab({
      group: { scraping: { kind: "repasse", sources: ["Mercado Livre"], filters: {} }, messageTemplate: "Com cupom: {preco_com_cupom}" },
    });
    expect(container.querySelector(".wa-preview").textContent).toContain("Com cupom: R$ 1.709,10");
  });

  // Campanha de busca também herda cupom do catálogo do ML no envio — a prévia
  // não pode mais esconder o cupom só por ser busca.
  it("campanha de busca mostra o cupom na prévia (o cupom vem ligado)", () => {
    const { container } = renderMessagesTab({ group: { messageTemplate: "Cupom: {cupom}" } });
    expect(container.querySelector(".wa-preview").textContent).toContain("Cupom: GALAXY10");
  });

  it("desligar o Cupom: some a linha do {cupom}, e a do {preco_com_cupom} some se o {preco} já aparece", () => {
    const { container } = renderMessagesTab({ group: { messageTemplate: "Por: {preco}\nCupom: {cupom}\nCom cupom: {preco_com_cupom}" } });
    fireEvent.click(screen.getByRole("switch", { name: "Simular item com cupom na prévia" }));
    const preview = container.querySelector(".wa-preview").textContent;
    expect(preview).toContain("Por: R$ 1.899,00");
    expect(preview).not.toContain("Cupom:");
    expect(preview).not.toContain("Com cupom:");
  });

  it("desligar o Cupom com {preco_com_cupom} como único preço: ele vira o preço normal", () => {
    const { container } = renderMessagesTab({ group: { messageTemplate: "Sai por: {preco_com_cupom}" } });
    fireEvent.click(screen.getByRole("switch", { name: "Simular item com cupom na prévia" }));
    expect(container.querySelector(".wa-preview").textContent).toContain("Sai por: R$ 1.899,00");
  });

  it("desligar a Promoção: somem as linhas de {preco_antigo}, {desconto} e {economia}", () => {
    const { container } = renderMessagesTab({ group: { messageTemplate: "De {preco_antigo}\nPor {preco}\n{desconto} OFF\nEconomize {economia}" } });
    expect(container.querySelector(".wa-preview").textContent).toContain("Economize R$ 600,00");
    fireEvent.click(screen.getByRole("switch", { name: "Simular item com promoção na prévia" }));
    const preview = container.querySelector(".wa-preview").textContent;
    expect(preview).toContain("Por R$ 1.899,00");
    expect(preview).not.toContain("De ");
    expect(preview).not.toContain("OFF");
    expect(preview).not.toContain("Economize");
  });

  it("{todos} aparece como @todos na prévia", () => {
    const { container } = renderMessagesTab({ group: { messageTemplate: "Oferta!\n{todos}" } });
    expect(container.querySelector(".wa-preview").textContent).toContain("@todos");
    expect(container.querySelector(".wa-preview").textContent).not.toContain("{todos}");
  });

  it("o chip {preco_com_cupom} insere a variável no editor", () => {
    const { container } = renderMessagesTab({ group: { messageTemplate: "" } });
    fireEvent.click(screen.getByRole("button", { name: "{preco_com_cupom}" }));
    expect(container.querySelector("textarea").value).toContain("{preco_com_cupom}");
  });
});

describe("GroupDashboard — aba Modelos Mensagens (imagem do modelo)", () => {
  const scrapingBase = { auto: true, sources: ["Amazon"], filters: {} };
  const comPrevia = { id: "tl", name: "Com prévia", template: "{produto} {link}", imageMode: "link" };

  function renderMessagesTab(overrides = {}) {
    const out = renderDashboard({
      customTemplates: [comPrevia],
      onAddCustomTemplate: vi.fn(() => "t2"),
      onUpdateCustomTemplate: vi.fn(),
      onDeleteCustomTemplate: vi.fn(),
      ...overrides,
    });
    fireEvent.click(screen.getByRole("button", { name: /Modelos/ }));
    return out;
  }
  const escolherModelo = (container, key) =>
    fireEvent.change(container.querySelector("select"), { target: { value: key } });
  const radio = (name) => screen.getByRole("radio", { name });

  it("modelo padrão é foto do produto, e a prévia mostra a foto", () => {
    renderMessagesTab({ group: { messageTemplate: "{produto} {link}" } });
    expect(radio("Foto do produto")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("preview-photo")).toBeInTheDocument();
    expect(screen.queryByTestId("preview-link-card")).toBeNull();
  });

  it("abrir um modelo salvo com prévia do link traz a escolha dele", () => {
    const { container } = renderMessagesTab();
    escolherModelo(container, "custom:tl");
    expect(radio("Prévia do link")).toHaveAttribute("aria-checked", "true");
    const card = screen.getByTestId("preview-link-card");
    expect(card.textContent).toContain("Smartphone Samsung Galaxy A55 256GB");
    expect(card.textContent).toContain("merc.li");
  });

  it("trocar a imagem é edição do modelo: não salva na campanha, deixa o modelo com alteração", () => {
    const { props, container } = renderMessagesTab({ group: { messageTemplate: "{produto} {link}", scraping: { ...scrapingBase, imageMode: "link" } } });
    expect(screen.getByRole("button", { name: "Salvar" })).toBeDisabled();
    fireEvent.click(radio("Foto do produto"));
    expect(props.onUpdate).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Salvar" })).not.toBeDisabled();
    expect(container.querySelector("select").selectedOptions[0].textContent).toMatch(/^• /);
  });

  it("Salvar grava a imagem no modelo", () => {
    const { props, container } = renderMessagesTab();
    escolherModelo(container, "custom:tl");
    fireEvent.click(radio("Foto do produto"));
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    expect(props.onUpdateCustomTemplate).toHaveBeenCalledWith("tl", { name: "Com prévia", template: "{produto} {link}", imageMode: "product" });
  });

  it("Salvar Como leva a imagem escolhida pro modelo novo", () => {
    const { props } = renderMessagesTab();
    fireEvent.click(radio("Prévia do link"));
    fireEvent.click(screen.getByRole("button", { name: "Salvar Como" }));
    fireEvent.change(screen.getByPlaceholderText(/minha versão/), { target: { value: "Com cartão" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar como novo" }));
    expect(props.onAddCustomTemplate).toHaveBeenCalledWith("Com cartão", "{produto} por {preco}", "link");
  });

  it("ativar o modelo leva a imagem dele pra campanha", () => {
    const { props, container } = renderMessagesTab();
    escolherModelo(container, "custom:tl");
    fireEvent.click(screen.getByRole("button", { name: "Ativar este modelo" }));
    expect(props.onUpdate).toHaveBeenCalledWith(1, {
      messageTemplate: "{produto} {link}",
      scraping: { ...scrapingBase, imageMode: "link" },
    });
  });

  it("'em uso' casa texto e imagem: mesmo texto com outra imagem não é o modelo em uso", () => {
    const { container } = renderMessagesTab({ group: { messageTemplate: "{produto} {link}", scraping: scrapingBase } });
    escolherModelo(container, "custom:tl");
    expect(screen.getByRole("button", { name: "Ativar este modelo" })).not.toBeDisabled();
  });

  // O padrão antigo virou o preset "Clássico". Campanhas criadas com ele (com ou
  // sem a linha do cupom) abrem nele, em uso e sem "•" — o texto delas não muda.
  it.each([
    ["com a linha do cupom", CLASSIC_MESSAGE_TEMPLATE],
    ["sem a linha do cupom (o que 'Nova campanha' gravava)", LEGACY_DEFAULT_MESSAGE_TEMPLATE],
  ])("campanha no padrão antigo %s abre como Clássico em uso, sem alteração", (_, texto) => {
    const { container } = renderMessagesTab({ group: { messageTemplate: texto, scraping: scrapingBase } });
    const select = container.querySelector("select");
    expect(select.value).toBe("preset:classic");
    expect(select.selectedOptions[0].textContent).toBe("Clássico — em uso");
    expect(screen.getByRole("button", { name: /Ativo na campanha/ })).toBeInTheDocument();
    // O editor mostra o texto que a campanha realmente envia.
    expect(container.querySelector("textarea").value).toBe(texto);
  });

  it("campanha nova (padrão do código) abre no Padrão em uso, sem alteração", () => {
    const { container } = renderMessagesTab({ group: { messageTemplate: DEFAULT_MESSAGE_TEMPLATE, scraping: scrapingBase } });
    const select = container.querySelector("select");
    expect(select.value).toBe("preset:default");
    expect(select.selectedOptions[0].textContent).toBe("Padrão — em uso");
  });

  it("campanha com prévia do link abre no modelo que casa texto e imagem", () => {
    renderMessagesTab({ group: { messageTemplate: "{produto} {link}", scraping: { ...scrapingBase, imageMode: "link" } } });
    expect(screen.getByRole("button", { name: /Ativo na campanha/ })).toBeInTheDocument();
    expect(radio("Prévia do link")).toHaveAttribute("aria-checked", "true");
  });

  it("prévia do link sem {link} no texto: avisa e a prévia mostra a foto", () => {
    const { container } = renderMessagesTab();
    fireEvent.click(radio("Prévia do link"));
    fireEvent.change(container.querySelector("textarea"), { target: { value: "{produto} por {preco}" } });
    expect(screen.getByText(/Sem \{link\} no texto, vai a foto do produto/)).toBeInTheDocument();
    expect(screen.getByTestId("preview-photo")).toBeInTheDocument();
  });

  it("o i explica a diferença ao clicar (celular) e fecha ao tocar fora", () => {
    renderMessagesTab();
    const info = screen.getByRole("button", { name: /Diferença entre foto do produto e prévia do link/ });
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.click(info);
    expect(screen.getByRole("tooltip").textContent).toMatch(/cartão do link/);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("o i abre ao passar o mouse", () => {
    renderMessagesTab();
    const info = screen.getByRole("button", { name: /Diferença entre foto do produto e prévia do link/ });
    fireEvent.mouseEnter(info.parentElement);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    fireEvent.mouseLeave(info.parentElement);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});

describe("GroupDashboard — aba Modelos Mensagens (Salvar / Salvar Como)", () => {
  const meuModelo = { id: "t1", name: "Meu modelo", template: "Texto salvo" };

  function renderMessagesTab(overrides = {}) {
    const out = renderDashboard({
      customTemplates: [meuModelo],
      onAddCustomTemplate: vi.fn(() => "t2"),
      onUpdateCustomTemplate: vi.fn(),
      onDeleteCustomTemplate: vi.fn(),
      ...overrides,
    });
    fireEvent.click(screen.getByRole("button", { name: /Modelos/ }));
    return out;
  }

  const escolherModelo = (container, key) =>
    fireEvent.change(container.querySelector("select"), { target: { value: key } });

  it("os botões são Salvar e Salvar Como — 'Criar a partir deste' não existe mais", () => {
    renderMessagesTab();
    expect(screen.queryByRole("button", { name: /Criar a partir deste/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Salvar" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Salvar Como" })).toBeInTheDocument();
  });

  it("Salvar num modelo próprio grava direto e pergunta se quer ativar", () => {
    const { props, container } = renderMessagesTab();
    escolherModelo(container, "custom:t1");
    fireEvent.change(container.querySelector("textarea"), { target: { value: "Texto novo" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));

    expect(props.onUpdateCustomTemplate).toHaveBeenCalledWith("t1", { name: "Meu modelo", template: "Texto novo", imageMode: "product" });
    expect(screen.getByText("Ativar este modelo?")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Ativar" }));
    const call = props.onUpdate.mock.calls.find(([, patch]) => patch.messageTemplate);
    expect(call[1].messageTemplate).toBe("Texto novo");
  });

  it("'Agora não' salva o modelo sem trocar o que a campanha usa", () => {
    const { props, container } = renderMessagesTab();
    escolherModelo(container, "custom:t1");
    fireEvent.change(container.querySelector("textarea"), { target: { value: "Texto novo" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    fireEvent.click(screen.getByRole("button", { name: "Agora não" }));

    expect(props.onUpdateCustomTemplate).toHaveBeenCalled();
    expect(props.onUpdate.mock.calls.find(([, patch]) => patch.messageTemplate)).toBeUndefined();
  });

  it("Salvar no modelo padrão (inalterável) pede um nome novo", () => {
    renderMessagesTab();
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    expect(screen.getByText("Salvar como novo modelo")).toBeInTheDocument();
  });

  it("Salvar Como cria um modelo novo com o texto que está no editor", () => {
    const { props, container } = renderMessagesTab();
    fireEvent.change(container.querySelector("textarea"), { target: { value: "Versão B" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar Como" }));
    fireEvent.change(screen.getByPlaceholderText(/minha versão/), { target: { value: "Promo curta" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar como novo" }));

    expect(props.onAddCustomTemplate).toHaveBeenCalledWith("Promo curta", "Versão B", "product");
  });
});
