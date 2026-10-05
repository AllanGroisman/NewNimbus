// Admin › Cupom › aba "Cupons do ML" — as duas etapas, a lista e a exclusão.
//
// O desenho que estes testes protegem (task 28): a tela tem DOIS botões, e a
// separação entre eles é o ponto.
//
//   1. Buscar cupons e condições — leitura pura. Abre a lista geral do ML e
//      guarda todos os cupons. Não clica em "Eu quero", não escreve na conta.
//   2. Buscar produtos — abre a vitrine de cada cupom, e para isso precisa ACEITAR
//      os que ainda não foram aceitos. Aceitar é escrita irreversível na conta do
//      ML, a mesma do Hub de Afiliados.
//
// Misturar as duas foi o que fez o botão de "puxar cupons" ser perigoso de
// clicar. Se algum teste daqui cair porque a etapa 1 passou a ativar cupom, é
// regressão, não teste velho.
//
// O testador de PALAVRA saiu daqui pra aba vizinha; os testes dele estão em
// AdminCupomPalavra.test.jsx.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

vi.mock("../data/api", () => ({
  // errText é helper puro (não faz rede) — usa a implementação de verdade.
  errText: (err, fallback) => err?.message || fallback,
  adminMlCupons: vi.fn(),
  adminMlCuponsStatus: vi.fn(),
  adminMlCuponsSaveConfig: vi.fn(),
  adminMlCuponsProducts: vi.fn(),
  adminMlCuponsClearAll: vi.fn(),
  adminMlCuponsDelete: vi.fn(),
  adminMlCuponsAlvosProdutos: vi.fn(),
  adminMlCuponsImportVitrine: vi.fn(),
  // A vitrine que abriu sem card nenhum (task 8) e as limpezas das tasks 9 e 10.
  adminMlCuponsVitrineVazia: vi.fn(() => Promise.resolve({ ok: true })),
  adminMlCuponsVencidos: vi.fn(),
  adminMlCuponsApagarVencidos: vi.fn(),
  adminMlCuponsApagarProdutos: vi.fn(),
  // O carimbo do catálogo uma vez por lote (task 14).
  adminMlCuponsCarimbar: vi.fn(() => Promise.resolve({ carimbados: 0, limpos: 0 })),
  adminMlCuponsLocalStart: vi.fn(),
  adminMlCuponsLocalAtivar: vi.fn(),
  adminMlCuponsLocalPagina: vi.fn(),
  adminMlCuponsLocalFim: vi.fn(),
  // O balanço dos botões 2 e 3 (task 17).
  adminMlCuponsRodadaFim: vi.fn(),
  // O ImportarCampanhaModal, que a caixa "Trazer campanha por ID" abre.
  adminMlCuponsImportCampaign: vi.fn(),
  adminMlCuponsImportStatus: vi.fn(),
  // A agenda das etapas (task 3).
  adminMlCuponsAgendaPendentes: vi.fn(),
  adminMlCuponsAgendaReivindicar: vi.fn(),
  adminMlCuponsAgendaFalhou: vi.fn(),
}));

// A extensão que colhe no Chrome do admin (extension/ na raiz). Aqui ela é
// fingida: o que se testa é a tela reagindo ao que ela devolve.
vi.mock("../data/coletor", () => ({
  coletorInfo: vi.fn(),
  // O modal de trazer campanha escolhe entre o Chrome do admin e o servidor.
  coletorEntende: vi.fn(),
  raparVitrine: vi.fn(),
  paginaDeCupons: vi.fn(),
  fecharAbaDoColetor: vi.fn(),
}));

import PageCuponsML from "../pages/AdminCupomML.jsx";
import {
  adminMlCupons,
  adminMlCuponsStatus,
  adminMlCuponsSaveConfig,
  adminMlCuponsDelete,
  adminMlCuponsAlvosProdutos,
  adminMlCuponsImportVitrine,
  adminMlCuponsLocalStart,
  adminMlCuponsLocalAtivar,
  adminMlCuponsLocalPagina,
  adminMlCuponsLocalFim,
  adminMlCuponsRodadaFim,
} from "../data/api";
import { adminMlCuponsImportCampaign, adminMlCuponsImportStatus } from "../data/api";
import { adminMlCuponsVencidos, adminMlCuponsApagarVencidos, adminMlCuponsApagarProdutos } from "../data/api";
import { adminMlCuponsAgendaPendentes, adminMlCuponsAgendaReivindicar, adminMlCuponsAgendaFalhou } from "../data/api";
import { coletorInfo, coletorEntende, raparVitrine, paginaDeCupons, fecharAbaDoColetor } from "../data/coletor";
import { _zerarParaTestes } from "../data/rodadaCupons";
import { _zerarParaTestes as zerarPrefsAdmin, gravar as gravarPref } from "../data/preferenciasAdmin";
import { lerLembrado } from "../data/useLembrado";

// As preferências de tela do admin vivem num módulo que dura a suíte inteira.
beforeEach(() => zerarPrefsAdmin());

// A extensão instalada, e quais comandos aquela cópia entende. A tela pergunta os
// dois: uma cópia da versão 1.0 responde ao ping e não conhece "lista".
const EXTENSAO = (...comandos) => ({ instalada: true, versao: "2.0.0", comandos });

const VAZIO = { items: [], total: 0, page: 1, pageSize: 50 };

// A fila da etapa 2, do jeito que o servidor a devolve.
const SEM_ALVO = {
  prontos: [], precisamAtivar: [], total: 0,
  // Pausas de 1ms: o que se testa é a ordem das chamadas, não a espera. `maxCiclos`
  // baixo para o teste do teto não precisar de vinte voltas.
  config: {
    maxPaginasVitrine: 6, pausaEntreVitrinesMs: 1, activateCoupons: true, maxActivationsPerRun: 20,
    pausaEntreCiclosMs: 1, maxCiclos: 2,
  },
};
const filaCom = (prontos = [], precisamAtivar = []) => ({
  ...SEM_ALVO, prontos, precisamAtivar, total: prontos.length + precisamAtivar.length,
});

const BOTAO_LISTA = /1 · Buscar cupons e condições/i;
// Sensível a maiúscula de propósito: o botão da linha é "buscar produtos".
const BOTAO_PRODUTOS = /^Buscar produtos( \(\d+\))?$/;
const CARD_PRODUTOS = /2 · Buscar Produtos Dos Cupons/i;

async function abrirTela() {
  render(<PageCuponsML />);
  await waitFor(() => expect(adminMlCupons).toHaveBeenCalled());
  // Ter chamado a API não quer dizer que a tela já desenhou o que ela devolveu.
  // Sem esperar os campos dos cards, os getBy* síncronos dos testes perdiam a
  // corrida quando a máquina estava ocupada (ex.: suíte inteira em paralelo).
  await screen.findByLabelText("Páginas da lista geral");
}

beforeEach(() => {
  vi.clearAllMocks();
  // A rodada vive no módulo (task 6) e duraria de um teste para o outro.
  _zerarParaTestes();
  // A escolha dos parciais é lembrada no navegador: sem limpar, um teste herdaria o do outro.
  localStorage.clear();
  adminMlCuponsStatus.mockResolvedValue({ config: {}, running: false });
  adminMlCupons.mockResolvedValue(VAZIO);
  adminMlCuponsAlvosProdutos.mockResolvedValue(SEM_ALVO);
  adminMlCuponsLocalFim.mockResolvedValue({ ok: true, resumo: {} });
  adminMlCuponsRodadaFim.mockResolvedValue({ ok: true });
  fecharAbaDoColetor.mockResolvedValue({ fechada: true });
  // Sem extensão é o estado padrão: a maioria dos testes desta tela não fala dela.
  coletorInfo.mockResolvedValue({ instalada: false, versao: null, comandos: [] });
  coletorEntende.mockResolvedValue(false);
  adminMlCuponsImportStatus.mockResolvedValue({ running: false, result: null, error: null });
  adminMlCuponsAgendaPendentes.mockResolvedValue({ pendentes: [] });
  adminMlCuponsAgendaReivindicar.mockResolvedValue({ ok: true });
  adminMlCuponsAgendaFalhou.mockResolvedValue({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────
// Os dois botões
// ─────────────────────────────────────────────────────────────────────────
describe("as duas etapas são dois botões", () => {
  it("sem a extensão, nenhum dos dois funciona — e a tela diz por quê", async () => {
    await abrirTela();
    expect(await screen.findByText(/Carregar sem compactação/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: BOTAO_LISTA })).toBeDisabled();
  });

  it("o botão dos produtos traz o número do que falta, vindo do servidor", async () => {
    // O número é do TOTAL guardado, não da página da tabela: o botão percorre
    // tudo o que falta, e prometer o número da página seria mentir.
    coletorInfo.mockResolvedValue(EXTENSAO("raspar", "lista"));
    adminMlCuponsAlvosProdutos.mockResolvedValue(filaCom(
      [{ campaignId: "1", title: "A", containerUrl: "u1" }, { campaignId: "2", title: "B", containerUrl: "u2" }],
      [{ campaignId: "3", title: "C" }],
    ));
    await abrirTela();

    expect(await screen.findByRole("button", { name: "Buscar produtos (3)" })).toBeInTheDocument();
  });

  it("a escolha \"só os sem nenhum produto\" refaz a fila, e cada opção diz o seu tamanho", async () => {
    coletorInfo.mockResolvedValue(EXTENSAO("raspar", "lista"));
    const contagens = { incompletos: 5, semNada: 1 };
    adminMlCuponsAlvosProdutos.mockImplementation(async ({ soSemProdutos } = {}) => (soSemProdutos
      ? { ...filaCom([{ campaignId: "1", title: "A", containerUrl: "u1" }]), ...contagens, parciaisFora: 4 }
      : { ...filaCom([1, 2, 3, 4, 5].map(i => ({ campaignId: String(i), title: `C${i}`, containerUrl: `u${i}` }))), ...contagens }));
    await abrirTela();
    expect(await screen.findByRole("button", { name: "Buscar produtos (5)" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /todos os que faltam \(5\)/i })).toBeChecked();

    fireEvent.click(screen.getByRole("radio", { name: /só os que não têm nenhum produto \(1\)/i }));

    expect(await screen.findByRole("button", { name: "Buscar produtos (1)" })).toBeInTheDocument();
    expect(adminMlCuponsAlvosProdutos).toHaveBeenCalledWith({ soSemProdutos: true });
  });

  it("o resumo reparte os cupons em sem nenhum produto, parciais e completos", async () => {
    adminMlCuponsStatus.mockResolvedValue({
      config: {}, running: false,
      stats: { cupons: 12, porCategoria: [], produtosPorCupom: { semNada: 3, parciais: 2, completos: 5, vitrineVazia: 2 } },
    });
    await abrirTela();

    const resumo = await screen.findByRole("group", { name: "Resumo dos produtos" });
    expect(within(resumo).getByText("Cupons no sistema").previousSibling).toHaveTextContent("12");
    expect(within(resumo).getByText("Sem nenhum produto").previousSibling).toHaveTextContent("3");
    expect(within(resumo).getByText("Parciais").previousSibling).toHaveTextContent("2");
    expect(within(resumo).getByText("Completos").previousSibling).toHaveTextContent("5");
    // Task 8: a vitrine vazia conta à parte, e não como "sem nenhum produto".
    expect(within(resumo).getByText("Vitrine vazia").previousSibling).toHaveTextContent("2");
  });

  it("sem nada faltando, o botão dos produtos fica desligado", async () => {
    coletorInfo.mockResolvedValue(EXTENSAO("raspar", "lista"));
    await abrirTela();
    expect(await screen.findByRole("button", { name: BOTAO_PRODUTOS })).toBeDisabled();
  });

  it("avisa quantos cupons vão ser aceitos na conta ANTES de alguém clicar", async () => {
    // "Aceitar" é irreversível. Um aviso que só aparece no `title` do botão é um
    // aviso que ninguém leu — por isso ele fica no corpo do card.
    coletorInfo.mockResolvedValue(EXTENSAO("raspar", "lista"));
    adminMlCuponsAlvosProdutos.mockResolvedValue(filaCom([], [{ campaignId: "3", title: "C" }]));
    await abrirTela();

    expect(await screen.findByText(/ainda não foram aceitos na sua conta/i)).toBeInTheDocument();
    expect(screen.getByText(/escrita irreversível/i)).toBeInTheDocument();
  });

  // O teto de aceites tem TRÊS valores e os três dizem coisas diferentes: número é
  // o teto, `null` é ligado sem teto, `0` é desligado. `null` e `0` são opostos, e
  // um `?? 0` no caminho basta para a tela prometer "não vou aceitar nenhum" logo
  // antes de aceitar a fila inteira.
  it("sem teto de aceites, o aviso diz TODOS — não zero", async () => {
    coletorInfo.mockResolvedValue(EXTENSAO("raspar", "lista"));
    adminMlCuponsAlvosProdutos.mockResolvedValue({
      ...filaCom([], [{ campaignId: "3", title: "C" }]),
      config: { ...SEM_ALVO.config, activateCoupons: true, maxActivationsPerRun: null },
    });
    await abrirTela();

    expect(await screen.findByText(/sem teto por rodada/i)).toBeInTheDocument();
    expect(screen.queryByText(/Está desligada/i)).not.toBeInTheDocument();
  });

  it("o resumo da rodada fica sempre à vista, com os tetos aplicados", async () => {
    // O botão promete o que a rodada FAZ: teto da rodada, teto de aceites e o corte
    // do servidor entram no número e viram uma linha cada no aviso.
    coletorInfo.mockResolvedValue(EXTENSAO("raspar", "lista"));
    adminMlCuponsAlvosProdutos.mockResolvedValue({
      ...filaCom(
        [1, 2, 3].map(i => ({ campaignId: String(i), title: `P${i}`, containerUrl: `u${i}` })),
        [4, 5, 6].map(i => ({ campaignId: String(i), title: `A${i}` })),
      ),
      totalProntos: 503, totalPrecisamAtivar: 3,
      config: {
        ...SEM_ALVO.config, activateCoupons: true, maxActivationsPerRun: 2,
        limiteCuponsProdutos: 4, maxProductsPerCoupon: 300, tamanhoLoteProdutos: 20,
      },
    });
    await abrirTela();

    expect(await screen.findByRole("button", { name: "Buscar produtos (4)" })).toBeInTheDocument();
    const plano = screen.getByTestId("plano-produtos");
    expect(plano).toHaveTextContent(/Até 4 cupom\(ns\) \(3 com vitrine \+ 1 a ativar\)/);
    expect(plano).toHaveTextContent(/máx\. 300 produtos \/ 6 página\(s\) por cupom/);
    // 503 com vitrine + 2 dos 3 a ativar (teto de 2) = 505 na fila, cortados em 4.
    expect(plano).toHaveTextContent(/teto da rodada: 4 de 505/);
    expect(plano).toHaveTextContent(/1 sem vitrine ficam de fora pelo teto de 2/);
  });

  it("com a ativação desligada, o aviso diz que está desligada", async () => {
    coletorInfo.mockResolvedValue(EXTENSAO("raspar", "lista"));
    adminMlCuponsAlvosProdutos.mockResolvedValue({
      ...filaCom([], [{ campaignId: "3", title: "C" }]),
      config: { ...SEM_ALVO.config, activateCoupons: false, maxActivationsPerRun: 0 },
    });
    await abrirTela();

    // Com a ativação desligada o cupom não aparece no que "falta": sem aceitar,
    // ele não tem vitrine e o botão 2 não teria o que fazer com ele.
    expect(await screen.findByRole("button", { name: BOTAO_PRODUTOS })).toBeDisabled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ETAPA 1 — a varredura da lista
// ─────────────────────────────────────────────────────────────────────────
//
// O que se testa aqui é a divisão de trabalho, que é a parte que erra caro: a
// tela percorre, mas NÃO decide. Qual página abrir e quando parar vem do
// servidor — porque as regras (teto de páginas, rótulo ambíguo de "Aplicar") já
// existem lá.
describe("etapa 1 — buscar cupons e condições", () => {
  const PAGINA1 = { url: "https://www.mercadolivre.com.br/cupons/filter?all=true&page=1", grouping: null, pagina: 1 };
  const PAGINA2 = { ...PAGINA1, url: "https://www.mercadolivre.com.br/cupons/filter?all=true&page=2", pagina: 2 };

  const comExtensaoQueColheLista = () => {
    coletorInfo.mockResolvedValue(EXTENSAO("raspar", "lista"));
  };

  it("uma cópia antiga da extensão não ganha o botão", async () => {
    coletorInfo.mockResolvedValue(EXTENSAO("raspar"));   // versão 1.0: só a vitrine
    await abrirTela();
    await waitFor(() => expect(screen.getByRole("button", { name: BOTAO_LISTA })).toBeDisabled());
  });

  it("percorre as páginas que o servidor manda e para quando ele para de mandar", async () => {
    comExtensaoQueColheLista();
    adminMlCuponsLocalStart.mockResolvedValue({ config: {}, ativa: false, categorias: [null], proxima: PAGINA1 });
    paginaDeCupons
      .mockResolvedValueOnce({ tabId: 7, props: { p: 1 }, muro: null, clicados: 0, semBotao: [] })
      .mockResolvedValueOnce({ tabId: 7, props: { p: 2 }, muro: null, clicados: 0, semBotao: [] });
    adminMlCuponsLocalPagina
      .mockResolvedValueOnce({ cupons: 30, novos: 30, de: 2, proxima: PAGINA2, alvos: null })
      .mockResolvedValueOnce({ cupons: 45, novos: 15, de: 2, proxima: null, alvos: null, resumo: { cupons: 45, novos: 45 } });
    await abrirTela();

    fireEvent.click(await screen.findByRole("button", { name: BOTAO_LISTA }));

    await waitFor(() => expect(adminMlCuponsLocalFim).toHaveBeenCalled());
    // A tela abriu exatamente as URLs que o servidor nomeou, na mesma aba — e a
    // primeira é a lista GERAL (`all=true`), não uma vertical.
    expect(paginaDeCupons).toHaveBeenNthCalledWith(1, { url: PAGINA1.url, tabId: null }, expect.anything());
    expect(paginaDeCupons).toHaveBeenNthCalledWith(2, { url: PAGINA2.url, tabId: 7 }, expect.anything());
    // E devolveu o modelo cru, sem interpretar nada.
    expect(adminMlCuponsLocalPagina).toHaveBeenNthCalledWith(1, expect.objectContaining({ props: { p: 1 } }));
    expect(fecharAbaDoColetor).toHaveBeenCalledWith(7);
    expect(await screen.findByText(/Varredura terminada/)).toBeInTheDocument();
  });

  // Task 20. Os quatorze números eram "meio confusos": a escolha que importa —
  // até onde ir — não era um número, estava escondida entre eles, e só o botão 3
  // sabia fazê-la.
  describe("até onde ir na lista", () => {
    const listaDeUmaPagina = () => {
      comExtensaoQueColheLista();
      adminMlCuponsLocalStart.mockResolvedValue({ config: {}, ativa: false, categorias: [null], proxima: PAGINA1 });
      paginaDeCupons.mockResolvedValue({ tabId: 7, props: { p: 1 }, muro: null, clicados: 0, semBotao: [] });
      adminMlCuponsLocalPagina.mockResolvedValue({ cupons: 1, novos: 1, de: 1, proxima: null, alvos: null, resumo: { cupons: 1, novos: 1, avisos: [] } });
    };

    it("no padrão, o botão 1 vai até os limites salvos", async () => {
      listaDeUmaPagina();
      await abrirTela();

      fireEvent.click(await screen.findByRole("button", { name: BOTAO_LISTA }));

      await waitFor(() => expect(adminMlCuponsLocalStart).toHaveBeenCalledWith({}));
    });

    it("escolhido \"tudo o que o ML tiver\", o botão 1 manda o flag — e não um número", async () => {
      listaDeUmaPagina();
      await abrirTela();

      fireEvent.click(await screen.findByRole("radio", { name: /tudo o que o ML tiver/i }));
      fireEvent.click(await screen.findByRole("button", { name: BOTAO_LISTA }));

      // `semTeto`, e NÃO `tudo`: o `tudo` é o botão 3, e é ele que faz o servidor
      // pular a gravação do "última vez" da lista. O botão 1 precisa continuar
      // deixando o balanço dele.
      await waitFor(() => expect(adminMlCuponsLocalStart).toHaveBeenCalledWith({ semTeto: true }));
    });

    // Task 19: cada botão num card, com o progresso e o balanço DELE. Antes as duas
    // respostas para "o que este botão fez?" moravam em cards diferentes.
    it("o que acontece aparece no card do botão que foi clicado", async () => {
      listaDeUmaPagina();
      await abrirTela();

      fireEvent.click(await screen.findByRole("button", { name: BOTAO_LISTA }));

      const card1 = screen.getByRole("region", { name: /1 · Cupons e condições/i });
      expect(await within(card1).findByText(/Varredura terminada/)).toBeInTheDocument();
      // E não no card do vizinho.
      const card2 = screen.getByRole("region", { name: CARD_PRODUTOS });
      expect(within(card2).queryByText(/Varredura terminada/)).toBeNull();
    });

    it("os limites de cada etapa moram no card daquela etapa", async () => {
      listaDeUmaPagina();
      await abrirTela();

      const card1 = screen.getByRole("region", { name: /1 · Cupons e condições/i });
      const card2 = screen.getByRole("region", { name: CARD_PRODUTOS });
      expect(within(card1).getByLabelText("Páginas da lista geral")).toBeInTheDocument();
      expect(within(card1).queryByLabelText("Aceites por rodada")).toBeNull();
      expect(within(card2).getByLabelText("Aceites por rodada")).toBeInTheDocument();
      expect(within(card2).queryByLabelText("Páginas da lista geral")).toBeNull();
    });

    it("salvar os limites de uma etapa não embarca os da outra", async () => {
      listaDeUmaPagina();
      await abrirTela();

      // Mexe num campo da etapa 2 e salva a etapa 1: o que foi mexido ao lado não
      // pode viajar junto — aceitar cupom é escrita irreversível na conta do ML.
      fireEvent.change(screen.getByLabelText("Aceites por rodada"), { target: { value: "7" } });
      fireEvent.click(screen.getByRole("button", { name: /salvar os limites da lista/i }));

      await waitFor(() => expect(adminMlCuponsSaveConfig).toHaveBeenCalled());
      expect(adminMlCuponsSaveConfig).toHaveBeenCalledWith(
        expect.not.objectContaining({ maxActivationsPerRun: expect.anything() }),
      );
    });

    it("nessa escolha os três tetos ficam de fora, e a tela diz isso", async () => {
      listaDeUmaPagina();
      await abrirTela();

      fireEvent.click(await screen.findByRole("radio", { name: /tudo o que o ML tiver/i }));

      expect(await screen.findByLabelText("Páginas da lista geral")).toBeDisabled();
      expect(screen.getByLabelText("Teto de cupons (0 = todos)")).toBeDisabled();
      expect(screen.getByLabelText("Páginas por categoria")).toBeDisabled();
      // O que NÃO é teto continua valendo: ele diz o que colher, não até onde ir.
      expect(screen.getByRole("checkbox", { name: /Ignorar cupons de loja/i })).not.toBeDisabled();
    });
  });

  describe("ignorar cupons de loja", () => {
    it("mora em destaque no card 1, fora dos limites da etapa", async () => {
      await abrirTela();
      const card1 = screen.getByRole("region", { name: /1 · Cupons e condições/i });
      expect(within(card1).getByRole("checkbox", { name: /Ignorar cupons de loja/i })).toBeInTheDocument();
      // E só existe uma caixa: a dos limites saiu.
      expect(screen.getAllByRole("checkbox", { name: /cupons? de loja/i })).toHaveLength(1);
    });

    it("marcar salva na hora, só a chave dela — e vale no \"tudo o que o ML tiver\"", async () => {
      adminMlCuponsSaveConfig.mockResolvedValue({});
      await abrirTela();

      fireEvent.click(await screen.findByRole("radio", { name: /tudo o que o ML tiver/i }));
      const caixa = screen.getByRole("checkbox", { name: /Ignorar cupons de loja/i });
      expect(caixa).not.toBeChecked();
      fireEvent.click(caixa);

      await waitFor(() => expect(adminMlCuponsSaveConfig).toHaveBeenCalledWith({ skipStoreCoupons: true }));
      expect(caixa).toBeChecked();
    });

    it("mostra o que está salvo no servidor", async () => {
      adminMlCuponsStatus.mockResolvedValue({ config: { skipStoreCoupons: true }, running: false });
      await abrirTela();
      expect(await screen.findByRole("checkbox", { name: /Ignorar cupons de loja/i })).toBeChecked();
    });
  });

  it("é leitura pura: não pergunta ao servidor quem ativar, nem raspa vitrine", async () => {
    // A regressão que este teste segura: se a etapa 1 voltar a ativar, o botão
    // "buscar cupons" volta a escrever na conta do ML sem ninguém pedir.
    comExtensaoQueColheLista();
    adminMlCuponsLocalStart.mockResolvedValue({ config: {}, ativa: false, categorias: [null], proxima: PAGINA1 });
    paginaDeCupons.mockResolvedValue({ tabId: 7, props: { p: 1 }, muro: null, clicados: 0, semBotao: [] });
    adminMlCuponsLocalPagina.mockResolvedValue({ cupons: 1, novos: 1, de: 1, proxima: null, alvos: null, resumo: { cupons: 1, novos: 1 } });
    await abrirTela();

    fireEvent.click(await screen.findByRole("button", { name: BOTAO_LISTA }));

    await waitFor(() => expect(adminMlCuponsLocalFim).toHaveBeenCalled());
    expect(adminMlCuponsLocalAtivar).not.toHaveBeenCalled();
    expect(raparVitrine).not.toHaveBeenCalled();
    expect(adminMlCuponsImportVitrine).not.toHaveBeenCalled();
  });

  it("o muro para a varredura, e o fim é avisado mesmo assim", async () => {
    comExtensaoQueColheLista();
    adminMlCuponsLocalStart.mockResolvedValue({ config: {}, ativa: false, categorias: [null], proxima: PAGINA1 });
    paginaDeCupons.mockResolvedValue({ tabId: 7, props: null, muro: "captcha", motivo: "não foi resolvida" });
    await abrirTela();

    fireEvent.click(await screen.findByRole("button", { name: BOTAO_LISTA }));

    // Sem o `fim`, o servidor ficaria com a varredura "rodando" e recusaria a
    // próxima — e o "Apagar todos" junto.
    await waitFor(() => expect(adminMlCuponsLocalFim).toHaveBeenCalledWith(expect.objectContaining({ cancelada: true })));
    expect(adminMlCuponsLocalPagina).not.toHaveBeenCalled();
    expect(await screen.findByText(/Varredura interrompida/)).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ETAPA 2 — os produtos
// ─────────────────────────────────────────────────────────────────────────
//
// Dois cuidados moram aqui, e os dois protegem a conta do ML: aceitar só quem foi
// nomeado, e parar no primeiro muro. O terceiro protege o dado: `parcial` nunca
// pode virar lista fechada.
describe("etapa 2 — buscar os produtos", () => {
  const produto = { name: "Boneco", link: "https://www.mercadolivre.com.br/x/p/MLB1", price: 25.9 };
  const pronto = (id) => ({ campaignId: id, title: `Cupom ${id}`, containerUrl: `https://lista.mercadolivre.com.br/_Container_${id}` });

  beforeEach(() => {
    coletorInfo.mockResolvedValue(EXTENSAO("raspar", "lista"));
    adminMlCuponsImportVitrine.mockResolvedValue({ ok: true, produtos: 1, parcial: false });
  });

  it("o que veio inteiro é gravado como lista fechada", async () => {
    adminMlCuponsAlvosProdutos.mockResolvedValue(filaCom([pronto("13471229")]));
    raparVitrine.mockResolvedValue({ produtos: [produto], parcial: false, motivo: null, paginas: 1 });
    await abrirTela();

    fireEvent.click(await screen.findByRole("button", { name: BOTAO_PRODUTOS }));

    await waitFor(() => expect(adminMlCuponsImportVitrine).toHaveBeenCalledWith(
      "13471229", { products: [produto], parcial: false, carimbar: false },
    ));
    expect(await screen.findByText(/Busca de produtos terminada/)).toBeInTheDocument();
    // O balanço do botão 2 vai pro servidor, para o "última vez" dele sobreviver a um F5.
    expect(adminMlCuponsRodadaFim).toHaveBeenCalledWith(expect.objectContaining({
      botao: "produtos", interrompida: false,
      resultado: expect.objectContaining({ tentados: 1, colhidos: 1, produtos: 1 }),
    }));
  });

  it("o que parou no meio vai marcado como parcial — e a tela avisa", async () => {
    // Se o pedaço entrar como lista fechada, o sistema passa a responder "esse
    // cupom não vale aqui" para produto que o cupom cobre.
    adminMlCuponsAlvosProdutos.mockResolvedValue(filaCom([pronto("13471229")]));
    raparVitrine.mockResolvedValue({ produtos: [produto], parcial: true, motivo: "teto de páginas", paginas: 6 });
    await abrirTela();

    fireEvent.click(await screen.findByRole("button", { name: BOTAO_PRODUTOS }));

    await waitFor(() => expect(adminMlCuponsImportVitrine).toHaveBeenCalledWith(
      "13471229", { products: [produto], parcial: true, carimbar: false },
    ));
    expect((await screen.findAllByText(/parcial/)).length).toBeGreaterThan(0);
  });

  it("usa o teto de páginas que o servidor mandou, não um escrito na tela", async () => {
    adminMlCuponsAlvosProdutos.mockResolvedValue({
      ...filaCom([pronto("1")]),
      config: { ...SEM_ALVO.config, maxPaginasVitrine: 2 },
    });
    raparVitrine.mockResolvedValue({ produtos: [produto], parcial: false, motivo: null, paginas: 1 });
    await abrirTela();

    fireEvent.click(await screen.findByRole("button", { name: BOTAO_PRODUTOS }));

    await waitFor(() => expect(raparVitrine).toHaveBeenCalledWith(
      "https://lista.mercadolivre.com.br/_Container_1",
      expect.objectContaining({ paginas: 2 }),
    ));
  });

  it("colhe os cupons um a um, na ordem, sem paralelizar", async () => {
    adminMlCuponsAlvosProdutos.mockResolvedValue(filaCom(["1", "2", "3"].map(pronto)));
    let abertasAoMesmoTempo = 0, pico = 0;
    raparVitrine.mockImplementation(async () => {
      pico = Math.max(pico, ++abertasAoMesmoTempo);
      await new Promise(r => setTimeout(r, 1));
      abertasAoMesmoTempo--;
      return { produtos: [produto], parcial: false, motivo: null, paginas: 1 };
    });
    await abrirTela();

    fireEvent.click(await screen.findByRole("button", { name: BOTAO_PRODUTOS }));

    await waitFor(() => expect(adminMlCuponsImportVitrine).toHaveBeenCalledTimes(3), { timeout: 20000 });
    // Uma aba por vez: o ML ver três listagens simultâneas da mesma conta é
    // exatamente o que a pausa entre cupons existe para evitar.
    expect(pico).toBe(1);
    expect(adminMlCuponsImportVitrine.mock.calls.map(c => c[0])).toEqual(["1", "2", "3"]);
  }, 25000);

  it("para no primeiro muro em vez de seguir para o próximo cupom", async () => {
    adminMlCuponsAlvosProdutos.mockResolvedValue(filaCom(["1", "2", "3"].map(pronto)));
    // O muro chega pelo progresso, do jeito que a extensão avisa: ela traz a aba
    // para a frente e espera o humano. O cupom até pode terminar bem — mas a
    // sessão já foi questionada, e é aí que o lote desiste.
    raparVitrine.mockImplementation(async (_url, { onProgresso }) => {
      onProgresso({ tipo: "muro" });
      return { produtos: [produto], parcial: true, motivo: null, paginas: 1 };
    });
    adminMlCuponsImportVitrine.mockResolvedValue({ ok: true, produtos: 1, parcial: true });
    await abrirTela();

    fireEvent.click(await screen.findByRole("button", { name: BOTAO_PRODUTOS }));

    expect(await screen.findByText("Busca de produtos interrompida")).toBeInTheDocument();
    // O primeiro foi gravado (os produtos dele são reais); o segundo nem começou.
    expect(raparVitrine).toHaveBeenCalledTimes(1);
    expect(adminMlCuponsImportVitrine).toHaveBeenCalledTimes(1);
  });

  it("vitrine vazia não vira gravação — não se apaga o que já existe por nada", async () => {
    adminMlCuponsAlvosProdutos.mockResolvedValue(filaCom([pronto("13471229")]));
    raparVitrine.mockResolvedValue({ produtos: [], parcial: true, motivo: "o Mercado Livre pediu verificação", paginas: 1 });
    await abrirTela();

    fireEvent.click(await screen.findByRole("button", { name: BOTAO_PRODUTOS }));

    expect(await screen.findByText(/a vitrine veio vazia/)).toBeInTheDocument();
    expect(adminMlCuponsImportVitrine).not.toHaveBeenCalled();
  });

  it("o resumo conta cupom a cupom, não só o total", async () => {
    adminMlCuponsAlvosProdutos.mockResolvedValue(filaCom(["1", "2", "3"].map(pronto)));
    // O do meio volta vazio: o resumo tem que contar os desfechos diferentes.
    raparVitrine.mockImplementation(async (url) => (
      url.includes("_Container_2")
        ? { produtos: [], parcial: false, motivo: "vitrine fora do ar", paginas: 1 }
        : { produtos: [produto], parcial: false, motivo: null, paginas: 1 }
    ));
    adminMlCuponsImportVitrine.mockResolvedValue({ ok: true, produtos: 4, parcial: false });
    await abrirTela();

    fireEvent.click(await screen.findByRole("button", { name: BOTAO_PRODUTOS }));

    expect(await screen.findByText("Busca de produtos terminada", {}, { timeout: 20000 })).toBeInTheDocument();
    expect(screen.getByText("Colhidos").previousSibling).toHaveTextContent("2");
    expect(screen.getByText("Vitrine vazia").previousSibling).toHaveTextContent("1");
    // A tabela nomeia quem falhou, em vez de só contar.
    expect(screen.getByText(/vitrine vazia — vitrine fora do ar/)).toBeInTheDocument();
  }, 25000);

  // ── A ativação ────────────────────────────────────────────────────────────
  // A parte cara: cada clique é uma escrita irreversível na conta do ML.

  it("antes de raspar, ativa só os que o servidor listou como faltando", async () => {
    const PAGINA1 = { url: "https://www.mercadolivre.com.br/cupons/filter?all=true&page=1", grouping: null, pagina: 1 };
    adminMlCuponsAlvosProdutos
      // A tela lê a fila ao montar (é o número do botão) e o laço a lê de novo ao
      // começar — as duas primeiras chamadas são a mesma fila.
      .mockResolvedValueOnce(filaCom([], [{ campaignId: "77", title: "Falta aceitar" }]))
      .mockResolvedValueOnce(filaCom([], [{ campaignId: "77", title: "Falta aceitar" }]))
      // Depois do "Eu quero" o ML entrega a vitrine, e a fila é relida.
      .mockResolvedValue(filaCom([pronto("77")]));
    adminMlCuponsLocalStart.mockResolvedValue({ config: {}, ativa: true, categorias: [null], proxima: PAGINA1 });
    paginaDeCupons
      .mockResolvedValueOnce({ tabId: 9, props: { antes: true }, muro: null, clicados: 0, semBotao: [] })
      .mockResolvedValueOnce({ tabId: 9, props: { depois: true }, muro: null, clicados: 1, semBotao: [] });
    adminMlCuponsLocalAtivar.mockResolvedValue({ labels: ["Aplicar cupom 15 por cento OFF"], restantes: 20 });
    adminMlCuponsLocalPagina.mockResolvedValue({ cupons: 1, novos: 1, de: 1, proxima: null, alvos: null, resumo: { cupons: 1, ativados: 1 } });
    raparVitrine.mockResolvedValue({ produtos: [produto], parcial: false, motivo: null, paginas: 1 });
    await abrirTela();

    fireEvent.click(await screen.findByRole("button", { name: BOTAO_PRODUTOS }));

    // Quem ele quer aceitar vai NOMEADO ao servidor: sem isso, o teto de aceites
    // seria gasto nos vizinhos da mesma página e o alvo ficaria sem vitrine.
    await waitFor(() => expect(adminMlCuponsLocalStart).toHaveBeenCalledWith({ ativarApenas: ["77"] }));
    // Os rótulos saem do modelo DESTA página, decididos no servidor…
    expect(adminMlCuponsLocalAtivar).toHaveBeenCalledWith({ grouping: null, props: { antes: true } });
    // …e voltam para a extensão como ordem de clique, na aba já aberta.
    expect(paginaDeCupons).toHaveBeenNthCalledWith(2, { tabId: 9, rotulos: ["Aplicar cupom 15 por cento OFF"] }, expect.anything());
    // E só então a vitrine.
    await waitFor(() => expect(adminMlCuponsImportVitrine).toHaveBeenCalledWith("77", { products: [produto], parcial: false, carimbar: false }));
  });

  it("com a aceitação desligada, ninguém é aceito — só se raspa quem já tem vitrine", async () => {
    adminMlCuponsAlvosProdutos.mockResolvedValue({
      ...filaCom([pronto("1")], [{ campaignId: "77", title: "Falta aceitar" }]),
      config: { ...SEM_ALVO.config, activateCoupons: false, maxActivationsPerRun: 0 },
    });
    raparVitrine.mockResolvedValue({ produtos: [produto], parcial: false, motivo: null, paginas: 1 });
    await abrirTela();

    fireEvent.click(await screen.findByRole("button", { name: BOTAO_PRODUTOS }));

    await waitFor(() => expect(adminMlCuponsImportVitrine).toHaveBeenCalledTimes(1));
    expect(adminMlCuponsLocalStart).not.toHaveBeenCalled();
  });

  it("o botão da linha busca os produtos daquele cupom só", async () => {
    adminMlCupons.mockResolvedValue({
      ...VAZIO, total: 1,
      items: [{ campaignId: "42", title: "Um cupom", scope: "campaign", activated: true, kind: "percent", value: 10, products: 0, inCatalog: 0, containerUrl: "u" }],
    });
    adminMlCuponsAlvosProdutos.mockResolvedValue(filaCom([pronto("42")]));
    raparVitrine.mockResolvedValue({ produtos: [produto], parcial: false, motivo: null, paginas: 1 });
    await abrirTela();

    fireEvent.click(await screen.findByRole("button", { name: "buscar produtos" }));

    // A fila é pedida para AQUELE cupom: sem isso o botão da linha percorreria a
    // lista inteira.
    await waitFor(() => expect(adminMlCuponsAlvosProdutos).toHaveBeenCalledWith({ campaignId: "42" }));
    await waitFor(() => expect(adminMlCuponsImportVitrine).toHaveBeenCalledWith("42", { products: [produto], parcial: false, carimbar: false }));
    // Um cupom escolhido a dedo não é o botão 2: não vira o "última vez" dele.
    await screen.findByText(/Busca de produtos terminada/);
    expect(adminMlCuponsRodadaFim).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Apagar
// ─────────────────────────────────────────────────────────────────────────
describe("produtos na linha do cupom", () => {
  const linha = (extra) => ({ campaignId: "5", title: "Um cupom", scope: "campaign", activated: true, kind: "percent", value: 10, inCatalog: 0, ...extra });

  it("com o total da vitrine, mostra guardados/total", async () => {
    adminMlCupons.mockResolvedValue({ ...VAZIO, total: 1, items: [linha({ products: 45, vitrineTotal: 200 })] });
    await abrirTela();
    expect(await screen.findByText("45/200")).toHaveAttribute("title", expect.stringMatching(/45 guardados de 200/));
  });

  it("sem o total, fica só o que foi guardado", async () => {
    adminMlCupons.mockResolvedValue({ ...VAZIO, total: 1, items: [linha({ products: 45, vitrineTotal: null })] });
    await abrirTela();
    await screen.findByText("Um cupom");
    expect(screen.getByText("45")).toBeInTheDocument();
    expect(screen.queryByText(/45\//)).toBeNull();
  });

  // Task 8.
  it("a vitrine que abriu vazia aparece como tal, e não como 'nenhum'", async () => {
    adminMlCupons.mockResolvedValue({ ...VAZIO, total: 1, items: [linha({ products: 0, vitrineVaziaAt: "2026-10-01T12:00:00.000Z" })] });
    await abrirTela();
    expect(await screen.findByText("vitrine vazia", { selector: "div" })).toHaveAttribute("title", expect.stringMatching(/sem produto nenhum/));
    expect(screen.queryByText("nenhum")).toBeNull();
  });

  it("o filtro de estado pede as vitrines vazias ao backend", async () => {
    await abrirTela();
    fireEvent.change(screen.getByLabelText("Estado dos produtos"), { target: { value: "vazia" } });
    await waitFor(() => expect(adminMlCupons).toHaveBeenLastCalledWith(expect.objectContaining({ produtos: "vazia", page: 1 })));
  });
});

describe("apagar cupons", () => {
  const cupom = {
    campaignId: "42", title: "Um cupom", scope: "campaign", activated: true,
    kind: "percent", value: 10, products: 5, inCatalog: 2, containerUrl: "u",
  };

  it("o 🗑 da linha pede confirmação antes de apagar", async () => {
    adminMlCupons.mockResolvedValue({ ...VAZIO, total: 1, items: [cupom] });
    adminMlCuponsDelete.mockResolvedValue({ ok: true, vinculos: 5, catalogoLimpo: 2 });
    await abrirTela();

    fireEvent.click(await screen.findByRole("button", { name: "🗑" }));
    // A confirmação diz o que vai junto: os vínculos e o carimbo no catálogo.
    expect(await screen.findByText("Apagar este cupom?")).toBeInTheDocument();
    expect(adminMlCuponsDelete).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Apagar cupom" }));
    await waitFor(() => expect(adminMlCuponsDelete).toHaveBeenCalledWith("42"));
  });

  it("cancelar a confirmação não apaga nada", async () => {
    adminMlCupons.mockResolvedValue({ ...VAZIO, total: 1, items: [cupom] });
    await abrirTela();

    fireEvent.click(await screen.findByRole("button", { name: "🗑" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancelar" }));

    await waitFor(() => expect(screen.queryByText("Apagar este cupom?")).toBe(null));
    expect(adminMlCuponsDelete).not.toHaveBeenCalled();
  });

  // Task 9: a prévia vem do servidor antes de qualquer coisa ser apagada.
  it("'Apagar vencidos' mostra a prévia e só apaga depois de confirmar", async () => {
    adminMlCuponsStatus.mockResolvedValue({ config: {}, running: false, stats: { cupons: 10, validos: 7, porCategoria: [] } });
    adminMlCuponsVencidos.mockResolvedValue({ cupons: 3, vinculos: 40, produtos: 25, produtosMantidos: 15 });
    adminMlCuponsApagarVencidos.mockResolvedValue({ ok: true, cupons: 3, vinculos: 40, produtos: 25, produtosMantidos: 15 });
    await abrirTela();

    fireEvent.click(await screen.findByRole("button", { name: "🗑 Apagar vencidos (3)" }));
    expect(await screen.findByText("Apagar os cupons vencidos?")).toBeInTheDocument();
    expect(await screen.findByText("25")).toBeInTheDocument();
    expect(screen.getByText("15")).toBeInTheDocument();
    expect(adminMlCuponsApagarVencidos).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Apagar vencidos" }));
    await waitFor(() => expect(adminMlCuponsApagarVencidos).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/Apaguei 3 cupom\(ns\) vencido\(s\), 40 vínculo\(s\) e 25 produto\(s\) do catálogo — 15 ficaram/)).toBeInTheDocument();
  });

  it("sem cupom vencido, o botão fica desligado", async () => {
    adminMlCuponsStatus.mockResolvedValue({ config: {}, running: false, stats: { cupons: 10, validos: 10, porCategoria: [] } });
    await abrirTela();
    expect(await screen.findByRole("button", { name: "🗑 Apagar vencidos" })).toBeDisabled();
  });

  // Task 10: só os produtos da vitrine; o cupom fica.
  it("'apagar produtos' da linha pede confirmação e apaga só os daquele cupom", async () => {
    adminMlCupons.mockResolvedValue({ ...VAZIO, total: 1, items: [cupom] });
    adminMlCuponsApagarProdutos.mockResolvedValue({ ok: true, vinculos: 5, produtos: 2, produtosMantidos: 3 });
    await abrirTela();

    fireEvent.click(await screen.findByRole("button", { name: "apagar produtos" }));
    expect(await screen.findByText("Apagar os produtos deste cupom?")).toBeInTheDocument();
    expect(adminMlCuponsApagarProdutos).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Apagar produtos" }));
    await waitFor(() => expect(adminMlCuponsApagarProdutos).toHaveBeenCalledWith("42"));
    expect(adminMlCuponsDelete).not.toHaveBeenCalled();
    expect(await screen.findByText(/Um cupom: saíram 5 vínculo\(s\) de vitrine e 2 produto\(s\) do catálogo — 3 ficaram/)).toBeInTheDocument();
  });

  it("cupom sem produto não ganha o 'apagar produtos'", async () => {
    adminMlCupons.mockResolvedValue({ ...VAZIO, total: 1, items: [{ ...cupom, products: 0 }] });
    await abrirTela();
    await screen.findByText("Um cupom");
    expect(screen.queryByRole("button", { name: "apagar produtos" })).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// A categoria do cupom
// ─────────────────────────────────────────────────────────────────────────
//
// O ML separa os cupons por categoria e o sistema guarda em quais cada um
// apareceu — como chave crua (`ce_vertical`). O nome bonito vem do dicionário que
// o backend mescla a cada varredura; sem ele a tela mostra a chave, que ainda diz
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
    // painel de limites, que é outra coisa (o que a próxima varredura vai carimbar).
    expect(await screen.findByRole("cell", { name: "Eletrônicos" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "xx_vertical" })).toBeInTheDocument();
  });

  it("cupom em mais de uma categoria mostra as duas", async () => {
    adminMlCupons.mockResolvedValue({ ...VAZIO, total: 1, items: [cupom({ groupings: ["ce_vertical", "tb_vertical"] })] });
    await abrirTela();

    expect(await screen.findByText("Eletrônicos · Moda")).toBeInTheDocument();
  });

  it("passando de duas categorias, mostra as duas primeiras e +N, com a lista inteira no title", async () => {
    // Escrever todas na célula empurrava a tabela para a rolagem lateral.
    adminMlCupons.mockResolvedValue({
      ...VAZIO, total: 1,
      items: [cupom({ groupings: ["ce_vertical", "tb_vertical", "xx_vertical", "yy_vertical"] })],
    });
    await abrirTela();

    const celula = await screen.findByRole("cell", { name: "Eletrônicos · Moda +2" });
    expect(celula).toHaveAttribute("title", "Eletrônicos · Moda · xx_vertical · yy_vertical");
  });

  it("cupom de loja tem categoria própria, com o nome do vendedor", async () => {
    // "Em produtos de Agrotrator" é a categoria que mais importa para quem olha a
    // tabela: ele vale só para os produtos daquele vendedor.
    adminMlCupons.mockResolvedValue({
      ...VAZIO, total: 1,
      items: [cupom({ scope: "store", sellerName: "Agrotrator", groupings: [] })],
    });
    await abrirTela();

    expect(await screen.findByRole("cell", { name: "Loja · Agrotrator" })).toBeInTheDocument();
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

  it("dá para ver só os cupons de loja", async () => {
    adminMlCupons.mockResolvedValue({ ...VAZIO, total: 1, items: [cupom()] });
    await abrirTela();

    fireEvent.change(await screen.findByDisplayValue("todos os tipos"), { target: { value: "store" } });
    await waitFor(() => expect(adminMlCupons).toHaveBeenLastCalledWith(expect.objectContaining({ scope: "store" })));
  });

  // O seletor da config é outra coisa do filtro acima: o filtro é sobre o que JÁ
  // foi colhido, o seletor é sobre o que a próxima varredura vai CARIMBAR. Ele não
  // existia — e por isso uma config antiga presa em `["tb_vertical"]` deixou a
  // rodada puxando só de Brinquedos sem nenhum jeito de sair pela tela (task 26).
  it("o painel de limites deixa escolher as categorias do carimbo", async () => {
    adminMlCupons.mockResolvedValue({ ...VAZIO, total: 1, items: [cupom()] });
    await abrirTela();

    // Nenhuma marcada é o estado bom, e a tela diz isso com todas as letras.
    expect(await screen.findByText("carimba todas")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: "Eletrônicos" }));
    fireEvent.click(screen.getByRole("button", { name: /salvar os limites da lista/i }));

    await waitFor(() => {
      expect(adminMlCuponsSaveConfig).toHaveBeenCalledWith(expect.objectContaining({ categorias: ["ce_vertical"] }));
    });
  });

  it("a config presa numa categoria tem como voltar a carimbar todas", async () => {
    adminMlCuponsStatus.mockResolvedValue({
      config: { categorias: ["tb_vertical"] }, running: false,
      groupingLabels: { ce_vertical: "Eletrônicos", tb_vertical: "Moda" },
      stats: { cupons: 1, porCategoria: [{ chave: "tb_vertical", n: 1 }] },
    });
    adminMlCupons.mockResolvedValue({ ...VAZIO, total: 1, items: [cupom()] });
    await abrirTela();

    expect(await screen.findByText("1 escolhida")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "carimbar todas" }));
    fireEvent.click(screen.getByRole("button", { name: /salvar os limites da lista/i }));

    await waitFor(() => {
      expect(adminMlCuponsSaveConfig).toHaveBeenCalledWith(expect.objectContaining({ categorias: [] }));
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

    expect(await screen.findByRole("checkbox", { name: "Eletrônicos" })).toBeInTheDocument();
    // Carimbar por eles poria "Mais de 10%" na coluna Categoria — uma categoria
    // que não existe.
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

// O balanço da última vez de cada botão vem do servidor e sobrevive a um F5 — o
// log ao vivo não. Um por botão (task 17): eles fazem coisas diferentes.
describe("o balanço da última vez de cada botão", () => {
  it("terminada a varredura, o resumo vira números em vez de uma frase corrida", async () => {
    adminMlCuponsStatus.mockResolvedValue({
      config: {}, running: false,
      ultimas: {
        lista: {
          at: "2026-08-31T12:00:00.000Z", duracaoMs: 92000, erro: null, interrompida: false,
          resultado: { cupons: 120, novos: 7, atualizados: 100, cuponsDeLojaIgnorados: 12 },
        },
        produtos: null,
      },
      log: [],
    });
    await abrirTela();

    expect(await screen.findByText(/1 · Cupons e condições — última vez/)).toBeInTheDocument();
    expect(screen.getByText("Cupons").previousSibling).toHaveTextContent("120");
    expect(screen.getByText("Novos").previousSibling).toHaveTextContent("7");
    expect(screen.getByText("Duração").previousSibling).toHaveTextContent("1min e 32s");
    // Sem balanço dos outros botões, nada deles aparece.
    expect(screen.queryByText(/2 · Buscar Produtos Dos Cupons — última vez/)).toBe(null);
  });

  it("cada botão mostra o seu, com o aviso de quem foi interrompido", async () => {
    const at = "2026-08-31T12:00:00.000Z";
    adminMlCuponsStatus.mockResolvedValue({
      config: {}, running: false,
      ultimas: {
        lista: { at, duracaoMs: 1000, resultado: { cupons: 5 }, erro: null, interrompida: false },
        produtos: { at, duracaoMs: 2000, resultado: { tentados: 4, colhidos: 3 }, erro: "Interrompido por você", interrompida: true },
      },
      log: [],
    });
    await abrirTela();

    expect(await screen.findByText(/1 · Cupons e condições — última vez/)).toBeInTheDocument();
    expect(screen.getByText(/2 · Buscar Produtos Dos Cupons — última vez .*\(interrompida\)/)).toBeInTheDocument();
    expect(screen.getByText("Interrompido por você")).toBeInTheDocument();
    expect(screen.getByText("Colhidos").previousSibling).toHaveTextContent("3");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Trazer uma campanha pelo ID (task 32)
// ─────────────────────────────────────────────────────────────────────────
//
// Outra forma de um cupom entrar aqui — e a única que parte de um número que veio
// de fora (um link, um print). O que estes testes protegem é a ORDEM: olhar primeiro
// no que já está guardado, e só então oferecer o ML. Trazer uma campanha abre um
// Chrome com a conta do sistema e varre a lista de cupons dela; fazer isso por uma
// campanha que já estava na tabela é o desperdício que a caixa existe para evitar.
describe("trazer campanha por ID", () => {
  const CAIXA = /13495993 ou o link do cupom/i;
  const BOTAO = /trazer campanha por id/i;

  const cupom = (campaignId, title) => ({
    campaignId, title, subtitle: null, kind: "percent", value: 20, scope: "campaign",
    activated: true, groupings: [], products: 0, inCatalog: 0, code: null, codeSource: null,
  });

  async function digitar(texto) {
    fireEvent.change(await screen.findByPlaceholderText(CAIXA), { target: { value: texto } });
    fireEvent.click(screen.getByRole("button", { name: BOTAO }));
  }

  it("campanha que já está guardada filtra a lista — e não vai ao ML", async () => {
    await abrirTela();
    adminMlCupons.mockResolvedValue({ ...VAZIO, items: [cupom("13495993", "20% OFF Casa")], total: 1 });

    await digitar("13495993");

    // O recado nomeia o cupom: o título aparece duas vezes na tela (aqui e na linha
    // da tabela), então a asserção casa a frase inteira, não só o nome.
    expect(await screen.findByText(/já está guardada: “20% OFF Casa”/)).toBeInTheDocument();
    // O modal é o que abriria um Chrome: ele não pode aparecer neste caminho.
    expect(screen.queryByText("Essa campanha não está no sistema")).toBeNull();
    expect(adminMlCuponsImportCampaign).not.toHaveBeenCalled();
    // E a lista passou a ser pedida por aquele id, com os vencidos incluídos.
    await waitFor(() => expect(adminMlCupons).toHaveBeenCalledWith(
      expect.objectContaining({ q: "13495993", onlyValid: false }),
    ));
  });

  it("campanha desconhecida abre o convite de buscar no ML, com aquele número", async () => {
    await abrirTela();
    // A busca por id não acha nada: a lista volta vazia.
    adminMlCupons.mockResolvedValue(VAZIO);

    await digitar("13495993");

    expect(await screen.findByText("Essa campanha não está no sistema")).toBeInTheDocument();
    // Sem palavra nenhuma testada: a frase é a do número digitado.
    expect(screen.getByText(/não está guardada aqui/i)).toBeInTheDocument();
  });

  it("o link do cupom vira o id da campanha — não o do vendedor", async () => {
    await abrirTela();
    adminMlCupons.mockResolvedValue(VAZIO);

    // `2903552873` é o `_CustId_`, o VENDEDOR. A campanha é a do parâmetro.
    await digitar("https://lista.mercadolivre.com.br/_CustId_2903552873?coupon_campaign_id=13495993");

    await screen.findByText("Essa campanha não está no sistema");
    await waitFor(() => expect(adminMlCupons).toHaveBeenCalledWith(
      expect.objectContaining({ q: "13495993" }),
    ));
    expect(adminMlCupons).not.toHaveBeenCalledWith(expect.objectContaining({ q: "2903552873" }));
  });

  it("texto que não tem id nenhum nem chega no servidor", async () => {
    await abrirTela();
    adminMlCupons.mockClear();

    await digitar("BRINQUEDOS");

    expect(await screen.findByText(/Não achei um número de campanha/i)).toBeInTheDocument();
    expect(adminMlCupons).not.toHaveBeenCalled();
    expect(screen.queryByText("Essa campanha não está no sistema")).toBeNull();
  });
});

// A agenda (task 3): o servidor marca a etapa vencida, e é esta aba que a roda.
describe("a agenda das etapas", () => {
  it("etapa vencida com a extensão: a aba pega e aperta o botão sozinha", async () => {
    coletorInfo.mockResolvedValue(EXTENSAO("raspar", "lista"));
    adminMlCuponsAgendaPendentes.mockResolvedValue({ pendentes: [{ botao: "lista", slot: "08:00" }] });
    await abrirTela();

    await waitFor(() => expect(adminMlCuponsAgendaReivindicar).toHaveBeenCalledWith("lista"));
    await waitFor(() => expect(adminMlCuponsLocalStart).toHaveBeenCalled());
    expect(adminMlCuponsAgendaFalhou).not.toHaveBeenCalled();
  });

  it("sem a extensão a aba não finge que rodou: avisa o motivo", async () => {
    adminMlCuponsAgendaPendentes.mockResolvedValue({ pendentes: [{ botao: "lista", slot: "03:00" }] });
    await abrirTela();

    await waitFor(() => expect(adminMlCuponsAgendaFalhou).toHaveBeenCalledWith("lista", expect.stringMatching(/extensão/)));
    expect(adminMlCuponsAgendaReivindicar).not.toHaveBeenCalled();
    expect(adminMlCuponsLocalStart).not.toHaveBeenCalled();
  });

  it("a etapa \"tudo\" (o antigo botão 3) falha em vez de ficar pendurada", async () => {
    coletorInfo.mockResolvedValue(EXTENSAO("raspar", "lista"));
    adminMlCuponsAgendaPendentes.mockResolvedValue({ pendentes: [{ botao: "tudo", slot: "03:00" }] });
    await abrirTela();

    await waitFor(() => expect(adminMlCuponsAgendaFalhou).toHaveBeenCalledWith("tudo", expect.stringMatching(/removida/)));
    expect(adminMlCuponsAgendaReivindicar).not.toHaveBeenCalled();
  });

  it("não existe mais o botão 3", async () => {
    await abrirTela();
    expect(screen.queryByRole("region", { name: /Buscar TUDO/i })).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Sair da aba e voltar (task 6)
// ─────────────────────────────────────────────────────────────────────────
// A aba é montada do zero a cada troca (AdminCupom.jsx). O laço continua rodando
// no Chrome enquanto isso — e a tela que volta tem de encontrá-lo, não recomeçar.
describe("sair da aba e voltar no meio de uma rodada", () => {
  const PAGINA1 = { url: "https://www.mercadolivre.com.br/cupons/filter?all=true&page=1", grouping: null, pagina: 1 };
  const PAGINA2 = { ...PAGINA1, url: "https://www.mercadolivre.com.br/cupons/filter?all=true&page=2", pagina: 2 };

  // A primeira página fica pendurada até o teste soltá-la: é a rodada "no meio".
  const listaPendurada = () => {
    coletorInfo.mockResolvedValue(EXTENSAO("raspar", "lista"));
    adminMlCuponsLocalStart.mockResolvedValue({ config: {}, ativa: false, categorias: [null], proxima: PAGINA1 });
    let soltar;
    paginaDeCupons.mockReturnValueOnce(new Promise(r => { soltar = r; }));
    // A lista acaba na página 2. Sem esse fim, uma `paginaDeCupons` que outro teste
    // deixou respondendo faria o laço girar para sempre depois de soltar a primeira.
    paginaDeCupons.mockResolvedValue({ tabId: 7, props: { p: 2 }, muro: null, clicados: 0, semBotao: [] });
    adminMlCuponsLocalPagina
      .mockResolvedValueOnce({ cupons: 30, novos: 30, de: 2, proxima: PAGINA2, alvos: null })
      .mockResolvedValue({ cupons: 45, novos: 15, de: 2, proxima: null, alvos: null, resumo: { cupons: 45, novos: 45 } });
    return () => soltar({ tabId: 7, props: { p: 1 }, muro: null, clicados: 0, semBotao: [] });
  };

  // O botão nasce desligado e só liga quando a extensão responde: clicar antes disso
  // não faz nada, e a suíte inteira em paralelo deixava essa resposta atrasar.
  const iniciarLista = async () => {
    const botao = await screen.findByRole("button", { name: BOTAO_LISTA });
    await waitFor(() => expect(botao).toBeEnabled());
    fireEvent.click(botao);
    await screen.findByRole("button", { name: /Parar a varredura/ });
  };

  it("a barra, o log e o Parar continuam lá — e o Parar ainda para", async () => {
    const soltar = listaPendurada();
    const { unmount } = render(<PageCuponsML />);
    await iniciarLista();

    unmount();
    await abrirTela();

    const card1 = screen.getByRole("region", { name: /1 · Cupons e condições/i });
    expect(within(card1).getByRole("button", { name: /Parar a varredura/ })).toBeInTheDocument();
    expect(within(card1).getByText(/O que está acontecendo agora/)).toBeInTheDocument();
    // Os vizinhos continuam travados: a rodada de antes ainda é a dona do Chrome.
    expect(screen.getByRole("button", { name: BOTAO_PRODUTOS })).toBeDisabled();

    fireEvent.click(within(card1).getByRole("button", { name: /Parar a varredura/ }));
    soltar();

    // Parou depois da página 1, sem abrir a 2 — e o balanço cai na tela NOVA.
    expect(await within(card1).findByText(/Varredura interrompida/)).toBeInTheDocument();
    expect(paginaDeCupons).toHaveBeenCalledTimes(1);
    expect(adminMlCuponsLocalFim).toHaveBeenCalledWith({ cancelada: true });
  });

  it("voltar não deixa disparar uma segunda rodada por cima da primeira", async () => {
    const soltar = listaPendurada();
    const { unmount } = render(<PageCuponsML />);
    await iniciarLista();

    unmount();
    await abrirTela();

    expect(screen.queryByRole("button", { name: BOTAO_LISTA })).toBeNull();
    expect(adminMlCuponsLocalStart).toHaveBeenCalledTimes(1);
    soltar();
    await waitFor(() => expect(adminMlCuponsLocalFim).toHaveBeenCalled());
  });
});

// Os filtros da tabela ficam lembrados no navegador — menos quando a tela abre
// apontando uma campanha vinda de outra aba: aí a campanha manda e NÃO vira o
// filtro lembrado.
describe("filtros lembrados", () => {
  const BUSCA = "buscar por título, loja, palavra ou nº da campanha";

  it("volta com a busca e o 'só válidos' da última vez", async () => {
    const { unmount } = render(<PageCuponsML />);
    await waitFor(() => expect(adminMlCupons).toHaveBeenCalled());
    fireEvent.change(screen.getByPlaceholderText(BUSCA), { target: { value: "jbl" } });
    await waitFor(() => expect(adminMlCupons).toHaveBeenLastCalledWith(expect.objectContaining({ q: "jbl" })));
    unmount();
    adminMlCupons.mockClear();

    render(<PageCuponsML />);
    await waitFor(() => expect(adminMlCupons).toHaveBeenCalled());
    expect(adminMlCupons.mock.calls[0][0]).toMatchObject({ q: "jbl", onlyValid: true, page: 1 });
    expect(screen.getByPlaceholderText(BUSCA)).toHaveValue("jbl");
  });

  it("a campanha vinda de outra aba não apaga nem substitui o que estava lembrado", async () => {
    gravarPref("cupons.mlFiltros", { q: "jbl", scope: "", grouping: "", onlyValid: true });
    const { unmount } = render(<PageCuponsML buscaInicial="123456" />);
    await waitFor(() => expect(adminMlCupons).toHaveBeenCalled());
    expect(adminMlCupons.mock.calls[0][0]).toMatchObject({ q: "123456", onlyValid: false });
    unmount();
    expect(lerLembrado("cupons.mlFiltros", {})).toMatchObject({ q: "jbl", onlyValid: true });
  });

  it("filtro guardado estragado cai no padrão", async () => {
    gravarPref("cupons.mlFiltros", "lixo");
    render(<PageCuponsML />);
    await waitFor(() => expect(adminMlCupons).toHaveBeenCalled());
    expect(adminMlCupons.mock.calls[0][0]).toMatchObject({ q: "", onlyValid: true, page: 1 });
  });
});
