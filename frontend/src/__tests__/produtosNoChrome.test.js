// A etapa 2 em LOTES: ativa o lote → colhe as vitrines dele → anuncia salvo →
// próximo lote. O que este arquivo protege é o motivo de existir dos lotes: a
// varredura de 21/09/2026 foi interrompida na ativação e não deixou nada no banco.
// Parar agora perde no máximo o lote em andamento.
import { describe, it, expect, vi, beforeEach } from "vitest";

const api = vi.hoisted(() => ({
  adminMlCuponsAlvosProdutos: vi.fn(),
  adminMlCuponsImportVitrine: vi.fn(),
  adminMlCuponsLocalFim: vi.fn(),
}));
const lista = vi.hoisted(() => ({ percorrerLista: vi.fn() }));
const coletor = vi.hoisted(() => ({ raparVitrine: vi.fn(), fecharAbaDoColetor: vi.fn() }));

vi.mock("../data/api", () => api);
vi.mock("../data/rodadaNoChrome", () => lista);
vi.mock("../data/coletor", () => coletor);

import { umCiclo } from "../data/produtosNoChrome";

const cupom = (i, extra = {}) => ({ campaignId: `C${i}`, title: `Cupom ${i}`, ...extra });
const config = { tamanhoLoteProdutos: 20, activateCoupons: true, maxActivationsPerRun: null, pausaEntreVitrinesMs: 1 };

beforeEach(() => {
  vi.clearAllMocks();
  coletor.raparVitrine.mockResolvedValue({ produtos: [{ name: "x" }, { name: "y" }], parcial: false });
  api.adminMlCuponsImportVitrine.mockResolvedValue({});
  api.adminMlCuponsLocalFim.mockResolvedValue({ resumo: { ativados: 0, salvos: 0 } });
  lista.percorrerLista.mockResolvedValue({ tabId: 1, parado: null, resumo: null });
});

describe("umCiclo em lotes", () => {
  it("45 prontos com lote de 20 viram 3 lotes, cada um anunciado como salvo", async () => {
    const prontos = Array.from({ length: 45 }, (_, i) => cupom(i, { containerUrl: `https://ml/${i}` }));
    api.adminMlCuponsAlvosProdutos.mockResolvedValue({ prontos, precisamAtivar: [], config });
    const eventos = [];

    const r = await umCiclo({ onProgresso: (p) => eventos.push(p) });

    const salvos = eventos.filter(e => e.tipo === "lote-salvo");
    expect(salvos.map(e => e.k)).toEqual([1, 2, 3]);
    expect(salvos.at(-1)).toMatchObject({ lotes: 3, de: 3, vitrines: 45, produtos: 90 });
    expect(r.lotes).toBe(3);
    expect(api.adminMlCuponsImportVitrine).toHaveBeenCalledTimes(45);
  });

  it("Parar no lote 2 deixa o lote 1 gravado e não abre o 3", async () => {
    const prontos = Array.from({ length: 45 }, (_, i) => cupom(i, { containerUrl: `https://ml/${i}` }));
    api.adminMlCuponsAlvosProdutos.mockResolvedValue({ prontos, precisamAtivar: [], config });
    let parar = false;
    // Para depois da 25ª vitrine: no meio do segundo lote.
    api.adminMlCuponsImportVitrine.mockImplementation(async () => {
      if (api.adminMlCuponsImportVitrine.mock.calls.length >= 25) parar = true;
    });
    const eventos = [];

    const r = await umCiclo({ parou: () => parar, onProgresso: (p) => eventos.push(p) });

    expect(r.parado).toMatch(/interrompido/i);
    expect(r.lotes).toBe(1);
    expect(api.adminMlCuponsImportVitrine).toHaveBeenCalledTimes(25);
    const salvos = eventos.filter(e => e.tipo === "lote-salvo");
    expect(salvos).toHaveLength(2);
    expect(salvos[1]).toMatchObject({ k: 2, completo: false, lotes: 1, vitrines: 25 });
    expect(eventos.filter(e => e.tipo === "lote").map(e => e.k)).toEqual([1, 2]);
  });

  it("ativa SÓ o lote da vez, e colhe os recém-ativados antes do próximo lote", async () => {
    const precisamAtivar = Array.from({ length: 25 }, (_, i) => cupom(i));
    const ativadosAteAgora = new Set();
    api.adminMlCuponsAlvosProdutos.mockImplementation(async () => ({
      prontos: [...ativadosAteAgora].map(id => ({ campaignId: id, title: id, containerUrl: `https://ml/${id}` })),
      precisamAtivar: precisamAtivar.filter(c => !ativadosAteAgora.has(c.campaignId)),
      config,
    }));
    lista.percorrerLista.mockImplementation(async ({ ativarApenas }) => {
      for (const id of ativarApenas) ativadosAteAgora.add(id);
      return { tabId: 1, parado: null, resumo: null };
    });
    api.adminMlCuponsLocalFim.mockImplementation(async () => ({ resumo: { ativados: 1 } }));

    const r = await umCiclo({ pular: { ativacao: new Set(), vitrine: new Set() } });

    expect(lista.percorrerLista).toHaveBeenCalledTimes(2);
    expect(lista.percorrerLista.mock.calls[0][0].ativarApenas).toHaveLength(20);
    expect(lista.percorrerLista.mock.calls[1][0].ativarApenas).toHaveLength(5);
    expect(api.adminMlCuponsImportVitrine).toHaveBeenCalledTimes(25);
    expect(r.ativados).toBe(2);
  });

  it("o teto de ativações vale para o ciclo, não para cada lote", async () => {
    const precisamAtivar = Array.from({ length: 50 }, (_, i) => cupom(i));
    api.adminMlCuponsAlvosProdutos.mockResolvedValue({
      prontos: [], precisamAtivar, config: { ...config, maxActivationsPerRun: 10 },
    });

    await umCiclo({});

    expect(lista.percorrerLista).toHaveBeenCalledTimes(1);
    expect(lista.percorrerLista.mock.calls[0][0].ativarApenas).toHaveLength(10);
  });
});

describe("o andamento que o ciclo anuncia (task 7) e o filtro dos parciais (task 11)", () => {
  it("anuncia a fila, cada desfecho e as pausas", async () => {
    const prontos = [1, 2, 3].map(i => cupom(i, { containerUrl: `https://ml/${i}` }));
    api.adminMlCuponsAlvosProdutos.mockResolvedValue({ prontos, precisamAtivar: [], config: { ...config, maxPaginasVitrine: 5 } });
    coletor.raparVitrine
      .mockResolvedValueOnce({ produtos: [{}], parcial: true })
      .mockResolvedValueOnce({ produtos: [], parcial: false, motivo: "sem itens" })
      .mockResolvedValueOnce({ produtos: [{}, {}], parcial: false });
    const eventos = [];

    await umCiclo({ onProgresso: (p) => eventos.push(p) });

    expect(eventos.find(e => e.tipo === "fila")).toMatchObject({ total: 3, prontos: 3, aAtivar: 0, lotes: 1, maxPaginas: 5 });
    const feitos = eventos.filter(e => e.tipo === "vitrine-feita");
    expect(feitos.map(f => [f.campaignId, f.ok, !!f.parcial, !!f.vazia])).toEqual([
      ["C1", true, true, false], ["C2", false, false, true], ["C3", true, false, false],
    ]);
    expect(eventos.filter(e => e.tipo === "pausa").map(e => e.motivo)).toEqual(["entre vitrines", "entre vitrines"]);
  });

  it("o filtro vai ao servidor em todas as leituras da fila", async () => {
    api.adminMlCuponsAlvosProdutos.mockResolvedValue({ prontos: [cupom(1, { containerUrl: "u" })], precisamAtivar: [], config });

    await umCiclo({ soSemProdutos: true });

    expect(api.adminMlCuponsAlvosProdutos).toHaveBeenCalledWith({ soSemProdutos: true });
  });

  it("o cupom escolhido a dedo ignora o filtro", async () => {
    api.adminMlCuponsAlvosProdutos.mockResolvedValue({ prontos: [cupom(1, { containerUrl: "u" })], precisamAtivar: [], config });

    await umCiclo({ campaignIds: ["C1"], soSemProdutos: true });

    expect(api.adminMlCuponsAlvosProdutos).toHaveBeenCalledWith({ campaignId: "C1" });
  });
});
