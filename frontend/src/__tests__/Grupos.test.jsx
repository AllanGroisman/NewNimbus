// Aba Grupos — estatísticas dos grupos que recebem campanha.
//
// O que estes testes protegem: a tela pede o período e a campanha certos, avisa
// do grupo perto de lotar, abre o detalhe do grupo tocado (e volta), e explica o
// que fazer quando nenhum grupo recebe campanha.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("../data/api", () => ({
  errText: (err, fallback) => err?.message || fallback,
  getGruposEstatisticas: vi.fn(),
  getGrupoEstatisticas: vi.fn(),
}));

import PageGrupos from "../pages/Grupos.jsx";
import { getGruposEstatisticas, getGrupoEstatisticas } from "../data/api";
import { periodoGrupos } from "../data/grupos";

const G1 = "111@g.us";

function grupo(extra = {}) {
  return {
    jid: G1, nome: "Ofertas Tech", numberId: "num-1", autoDuplicate: false,
    campanhas: [{ id: "1", name: "Tech" }],
    membros: 950, membrosEm: "2026-10-06", ocupacao: 0.928, enchendo: true, cap: 1024,
    previsao: { ritmoDia: 10, diasParaLotar: 8, dataPrevista: "2026-10-14", base: "registros", motivo: null },
    entradas: 30, saidas: 12, saldo: 18, envios: 40,
    ...extra,
  };
}

function overview(extra = {}) {
  return {
    from: "2026-09-30", to: "2026-10-06", cap: 1024, enchendoEm: 900, coletandoDesde: "2026-10-01",
    campanhas: [{ id: "1", name: "Tech" }, { id: "2", name: "Casa" }],
    totais: { grupos: 2, membros: 1250, entradas: 35, saidas: 14, saldo: 21, envios: 60 },
    porDia: [
      { date: "2026-09-30", semDados: true },
      { date: "2026-10-01", entradas: 5, saidas: 2, saldo: 3, envios: 8 },
    ],
    grupos: [
      grupo(),
      grupo({ jid: "222@g.us", nome: "Casa e Cozinha", campanhas: [{ id: "2", name: "Casa" }], membros: 300, enchendo: false, previsao: { motivo: "estavel", ritmoDia: 0.1 } }),
    ],
    ...extra,
  };
}

function detalhe() {
  return {
    from: "2026-09-30", to: "2026-10-06", cap: 1024, enchendoEm: 900, coletandoDesde: "2026-10-01",
    grupo: { jid: G1, nome: "Ofertas Tech", campanhas: [{ id: "1", name: "Tech" }], membros: 950, enchendo: true, autoDuplicate: false },
    porDia: [{ date: "2026-10-01", entradas: 5, entradasLink: 4, entradasAdicionados: 1, entradasOutras: 0, saidas: 2, saiu: 2, removidos: 0, saldo: 3, envios: 8, membros: 945 }],
    origem: { entradas: { link: 25, adicionado: 5, outro: 0 }, saidas: { saiu: 10, removido: 2 } },
    permanencia: {
      saidas: 10, comEntrada: 8, semEntrada: 2, medianaMs: 5 * 3600e3, ate1h: 2, ate24h: 6, ate7d: 8,
      pctAte1h: 25, pctAte24h: 75, pctAte7d: 100,
      porOrigem: { join_link: { n: 6, medianaMs: 4 * 3600e3 }, join_added: { n: 2, medianaMs: 30 * 3600e3 }, join_other: { n: 0, medianaMs: null } },
      entraram: 30, aindaNoGrupo: 22,
    },
    aposEnvio: {
      janelaMin: 60, envios: 40, saidas: 10, saidasAposEnvio: 7, pct: 70, mediaPorEnvio: 0.18,
      taxaHora: { aposEnvio: 0.3, foraDeEnvio: 0.1 },
      piores: [{ at: "2026-10-02T15:00:00Z", produto: "Air fryer", saidas: 3 }],
    },
    horarios: {
      entradas: Array.from({ length: 7 }, () => new Array(24).fill(0)),
      saidas: Array.from({ length: 7 }, () => new Array(24).fill(0)),
      destaques: { entradas: [], saidas: [] },
    },
    lotacao: { membros: 950, membrosEm: "2026-10-06", ocupacao: 0.928, enchendo: true, cap: 1024, previsao: { ritmoDia: 10, diasParaLotar: 8, dataPrevista: "2026-10-14", base: "registros", motivo: null } },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PageGrupos", () => {
  it("pede o período padrão (7 dias até hoje) e lista os grupos, avisando do que está enchendo", async () => {
    getGruposEstatisticas.mockResolvedValue(overview());
    render(<PageGrupos />);
    expect(await screen.findByText("Ofertas Tech")).toBeInTheDocument();
    expect(getGruposEstatisticas).toHaveBeenCalledWith({ ...periodoGrupos("7d"), campanha: undefined });
    expect(screen.getByRole("alert")).toHaveTextContent(/Ofertas Tech.*perto de lotar/);
    expect(screen.getByText("Lota em ~8 dias (14/10)")).toBeInTheDocument();
    expect(screen.getByText("Estável")).toBeInTheDocument();
    expect(screen.getByText("+21")).toBeInTheDocument();
    expect(screen.getByText(/Coletando desde 01\/10/)).toBeInTheDocument();
  });

  it("trocar a campanha e o período refaz a consulta", async () => {
    getGruposEstatisticas.mockResolvedValue(overview());
    render(<PageGrupos />);
    await screen.findByText("Ofertas Tech");
    fireEvent.change(screen.getByLabelText("Campanha"), { target: { value: "2" } });
    await waitFor(() => expect(getGruposEstatisticas).toHaveBeenLastCalledWith({ ...periodoGrupos("7d"), campanha: "2" }));
    fireEvent.click(screen.getByRole("button", { name: "30 dias" }));
    await waitFor(() => expect(getGruposEstatisticas).toHaveBeenLastCalledWith({ ...periodoGrupos("30d"), campanha: "2" }));
  });

  it("tocar no grupo abre o detalhe, e o nome da campanha abre a campanha", async () => {
    getGruposEstatisticas.mockResolvedValue(overview());
    getGrupoEstatisticas.mockResolvedValue(detalhe());
    const onOpenCampanha = vi.fn();
    render(<PageGrupos onOpenCampanha={onOpenCampanha} />);
    fireEvent.click(await screen.findByText("Ofertas Tech"));

    expect(await screen.findByText("Origem e permanência")).toBeInTheDocument();
    expect(getGrupoEstatisticas).toHaveBeenCalledWith(G1, periodoGrupos("7d"));
    expect(screen.getByText("5 h")).toBeInTheDocument();
    expect(screen.getByText(/aconteceram até 60 min depois de um envio/)).toBeInTheDocument();
    expect(screen.getByText(/3× mais pessoas/)).toBeInTheDocument();
    expect(screen.getByText("Air fryer")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Tech" }));
    expect(onOpenCampanha).toHaveBeenCalledWith("1");

    fireEvent.click(screen.getByRole("button", { name: "← Todos os grupos" }));
    expect(await screen.findByText("Casa e Cozinha")).toBeInTheDocument();
  });

  it("sem grupo de destino explica onde vincular", async () => {
    getGruposEstatisticas.mockResolvedValue(overview({
      campanhas: [], grupos: [], totais: { grupos: 0, membros: 0, entradas: 0, saidas: 0, saldo: 0, envios: 0 },
    }));
    render(<PageGrupos />);
    expect(await screen.findByText(/Nenhum grupo recebe campanhas ainda/)).toBeInTheDocument();
  });

  it("erro do servidor mostra o motivo com tentar de novo", async () => {
    getGruposEstatisticas.mockRejectedValueOnce(new Error("Banco fora do ar")).mockResolvedValue(overview());
    render(<PageGrupos />);
    expect(await screen.findByText("Banco fora do ar")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    expect(await screen.findByText("Ofertas Tech")).toBeInTheDocument();
  });
});
