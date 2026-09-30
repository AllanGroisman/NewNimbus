// Admin › Extensão — o veredito sobre a cópia deste Chrome e o botão de baixar.
//
// O que importa é o veredito: "em dia" quando não está é o que deixa o admin
// preso a uma cópia velha que não entende os comandos novos das telas de cupom.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("../data/api", () => ({
  errText: (err, fallback) => err?.message || fallback,
  adminExtensaoInfo: vi.fn(),
  adminExtensaoBaixar: vi.fn(),
}));

vi.mock("../data/coletor", () => ({
  coletorInfo: vi.fn(),
  _resetColetor: vi.fn(),
}));

import PageAdminExtensao, { compararVersao } from "../pages/AdminExtensao.jsx";
import { adminExtensaoInfo, adminExtensaoBaixar } from "../data/api";
import { coletorInfo, _resetColetor } from "../data/coletor";

beforeEach(() => {
  vi.clearAllMocks();
  adminExtensaoInfo.mockResolvedValue({ nome: "Nimbus — cupons no meu Chrome", versao: "2.4.6" });
});

describe("compararVersao", () => {
  it("compara número a número, não texto", () => {
    expect(compararVersao("2.4.10", "2.4.9")).toBe(1);
    expect(compararVersao("2.4.6", "2.4.6")).toBe(0);
    expect(compararVersao("2.4", "2.4.1")).toBe(-1);
  });
});

describe("Admin › Extensão", () => {
  it("mesma versão: em dia", async () => {
    coletorInfo.mockResolvedValue({ instalada: true, versao: "2.4.6", comandos: [] });
    render(<PageAdminExtensao />);
    expect(await screen.findByText(/Em dia/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Baixar extensão \(v2\.4\.6\)/ })).toBeInTheDocument();
  });

  it("versão antiga: atualização disponível", async () => {
    coletorInfo.mockResolvedValue({ instalada: true, versao: "2.4.5", comandos: [] });
    render(<PageAdminExtensao />);
    expect(await screen.findByText(/Atualização disponível/)).toBeInTheDocument();
  });

  it("sem extensão: diz que não respondeu", async () => {
    coletorInfo.mockResolvedValue({ instalada: false, versao: null, comandos: [] });
    render(<PageAdminExtensao />);
    expect(await screen.findByText(/Não respondeu neste Chrome/)).toBeInTheDocument();
  });

  it("Verificar de novo zera o cache e pergunta outra vez", async () => {
    coletorInfo.mockResolvedValueOnce({ instalada: false, versao: null, comandos: [] })
      .mockResolvedValueOnce({ instalada: true, versao: "2.4.6", comandos: [] });
    render(<PageAdminExtensao />);
    await screen.findByText(/Não respondeu neste Chrome/);
    fireEvent.click(screen.getByRole("button", { name: "Verificar de novo" }));
    expect(await screen.findByText(/Em dia/)).toBeInTheDocument();
    expect(_resetColetor).toHaveBeenCalled();
  });

  it("baixar chama a API e mostra o arquivo", async () => {
    coletorInfo.mockResolvedValue({ instalada: true, versao: "2.4.6", comandos: [] });
    adminExtensaoBaixar.mockResolvedValue({ arquivo: "nimbus-extensao-2.4.6.zip" });
    render(<PageAdminExtensao />);
    fireEvent.click(await screen.findByRole("button", { name: /Baixar extensão/ }));
    await waitFor(() => expect(adminExtensaoBaixar).toHaveBeenCalled());
    expect(await screen.findByText(/Baixado: nimbus-extensao-2\.4\.6\.zip/)).toBeInTheDocument();
  });

  it("erro no download aparece na tela", async () => {
    coletorInfo.mockResolvedValue({ instalada: true, versao: "2.4.6", comandos: [] });
    adminExtensaoBaixar.mockRejectedValue(new Error("Sem permissão."));
    render(<PageAdminExtensao />);
    fireEvent.click(await screen.findByRole("button", { name: /Baixar extensão/ }));
    expect(await screen.findByText("Sem permissão.")).toBeInTheDocument();
  });
});
