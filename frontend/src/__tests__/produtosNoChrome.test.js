// A etapa 2 em LOTES: ativa o lote → colhe as vitrines dele → anuncia salvo →
// próximo lote. O que este arquivo protege é o motivo de existir dos lotes: a
// varredura de 21/09/2026 foi interrompida na ativação e não deixou nada no banco.
// Parar agora perde no máximo o lote em andamento.
import { describe, it, expect, vi, beforeEach } from "vitest";

const api = vi.hoisted(() => ({
  adminMlCuponsAlvosProdutos: vi.fn(),
  adminMlCuponsImportVitrine: vi.fn(),
  adminMlCuponsLocalFim: vi.fn(),
  adminMlCuponsCarimbar: vi.fn(),
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
  api.adminMlCuponsCarimbar.mockResolvedValue({ carimbados: 0, limpos: 0 });
  api.adminMlCuponsLocalFim.mockResolvedValue({ resumo: { ativados: 0, salvos: 0 } });
  lista.percorrerLista.mockResolvedValue({ tabId: 1, parado: null, resumo: null });
});

describe("umCiclo em lotes", () => {
  it("o total que a vitrine declara vai junto para o servidor", async () => {
    api.adminMlCuponsAlvosProdutos.mockResolvedValue({ prontos: [cupom(1, { containerUrl: "https://ml/1" })], precisamAtivar: [], config });
    coletor.raparVitrine.mockResolvedValue({ produtos: [{ name: "x" }], parcial: true, total: 200 });

    await umCiclo({});

    expect(api.adminMlCuponsImportVitrine).toHaveBeenCalledWith("C1", expect.objectContaining({ total: 200 }));
  });

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

// Task 14: vitrines em paralelo, ativação do próximo lote sobreposta à colheita e
// o carimbo do catálogo uma vez por lote.
describe("umCiclo em paralelo (task 14)", () => {
  const prontosN = (n) => Array.from({ length: n }, (_, i) => cupom(i, { containerUrl: `https://ml/${i}` }));
  const devagar = (ms = 5) => new Promise(r => setTimeout(r, ms));

  it("com vitrinesEmParalelo: 2 nunca passa de 2 abas de vitrine, e colhe todas", async () => {
    api.adminMlCuponsAlvosProdutos.mockResolvedValue({ prontos: prontosN(7), precisamAtivar: [], config: { ...config, vitrinesEmParalelo: 2 } });
    let emVoo = 0;
    let pico = 0;
    coletor.raparVitrine.mockImplementation(async () => {
      emVoo++; pico = Math.max(pico, emVoo);
      await devagar();
      emVoo--;
      return { produtos: [{}], parcial: false };
    });

    const r = await umCiclo({});

    expect(pico).toBe(2);
    expect(r.feitos).toHaveLength(7);
    expect(new Set(api.adminMlCuponsImportVitrine.mock.calls.map(c => c[0])).size).toBe(7);
    expect(api.adminMlCuponsImportVitrine.mock.calls.every(c => c[1].carimbar === false)).toBe(true);
  });

  it("sem o número na config continua uma vitrine por vez", async () => {
    api.adminMlCuponsAlvosProdutos.mockResolvedValue({ prontos: prontosN(4), precisamAtivar: [], config });
    let emVoo = 0;
    let pico = 0;
    coletor.raparVitrine.mockImplementation(async () => {
      emVoo++; pico = Math.max(pico, emVoo);
      await devagar();
      emVoo--;
      return { produtos: [{}], parcial: false };
    });

    await umCiclo({});

    expect(pico).toBe(1);
  });

  it("o muro numa aba fecha a porta: nenhuma vitrine nova começa", async () => {
    api.adminMlCuponsAlvosProdutos.mockResolvedValue({ prontos: prontosN(10), precisamAtivar: [], config: { ...config, vitrinesEmParalelo: 2 } });
    coletor.raparVitrine.mockImplementation(async (url, { onProgresso }) => {
      if (url === "https://ml/1") onProgresso({ tipo: "muro", muro: "captcha" });
      await devagar();
      return { produtos: [{}], parcial: url === "https://ml/1" };
    });

    const r = await umCiclo({});

    expect(r.muro).toBe(true);
    expect(r.parado).toMatch(/verificação/);
    // As duas que já estavam abertas terminam; a porta fecha para as outras 8.
    expect(coletor.raparVitrine.mock.calls.length).toBeLessThanOrEqual(3);
    expect(api.adminMlCuponsCarimbar).toHaveBeenCalledTimes(1);
  });

  it("carimba o catálogo uma vez por lote, e também quando para no meio", async () => {
    api.adminMlCuponsAlvosProdutos.mockResolvedValue({ prontos: prontosN(45), precisamAtivar: [], config: { ...config, vitrinesEmParalelo: 3 } });
    await umCiclo({});
    expect(api.adminMlCuponsCarimbar).toHaveBeenCalledTimes(3);

    vi.clearAllMocks();
    api.adminMlCuponsCarimbar.mockResolvedValue({});
    coletor.raparVitrine.mockResolvedValue({ produtos: [{}], parcial: false });
    let parar = false;
    api.adminMlCuponsImportVitrine.mockImplementation(async () => { parar = true; });
    const r = await umCiclo({ parou: () => parar });
    expect(r.parado).toMatch(/interrompido/i);
    expect(api.adminMlCuponsCarimbar).toHaveBeenCalledTimes(1);
  });

  it("ativa o lote 2 enquanto o lote 1 colhe — nunca duas ativações de uma vez", async () => {
    // Lote 1: 2 prontos. Lote 2: 2 que precisam ativar.
    const ativadosAteAgora = new Set();
    const aAtivar = [cupom(10), cupom(11)];
    api.adminMlCuponsAlvosProdutos.mockImplementation(async () => ({
      prontos: [
        ...prontosN(2),
        ...[...ativadosAteAgora].map(id => ({ campaignId: id, title: id, containerUrl: `https://ml/${id}` })),
      ],
      precisamAtivar: aAtivar.filter(c => !ativadosAteAgora.has(c.campaignId)),
      config: { ...config, tamanhoLoteProdutos: 2, vitrinesEmParalelo: 2 },
    }));
    const linha = [];
    let ativacoes = 0;
    lista.percorrerLista.mockImplementation(async ({ ativarApenas }) => {
      ativacoes++;
      expect(ativacoes).toBe(1);
      linha.push("ativacao-inicio");
      await devagar(3);
      for (const id of ativarApenas) ativadosAteAgora.add(id);
      linha.push("ativacao-fim");
      ativacoes--;
      return { tabId: 9, parado: null, resumo: null };
    });
    coletor.raparVitrine.mockImplementation(async (url) => {
      linha.push(`vitrine ${url}`);
      await devagar(10);
      return { produtos: [{}], parcial: false };
    });
    const pular = { ativacao: new Set(), vitrine: new Set() };

    const r = await umCiclo({ pular });

    expect(lista.percorrerLista).toHaveBeenCalledTimes(1);
    // A ativação começou antes de a primeira vitrine do lote 1 terminar.
    expect(linha.indexOf("ativacao-inicio")).toBeLessThan(linha.indexOf("vitrine https://ml/C10"));
    expect(linha.slice(0, 3)).toContain("ativacao-inicio");
    expect(r.feitos.map(f => f.campaignId).sort()).toEqual(["C0", "C1", "C10", "C11"]);
    expect(api.adminMlCuponsLocalFim).toHaveBeenCalledTimes(1);
    // Sem pausa "entre lotes": a ativação já correu durante a colheita.
    expect(r.parado).toBeNull();
  });

  it("parar no meio espera a ativação de fundo chamar o local/fim antes de devolver", async () => {
    api.adminMlCuponsAlvosProdutos.mockResolvedValue({
      prontos: prontosN(2), precisamAtivar: [cupom(10), cupom(11)],
      config: { ...config, tamanhoLoteProdutos: 2, vitrinesEmParalelo: 2 },
    });
    let parar = false;
    lista.percorrerLista.mockImplementation(async ({ parou }) => {
      while (!parou()) await devagar(2);
      return { tabId: 9, parado: "Interrompido por você", resumo: null };
    });
    coletor.raparVitrine.mockImplementation(async () => { await devagar(5); parar = true; return { produtos: [{}], parcial: false }; });

    const r = await umCiclo({ parou: () => parar });

    expect(r.parado).toMatch(/interrompido/i);
    expect(api.adminMlCuponsLocalFim).toHaveBeenCalledWith({ cancelada: true });
    expect(coletor.fecharAbaDoColetor).toHaveBeenCalledWith(9);
  });
});
