// Conteúdo da aba Shopee da tela Desempenho, no desenho da aba do ML.
//
// O que estes testes protegem: os cards (sem Cliques/Conversão, que a API da
// Shopee não tem), o detalhe dos ganhos por fonte com a MCN só pra quem tem, e
// cada aba de baixo — Vendas (que pagina e também serve a visão geral da
// campanha), Produtos vendidos, Categorias, Campanhas (no lugar das etiquetas do
// ML, com a dica quando nada ainda está marcado), Data, Audiências e Não
// efetivadas —, inclusive o vazio de cada uma.

import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import DesempenhoShopee from "../components/desempenho/DesempenhoShopee.jsx";

function venda(i, extra = {}) {
  return {
    id: `v${i}`, orderId: `P${i}`, purchaseTime: "2026-09-22T17:59:01.000Z", date: "2026-09-22",
    status: "pendente", name: `Produto ${i}`, image: null, link: null, shopName: "Loja", qty: 1,
    amount: 40.52, commission: 1.22, attribution: null, groupId: null, group: null,
    ...extra,
  };
}

const RESUMO = {
  orders: 3, units: 14, sales: 730.75, grossSales: 780.75,
  notEffectiveSales: 50, notEffectiveCount: 1, purchases: 3, newBuyers: 1,
  commission: { total: 21.93, concluida: 11.59, pendente: 10.34, shopee: 21.73, seller: 0.2, brand: 0 },
  cancelled: { orders: 1, commission: 1.5 },
  mcnFee: 0,
};

const RESUMO_VAZIO = {
  orders: 0, units: 0, sales: 0, grossSales: 0, notEffectiveSales: 0, notEffectiveCount: 0, purchases: 0, newBuyers: 0,
  commission: { total: 0, concluida: 0, pendente: 0, shopee: 0, seller: 0, brand: 0 },
  cancelled: { orders: 0, commission: 0 },
  mcnFee: 0,
};

function dados(extra = {}) {
  return {
    from: "2026-09-20",
    to: "2026-09-25",
    summary: RESUMO,
    days: [
      { date: "2026-09-22", orders: 1, units: 3, sales: 60.52, commission: 1.82 },
      { date: "2026-09-23", orders: 0, units: 0, sales: 0, commission: 0 },
      { date: "2026-09-25", orders: 1, units: 1, sales: 386.18, commission: 11.59 },
    ],
    groups: [
      { groupId: "123", name: "Ofertas Tech", orders: 1, units: 1, sales: 386.18, commission: 11.59 },
      { groupId: null, name: "Sem campanha", orders: 1, units: 3, sales: 60.52, commission: 1.82 },
    ],
    sales: [
      venda(1, {
        status: "concluida", name: "Relógio Masculino", amount: 386.18, commission: 11.59, attribution: "direta",
        link: "https://shopee.com.br/product/1101/11", groupId: "123", group: "Ofertas Tech",
      }),
      venda(2, { name: "Cartas Colecionáveis", qty: 10 }),
      venda(3, { status: "cancelada", name: "Caneca" }),
    ],
    totalSales: 3,
    products: [
      { product: "Relógio Masculino", image: null, link: "https://shopee.com.br/product/1101/11", category: "Relógios", units: 1, sales: 386.18, earnings: 11.59, feePct: 3 },
      { product: "Álbum de Figurinhas", image: null, link: null, category: "Hobbies e Coleções", units: 2, sales: 20, earnings: 0.6, feePct: 3 },
    ],
    categories: [
      { category: "Relógios", units: 1, earnings: 11.59, feePct: 3 },
      { category: "Hobbies e Coleções", units: 13, earnings: 10.34, feePct: 12.5 },
    ],
    notEffective: [
      { product: "Caneca Cancelada", image: null, link: null, category: "Casa e Decoração", canceled: 1, notApproved: 0, lostEarnings: 1.5 },
      { product: "Fone Recusado", image: null, link: null, category: null, canceled: 0, notApproved: 2, lostEarnings: 0.9 },
    ],
    audience: {
      buyers: [{ label: "Já compravam", value: 2 }, { label: "Novos", value: 1 }],
      device: [{ label: "App", value: 3 }],
      referrer: [{ label: "WhatsApp", value: 3 }],
      attribution: [{ label: "Na loja do link", value: 2 }, { label: "Em outra loja", value: 1 }],
    },
    ...extra,
  };
}

const abre = (nome) => fireEvent.click(screen.getByRole("button", { name: nome }));

describe("DesempenhoShopee — cards", () => {
  it("os cards do ML que a Shopee tem; sem Cliques nem Conversão, com o aviso no rodapé", () => {
    render(<DesempenhoShopee dados={dados()} />);
    for (const rotulo of ["Pedidos", "Produtos", "Compradores novos", "Comissão estimada", "Vendas estimadas", "Vendas brutas", "Não efetivadas"]) {
      expect(screen.getByRole("button", { name: `O que é ${rotulo}` })).toBeInTheDocument();
    }
    expect(screen.queryByText("Cliques")).not.toBeInTheDocument();
    expect(screen.queryByText("Conversão")).not.toBeInTheDocument();
    expect(screen.getByText("de 3 compras")).toBeInTheDocument();
    expect(screen.getByText(/R\$\s21,93/)).toBeInTheDocument();
    expect(screen.getByText(/R\$\s11,59 concluída · R\$\s10,34 pendente/)).toBeInTheDocument();
    expect(screen.getByText(/R\$\s730,75/)).toBeInTheDocument();
    expect(screen.getByText(/R\$\s780,75/)).toBeInTheDocument();
    expect(screen.getByText(/R\$\s50,00/)).toBeInTheDocument();
    expect(screen.getByText("1 venda")).toBeInTheDocument();
    expect(screen.getByText(/não informa cliques/)).toBeInTheDocument();
  });

  it("cada card compara com o período anterior", () => {
    const anterior = { from: "2026-09-14", to: "2026-09-19", summary: { ...RESUMO, orders: 2, notEffectiveSales: 25 } };
    render(<DesempenhoShopee dados={dados({ anterior })} />);
    expect(screen.getAllByText(/↑\s50%/).length).toBeGreaterThan(0);
    expect(screen.getAllByText("igual ao anterior").length).toBeGreaterThan(0);
    expect(screen.getByText(/↑\s100%/)).toBeInTheDocument();
  });

  it("detalhe dos ganhos: as três fontes da comissão; a MCN só aparece pra quem tem", () => {
    const { unmount } = render(<DesempenhoShopee dados={dados()} />);
    expect(screen.getByText("Detalhe dos ganhos")).toBeInTheDocument();
    expect(screen.getByText("Comissão da Shopee")).toBeInTheDocument();
    expect(screen.getByText(/R\$\s21,73/)).toBeInTheDocument();
    expect(screen.getByText("Comissão Xtra do vendedor")).toBeInTheDocument();
    expect(screen.getByText(/R\$\s0,20/)).toBeInTheDocument();
    expect(screen.getByText("Comissão de marca")).toBeInTheDocument();
    expect(screen.queryByText(/MCN/)).not.toBeInTheDocument();
    unmount();

    render(<DesempenhoShopee dados={dados({ summary: { ...RESUMO, mcnFee: 0.5 } })} />);
    expect(screen.getByText(/Taxa da agência \(MCN\)/)).toBeInTheDocument();
    expect(screen.getByText(/−\sR\$\s0,50/)).toBeInTheDocument();
  });
});

describe("DesempenhoShopee — abas", () => {
  it("abre em Vendas: status, quantidade, loja, campanha, tipo e taxa de cada item; nome vira link pro anúncio", () => {
    render(<DesempenhoShopee dados={dados()} />);
    expect(screen.getByRole("button", { name: "Vendas" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Concluída")).toBeInTheDocument();
    expect(screen.getByText("Pendente")).toBeInTheDocument();
    expect(screen.getByText("Cancelada")).toBeInTheDocument();
    expect(screen.getByText("10× Cartas Colecionáveis")).toBeInTheDocument();
    expect(screen.getByText("22/09 · Loja · Ofertas Tech · direta 3%")).toBeInTheDocument();
    expect(screen.getAllByText("22/09 · Loja · 3%")).toHaveLength(2);
    expect(screen.getByRole("link", { name: "Relógio Masculino" })).toHaveAttribute("href", "https://shopee.com.br/product/1101/11");
  });

  it("vendas: 10 de cada vez no 'Ver mais'; o corte do backend é avisado", () => {
    const muitas = Array.from({ length: 25 }, (_, i) => venda(i + 1));
    render(<DesempenhoShopee dados={dados({ sales: muitas, totalSales: 600 })} />);
    expect(screen.getByText("Produto 10")).toBeInTheDocument();
    expect(screen.queryByText("Produto 11")).not.toBeInTheDocument();
    abre("Ver mais");
    expect(screen.getByText("Produto 20")).toBeInTheDocument();
    abre("Ver mais");
    expect(screen.getByText("Produto 25")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ver mais" })).not.toBeInTheDocument();
    expect(screen.getByText("Mostrando as 25 mais recentes de 600.")).toBeInTheDocument();
  });

  it("produtos vendidos: unidades, vendas e taxa de cada produto, com a comissão", () => {
    render(<DesempenhoShopee dados={dados()} />);
    abre("Produtos vendidos");
    expect(screen.getByText(/1 unidade · R\$\s386,18 em vendas · 3%/)).toBeInTheDocument();
    expect(screen.getByText(/2 unidades · R\$\s20,00 em vendas · 3%/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Relógio Masculino" })).toBeInTheDocument();
  });

  it("categorias: uma linha por categoria, com a coluna Comissão", () => {
    render(<DesempenhoShopee dados={dados()} />);
    abre("Categorias");
    const tabela = screen.getByRole("table");
    expect(within(tabela).getByText("Comissão")).toBeInTheDocument();
    const linha = within(tabela).getByText("Hobbies e Coleções").closest("tr");
    expect(within(linha).getByText("13")).toBeInTheDocument();
    expect(within(linha).getByText("12,5%")).toBeInTheDocument();
  });

  it("campanhas: uma linha por campanha; a dica só aparece quando nada ainda veio marcado", () => {
    const { unmount } = render(<DesempenhoShopee dados={dados()} />);
    abre("Campanhas");
    const tabela = screen.getByRole("table");
    expect(within(tabela).getByText("Ofertas Tech")).toBeInTheDocument();
    expect(within(tabela).getByText("Sem campanha")).toBeInTheDocument();
    expect(screen.queryByText(/agora saem marcados com a campanha/)).not.toBeInTheDocument();
    unmount();

    render(<DesempenhoShopee dados={dados({ groups: [{ groupId: null, name: "Sem campanha", orders: 3, units: 14, sales: 730.75, commission: 21.93 }] })} />);
    abre("Campanhas");
    expect(screen.getByText(/agora saem marcados com a campanha/)).toBeInTheDocument();
  });

  it("data: o gráfico por dia e a tabela só com os dias que tiveram venda, do mais recente", () => {
    render(<DesempenhoShopee dados={dados()} />);
    abre("Data");
    expect(screen.getByText("Por dia")).toBeInTheDocument();
    const linhas = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    expect(linhas.map(l => l.firstChild.textContent)).toEqual(["25/09", "22/09"]);
  });

  it("audiências: os quatro grupos em % dos pedidos", () => {
    render(<DesempenhoShopee dados={dados()} />);
    abre("Audiências");
    for (const titulo of ["Compradores", "Dispositivo", "Origem do clique", "Onde comprou"]) {
      expect(screen.getByText(titulo)).toBeInTheDocument();
    }
    expect(screen.getByText("Novos")).toBeInTheDocument();
    expect(screen.getAllByText("33,3%").length).toBeGreaterThan(0);
    expect(screen.getAllByText("100%").length).toBe(2);
  });

  it("não efetivadas: canceladas e recusadas por produto, com o valor não recebido", () => {
    render(<DesempenhoShopee dados={dados()} />);
    abre("Não efetivadas");
    expect(screen.getByText(/Valor não recebido/)).toBeInTheDocument();
    expect(screen.getByText("1 cancelada · Casa e Decoração")).toBeInTheDocument();
    expect(screen.getByText("2 não aprovadas")).toBeInTheDocument();
    expect(screen.getByText(/R\$\s1,50/)).toBeInTheDocument();
  });

  it("o 'Ver mais' de uma aba sobrevive à troca de aba e volta ao começo num resumo novo", () => {
    const muitas = Array.from({ length: 15 }, (_, i) => venda(i + 1));
    const { rerender } = render(<DesempenhoShopee dados={dados({ sales: muitas, totalSales: 15 })} versao={1} />);
    abre("Ver mais");
    expect(screen.getByText("Produto 15")).toBeInTheDocument();
    abre("Categorias");
    abre("Vendas");
    expect(screen.getByText("Produto 15")).toBeInTheDocument();

    rerender(<DesempenhoShopee dados={dados({ sales: muitas, totalSales: 15 })} versao={2} />);
    expect(screen.queryByText("Produto 15")).not.toBeInTheDocument();
  });

  it("período sem venda: cada aba diz que não tem nada", () => {
    render(<DesempenhoShopee dados={dados({
      summary: RESUMO_VAZIO,
      days: [{ date: "2026-09-22", orders: 0, units: 0, sales: 0, commission: 0 }],
      groups: [], sales: [], totalSales: 0, products: [], categories: [], notEffective: [],
      audience: { buyers: [], device: [], referrer: [], attribution: [] },
    })} />);
    expect(screen.getByText("Nenhuma venda no período.")).toBeInTheDocument();
    for (const aba of ["Produtos vendidos", "Categorias", "Campanhas", "Audiências", "Não efetivadas"]) {
      abre(aba);
      expect(screen.getAllByText("Nenhum dado registrado para este período.").filter(e => !e.closest("[hidden]"))).toHaveLength(1);
    }
    abre("Data");
    expect(screen.getByText("Sem pedidos no período.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});
