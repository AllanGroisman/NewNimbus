// Tela Desempenho — os números de afiliado do usuário, uma aba por loja.
//
// O que estes testes protegem: a tela pede o período certo, mostra os cards,
// troca de loja sem misturar os números de uma com a outra, esconde a loja
// trancada, e credencial ausente/vencida manda pra aba da loja em vez de um
// "tentar de novo" que não resolveria.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("../data/api", () => ({
  errText: (err, fallback) => err?.message || fallback,
  getMLDesempenho: vi.fn(),
  getShopeeDesempenho: vi.fn(),
}));

import PageDesempenho from "../pages/Desempenho.jsx";
import { getMLDesempenho, getShopeeDesempenho } from "../data/api";
import { periodo } from "../data/desempenho";

function resposta({ clicks = 20, earnings = 18.5, days } = {}) {
  return {
    from: "2026-09-20",
    to: "2026-09-22",
    summary: {
      clicks,
      clicksVariation: { pct: 100, direction: "increase" },
      buyers: 3, orders: 4, units: 5,
      earnings: { total: earnings, marketplace: 12, seller: 4.5, brand: 2 },
      grossSales: 310.9, estimatedSales: 250.9, notEffectiveSales: 60, notEffectiveCount: 1,
      lastUpdate: "2026-09-29T13:26:24Z",
    },
    days: days || [
      { date: "2026-09-20", clicks: 5, orders: 1, units: 1, earnings: 3, coupons: 0 },
      { date: "2026-09-21", clicks: 0, orders: 0, units: 0, earnings: 0, coupons: 0 },
      { date: "2026-09-22", clicks: 15, orders: 3, units: 4, earnings: 15.5, coupons: 1 },
    ],
    tags: [{ tag: "minha-tag", clicks: 20, units: 5, earnings: 18.5, conversion: 0.25 }],
    fetchedAt: "2026-09-29T15:00:00Z",
    cached: false,
  };
}

function erro(message, kind) {
  return Object.assign(new Error(message), { body: { error: message, kind } });
}

function respostaShopee(extra = {}) {
  return {
    from: "2026-09-20",
    to: "2026-09-22",
    summary: {
      orders: 3, units: 14, sales: 730.75,
      commission: { total: 21.93, concluida: 11.59, pendente: 10.34 },
      cancelled: { orders: 1, commission: 1.5 },
      mcnFee: 0,
    },
    days: [{ date: "2026-09-22", orders: 1, units: 3, sales: 60.52, commission: 1.82 }],
    groups: [{ groupId: "123", name: "Ofertas Tech", orders: 1, units: 1, sales: 386.18, commission: 11.59 }],
    sales: [],
    totalSales: 0,
    requestedFrom: null,
    fetchedAt: "2026-09-29T15:00:00Z",
    cached: false,
    ...extra,
  };
}

beforeEach(() => {
  getMLDesempenho.mockReset();
  getShopeeDesempenho.mockReset();
});

describe("PageDesempenho", () => {
  it("abre nos 30 dias e mostra os cards, a origem do ganho e as etiquetas", async () => {
    getMLDesempenho.mockResolvedValue(resposta());
    render(<PageDesempenho />);

    const { from, to } = periodo("30d");
    expect(getMLDesempenho).toHaveBeenCalledWith(from, to, { refresh: false });

    expect(await screen.findByText("Compradores")).toBeInTheDocument();
    expect(screen.getAllByText("20")).toHaveLength(2);               // card de cliques + linha da etiqueta
    expect(screen.getByText(/↑ 100% vs\. período anterior/)).toBeInTheDocument();
    expect(screen.getByText("20%")).toBeInTheDocument();          // 4 pedidos ÷ 20 cliques
    expect(screen.getAllByText(/R\$\s18,50/).length).toBeGreaterThan(0);
    expect(screen.getByText("Parceria do vendedor")).toBeInTheDocument();
    expect(screen.getByText("minha-tag")).toBeInTheDocument();
  });

  it("trocar o período busca de novo com as datas dele", async () => {
    getMLDesempenho.mockResolvedValue(resposta());
    render(<PageDesempenho />);
    await screen.findByText("Compradores");

    fireEvent.click(screen.getByRole("button", { name: "7 dias" }));
    const { from, to } = periodo("7d");
    await waitFor(() => expect(getMLDesempenho).toHaveBeenLastCalledWith(from, to, { refresh: false }));
  });

  it("Atualizar pede ao backend pra furar o cache", async () => {
    getMLDesempenho.mockResolvedValue(resposta());
    render(<PageDesempenho />);
    await screen.findByText("Compradores");

    fireEvent.click(screen.getByRole("button", { name: /Atualizar/ }));
    await waitFor(() => expect(getMLDesempenho).toHaveBeenLastCalledWith(expect.any(String), expect.any(String), { refresh: true }));
  });

  it("cookie vencido aponta pra aba Mercado Livre, sem 'tentar de novo'", async () => {
    getMLDesempenho.mockRejectedValue(erro("O cookie do Mercado Livre venceu — cole um novo na aba Mercado Livre.", "login-wall"));
    const onGoToML = vi.fn();
    render(<PageDesempenho onGoToML={onGoToML} />);

    expect(await screen.findByText(/cookie do Mercado Livre venceu/)).toBeInTheDocument();
    expect(screen.queryByText("Tentar de novo")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Abrir aba Mercado Livre" }));
    expect(onGoToML).toHaveBeenCalled();
  });

  it("erro do ML oferece tentar de novo", async () => {
    getMLDesempenho
      .mockRejectedValueOnce(erro("O Mercado Livre respondeu HTTP 500 ao buscar as métricas.", "desconhecido"))
      .mockResolvedValue(resposta());
    render(<PageDesempenho />);

    fireEvent.click(await screen.findByText("Tentar de novo"));
    expect(await screen.findByText("Compradores")).toBeInTheDocument();
    expect(getMLDesempenho).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/HTTP 500/)).not.toBeInTheDocument();
  });

  it("período sem movimento diz isso em vez de desenhar barras vazias", async () => {
    getMLDesempenho.mockResolvedValue(resposta({ clicks: 0, days: [{ date: "2026-09-20", clicks: 0, orders: 0, units: 0, earnings: 0, coupons: 0 }] }));
    render(<PageDesempenho />);
    expect(await screen.findByText("Sem cliques no período.")).toBeInTheDocument();
  });
});

describe("PageDesempenho — lojas", () => {
  it("a aba Shopee busca o mesmo período na Shopee, sem mostrar os números do ML enquanto carrega", async () => {
    getMLDesempenho.mockResolvedValue(resposta());
    let entrega;
    getShopeeDesempenho.mockImplementation(() => new Promise(r => { entrega = r; }));
    render(<PageDesempenho />);
    await screen.findByText("Compradores");

    fireEvent.click(screen.getByRole("button", { name: "Shopee" }));
    const { from, to } = periodo("30d");
    expect(getShopeeDesempenho).toHaveBeenCalledWith(from, to, { refresh: false });
    expect(await screen.findByText("Buscando na Shopee…")).toBeInTheDocument();
    expect(screen.queryByText("Compradores")).not.toBeInTheDocument();

    entrega(respostaShopee());
    expect(await screen.findByText("Comissão estimada")).toBeInTheDocument();
    expect(screen.getByText("Ofertas Tech")).toBeInTheDocument();
  });

  it("loja trancada não vira aba, e a que sobra é a aberta", async () => {
    getShopeeDesempenho.mockResolvedValue(respostaShopee());
    render(<PageDesempenho lojas={["shopee"]} />);
    expect(await screen.findByText("Comissão estimada")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mercado Livre" })).not.toBeInTheDocument();
    expect(getMLDesempenho).not.toHaveBeenCalled();
  });

  it("abre na loja pedida pelo App", async () => {
    getShopeeDesempenho.mockResolvedValue(respostaShopee());
    render(<PageDesempenho lojaInicial="shopee" />);
    expect(await screen.findByText("Comissão estimada")).toBeInTheDocument();
    expect(getMLDesempenho).not.toHaveBeenCalled();
  });

  it("credencial da Shopee recusada aponta pra aba Shopee", async () => {
    getShopeeDesempenho.mockRejectedValue(erro("A Shopee recusou o App ID/senha pra ler o relatório. Confira na aba Shopee.", "credencial-recusada"));
    const onGoToShopee = vi.fn();
    render(<PageDesempenho lojaInicial="shopee" onGoToShopee={onGoToShopee} />);

    fireEvent.click(await screen.findByRole("button", { name: "Abrir aba Shopee" }));
    expect(onGoToShopee).toHaveBeenCalled();
    expect(screen.queryByText("Tentar de novo")).not.toBeInTheDocument();
  });

  it("período cortado pelo limite da Shopee é avisado com a data em que começa", async () => {
    getShopeeDesempenho.mockResolvedValue(respostaShopee({ from: "2026-06-01", requestedFrom: "2026-05-30" }));
    render(<PageDesempenho lojaInicial="shopee" />);
    expect(await screen.findByText(/só guarda os últimos 3 meses — o período começa em 01\/06\/2026/)).toBeInTheDocument();
  });
});
