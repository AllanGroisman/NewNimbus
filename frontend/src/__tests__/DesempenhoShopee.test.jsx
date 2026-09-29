// Conteúdo da aba Shopee da tela Desempenho.
//
// O que estes testes protegem: a comissão aparece separada em concluída e
// pendente, o cancelado fica à parte, as vendas por grupo aparecem (com a dica
// quando nada ainda está marcado), a lista de vendas pagina, e a taxa de MCN só
// aparece pra quem tem.

import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import DesempenhoShopee from "../components/desempenho/DesempenhoShopee.jsx";

function venda(i, extra = {}) {
  return {
    id: `v${i}`, orderId: `P${i}`, purchaseTime: "2026-09-22T17:59:01.000Z", date: "2026-09-22",
    status: "pendente", name: `Produto ${i}`, image: null, shopName: "Loja", qty: 1,
    amount: 40.52, commission: 1.22, groupId: null, group: null,
    ...extra,
  };
}

function dados(extra = {}) {
  return {
    from: "2026-09-20",
    to: "2026-09-25",
    summary: {
      orders: 3, units: 14, sales: 730.75,
      commission: { total: 21.93, concluida: 11.59, pendente: 10.34 },
      cancelled: { orders: 1, commission: 1.5 },
      mcnFee: 0,
    },
    days: [
      { date: "2026-09-22", orders: 1, units: 3, sales: 60.52, commission: 1.82 },
      { date: "2026-09-23", orders: 0, units: 0, sales: 0, commission: 0 },
    ],
    groups: [
      { groupId: "123", name: "Ofertas Tech", orders: 1, units: 1, sales: 386.18, commission: 11.59 },
      { groupId: null, name: "Sem grupo", orders: 1, units: 3, sales: 60.52, commission: 1.82 },
    ],
    sales: [
      venda(1, { status: "concluida", name: "Relógio Masculino", qty: 1, amount: 386.18, commission: 11.59, groupId: "123", group: "Ofertas Tech" }),
      venda(2, { name: "Cartas Colecionáveis", qty: 10 }),
      venda(3, { status: "cancelada", name: "Caneca" }),
    ],
    totalSales: 3,
    ...extra,
  };
}

describe("DesempenhoShopee", () => {
  it("cards: comissão dividida em concluída e pendente, cancelado à parte, sem MCN", () => {
    render(<DesempenhoShopee dados={dados()} />);
    expect(screen.getByText(/R\$\s21,93/)).toBeInTheDocument();
    expect(screen.getByText(/R\$\s11,59 concluída · R\$\s10,34 pendente/)).toBeInTheDocument();
    expect(screen.getByText(/R\$\s1,50 de comissão perdida/)).toBeInTheDocument();
    expect(screen.getByText(/R\$\s730,75/)).toBeInTheDocument();
    expect(screen.queryByText(/MCN/)).not.toBeInTheDocument();
    expect(screen.getByText(/não informa cliques/)).toBeInTheDocument();
  });

  it("taxa de MCN aparece quando existe", () => {
    render(<DesempenhoShopee dados={dados({ summary: { ...dados().summary, mcnFee: 0.5 } })} />);
    expect(screen.getByText("Taxa da agência (MCN)")).toBeInTheDocument();
  });

  it("por grupo: uma linha por grupo; a dica só aparece quando nada ainda veio marcado", () => {
    const { unmount } = render(<DesempenhoShopee dados={dados()} />);
    const tabela = screen.getByRole("table");
    expect(within(tabela).getByText("Ofertas Tech")).toBeInTheDocument();
    expect(within(tabela).getByText("Sem grupo")).toBeInTheDocument();
    expect(screen.queryByText(/agora saem marcados com o grupo/)).not.toBeInTheDocument();
    unmount();

    render(<DesempenhoShopee dados={dados({ groups: [{ groupId: null, name: "Sem grupo", orders: 3, units: 14, sales: 730.75, commission: 21.93 }] })} />);
    expect(screen.getByText(/agora saem marcados com o grupo/)).toBeInTheDocument();
  });

  it("vendas: status, quantidade e grupo de cada item", () => {
    render(<DesempenhoShopee dados={dados()} />);
    expect(screen.getByText("Concluída")).toBeInTheDocument();
    expect(screen.getByText("Pendente")).toBeInTheDocument();
    expect(screen.getByText("Cancelada")).toBeInTheDocument();
    expect(screen.getByText("10× Cartas Colecionáveis")).toBeInTheDocument();
    expect(screen.getByText("22/09 · Loja · Ofertas Tech")).toBeInTheDocument();
  });

  it("lista longa mostra 20 e o resto no 'Mostrar mais'; corte do backend é avisado", () => {
    const muitas = Array.from({ length: 45 }, (_, i) => venda(i + 1));
    render(<DesempenhoShopee dados={dados({ sales: muitas, totalSales: 600 })} />);
    expect(screen.getByText("Produto 20")).toBeInTheDocument();
    expect(screen.queryByText("Produto 21")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Mostrar mais (25)" }));
    expect(screen.getByText("Produto 40")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Mostrar mais (5)" }));
    expect(screen.getByText("Produto 45")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Mostrar mais/ })).not.toBeInTheDocument();
    expect(screen.getByText("Mostrando as 45 mais recentes de 600.")).toBeInTheDocument();
  });

  it("período sem venda diz isso", () => {
    render(<DesempenhoShopee dados={dados({
      summary: { orders: 0, units: 0, sales: 0, commission: { total: 0, concluida: 0, pendente: 0 }, cancelled: { orders: 0, commission: 0 }, mcnFee: 0 },
      days: [{ date: "2026-09-22", orders: 0, units: 0, sales: 0, commission: 0 }],
      groups: [], sales: [], totalSales: 0,
    })} />);
    expect(screen.getByText("Sem pedidos no período.")).toBeInTheDocument();
    expect(screen.getByText("Nenhuma venda no período.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});
