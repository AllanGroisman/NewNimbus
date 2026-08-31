// Admin › Cupom › aba "Cupons do ML" — a rodada, a lista e a colheita de vitrine.
//
// O testador de PALAVRA saiu daqui pra aba vizinha; os testes dele estão em
// AdminCupomPalavra.test.jsx.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("../data/api", () => ({
  // errText é helper puro (não faz rede) — usa a implementação de verdade.
  errText: (err, fallback) => err?.message || fallback,
  adminMlCupons: vi.fn(),
  adminMlCuponsStatus: vi.fn(),
  adminMlCuponsRun: vi.fn(),
  adminMlCuponsCancel: vi.fn(),
  adminMlCuponsSaveConfig: vi.fn(),
  adminMlCuponsProducts: vi.fn(),
  adminMlCuponsSyncProducts: vi.fn(),
  adminMlCuponsClearAll: vi.fn(),
  adminMlCuponsImportVitrine: vi.fn(),
}));

// A extensão que colhe a vitrine no Chrome do admin (extension/ na raiz). Aqui ela
// é fingida: o que se testa é a tela reagindo ao que ela devolve.
vi.mock("../data/coletor", () => ({
  coletorPronto: vi.fn(),
  raparVitrine: vi.fn(),
}));

import PageCuponsML from "../pages/AdminCupomML.jsx";
import {
  adminMlCupons,
  adminMlCuponsStatus,
  adminMlCuponsImportVitrine,
} from "../data/api";
import { coletorPronto, raparVitrine } from "../data/coletor";

const VAZIO = { items: [], total: 0, page: 1, pageSize: 50 };

async function abrirTela() {
  render(<PageCuponsML />);
  await waitFor(() => expect(adminMlCupons).toHaveBeenCalled());
}

beforeEach(() => {
  vi.clearAllMocks();
  adminMlCuponsStatus.mockResolvedValue({ config: {}, running: false });
  adminMlCupons.mockResolvedValue(VAZIO);
  // Sem extensão é o estado padrão: a maioria dos testes desta tela não fala dela.
  coletorPronto.mockResolvedValue(false);
});


// ─────────────────────────────────────────────────────────────────────────
// Colher a vitrine na aba do próprio Chrome (extension/)
// ─────────────────────────────────────────────────────────────────────────
//
// Por que existe: a vitrine do cupom responde CAPTCHA para o navegador do
// servidor — o botão "raspar" volta de mãos vazias. Numa aba do Chrome do admin,
// com a sessão dele, é só uma página, e a extensão é a única peça que consegue ler
// o conteúdo dela.
//
// O que se protege aqui é o campo `parcial`. Coleta interrompida (o ML pediu
// verificação, ou a lista não acabou) viu um PEDAÇO da vitrine. Se esse pedaço
// entrar como lista fechada, o sistema passa a responder "esse cupom não vale
// aqui" para produto que o cupom cobre — que é o prejuízo que a ferramenta existe
// pra evitar.
// ── A rodada do servidor ────────────────────────────────────────────────────
// O log dela é montado no backend (coupons/sync.js) e chega pelo status. Aqui só
// se testa que a tela mostra o que chegou — e que, parada a rodada, o resumo
// aparece em vez da frase corrida de antes.
describe("o passo a passo da rodada do servidor", () => {
  it("mostra as linhas do log enquanto a rodada corre", async () => {
    adminMlCuponsStatus.mockResolvedValue({
      config: {}, running: true,
      log: [
        { at: "2026-08-31T12:00:00.000Z", tipo: "info", texto: "lendo a lista geral — página 1/3, 40 cupons" },
        { at: "2026-08-31T12:01:00.000Z", tipo: "aviso", texto: "o ML pediu verificação" },
      ],
    });
    await abrirTela();

    expect(await screen.findByText(/lendo a lista geral — página 1\/3/)).toBeInTheDocument();
    expect(screen.getByText("o ML pediu verificação")).toBeInTheDocument();
  });

  it("terminada a rodada, o balanço vira números em vez de uma frase corrida", async () => {
    adminMlCuponsStatus.mockResolvedValue({
      config: {}, running: false,
      lastRun: "2026-08-31T12:00:00.000Z",
      lastDuration: 92000,
      lastResult: { cupons: 120, novos: 7, ativados: 3, vinculos: 4100, catalogoCarimbado: 88, cuponsDeLojaIgnorados: 12 },
      log: [],
    });
    await abrirTela();

    expect(await screen.findByText(/Última rodada —/)).toBeInTheDocument();
    expect(screen.getByText("Cupons").previousSibling).toHaveTextContent("120");
    expect(screen.getByText("Novos").previousSibling).toHaveTextContent("7");
    expect(screen.getByText("Duração").previousSibling).toHaveTextContent("92s");
  });
});

describe("colher a vitrine no Chrome do admin", () => {
  const COM_VITRINE = {
    items: [{
      campaignId: "13471229", title: "15% OFF BRINCADEIRAS", scope: "campaign", activated: true,
      products: 0, inCatalog: 0, kind: "percent", value: 15,
      containerUrl: "https://lista.mercadolivre.com.br/_Container_toys?coupon_campaign_id=13471229",
    }],
    total: 1, page: 1, pageSize: 50,
  };
  const produto = { name: "Boneco", link: "https://www.mercadolivre.com.br/x/p/MLB1", price: 25.9 };

  it("sem a extensão o botão não existe, e a tela diz onde ele foi parar", async () => {
    adminMlCupons.mockResolvedValue(COM_VITRINE);
    await abrirTela();

    expect(await screen.findByText(/Carregar sem compactação/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /no meu Chrome/i })).not.toBeInTheDocument();
  });

  it("com a extensão, o que veio inteiro é gravado como lista fechada", async () => {
    coletorPronto.mockResolvedValue(true);
    adminMlCupons.mockResolvedValue(COM_VITRINE);
    raparVitrine.mockResolvedValue({ produtos: [produto], parcial: false, motivo: null, paginas: 1 });
    adminMlCuponsImportVitrine.mockResolvedValue({ ok: true, produtos: 1, parcial: false });
    await abrirTela();

    fireEvent.click(await screen.findByRole("button", { name: /no meu Chrome/i }));

    await waitFor(() => expect(adminMlCuponsImportVitrine).toHaveBeenCalledWith(
      "13471229", { products: [produto], parcial: false },
    ));
    // O desfecho vira resumo, não uma linha que some: o número gravado aparece
    // no balanço, e o passo a passo fica no log acima dele.
    expect(await screen.findByText(/Vitrine de .* colhida/)).toBeInTheDocument();
    expect(screen.getByText("Produtos gravados")).toBeInTheDocument();
    expect(await screen.findByText(/1 produto\(s\) gravado\(s\)/)).toBeInTheDocument();
  });

  it("o que parou no meio vai marcado como parcial — e a tela avisa", async () => {
    coletorPronto.mockResolvedValue(true);
    adminMlCupons.mockResolvedValue(COM_VITRINE);
    raparVitrine.mockResolvedValue({ produtos: [produto], parcial: true, motivo: "o Mercado Livre pediu verificação", paginas: 1 });
    adminMlCuponsImportVitrine.mockResolvedValue({ ok: true, produtos: 1, parcial: true });
    await abrirTela();

    fireEvent.click(await screen.findByRole("button", { name: /no meu Chrome/i }));

    await waitFor(() => expect(adminMlCuponsImportVitrine).toHaveBeenCalledWith(
      "13471229", { products: [produto], parcial: true },
    ));
    // Aparece duas vezes de propósito — na linha do log e na nota do resumo — e
    // é por isso que a asserção é `findAllBy`.
    expect((await screen.findAllByText(/parcial/)).length).toBeGreaterThan(0);
  });

  // ── O lote ────────────────────────────────────────────────────────────────
  // O que se testa aqui é quando ele PARA. Um laço que colhe tudo é fácil; um que
  // sabe desistir é o que impede a conta do admin de virar verificação.

  const TRES = {
    items: ["1", "2", "3"].map(id => ({
      campaignId: id, title: `Cupom ${id}`, scope: "campaign", activated: true,
      products: 0, inCatalog: 0, kind: "percent", value: 10,
      containerUrl: `https://lista.mercadolivre.com.br/_Container_${id}?coupon_campaign_id=${id}`,
    })),
    total: 3, page: 1, pageSize: 50,
  };

  it("colhe os cupons um a um, na ordem, sem paralelizar", async () => {
    coletorPronto.mockResolvedValue(true);
    adminMlCupons.mockResolvedValue(TRES);
    let abertasAoMesmoTempo = 0, pico = 0;
    raparVitrine.mockImplementation(async () => {
      pico = Math.max(pico, ++abertasAoMesmoTempo);
      await new Promise(r => setTimeout(r, 1));
      abertasAoMesmoTempo--;
      return { produtos: [produto], parcial: false, motivo: null, paginas: 1 };
    });
    adminMlCuponsImportVitrine.mockResolvedValue({ ok: true, produtos: 1, parcial: false });
    await abrirTela();

    fireEvent.click(await screen.findByRole("button", { name: /Colher todas as vitrines \(3\)/i }));

    await waitFor(() => expect(adminMlCuponsImportVitrine).toHaveBeenCalledTimes(3), { timeout: 20000 });
    // Uma aba por vez: o ML ver três listagens simultâneas da mesma conta é
    // exatamente o que a pausa entre cupons existe para evitar.
    expect(pico).toBe(1);
    expect(adminMlCuponsImportVitrine.mock.calls.map(c => c[0])).toEqual(["1", "2", "3"]);
  }, 25000);

  it("para no primeiro muro em vez de seguir para o próximo cupom", async () => {
    coletorPronto.mockResolvedValue(true);
    adminMlCupons.mockResolvedValue(TRES);
    // O muro chega pelo progresso, do jeito que a extensão avisa: ela traz a aba
    // para a frente e espera o humano. O cupom até pode terminar bem — mas a
    // sessão já foi questionada, e é aí que o lote desiste.
    raparVitrine.mockImplementation(async (_url, { onProgresso }) => {
      onProgresso({ tipo: "muro" });
      return { produtos: [produto], parcial: true, motivo: null, paginas: 1 };
    });
    adminMlCuponsImportVitrine.mockResolvedValue({ ok: true, produtos: 1, parcial: true });
    await abrirTela();

    fireEvent.click(await screen.findByRole("button", { name: /Colher todas as vitrines/i }));

    // Duas vezes: a linha do log e a nota do resumo.
    expect((await screen.findAllByText(/pediu verificação — parei aqui de propósito/)).length).toBe(2);
    expect(await screen.findByText("Colheita interrompida")).toBeInTheDocument();
    // O primeiro foi gravado (os produtos dele são reais); o segundo nem começou.
    expect(raparVitrine).toHaveBeenCalledTimes(1);
    expect(adminMlCuponsImportVitrine).toHaveBeenCalledTimes(1);
  });

  it("cupom sem vitrine não entra no lote — não há o que abrir", async () => {
    coletorPronto.mockResolvedValue(true);
    adminMlCupons.mockResolvedValue({
      items: [{ ...TRES.items[0], containerUrl: null }, TRES.items[1]],
      total: 2, page: 1, pageSize: 50,
    });
    await abrirTela();

    // O número no botão é a promessa do que ele vai percorrer.
    expect(await screen.findByRole("button", { name: /Colher todas as vitrines \(1\)/i })).toBeInTheDocument();
  });

  // ── O resumo ──────────────────────────────────────────────────────────────
  // O lote demorava minutos e terminava numa frase que sumia. O que se testa aqui
  // é o balanço: quantas vitrines, quantos produtos, e o que deu errado em cada
  // cupom — sem isso, "colhi tudo" e "colhi metade" são a mesma tela.

  it("o lote termina com um resumo do que foi buscado, cupom a cupom", async () => {
    coletorPronto.mockResolvedValue(true);
    adminMlCupons.mockResolvedValue(TRES);
    // O do meio volta vazio: o resumo tem que contar os três desfechos diferentes.
    raparVitrine.mockImplementation(async (url) => (
      url.includes("_Container_2")
        ? { produtos: [], parcial: false, motivo: "vitrine fora do ar", paginas: 1 }
        : { produtos: [produto], parcial: false, motivo: null, paginas: 1 }
    ));
    adminMlCuponsImportVitrine.mockResolvedValue({ ok: true, produtos: 4, parcial: false });
    await abrirTela();

    fireEvent.click(await screen.findByRole("button", { name: /Colher todas as vitrines \(3\)/i }));

    expect(await screen.findByText("Colheita terminada", {}, { timeout: 20000 })).toBeInTheDocument();
    // 2 colhidas de 3 tentadas, 4 produtos cada.
    expect(screen.getByText("Colhidas").previousSibling).toHaveTextContent("2");
    expect(screen.getByText("Produtos gravados").previousSibling).toHaveTextContent("8");
    expect(screen.getByText("Vitrine vazia").previousSibling).toHaveTextContent("1");
    // A tabela nomeia quem falhou, em vez de só contar.
    expect(screen.getByText(/vitrine vazia — vitrine fora do ar/)).toBeInTheDocument();
  }, 25000);

  it("o resumo conta o que ficou de fora quando o lote é interrompido", async () => {
    coletorPronto.mockResolvedValue(true);
    adminMlCupons.mockResolvedValue(TRES);
    raparVitrine.mockImplementation(async (_url, { onProgresso }) => {
      onProgresso({ tipo: "muro" });
      return { produtos: [produto], parcial: true, motivo: null, paginas: 1 };
    });
    adminMlCuponsImportVitrine.mockResolvedValue({ ok: true, produtos: 1, parcial: true });
    await abrirTela();

    fireEvent.click(await screen.findByRole("button", { name: /Colher todas as vitrines/i }));

    expect(await screen.findByText("Colheita interrompida")).toBeInTheDocument();
    // Prometer 3 e entregar 1 é exatamente o que o resumo existe para mostrar.
    expect(screen.getByText("Vitrines na página").previousSibling).toHaveTextContent("3");
    expect(screen.getByText("Tentadas").previousSibling).toHaveTextContent("1");
    expect(screen.getByText("Colhidas").previousSibling).toHaveTextContent("1");
  });

  it("vitrine vazia não vira gravação — não se apaga o que já existe por nada", async () => {
    coletorPronto.mockResolvedValue(true);
    adminMlCupons.mockResolvedValue(COM_VITRINE);
    raparVitrine.mockResolvedValue({ produtos: [], parcial: true, motivo: "o Mercado Livre pediu verificação", paginas: 1 });
    await abrirTela();

    fireEvent.click(await screen.findByRole("button", { name: /no meu Chrome/i }));

    // O erro no topo e a nota do resumo dizem a mesma coisa — é o mesmo desfecho
    // visto de dois lugares.
    expect((await screen.findAllByText(/não devolveu produto nenhum/)).length).toBeGreaterThan(0);
    expect(adminMlCuponsImportVitrine).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// A categoria do cupom
// ─────────────────────────────────────────────────────────────────────────
//
// O ML separa os cupons por categoria e o sistema guarda em quais cada um
// apareceu — como chave crua (`ce_vertical`). O nome bonito vem do dicionário que
// o backend mescla a cada rodada; sem ele a tela mostra a chave, que ainda diz
// mais do que um traço.
describe("categoria dos cupons", () => {
  const cupom = (extra = {}) => ({
    campaignId: "13907402", title: "20% OFF", subtitle: null, kind: "percent", value: 20,
    scope: "campaign", activated: true, products: 3, inCatalog: 1, groupings: ["ce_vertical"], ...extra,
  });

  beforeEach(() => {
    adminMlCuponsStatus.mockResolvedValue({
      config: {}, running: false,
      groupingLabels: { ce_vertical: "Eletrônicos", tb_vertical: "Moda" },
      stats: { cupons: 2, porCategoria: [{ chave: "ce_vertical", n: 2 }, { chave: "tb_vertical", n: 1 }] },
    });
  });

  it("mostra o nome da categoria na linha, e a chave crua quando não há nome", async () => {
    adminMlCupons.mockResolvedValue({
      ...VAZIO, total: 2,
      items: [cupom(), cupom({ campaignId: "999", title: "R$ 30 OFF", groupings: ["xx_vertical"] })],
    });
    await abrirTela();

    expect(await screen.findByText("Eletrônicos")).toBeInTheDocument();
    expect(screen.getByText("xx_vertical")).toBeInTheDocument();
  });

  it("cupom em mais de uma categoria mostra as duas", async () => {
    adminMlCupons.mockResolvedValue({ ...VAZIO, total: 1, items: [cupom({ groupings: ["ce_vertical", "tb_vertical"] })] });
    await abrirTela();

    expect(await screen.findByText("Eletrônicos · Moda")).toBeInTheDocument();
  });

  it("o filtro pede a categoria ao backend", async () => {
    adminMlCupons.mockResolvedValue({ ...VAZIO, total: 1, items: [cupom()] });
    await abrirTela();

    // As opções saem da contagem LOCAL, com quantos cupons há em cada uma.
    const filtro = await screen.findByDisplayValue("todas as categorias");
    expect(screen.getByRole("option", { name: "Moda (1)" })).toBeInTheDocument();
    fireEvent.change(filtro, { target: { value: "tb_vertical" } });

    await waitFor(() => {
      expect(adminMlCupons).toHaveBeenLastCalledWith(expect.objectContaining({ grouping: "tb_vertical" }));
    });
  });

  it("sem categoria nenhuma colhida, o filtro nem aparece", async () => {
    adminMlCuponsStatus.mockResolvedValue({ config: {}, running: false, groupingLabels: {}, stats: { cupons: 1, porCategoria: [] } });
    adminMlCupons.mockResolvedValue({ ...VAZIO, total: 1, items: [cupom({ groupings: [] })] });
    await abrirTela();

    await screen.findByText("20% OFF");
    expect(screen.queryByDisplayValue("todas as categorias")).toBe(null);
    // Sem categoria, a coluna fica com o traço em vez de vazia.
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });
});
