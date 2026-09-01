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
  adminMlCuponsLocalStart: vi.fn(),
  adminMlCuponsLocalAtivar: vi.fn(),
  adminMlCuponsLocalPagina: vi.fn(),
  adminMlCuponsLocalFim: vi.fn(),
}));

// A extensão que colhe a vitrine no Chrome do admin (extension/ na raiz). Aqui ela
// é fingida: o que se testa é a tela reagindo ao que ela devolve.
vi.mock("../data/coletor", () => ({
  coletorInfo: vi.fn(),
  raparVitrine: vi.fn(),
  paginaDeCupons: vi.fn(),
  fecharAbaDoColetor: vi.fn(),
}));

import PageCuponsML from "../pages/AdminCupomML.jsx";
import {
  adminMlCupons,
  adminMlCuponsStatus,
  adminMlCuponsSaveConfig,
  adminMlCuponsImportVitrine,
  adminMlCuponsLocalStart,
  adminMlCuponsLocalAtivar,
  adminMlCuponsLocalPagina,
  adminMlCuponsLocalFim,
} from "../data/api";
import { coletorInfo, raparVitrine, paginaDeCupons, fecharAbaDoColetor } from "../data/coletor";

// A extensão instalada, e quais comandos aquela cópia entende. A tela pergunta os
// dois: uma cópia da versão 1.0 responde ao ping e não conhece "lista".
const EXTENSAO = (...comandos) => ({ instalada: true, versao: "2.0.0", comandos });

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
  coletorInfo.mockResolvedValue({ instalada: false, versao: null, comandos: [] });
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
    coletorInfo.mockResolvedValue(EXTENSAO("raspar"));
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
    coletorInfo.mockResolvedValue(EXTENSAO("raspar"));
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
    coletorInfo.mockResolvedValue(EXTENSAO("raspar"));
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
    coletorInfo.mockResolvedValue(EXTENSAO("raspar"));
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
    coletorInfo.mockResolvedValue(EXTENSAO("raspar"));
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
    coletorInfo.mockResolvedValue(EXTENSAO("raspar"));
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
    coletorInfo.mockResolvedValue(EXTENSAO("raspar"));
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
    coletorInfo.mockResolvedValue(EXTENSAO("raspar"));
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

    // Na CÉLULA da tabela: o nome também aparece no seletor de categorias do
    // painel de limites, que é outra coisa (o que a próxima rodada vai varrer).
    expect(await screen.findByRole("cell", { name: "Eletrônicos" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "xx_vertical" })).toBeInTheDocument();
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

  // O seletor da config é outra coisa do filtro acima: o filtro é sobre o que JÁ
  // foi colhido, o seletor é sobre o que a próxima rodada vai varrer. Ele não
  // existia — e por isso uma config antiga presa em `["tb_vertical"]` deixou a
  // rodada puxando só de Brinquedos sem nenhum jeito de sair pela tela (task 26).
  it("o painel de limites deixa escolher as categorias da rodada", async () => {
    adminMlCupons.mockResolvedValue({ ...VAZIO, total: 1, items: [cupom()] });
    await abrirTela();

    fireEvent.click(await screen.findByText("Limites da rodada"));
    // Nenhuma marcada é o estado bom, e a tela diz isso com todas as letras.
    expect(screen.getByText("varre todas as categorias")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: "Eletrônicos" }));
    fireEvent.click(screen.getByRole("button", { name: "salvar" }));

    await waitFor(() => {
      expect(adminMlCuponsSaveConfig).toHaveBeenCalledWith(expect.objectContaining({ groupings: ["ce_vertical"] }));
    });
  });

  it("a config presa numa categoria tem como voltar a varrer todas", async () => {
    adminMlCuponsStatus.mockResolvedValue({
      config: { groupings: ["tb_vertical"] }, running: false,
      groupingLabels: { ce_vertical: "Eletrônicos", tb_vertical: "Moda" },
      stats: { cupons: 1, porCategoria: [{ chave: "tb_vertical", n: 1 }] },
    });
    adminMlCupons.mockResolvedValue({ ...VAZIO, total: 1, items: [cupom()] });
    await abrirTela();

    fireEvent.click(await screen.findByText("Limites da rodada"));
    expect(screen.getByText("1 escolhida")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "varrer todas" }));
    fireEvent.click(screen.getByRole("button", { name: "salvar" }));

    await waitFor(() => {
      expect(adminMlCuponsSaveConfig).toHaveBeenCalledWith(expect.objectContaining({ groupings: [] }));
    });
  });

  it("filtro do ML não é categoria: price e percentage não entram no seletor", async () => {
    adminMlCuponsStatus.mockResolvedValue({
      config: {}, running: false,
      groupingLabels: { ce_vertical: "Eletrônicos", price: "Mais de R$100", percentage: "Mais de 10%" },
      stats: { cupons: 1, porCategoria: [{ chave: "ce_vertical", n: 1 }] },
    });
    adminMlCupons.mockResolvedValue({ ...VAZIO, total: 1, items: [cupom()] });
    await abrirTela();

    fireEvent.click(await screen.findByText("Limites da rodada"));
    expect(screen.getByRole("checkbox", { name: "Eletrônicos" })).toBeInTheDocument();
    // Varrer por eles carimbaria "Mais de 10%" na coluna Categoria — uma
    // categoria que não existe.
    expect(screen.queryByRole("checkbox", { name: "Mais de R$100" })).toBe(null);
    expect(screen.queryByRole("checkbox", { name: "Mais de 10%" })).toBe(null);
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

// ─────────────────────────────────────────────────────────────────────────
// A rodada inteira no Chrome do admin
// ─────────────────────────────────────────────────────────────────────────
//
// O que se testa aqui é a divisão de trabalho, que é a parte que erra caro: a
// tela percorre, mas NÃO decide. Qual página abrir, quem ativar e quando parar
// vem do servidor — porque as regras (teto de páginas, rótulo ambíguo de
// "Aplicar") já existem lá, e ativar cupom é escrita irreversível na conta.
describe("a rodada de cupons no Chrome do admin", () => {
  const PAGINA1 = { url: "https://www.mercadolivre.com.br/cupons/filter?all=true&page=1", grouping: null, pagina: 1 };
  const PAGINA2 = { ...PAGINA1, url: "https://www.mercadolivre.com.br/cupons/filter?all=true&page=2", pagina: 2 };
  const ALVO = {
    campaignId: "13471229", title: "15% OFF BRINCADEIRAS",
    containerUrl: "https://lista.mercadolivre.com.br/_Container_toys?coupon_campaign_id=13471229",
  };
  const produto = { name: "Boneco", link: "https://www.mercadolivre.com.br/x/p/MLB1", price: 25.9 };

  const comExtensaoQueColheLista = () => {
    coletorInfo.mockResolvedValue(EXTENSAO("raspar", "lista"));
    fecharAbaDoColetor.mockResolvedValue({ fechada: true });
    adminMlCuponsLocalFim.mockResolvedValue({ ok: true, resumo: {} });
  };

  it("uma cópia antiga da extensão não ganha o botão da rodada", async () => {
    coletorInfo.mockResolvedValue(EXTENSAO("raspar"));   // versão 1.0: só a vitrine
    await abrirTela();
    expect(screen.queryByRole("button", { name: /Puxar cupons no meu Chrome/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Puxar cupons agora/i })).toBeInTheDocument();
  });

  it("percorre as páginas que o servidor manda e para quando ele para de mandar", async () => {
    comExtensaoQueColheLista();
    adminMlCuponsLocalStart.mockResolvedValue({ config: { limitPerGrouping: 60, groupings: [] }, ativa: false, proxima: PAGINA1 });
    paginaDeCupons
      .mockResolvedValueOnce({ tabId: 7, props: { p: 1 }, muro: null, clicados: 0, semBotao: [] })
      .mockResolvedValueOnce({ tabId: 7, props: { p: 2 }, muro: null, clicados: 0, semBotao: [] });
    adminMlCuponsLocalPagina
      .mockResolvedValueOnce({ cupons: 30, novos: 30, de: 2, proxima: PAGINA2, alvos: null })
      .mockResolvedValueOnce({ cupons: 45, novos: 15, de: 2, proxima: null, alvos: [], resumo: { cupons: 45, novos: 45, ativados: 0 } });
    await abrirTela();

    fireEvent.click(await screen.findByRole("button", { name: /Puxar cupons no meu Chrome/i }));

    await waitFor(() => expect(adminMlCuponsLocalFim).toHaveBeenCalled());
    // A tela abriu exatamente as URLs que o servidor nomeou, na mesma aba.
    expect(paginaDeCupons).toHaveBeenNthCalledWith(1, { url: PAGINA1.url, tabId: null }, expect.anything());
    expect(paginaDeCupons).toHaveBeenNthCalledWith(2, { url: PAGINA2.url, tabId: 7 }, expect.anything());
    // E devolveu o modelo cru, sem interpretar nada.
    expect(adminMlCuponsLocalPagina).toHaveBeenNthCalledWith(1, expect.objectContaining({ props: { p: 1 } }));
    expect(fecharAbaDoColetor).toHaveBeenCalledWith(7);
    expect(await screen.findByText(/Rodada terminada/)).toBeInTheDocument();
  });

  it("quem escolhe os cupons a ativar é o servidor — a extensão só clica", async () => {
    comExtensaoQueColheLista();
    adminMlCuponsLocalStart.mockResolvedValue({ config: { limitPerGrouping: 60, groupings: [] }, ativa: true, proxima: PAGINA1 });
    paginaDeCupons
      .mockResolvedValueOnce({ tabId: 7, props: { antes: true }, muro: null, clicados: 0, semBotao: [] })
      .mockResolvedValueOnce({ tabId: 7, props: { depois: true }, muro: null, clicados: 1, semBotao: [] });
    adminMlCuponsLocalAtivar.mockResolvedValue({ labels: ["Aplicar cupom 15 por cento OFF"], restantes: 20 });
    adminMlCuponsLocalPagina.mockResolvedValue({ cupons: 1, novos: 1, de: 1, proxima: null, alvos: [], resumo: { cupons: 1, novos: 1, ativados: 1 } });
    await abrirTela();

    fireEvent.click(await screen.findByRole("button", { name: /Puxar cupons no meu Chrome/i }));

    await waitFor(() => expect(adminMlCuponsLocalFim).toHaveBeenCalled());
    // Os rótulos saem do modelo DESTA página, decididos no servidor…
    expect(adminMlCuponsLocalAtivar).toHaveBeenCalledWith({ grouping: null, props: { antes: true } });
    // …e voltam para a extensão como ordem de clique, na aba já aberta.
    expect(paginaDeCupons).toHaveBeenNthCalledWith(2, { tabId: 7, rotulos: ["Aplicar cupom 15 por cento OFF"] }, expect.anything());
    // O que chega ao servidor é a leitura de DEPOIS do clique: é ela que traz a
    // vitrine do cupom recém-ativado.
    expect(adminMlCuponsLocalPagina).toHaveBeenCalledWith(expect.objectContaining({ props: { depois: true }, ativados: 1 }));
  });

  it("terminada a lista, colhe as vitrines que o servidor apontou", async () => {
    comExtensaoQueColheLista();
    adminMlCuponsLocalStart.mockResolvedValue({ config: { limitPerGrouping: 60, groupings: [] }, ativa: false, proxima: PAGINA1 });
    paginaDeCupons.mockResolvedValue({ tabId: 7, props: { p: 1 }, muro: null, clicados: 0, semBotao: [] });
    adminMlCuponsLocalPagina.mockResolvedValue({ cupons: 1, novos: 1, de: 1, proxima: null, alvos: [ALVO], resumo: { cupons: 1, novos: 1, ativados: 0 } });
    raparVitrine.mockResolvedValue({ produtos: [produto], parcial: false, motivo: null, paginas: 1 });
    adminMlCuponsImportVitrine.mockResolvedValue({ ok: true, produtos: 1, parcial: false });
    await abrirTela();

    fireEvent.click(await screen.findByRole("button", { name: /Puxar cupons no meu Chrome/i }));

    await waitFor(() => expect(adminMlCuponsImportVitrine).toHaveBeenCalledWith(
      "13471229", { products: [produto], parcial: false },
    ));
    await waitFor(() => expect(adminMlCuponsLocalFim).toHaveBeenCalledWith(
      expect.objectContaining({ vitrines: 1, produtos: 1 }),
    ));
  });

  it("o muro para a rodada, e o fim é avisado mesmo assim", async () => {
    comExtensaoQueColheLista();
    adminMlCuponsLocalStart.mockResolvedValue({ config: { limitPerGrouping: 60, groupings: [] }, ativa: false, proxima: PAGINA1 });
    paginaDeCupons.mockResolvedValue({ tabId: 7, props: null, muro: "captcha", motivo: "não foi resolvida" });
    await abrirTela();

    fireEvent.click(await screen.findByRole("button", { name: /Puxar cupons no meu Chrome/i }));

    // Sem o `fim`, o servidor ficaria com a rodada "rodando" e recusaria a
    // próxima — e o "Apagar todos" junto.
    await waitFor(() => expect(adminMlCuponsLocalFim).toHaveBeenCalledWith(expect.objectContaining({ cancelada: true })));
    expect(adminMlCuponsLocalPagina).not.toHaveBeenCalled();
    expect(await screen.findByText(/Rodada interrompida/)).toBeInTheDocument();
  });
});
