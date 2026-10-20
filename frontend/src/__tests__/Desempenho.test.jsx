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
  getMLDesempenhoLista: vi.fn(),
  getShopeeDesempenho: vi.fn(),
}));

import PageDesempenho from "../pages/Desempenho.jsx";
import { getMLDesempenho, getMLDesempenhoLista, getShopeeDesempenho } from "../data/api";
import { periodo } from "../data/desempenho";
import { periodoAnterior, hojeBR, somaDias } from "../data/periodos";

// O que a tela manda pro backend num preset: o período e o anterior (variação).
function pedido(id, { refresh = false } = {}) {
  const p = periodo(id);
  const ant = periodoAnterior({ id, ...p });
  return [p.from, p.to, { refresh, antFrom: ant.from, antTo: ant.to }];
}

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

// Uma venda no formato de /api/affiliate/ml/desempenho/lista?aba=vendas.
function venda(extra = {}) {
  return {
    id: "1", date: "2026-09-22", product: "Fone XYZ", image: null, link: null, category: "Eletrônicos",
    store: "Loja ABC", value: 89.9, units: 1, commission: 7.19, commissionPct: 8, saleType: "DIRECT",
    status: "IN_REVIEW", statusDetail: null, statusUntil: "2026-11-21",
    ...extra,
  };
}

// Resposta das abas que buscam: Vendas com uma venda, o resto vazio.
function listaPadrao(aba, from, to, { page = 1 } = {}) {
  if (aba === "audiencias") return Promise.resolve({ aba, from, to, age: [], gender: [], location: [] });
  const items = aba === "vendas" ? [venda()] : [];
  return Promise.resolve({ aba, from, to, page, total: items.length, hasMore: false, items });
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
  getMLDesempenhoLista.mockReset();
  getMLDesempenhoLista.mockImplementation(listaPadrao);
  getShopeeDesempenho.mockReset();
});

describe("PageDesempenho", () => {
  it("abre nos 30 dias e mostra os cards e o detalhe dos ganhos, sem a nota do rodapé", async () => {
    getMLDesempenho.mockResolvedValue(resposta());
    render(<PageDesempenho />);

    expect(getMLDesempenho).toHaveBeenCalledWith(...pedido("30d"));

    expect(await screen.findByText("Compradores")).toBeInTheDocument();
    expect(screen.getByText("20")).toBeInTheDocument();
    // Sem `anterior` na resposta, o card de cliques usa a variação do próprio ML.
    expect(screen.getByText(/↑ 100%/)).toBeInTheDocument();
    expect(screen.getByText("20%")).toBeInTheDocument();          // 4 pedidos ÷ 20 cliques
    expect(screen.getAllByText(/R\$\s18,50/).length).toBeGreaterThan(0);
    expect(screen.getByText("Detalhe dos ganhos")).toBeInTheDocument();
    expect(screen.getByText("Parceria do vendedor")).toBeInTheDocument();
    expect(screen.getByText("Patrocinado por marca")).toBeInTheDocument();
    expect(screen.queryByText(/atualiza estes números uma vez por dia/)).not.toBeInTheDocument();
  });

  it("o (i) de cada número mostra o texto do painel do ML", async () => {
    getMLDesempenho.mockResolvedValue(resposta());
    render(<PageDesempenho />);
    await screen.findByText("Compradores");

    fireEvent.click(screen.getByRole("button", { name: "O que é Pedidos" }));
    expect(screen.getByRole("tooltip")).toHaveTextContent("É a quantidade de pedidos feitos pelos compradores. Pode variar após o processo de aprovação.");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "O que é Parceria do vendedor" }));
    expect(screen.getByRole("tooltip")).toHaveTextContent("São as porcentagens de parceria definidas pelo vendedor.");
  });

  it("trocar o período busca de novo com as datas dele", async () => {
    getMLDesempenho.mockResolvedValue(resposta());
    render(<PageDesempenho />);
    await screen.findByText("Compradores");

    fireEvent.click(screen.getByRole("button", { name: "7 dias" }));
    await waitFor(() => expect(getMLDesempenho).toHaveBeenLastCalledWith(...pedido("7d")));
  });

  it("Atualizar pede ao backend pra furar o cache", async () => {
    getMLDesempenho.mockResolvedValue(resposta());
    render(<PageDesempenho />);
    await screen.findByText("Compradores");

    fireEvent.click(screen.getByRole("button", { name: /Atualizar/ }));
    await waitFor(() => expect(getMLDesempenho).toHaveBeenLastCalledWith(expect.any(String), expect.any(String), expect.objectContaining({ refresh: true })));
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

  it("com o período anterior na resposta, cada card mostra a variação", async () => {
    const r = resposta();
    getMLDesempenho.mockResolvedValue({
      ...r,
      anterior: { from: "2026-09-17", to: "2026-09-19", summary: { ...r.summary, clicks: 10, buyers: 3, earnings: { ...r.summary.earnings, total: 37 } }, tags: [] },
    });
    render(<PageDesempenho />);
    expect(await screen.findByText(/Comparando com 17\/09 a 19\/09/)).toBeInTheDocument();
    expect(screen.getByText(/↑ 100%/)).toBeInTheDocument();    // cliques 10 → 20
    expect(screen.getByText(/↓ 50%/)).toBeInTheDocument();     // ganho 37 → 18,50
    expect(screen.getAllByText("igual ao anterior").length).toBeGreaterThan(0);   // compradores 3 → 3
  });

  it("'Ontem' e o ‹ pedem o dia e o período vizinho", async () => {
    getMLDesempenho.mockResolvedValue(resposta());
    render(<PageDesempenho />);
    await screen.findByText("Compradores");

    fireEvent.click(screen.getByRole("button", { name: "Ontem" }));
    const ontem = somaDias(hojeBR(), -1);
    const anteontem = somaDias(ontem, -1);
    await waitFor(() => expect(getMLDesempenho).toHaveBeenLastCalledWith(ontem, ontem, { refresh: false, antFrom: anteontem, antTo: anteontem }));

    fireEvent.click(screen.getByRole("button", { name: "Período anterior" }));
    const antes = somaDias(anteontem, -1);
    await waitFor(() => expect(getMLDesempenho).toHaveBeenLastCalledWith(anteontem, anteontem, { refresh: false, antFrom: antes, antTo: antes }));
  });

  it("'Escolher datas' busca o intervalo só no 'Ver', e recusa data depois de ontem no ML", async () => {
    getMLDesempenho.mockResolvedValue(resposta());
    const { container } = render(<PageDesempenho />);
    await screen.findByText("Compradores");
    const chamadas = getMLDesempenho.mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: "Escolher datas" }));
    const [de, ate] = container.querySelectorAll('input[type="date"]');
    fireEvent.change(de, { target: { value: "2026-09-10" } });
    fireEvent.change(ate, { target: { value: "2026-09-12" } });
    expect(getMLDesempenho.mock.calls.length).toBe(chamadas);
    fireEvent.click(screen.getByRole("button", { name: "Ver" }));
    await waitFor(() => expect(getMLDesempenho).toHaveBeenLastCalledWith("2026-09-10", "2026-09-12", { refresh: false, antFrom: "2026-09-07", antTo: "2026-09-09" }));

    fireEvent.click(screen.getByRole("button", { name: "Escolher datas" }));
    const [de2, ate2] = container.querySelectorAll('input[type="date"]');
    fireEvent.change(de2, { target: { value: hojeBR() } });
    fireEvent.change(ate2, { target: { value: hojeBR() } });
    fireEvent.click(screen.getByRole("button", { name: "Ver" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Escolha até/);
  });

  it("tocar numa barra da aba Data oferece ver só aquele dia", async () => {
    getMLDesempenho.mockResolvedValue(resposta());
    render(<PageDesempenho />);
    await screen.findByText("Compradores");

    fireEvent.click(screen.getByRole("button", { name: "Data" }));
    fireEvent.click(screen.getByTitle(/^22\/09:/));
    fireEvent.click(screen.getByRole("button", { name: /Ver só 22\/09/ }));
    await waitFor(() => expect(getMLDesempenho).toHaveBeenLastCalledWith("2026-09-22", "2026-09-22", { refresh: false, antFrom: "2026-09-21", antTo: "2026-09-21" }));
  });

  it("a etiqueta mostra as campanhas que a usam, com link", async () => {
    getMLDesempenho.mockResolvedValue(resposta());
    const onOpenCampanha = vi.fn();
    const campanhas = [
      { id: 1, name: "Ofertas Tech", scraping: { mlTag: "minha-tag" } },
      { id: 2, name: "Casa", scraping: {} },                                        // padrão = outra
      { id: 3, name: "Só Shopee", scraping: { mlTag: "minha-tag", sources: ["Shopee"] } },
    ];
    render(<PageDesempenho campanhas={campanhas} onOpenCampanha={onOpenCampanha} mlTags={[{ tag: "minha-tag" }, { tag: "padrao" }]} mlDefaultTag="padrao" />);
    fireEvent.click(await screen.findByRole("button", { name: "Etiquetas" }));
    expect(screen.getByText("minha-tag")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Ofertas Tech" }));
    expect(onOpenCampanha).toHaveBeenCalledWith(1);
    expect(screen.queryByRole("button", { name: "Casa" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Só Shopee" })).not.toBeInTheDocument();
  });

  it("período sem movimento diz isso em vez de desenhar barras vazias", async () => {
    getMLDesempenho.mockResolvedValue(resposta({ clicks: 0, days: [{ date: "2026-09-20", clicks: 0, orders: 0, units: 0, earnings: 0, coupons: 0 }] }));
    render(<PageDesempenho />);
    fireEvent.click(await screen.findByRole("button", { name: "Data" }));
    expect(screen.getByText("Sem cliques no período.")).toBeInTheDocument();
  });
});

describe("PageDesempenho — abas do ML", () => {
  it("abre em Vendas: busca a lista do período e mostra status, loja e comissão", async () => {
    getMLDesempenho.mockResolvedValue(resposta());
    render(<PageDesempenho />);

    expect(await screen.findByText("Fone XYZ")).toBeInTheDocument();
    expect(getMLDesempenhoLista).toHaveBeenCalledWith("vendas", "2026-09-20", "2026-09-22", { page: 1, refresh: false });
    expect(screen.getByText("Em revisão")).toBeInTheDocument();
    expect(screen.getByText("até 21/11")).toBeInTheDocument();
    expect(screen.getByText("22/09 · Loja ABC · direta 8%")).toBeInTheDocument();
    expect(screen.getByText(/R\$\s7,19/)).toBeInTheDocument();
    expect(screen.getByText(/de R\$\s89,90/)).toBeInTheDocument();
  });

  it("cada chip busca a sua aba uma vez só; voltar não busca de novo", async () => {
    getMLDesempenho.mockResolvedValue(resposta());
    render(<PageDesempenho />);
    await screen.findByText("Fone XYZ");

    fireEvent.click(screen.getByRole("button", { name: "Produtos vendidos" }));
    await waitFor(() => expect(getMLDesempenhoLista).toHaveBeenCalledWith("produtos", "2026-09-20", "2026-09-22", { page: 1, refresh: false }));
    expect(await screen.findByText("Nenhum dado registrado para este período.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Vendas" }));
    expect(screen.getByText("Fone XYZ")).toBeVisible();
    expect(getMLDesempenhoLista.mock.calls.filter(([aba]) => aba === "vendas")).toHaveLength(1);

    // Data e Etiquetas saem do resumo: não pedem nada.
    fireEvent.click(screen.getByRole("button", { name: "Data" }));
    fireEvent.click(screen.getByRole("button", { name: "Etiquetas" }));
    expect(getMLDesempenhoLista).toHaveBeenCalledTimes(2);
  });

  it("'Ver mais' pede a próxima página e acrescenta embaixo", async () => {
    getMLDesempenho.mockResolvedValue(resposta());
    getMLDesempenhoLista.mockImplementation(async (aba, from, to, { page }) => ({
      aba, from, to, page, total: 11, hasMore: page === 1,
      items: [venda({ id: String(page), product: page === 1 ? "Fone XYZ" : "Capa ABC" })],
    }));
    render(<PageDesempenho />);
    await screen.findByText("Fone XYZ");

    fireEvent.click(screen.getByRole("button", { name: "Ver mais" }));
    expect(await screen.findByText("Capa ABC")).toBeInTheDocument();
    expect(screen.getByText("Fone XYZ")).toBeInTheDocument();
    expect(getMLDesempenhoLista).toHaveBeenLastCalledWith("vendas", "2026-09-20", "2026-09-22", { page: 2, refresh: false });
    expect(screen.queryByRole("button", { name: "Ver mais" })).not.toBeInTheDocument();
  });

  it("Atualizar também renova a aba aberta", async () => {
    getMLDesempenho.mockResolvedValue(resposta());
    render(<PageDesempenho />);
    await screen.findByText("Fone XYZ");

    fireEvent.click(screen.getByRole("button", { name: /Atualizar/ }));
    await waitFor(() => expect(getMLDesempenhoLista).toHaveBeenLastCalledWith("vendas", "2026-09-20", "2026-09-22", { page: 1, refresh: true }));
  });

  it("erro na lista oferece tentar de novo, sem derrubar os cards", async () => {
    getMLDesempenho.mockResolvedValue(resposta());
    getMLDesempenhoLista
      .mockRejectedValueOnce(erro("O Mercado Livre respondeu HTTP 500 ao buscar as métricas.", "desconhecido"))
      .mockImplementation(listaPadrao);
    render(<PageDesempenho />);

    fireEvent.click(await screen.findByText("Tentar de novo"));
    expect(await screen.findByText("Fone XYZ")).toBeInTheDocument();
    expect(screen.getByText("Compradores")).toBeInTheDocument();
  });

  it("Data mostra a tabela dos dias com movimento, do mais recente pro mais antigo", async () => {
    getMLDesempenho.mockResolvedValue(resposta());
    render(<PageDesempenho />);
    await screen.findByText("Compradores");

    fireEvent.click(screen.getByRole("button", { name: "Data" }));
    const linhas = screen.getAllByRole("row").slice(1).map(r => r.textContent);
    expect(linhas).toHaveLength(2);                       // 21/09 não teve nada
    expect(linhas[0]).toMatch(/^22\/09/);
    expect(linhas[1]).toMatch(/^20\/09/);
  });

  it("Audiências desenha idade, gênero e local em %", async () => {
    getMLDesempenho.mockResolvedValue(resposta());
    getMLDesempenhoLista.mockImplementation(async (aba, from, to) => (aba === "audiencias"
      ? { aba, from, to, age: [{ label: "18-24", value: 1 }, { label: "25-34", value: 3 }], gender: [{ label: "Feminino", value: 1 }], location: [] }
      : listaPadrao(aba, from, to)));
    render(<PageDesempenho />);
    await screen.findByText("Fone XYZ");

    fireEvent.click(screen.getByRole("button", { name: "Audiências" }));
    expect(await screen.findByText("25-34")).toBeInTheDocument();
    expect(screen.getByText("75%")).toBeInTheDocument();
    expect(screen.getByText("100%")).toBeInTheDocument();     // gênero: uma fatia só
    expect(screen.getByText("Sem dados.")).toBeInTheDocument(); // local vazio
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
    expect(getShopeeDesempenho).toHaveBeenCalledWith(...pedido("30d"));
    expect(await screen.findByText("Buscando na Shopee…")).toBeInTheDocument();
    expect(screen.queryByText("Compradores")).not.toBeInTheDocument();

    entrega(respostaShopee());
    expect(await screen.findByText("Comissão estimada")).toBeInTheDocument();
    expect(screen.getByText("Ofertas Tech")).toBeInTheDocument();
  });

  it("'Hoje' da Shopee vira 'Ontem' ao trocar pro ML (o ML só fecha o dia seguinte)", async () => {
    getShopeeDesempenho.mockResolvedValue(respostaShopee());
    getMLDesempenho.mockResolvedValue(resposta());
    render(<PageDesempenho lojaInicial="shopee" />);
    await screen.findByText("Comissão estimada");

    fireEvent.click(screen.getByRole("button", { name: "Hoje" }));
    const hoje = hojeBR();
    await waitFor(() => expect(getShopeeDesempenho).toHaveBeenLastCalledWith(hoje, hoje, expect.objectContaining({ refresh: false })));

    fireEvent.click(screen.getByRole("button", { name: "Mercado Livre" }));
    const ontem = somaDias(hoje, -1);
    await waitFor(() => expect(getMLDesempenho).toHaveBeenLastCalledWith(ontem, ontem, expect.objectContaining({ refresh: false })));
    expect(screen.queryByRole("button", { name: "Hoje" })).not.toBeInTheDocument();
  });

  it("a linha de uma campanha em 'Por campanha' abre a campanha; a apagada não é link", async () => {
    getShopeeDesempenho.mockResolvedValue(respostaShopee({
      groups: [
        { groupId: "123", name: "Ofertas Tech", orders: 1, units: 1, sales: 386.18, commission: 11.59 },
        { groupId: "999", name: "Campanha apagada", orders: 1, units: 1, sales: 10, commission: 1 },
      ],
    }));
    const onOpenCampanha = vi.fn();
    render(<PageDesempenho lojaInicial="shopee" campanhas={[{ id: 123, name: "Ofertas Tech", scraping: {} }]} onOpenCampanha={onOpenCampanha} />);
    expect(await screen.findByText("Por campanha")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Ofertas Tech" }));
    expect(onOpenCampanha).toHaveBeenCalledWith(123);
    expect(screen.queryByRole("button", { name: "Campanha apagada" })).not.toBeInTheDocument();
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
