// Mini Desempenho da visão geral da campanha (components/campaign/DesempenhoCampanha.jsx).
//
// O que estes testes protegem: as três buscas (sistema, Shopee, ML) saem com o
// período, o anterior e o recorte certos; os cards comparam com o anterior; o ML
// nunca é pedido além de ontem (nem no "Hoje"); loja trancada ou fora da
// campanha some; erro de credencial aponta pra aba da loja.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("../data/api", () => ({
  errText: (err, fallback) => err?.message || fallback,
  getCampanhaDesempenho: vi.fn(),
  getShopeeDesempenho: vi.fn(),
  getMLDesempenho: vi.fn(),
}));

import DesempenhoCampanha from "../components/campaign/DesempenhoCampanha.jsx";
import { getCampanhaDesempenho, getShopeeDesempenho, getMLDesempenho } from "../data/api";

// 19/10/2026 (segunda) às 15h em Brasília: "7 dias" = 12 a 18/10, anterior 5 a 11/10.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-19T18:00:00Z"));
  getCampanhaDesempenho.mockReset().mockResolvedValue(sistema());
  getShopeeDesempenho.mockReset().mockResolvedValue(shopee());
  getMLDesempenho.mockReset().mockResolvedValue(ml());
});
afterEach(() => vi.useRealTimers());

const dias = (from, n, f) => Array.from({ length: n }, (_, i) => {
  const d = new Date(`${from}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + i);
  return { date: d.toISOString().slice(0, 10), ...f(i) };
});

function sistema(extra = {}) {
  return {
    from: "2026-10-12", to: "2026-10-18", coletandoDesde: "2026-10-01", enviosDesde: "2026-10-01",
    envios: { produtos: 42, mensagens: 126 },
    membros: { grupos: 2, membros: 2450, entradas: 80, saidas: 31, saldo: 49 },
    porDia: dias("2026-10-12", 7, (i) => ({ produtos: 6, mensagens: 18, entradas: i, saidas: 1, saldo: i - 1 })),
    anterior: { from: "2026-10-05", to: "2026-10-11", envios: { produtos: 21, mensagens: 60 }, membros: { entradas: 40, saidas: 31, saldo: 9 } },
    ...extra,
  };
}

function shopee() {
  const resumo = (commission, orders) => ({
    orders, units: orders, sales: 900, commission: { total: commission, concluida: 0, pendente: commission },
    cancelled: { orders: 0, commission: 0 }, mcnFee: 0,
  });
  return {
    from: "2026-10-12", to: "2026-10-18",
    summary: resumo(45.6, 3),
    days: [{ date: "2026-10-15", orders: 3, units: 3, sales: 900, commission: 45.6 }],
    sales: [{ id: "v1", orderId: "P1", date: "2026-10-15", status: "pendente", name: "Fone Bluetooth", image: null, shopName: null, qty: 1, amount: 900, commission: 45.6, groupId: "1", group: null }],
    totalSales: 1, requestedFrom: null,
    anterior: { from: "2026-10-05", to: "2026-10-11", summary: resumo(22.8, 3) },
  };
}

function ml() {
  return {
    from: "2026-10-12", to: "2026-10-18",
    summary: {}, days: [],
    tags: [{ tag: "tag-a", clicks: 340, units: 8, earnings: 30 }, { tag: "tag-b", clicks: 5, units: 0, earnings: 0 }],
    anterior: { from: "2026-10-05", to: "2026-10-11", summary: {}, tags: [{ tag: "tag-a", clicks: 170, units: 4, earnings: 60 }] },
  };
}

const GRUPO = { id: 1, name: "Ofertas Tech", scraping: { sources: ["Mercado Livre", "Shopee"], mlTag: "tag-a" } };
const STATUS = { mlTags: [{ tag: "tag-a" }, { tag: "tag-b" }], mlDefaultTag: "tag-b" };

function monta(props = {}) {
  const onGoToAffiliate = vi.fn();
  const utils = render(
    <DesempenhoCampanha group={GRUPO} storeLocks={{}} affiliateStatus={STATUS} campanhas={[GRUPO]} onGoToAffiliate={onGoToAffiliate} {...props} />,
  );
  return { onGoToAffiliate, ...utils };
}

describe("DesempenhoCampanha", () => {
  it("pede as três buscas com o período, o anterior e a campanha", async () => {
    monta();
    await screen.findByText("42");
    expect(getCampanhaDesempenho).toHaveBeenCalledWith(1, { from: "2026-10-12", to: "2026-10-18", antFrom: "2026-10-05", antTo: "2026-10-11" });
    expect(getShopeeDesempenho).toHaveBeenCalledWith("2026-10-12", "2026-10-18", { campanha: 1, antFrom: "2026-10-05", antTo: "2026-10-11", refresh: false });
    expect(getMLDesempenho).toHaveBeenCalledWith("2026-10-12", "2026-10-18", { antFrom: "2026-10-05", antTo: "2026-10-11", refresh: false });
  });

  it("mostra ofertas, membros e vendas, cada um comparado com o período anterior", async () => {
    monta();
    expect(await screen.findByText("42")).toBeInTheDocument();
    expect(screen.getByText("em 126 mensagens")).toBeInTheDocument();
    expect(screen.getByText("2.450")).toBeInTheDocument();
    expect(screen.getByText("saldo +49 no período")).toBeInTheDocument();
    // Comissão no card e na venda da lista.
    expect((await screen.findAllByText(/R\$\s45,60/)).length).toBeGreaterThanOrEqual(2);
    expect(await screen.findByText(/R\$\s30,00/)).toBeInTheDocument();
    expect(screen.getByText("340")).toBeInTheDocument();
    // Ofertas 21→42, entradas 40→80, comissão 22,80→45,60 e cliques 170→340: ↑100%.
    expect(screen.getAllByText(/↑ 100%/)).toHaveLength(4);
    // Ganho ML 60→30.
    expect(screen.getByText(/↓ 50%/)).toBeInTheDocument();
    // Saídas e pedidos iguais.
    expect(screen.getAllByText("igual ao anterior")).toHaveLength(2);
    expect(screen.getByText("Vendas da Shopee nesta campanha")).toBeInTheDocument();
    expect(screen.getByText("Fone Bluetooth")).toBeInTheDocument();
  });

  it("explica que o ML é pela etiqueta, e diz quem mais usa a mesma", async () => {
    const outra = { id: 2, name: "Casa e Cozinha", scraping: { mlTag: "tag-a" } };
    monta({ campanhas: [GRUPO, outra] });
    expect(await screen.findByText(/também usada por Casa e Cozinha/)).toBeInTheDocument();
    expect(screen.getByText("tag-a")).toBeInTheDocument();
  });

  it("'Hoje' não pergunta ao ML (ele só fecha o dia seguinte) e avisa", async () => {
    monta();
    await screen.findByText("42");
    getMLDesempenho.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Hoje" }));
    await waitFor(() => expect(getCampanhaDesempenho).toHaveBeenLastCalledWith(1, expect.objectContaining({ from: "2026-10-19", to: "2026-10-19" })));
    expect(getMLDesempenho).not.toHaveBeenCalled();
    expect(screen.getByText(/só mostra os números de hoje amanhã/)).toBeInTheDocument();
  });

  it("período que termina hoje pede o ML só até ontem", async () => {
    const { container } = monta();
    await screen.findByText("42");
    fireEvent.click(screen.getByRole("button", { name: "Escolher datas" }));
    const [de, ate] = container.querySelectorAll('input[type="date"]');
    fireEvent.change(de, { target: { value: "2026-10-17" } });
    fireEvent.change(ate, { target: { value: "2026-10-19" } });
    fireEvent.click(screen.getByRole("button", { name: "Ver" }));
    await waitFor(() => expect(getMLDesempenho).toHaveBeenLastCalledWith("2026-10-17", "2026-10-18", { antFrom: "2026-10-15", antTo: "2026-10-16", refresh: false }));
    expect(getShopeeDesempenho).toHaveBeenLastCalledWith("2026-10-17", "2026-10-19", expect.objectContaining({ campanha: 1 }));
    expect(screen.getByText(/Mercado Livre: até ontem/)).toBeInTheDocument();
  });

  it("loja trancada ou fora da campanha não aparece nem é pedida", async () => {
    monta({ storeLocks: { shopee: { locked: true } }, group: { ...GRUPO, scraping: { sources: ["Shopee", "Amazon"] } } });
    await screen.findByText("42");
    expect(getShopeeDesempenho).not.toHaveBeenCalled();
    expect(getMLDesempenho).not.toHaveBeenCalled();
    expect(screen.queryByText("Comissão Shopee")).not.toBeInTheDocument();
    expect(screen.queryByText("Ganho ML")).not.toBeInTheDocument();
  });

  it("credencial da Shopee ausente aponta pra aba Shopee, sem derrubar o resto", async () => {
    getShopeeDesempenho.mockRejectedValue(Object.assign(new Error("Configure o App ID e a senha da API na aba Shopee pra ver o desempenho."), { body: { kind: "afiliado-ausente" } }));
    const { onGoToAffiliate } = monta();
    fireEvent.click(await screen.findByRole("button", { name: "Abrir aba Shopee" }));
    expect(onGoToAffiliate).toHaveBeenCalledWith("shopee");
    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.queryByText("Comissão Shopee")).not.toBeInTheDocument();
  });

  it("um dia só não desenha o gráfico; tocar numa barra leva pro dia", async () => {
    monta();
    await screen.findByText("Por dia");
    fireEvent.click(screen.getByTitle(/^14\/10:/));
    fireEvent.click(screen.getByRole("button", { name: /Ver só 14\/10/ }));
    await waitFor(() => expect(getCampanhaDesempenho).toHaveBeenLastCalledWith(1, { from: "2026-10-14", to: "2026-10-14", antFrom: "2026-10-13", antTo: "2026-10-13" }));
    await waitFor(() => expect(screen.queryByText("Por dia")).not.toBeInTheDocument());
  });

  it("campanha ainda não salva (404) diz que os números vêm depois", async () => {
    getCampanhaDesempenho.mockRejectedValue(Object.assign(new Error("Campanha não encontrada."), { status: 404 }));
    monta();
    expect(await screen.findByText(/assim que a campanha for salva/)).toBeInTheDocument();
  });

  it("campanha recém-criada (404) tenta de novo sozinha até ela ser salva", async () => {
    // Relógio de verdade: a nova tentativa sai 3 s depois do 404.
    vi.useRealTimers();
    getCampanhaDesempenho.mockRejectedValueOnce(Object.assign(new Error("Campanha não encontrada."), { status: 404 }));
    monta();
    expect(await screen.findByText(/assim que a campanha for salva/)).toBeInTheDocument();
    expect(await screen.findByText("42", {}, { timeout: 5000 })).toBeInTheDocument();
    expect(getCampanhaDesempenho).toHaveBeenCalledTimes(2);
  }, 10000);

  it("antes de começar o registro, avisa desde quando há dado", async () => {
    getCampanhaDesempenho.mockResolvedValue(sistema({ enviosDesde: "2026-10-15", coletandoDesde: "2026-10-16" }));
    monta();
    expect(await screen.findByText("Envios registrados desde 15/10/2026.")).toBeInTheDocument();
    expect(screen.getByText("Entradas e saídas registradas desde 16/10/2026.")).toBeInTheDocument();
  });
});
