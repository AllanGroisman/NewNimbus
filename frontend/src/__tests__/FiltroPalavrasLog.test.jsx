// Histórico → Filtro de palavras da campanha de repasse.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("../data/api", () => ({
  errText: (err, fallback) => err?.message || fallback,
  filtroPalavrasLog: vi.fn(),
}));

import FiltroPalavrasLog from "../components/campaign/FiltroPalavrasLog.jsx";
import { filtroPalavrasLog } from "../data/api";

const ROWS = [
  { id: "1", createdAt: "2026-11-04T12:00:00Z", productName: "Fone JBL", store: "Mercado Livre", price: 99.9, outcome: "queued", wordFilter: "approved", wordFilterReason: 'tem "fone" da lista branca' },
  { id: "2", createdAt: "2026-11-04T11:00:00Z", productName: "Boneca Infantil", store: "Shopee", price: 50, outcome: "discarded", wordFilter: "rejected", wordFilterReason: 'palavra da lista negra: "infantil"' },
];

beforeEach(() => {
  vi.clearAllMocks();
  filtroPalavrasLog.mockResolvedValue({ rows: ROWS, total: 2, page: 1 });
});

describe("FiltroPalavrasLog", () => {
  it("mostra selo, motivo e o que houve depois do aprovado", async () => {
    render(<FiltroPalavrasLog groupId={7} />);
    expect(await screen.findByText("Fone JBL")).toBeInTheDocument();
    expect(screen.getByText("Aprovado")).toBeInTheDocument();
    expect(screen.getByText("Reprovado")).toBeInTheDocument();
    expect(screen.getByText('tem "fone" da lista branca')).toBeInTheDocument();
    expect(screen.getByText('palavra da lista negra: "infantil"')).toBeInTheDocument();
    expect(screen.getByText(/entrou na fila/)).toBeInTheDocument();
  });

  it("trocar o filtro pede de novo à API", async () => {
    render(<FiltroPalavrasLog groupId={7} />);
    await screen.findByText("Fone JBL");
    fireEvent.click(screen.getByRole("button", { name: "Reprovados" }));
    await waitFor(() => expect(filtroPalavrasLog).toHaveBeenLastCalledWith(7, { page: 1, filtro: "rejected" }));
  });

  it("carregar mais pede a próxima página e junta as linhas", async () => {
    filtroPalavrasLog.mockResolvedValueOnce({ rows: [ROWS[0]], total: 2, page: 1 })
      .mockResolvedValueOnce({ rows: [ROWS[1]], total: 2, page: 2 });
    render(<FiltroPalavrasLog groupId={7} />);
    fireEvent.click(await screen.findByRole("button", { name: /Carregar mais/ }));
    expect(await screen.findByText("Boneca Infantil")).toBeInTheDocument();
    expect(screen.getByText("Fone JBL")).toBeInTheDocument();
    expect(filtroPalavrasLog).toHaveBeenLastCalledWith(7, { page: 2, filtro: "" });
  });
});
