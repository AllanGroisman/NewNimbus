// Configurações › Mercado Livre — a troca da "Etiqueta em uso", só de admin.
//
// O que importa: quem não é admin não vê nada novo; o admin vê a lista que veio
// do ML, troca, e a tela passa a mostrar a TAG nova; e o aviso quando a TAG
// salva nem é da conta (link sem comissão).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("../data/api", () => ({
  errText: (err, fallback) => err?.message || fallback,
  getAffiliateStatus: vi.fn(),
  saveAffiliate: vi.fn(),
  clearAffiliate: vi.fn(),
  testAffiliate: vi.fn(),
  getMLEtiquetas: vi.fn(),
  trocarMLEtiqueta: vi.fn(),
}));

import PageAffiliateML from "../pages/AffiliateML.jsx";
import { getAffiliateStatus, getMLEtiquetas, trocarMLEtiqueta } from "../data/api";

const status = (tag) => ({ configured: true, healthy: true, tag, cookieLength: 900 });
const TAGS = [
  { tag: "allangroisman", inUse: true, createdAt: "2026-07-21 17:27:07" },
  { tag: "grupo-ofertas", inUse: false, createdAt: "2026-09-30 10:00:00" },
];

beforeEach(() => {
  vi.clearAllMocks();
  getAffiliateStatus.mockResolvedValue(status("allangroisman"));
  getMLEtiquetas.mockResolvedValue({ tags: TAGS, current: "allangroisman" });
});

describe("Etiqueta em uso", () => {
  it("quem não é admin não vê a troca", async () => {
    render(<PageAffiliateML />);
    await waitFor(() => expect(getAffiliateStatus).toHaveBeenCalled());
    await screen.findByDisplayValue("allangroisman");   // o campo TAG de sempre
    expect(screen.queryByText(/Etiqueta em uso/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Trocar etiqueta" })).not.toBeInTheDocument();
  });

  it("admin sem cookie salvo não vê a troca", async () => {
    getAffiliateStatus.mockResolvedValue({ configured: false, tag: null });
    render(<PageAffiliateML isAdmin />);
    await waitFor(() => expect(getAffiliateStatus).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Trocar etiqueta" })).not.toBeInTheDocument();
  });

  it("admin busca a lista no ML, troca e a tela passa a mostrar a nova", async () => {
    const onAffiliateChange = vi.fn();
    trocarMLEtiqueta.mockResolvedValue({
      tags: TAGS.map(t => ({ ...t, inUse: t.tag === "grupo-ofertas" })),
      current: "grupo-ofertas",
      status: status("grupo-ofertas"),
    });
    render(<PageAffiliateML isAdmin onAffiliateChange={onAffiliateChange} />);

    fireEvent.click(await screen.findByRole("button", { name: "Trocar etiqueta" }));
    const select = await screen.findByRole("combobox", { name: "Etiqueta" });
    expect(select.value).toBe("allangroisman");
    expect(screen.getByRole("option", { name: "allangroisman (em uso no ML)" })).toBeInTheDocument();

    // A atual já é a em uso aqui e no ML: nada a trocar.
    expect(screen.getByRole("button", { name: "Usar esta etiqueta" })).toBeDisabled();

    fireEvent.change(select, { target: { value: "grupo-ofertas" } });
    fireEvent.click(screen.getByRole("button", { name: "Usar esta etiqueta" }));

    expect(await screen.findByText(/os próximos links saem com grupo-ofertas/)).toBeInTheDocument();
    expect(trocarMLEtiqueta).toHaveBeenCalledWith("grupo-ofertas");
    expect(onAffiliateChange).toHaveBeenLastCalledWith(status("grupo-ofertas"));
    expect(screen.getByDisplayValue("grupo-ofertas")).toBeInTheDocument();   // o campo TAG acompanhou
  });

  it("erro do ML aparece na tela", async () => {
    getMLEtiquetas.mockRejectedValue(new Error("O cookie do Mercado Livre venceu — cole um novo nesta aba."));
    render(<PageAffiliateML isAdmin />);
    fireEvent.click(await screen.findByRole("button", { name: "Trocar etiqueta" }));
    expect(await screen.findByText(/cookie do Mercado Livre venceu/)).toBeInTheDocument();
  });

  it("avisa quando a TAG salva não é da conta", async () => {
    getAffiliateStatus.mockResolvedValue(status("digitada-errada"));
    render(<PageAffiliateML isAdmin />);
    fireEvent.click(await screen.findByRole("button", { name: "Trocar etiqueta" }));
    expect(await screen.findByText(/digitada-errada\) não está entre as etiquetas desta conta/)).toBeInTheDocument();
  });
});
