// Configurações › Mercado Livre — só o cookie (task 5).
//
// O que importa: não existe mais campo de TAG; "Salvar e testar" manda só o
// cookie e a tela passa a mostrar as etiquetas que vieram da conta, com a padrão
// marcada; "Testar conexão" rebusca as etiquetas e, com uma URL de produto, gera
// um link; config antiga (sem a lista) pede o teste.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("../data/api", () => ({
  errText: (err, fallback) => err?.message || fallback,
  getAffiliateStatus: vi.fn(),
  saveAffiliate: vi.fn(),
  clearAffiliate: vi.fn(),
  testAffiliate: vi.fn(),
  atualizarMLEtiquetas: vi.fn(),
}));

import PageAffiliateML from "../pages/AffiliateML.jsx";
import { getAffiliateStatus, saveAffiliate, testAffiliate, atualizarMLEtiquetas } from "../data/api";

const TAGS = [
  { tag: "allangroisman", inUse: true, createdAt: "2026-07-21 17:27:07" },
  { tag: "grupo-ofertas", inUse: false, createdAt: "2026-09-30 10:00:00" },
];
const vazio = { configured: false, tag: null, tags: [], cookieLength: 0 };
const pronto = { configured: true, healthy: true, tag: "allangroisman", tags: TAGS, cookieLength: 900 };

beforeEach(() => {
  vi.clearAllMocks();
  getAffiliateStatus.mockResolvedValue(vazio);
});

describe("aba Mercado Livre", () => {
  it("não tem mais campo de TAG", async () => {
    render(<PageAffiliateML />);
    await waitFor(() => expect(getAffiliateStatus).toHaveBeenCalled());
    expect(screen.queryByText(/TAG de afiliado/)).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/ab12345678901234/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Salvar e testar" })).toBeDisabled();
  });

  it("Salvar e testar manda só o cookie e mostra as etiquetas da conta", async () => {
    const onAffiliateChange = vi.fn();
    saveAffiliate.mockResolvedValue(pronto);
    render(<PageAffiliateML onAffiliateChange={onAffiliateChange} />);
    await waitFor(() => expect(getAffiliateStatus).toHaveBeenCalled());

    fireEvent.change(screen.getByPlaceholderText(/Cole aqui o cookie/), { target: { value: " ssid=abc " } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar e testar" }));

    expect(await screen.findByText(/Cookie salvo — 2 etiquetas encontradas/)).toBeInTheDocument();
    expect(saveAffiliate).toHaveBeenCalledWith({ cookie: "ssid=abc" });
    expect(onAffiliateChange).toHaveBeenLastCalledWith(pronto);
    expect(screen.getByText("allangroisman · padrão")).toBeInTheDocument();
    expect(screen.getByText("grupo-ofertas")).toBeInTheDocument();
  });

  it("cookie recusado pelo ML: o erro aparece e nada muda", async () => {
    saveAffiliate.mockRejectedValue(new Error("O Mercado Livre não aceitou este cookie (sessão vencida)."));
    render(<PageAffiliateML />);
    await waitFor(() => expect(getAffiliateStatus).toHaveBeenCalled());

    fireEvent.change(screen.getByPlaceholderText(/Cole aqui o cookie/), { target: { value: "ssid=morto" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar e testar" }));

    expect(await screen.findByText(/não aceitou este cookie/)).toBeInTheDocument();
    expect(screen.queryByText("Etiquetas da conta")).not.toBeInTheDocument();
  });

  it("Testar conexão rebusca as etiquetas e, com URL, gera o link", async () => {
    getAffiliateStatus.mockResolvedValue(pronto);
    atualizarMLEtiquetas.mockResolvedValue(pronto);
    testAffiliate.mockResolvedValue({ ok: true, shortUrl: "https://meli.la/abc" });
    render(<PageAffiliateML />);

    fireEvent.click(await screen.findByRole("button", { name: "Testar conexão" }));

    expect(await screen.findByText(/Funcionou! 2 etiquetas encontradas/)).toBeInTheDocument();
    expect(atualizarMLEtiquetas).toHaveBeenCalled();
    expect(testAffiliate).toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "https://meli.la/abc" })).toBeInTheDocument();
  });

  it("Testar conexão sem URL só confere o cookie", async () => {
    getAffiliateStatus.mockResolvedValue(pronto);
    atualizarMLEtiquetas.mockResolvedValue(pronto);
    render(<PageAffiliateML />);

    fireEvent.change(await screen.findByPlaceholderText(/algum-produto/), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Testar conexão" }));

    expect(await screen.findByText(/Conexão OK — 2 etiquetas encontradas/)).toBeInTheDocument();
    expect(testAffiliate).not.toHaveBeenCalled();
  });

  it("config antiga (TAG digitada, sem lista) pede o teste pra carregar as etiquetas", async () => {
    getAffiliateStatus.mockResolvedValue({ ...pronto, tag: "digitada", tags: [] });
    render(<PageAffiliateML />);
    expect(await screen.findByText(/Clique em Testar conexão para carregar as etiquetas/)).toBeInTheDocument();
  });
});
