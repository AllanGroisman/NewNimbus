// Admin › Cupom › "Descobrir palavra" — o convite pra trazer a campanha que uma
// palavra apontou.
//
// O ML só responde o ID da campanha. Quando esse ID não está no sistema, a tela
// mostrava um número solto e o único caminho era rodar a coleta inteira (minutos
// de Chrome com a conta do sistema). O popup é o atalho — e o que estes testes
// protegem é justamente ele NÃO aparecer quando a campanha já está aqui, que é o
// caso comum e onde um popup à toa vira ruído a cada teste de palavra.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("../data/api", () => ({
  // errText é helper puro (não faz rede) — usa a implementação de verdade.
  errText: (err, fallback) => err?.message || fallback,
  adminMlCuponsTestWord: vi.fn(),
  adminMlCuponsLocalPalavra: vi.fn(),
  adminMlCuponsImportVitrine: vi.fn(),
  adminMlCuponsLocalFim: vi.fn(),
  adminMlCuponsCodes: vi.fn(),
  adminMlCuponsImportCampaign: vi.fn(),
  adminMlCuponsImportStatus: vi.fn(),
}));

// A extensão do Chrome (extension/ na raiz). O teste de palavra prefere ela quando
// está instalada; aqui o padrão é NÃO estar, que é o caminho do servidor.
vi.mock("../data/coletor", () => ({
  coletorEntende: vi.fn(),
  testarPalavraNoChrome: vi.fn(),
  raparVitrine: vi.fn(),
  fecharAbaDoColetor: vi.fn(),
}));

// O laço da lista de cupons no Chrome do admin (data/rodadaNoChrome.js). O modal
// de "trazer campanha" usa o mesmo laço da rodada, com uma campanha alvo.
vi.mock("../data/rodadaNoChrome", () => ({ percorrerLista: vi.fn() }));

import DescobrirPalavra from "../pages/AdminCupomPalavra.jsx";
import { coletorEntende, testarPalavraNoChrome, raparVitrine, fecharAbaDoColetor } from "../data/coletor";
import { percorrerLista } from "../data/rodadaNoChrome";
import {
  adminMlCuponsCodes,
  adminMlCuponsTestWord,
  adminMlCuponsLocalPalavra,
  adminMlCuponsImportVitrine,
  adminMlCuponsLocalFim,
  adminMlCuponsImportCampaign,
  adminMlCuponsImportStatus,
} from "../data/api";
import { _zerarParaTestes as zerarPrefsAdmin } from "../data/preferenciasAdmin";

// As preferências de tela do admin vivem num módulo que dura a suíte inteira.
beforeEach(() => zerarPrefsAdmin());

// A resposta do POST /code. `coupon: null` é o caso que abre o popup: o ML
// reconheceu a palavra e o sistema não tem a campanha.
const resposta = (extra = {}) => ({
  result: {
    word: "BRINQUEDOS", verdict: "valid", campaignId: "13907402",
    coupon: null, message: "Cupom aplicado", cached: false, ...extra,
  },
});

async function abrirTela(props = {}) {
  render(<DescobrirPalavra {...props} />);
  await waitFor(() => expect(adminMlCuponsCodes).toHaveBeenCalled());
}

async function testarPalavra() {
  fireEvent.change(screen.getByPlaceholderText("BRINQUEDOS"), { target: { value: "brinquedos" } });
  fireEvent.click(screen.getByRole("button", { name: /testar palavra/i }));
}

beforeEach(() => {
  vi.clearAllMocks();
  // "Trazer com produtos" é lembrado no navegador.
  localStorage.clear();
  // Sem extensão é o padrão: o teste de palavra cai no caminho do servidor.
  coletorEntende.mockResolvedValue(false);
  adminMlCuponsCodes.mockResolvedValue({ codes: [] });
  // A busca roda solta: o POST só dispara, o desfecho vem pelo status.
  adminMlCuponsImportCampaign.mockResolvedValue({ started: true, running: true });
  adminMlCuponsImportStatus.mockResolvedValue({ running: false, result: null, error: null });
});

describe("popup de campanha que falta", () => {
  it("abre quando a palavra vale e a campanha não está no sistema", async () => {
    adminMlCuponsTestWord.mockResolvedValue(resposta());
    await abrirTela();
    await testarPalavra();

    expect(await screen.findByText("Essa campanha não está no sistema")).toBeInTheDocument();
    // A palavra vai maiúscula pro backend, como o campo mostra.
    expect(adminMlCuponsTestWord).toHaveBeenCalledWith("BRINQUEDOS", false, "admin");
  });

  it("NÃO abre quando a campanha já está aqui", async () => {
    adminMlCuponsTestWord.mockResolvedValue(resposta({ coupon: { campaignId: "13907402", title: "20% OFF" } }));
    await abrirTela();
    await testarPalavra();

    await screen.findByText(/20% OFF/);
    expect(screen.queryByText("Essa campanha não está no sistema")).not.toBeInTheDocument();
  });

  it("NÃO abre quando o ML não reconheceu a palavra", async () => {
    adminMlCuponsTestWord.mockResolvedValue(resposta({ verdict: "invalid", campaignId: null }));
    await abrirTela();
    await testarPalavra();

    await waitFor(() => expect(adminMlCuponsTestWord).toHaveBeenCalled());
    expect(screen.queryByText("Essa campanha não está no sistema")).not.toBeInTheDocument();
  });

  it("abre também para resposta guardada — o cache diz do veredito, não da campanha", async () => {
    adminMlCuponsTestWord.mockResolvedValue(resposta({ cached: true, checkedAt: new Date().toISOString() }));
    await abrirTela();
    await testarPalavra();

    expect(await screen.findByText("Essa campanha não está no sistema")).toBeInTheDocument();
  });

  it("busca com os produtos por padrão, mostra o progresso e depois o que entrou", async () => {
    adminMlCuponsTestWord.mockResolvedValue(resposta());
    // Primeiro tick: ainda varrendo. Segundo: terminou.
    adminMlCuponsImportStatus
      .mockResolvedValueOnce({ running: true, progress: { etapa: "cupons", pagina: 2, de: 13, cupons: 60 } })
      .mockResolvedValue({
        running: false,
        result: { ok: true, coupon: { campaignId: "13907402", title: "Até 20% OFF em brinquedos" }, produtos: 52, vinculos: 52 },
      });
    await abrirTela();
    await testarPalavra();
    await screen.findByText("Essa campanha não está no sistema");

    fireEvent.click(screen.getByRole("button", { name: /buscar e adicionar/i }));

    await waitFor(() => expect(adminMlCuponsImportCampaign).toHaveBeenCalledWith("13907402", true));
    expect(await screen.findByText(/página 2\/13/)).toBeInTheDocument();
    // O desfecho só chega na leitura seguinte, 3s depois.
    expect(await screen.findByText(/52 produtos/, {}, { timeout: 5000 })).toBeInTheDocument();
  });

  it("campanha que já estava no sistema é desfecho na hora, sem acompanhar", async () => {
    adminMlCuponsTestWord.mockResolvedValue(resposta());
    adminMlCuponsImportCampaign.mockResolvedValue({
      ok: true, already: true, coupon: { campaignId: "13907402", title: "Já estava aqui" },
    });
    await abrirTela();
    await testarPalavra();
    await screen.findByText("Essa campanha não está no sistema");

    fireEvent.click(screen.getByRole("button", { name: /buscar e adicionar/i }));

    expect(await screen.findByText(/Já estava aqui/)).toBeInTheDocument();
    expect(adminMlCuponsImportStatus).not.toHaveBeenCalled();
  });

  it("desmarcar o checkbox traz só a campanha", async () => {
    adminMlCuponsTestWord.mockResolvedValue(resposta());
    adminMlCuponsImportStatus.mockResolvedValue({
      running: false, result: { ok: true, coupon: { campaignId: "13907402", title: "Só a campanha" }, produtos: 0 },
    });
    await abrirTela();
    await testarPalavra();
    await screen.findByText("Essa campanha não está no sistema");

    // Pelo rótulo, não por role: a tela tem outros checkboxes (o filtro e o
    // "ignorar cupom de loja" da configuração da rodada).
    fireEvent.click(screen.getByLabelText(/Trazer também os produtos da vitrine/));
    fireEvent.click(screen.getByRole("button", { name: /buscar e adicionar/i }));

    await waitFor(() => expect(adminMlCuponsImportCampaign).toHaveBeenCalledWith("13907402", false));
  });

  it("erro do servidor durante a busca aparece no modal", async () => {
    adminMlCuponsTestWord.mockResolvedValue(resposta());
    adminMlCuponsImportStatus.mockResolvedValue({
      running: false, error: "Sem sessão do Mercado Livre do sistema.",
    });
    await abrirTela();
    await testarPalavra();
    await screen.findByText("Essa campanha não está no sistema");

    fireEvent.click(screen.getByRole("button", { name: /buscar e adicionar/i }));

    expect(await screen.findByText("Sem sessão do Mercado Livre do sistema.")).toBeInTheDocument();
  });

  // A busca dura minutos e o modal diz que dá pra fechar. Se o intervalo ficasse
  // vivo, ele seguiria chamando a API e gravando estado em componente desmontado.
  it("fechar no meio da busca não deixa o acompanhamento rodando", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      adminMlCuponsTestWord.mockResolvedValue(resposta());
      adminMlCuponsImportStatus.mockResolvedValue({ running: true, progress: { etapa: "abrindo" } });
      await abrirTela();
      await testarPalavra();
      await screen.findByText("Essa campanha não está no sistema");

      fireEvent.click(screen.getByRole("button", { name: /buscar e adicionar/i }));
      await waitFor(() => expect(adminMlCuponsImportStatus).toHaveBeenCalled());

      fireEvent.click(screen.getByRole("button", { name: /a busca continua/i }));
      await waitFor(() => expect(screen.queryByText("Essa campanha não está no sistema")).not.toBeInTheDocument());

      const antes = adminMlCuponsImportStatus.mock.calls.length;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(adminMlCuponsImportStatus.mock.calls.length).toBe(antes);
    } finally {
      vi.useRealTimers();
    }
  });

  it("campanha não achada na lista mostra o motivo e não fecha sozinho", async () => {
    adminMlCuponsTestWord.mockResolvedValue(resposta());
    adminMlCuponsImportStatus.mockResolvedValue({
      running: false, result: { ok: false, reason: "Essa campanha não aparece na lista da conta." },
    });
    await abrirTela();
    await testarPalavra();
    await screen.findByText("Essa campanha não está no sistema");

    fireEvent.click(screen.getByRole("button", { name: /buscar e adicionar/i }));

    expect(await screen.findByText("Essa campanha não aparece na lista da conta.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /buscar e adicionar/i })).toBeInTheDocument();
  });
});

describe("palavras já testadas", () => {
  const historico = [
    { code: "REPASSE10", verdict: "valid", campaignId: "13907402", inSystem: false, checkedAt: new Date().toISOString(), message: null },
    { code: "GAMER", verdict: "valid", campaignId: "14030498", inSystem: true, couponTitle: "15% OFF", checkedAt: new Date().toISOString(), message: null },
  ];

  it("só a palavra cuja campanha falta ganha o botão de adicionar", async () => {
    adminMlCuponsCodes.mockResolvedValue({ codes: historico });
    await abrirTela();

    // "Palavras já testadas" só existe depois que o histórico carrega — e "BRINQUEDOS"
    // não serve de âncora: a explicação do card usa a mesma palavra de exemplo.
    await screen.findByText("Palavras já testadas");
    expect(screen.getAllByRole("button", { name: /adicionar/i })).toHaveLength(1);
  });

  it("o botão do histórico abre o mesmo popup, com aquela campanha", async () => {
    adminMlCuponsCodes.mockResolvedValue({ codes: historico });
    adminMlCuponsImportStatus.mockResolvedValue({
      running: false, result: { ok: true, coupon: { campaignId: "13907402", title: "Achada" }, produtos: 3 },
    });
    await abrirTela();

    fireEvent.click(await screen.findByRole("button", { name: /adicionar/i }));
    await screen.findByText("Essa campanha não está no sistema");
    fireEvent.click(screen.getByRole("button", { name: /buscar e adicionar/i }));

    await waitFor(() => expect(adminMlCuponsImportCampaign).toHaveBeenCalledWith("13907402", true));
  });
});

// "Tivemos um problema" é o ML engasgando antes de avaliar a palavra — não é ele
// dizendo que a palavra não existe. A tela chamava isso de "o ML não reconheceu"
// para uma palavra que já era uma campanha viva aqui dentro.
describe("engasgo do ML (indeterminado)", () => {
  const engasgo = (extra = {}) => ({
    result: {
      word: "BRINQUEDOS", verdict: "indeterminado", campaignId: null, coupon: null,
      message: "Tivemos um problema", cached: false, knownLocally: false, ...extra,
    },
  });

  it("não diz 'não reconheceu' — diz que o ML não respondeu", async () => {
    adminMlCuponsTestWord.mockResolvedValue(engasgo());
    await abrirTela();
    await testarPalavra();

    expect(await screen.findByText(/o ML não respondeu/)).toBeTruthy();
    expect(screen.queryByText(/não reconheceu/)).toBe(null);
  });

  it("oferece testar de novo, e aí sim ignora o cache (force)", async () => {
    adminMlCuponsTestWord.mockResolvedValue(engasgo());
    await abrirTela();
    await testarPalavra();

    // O teste normal NÃO manda force: senão todo teste queimaria um Chrome à toa.
    expect(adminMlCuponsTestWord).toHaveBeenCalledWith("BRINQUEDOS", false, "admin");

    fireEvent.click(await screen.findByRole("button", { name: /testar de novo/i }));
    await waitFor(() => expect(adminMlCuponsTestWord).toHaveBeenCalledWith("BRINQUEDOS", true, "admin"));
  });

  it("mostra a campanha que o sistema já sabe, e não oferece importar ela", async () => {
    adminMlCuponsTestWord.mockResolvedValue(engasgo({
      campaignId: "13471229",
      knownLocally: true,
      coupon: { campaignId: "13471229", title: "15% OFF com BRINCADEIRAS" },
    }));
    await abrirTela();
    await testarPalavra();

    expect(await screen.findByText("13471229")).toBeTruthy();
    expect(screen.getByText(/já está carimbada nela/)).toBeTruthy();
    // O popup é só pra campanha que FALTA: essa está aqui.
    expect(screen.queryByRole("button", { name: /buscar e adicionar/i })).toBe(null);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Com a extensão instalada, a palavra é testada no Chrome do admin
// ─────────────────────────────────────────────────────────────────────────
//
// O ML responde CAPTCHA para navegador automatizado — o caminho do servidor abre
// o próprio Chrome e é justamente ele que apanha. Com a extensão, quem digita a
// palavra é uma aba do Chrome do admin, com a sessão dele.
//
// O que estes testes protegem é a divisão: a extensão devolve os corpos CRUS que a
// página do ML respondeu, e quem lê é o servidor — a mesma função pura dos dois
// caminhos. Se a extensão passasse a interpretar, a mesma palavra teria dois
// vereditos dependendo de quem abriu a página.
describe("a palavra testada pela extensão", () => {
  it("manda o material cru para o servidor e não chama o caminho antigo", async () => {
    coletorEntende.mockResolvedValue(true);
    testarPalavraNoChrome.mockResolvedValue({
      respostas: ['{"coupon":{"campaignId":"13907402"}}'], bodyText: "…", muro: null, motivo: null,
    });
    adminMlCuponsLocalPalavra.mockResolvedValue({ result: { word: "BRINQUEDOS", verdict: "valid", campaignId: "13907402", coupon: { campaignId: "13907402", title: "20% OFF" } } });
    await abrirTela();

    fireEvent.change(screen.getByPlaceholderText(/BRINQUEDOS/i), { target: { value: "brinquedos" } });
    fireEvent.click(screen.getByRole("button", { name: /Testar palavra/i }));

    await waitFor(() => expect(adminMlCuponsLocalPalavra).toHaveBeenCalledWith(expect.objectContaining({
      word: "BRINQUEDOS",
      respostas: ['{"coupon":{"campaignId":"13907402"}}'],
      source: "admin",
    })));
    expect(adminMlCuponsTestWord).not.toHaveBeenCalled();
  });

  it("o muro na aba do admin não vira nova tentativa pelo servidor", async () => {
    coletorEntende.mockResolvedValue(true);
    testarPalavraNoChrome.mockResolvedValue({
      respostas: [], muro: "captcha", motivo: "o Mercado Livre pediu verificação e ela não foi resolvida",
    });
    await abrirTela();

    fireEvent.change(screen.getByPlaceholderText(/BRINQUEDOS/i), { target: { value: "brinquedos" } });
    fireEvent.click(screen.getByRole("button", { name: /Testar palavra/i }));

    // Insistir pelo servidor seria a MESMA conta por um caminho que apanha mais.
    await waitFor(() => expect(screen.getByText(/pediu verificação/)).toBeTruthy());
    expect(adminMlCuponsTestWord).not.toHaveBeenCalled();
    expect(adminMlCuponsLocalPalavra).not.toHaveBeenCalled();
  });

  it("página do ML mudou de forma: aí sim vale tentar pelo servidor", async () => {
    coletorEntende.mockResolvedValue(true);
    testarPalavraNoChrome.mockResolvedValue({ respostas: [], muro: null, motivo: 'Não achei o "Inserir código do cupom" na página.' });
    adminMlCuponsTestWord.mockResolvedValue(resposta());
    await abrirTela();

    fireEvent.change(screen.getByPlaceholderText(/BRINQUEDOS/i), { target: { value: "brinquedos" } });
    fireEvent.click(screen.getByRole("button", { name: /Testar palavra/i }));

    await waitFor(() => expect(adminMlCuponsTestWord).toHaveBeenCalledWith("BRINQUEDOS", false, "admin"));
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Trazer a campanha pela extensão
// ─────────────────────────────────────────────────────────────────────────
//
// A busca do servidor abre um Chrome próprio e é ela que o ML barra. Com a
// extensão, a mesma varredura acontece numa aba do admin — e é literalmente a
// mesma: `percorrerLista` com uma campanha alvo, que para na página em que ela
// aparecer.
describe("trazer a campanha pelo Chrome do admin", () => {
  const ALVO = { campaignId: "13907402", title: "20% OFF", containerUrl: "https://lista.mercadolivre.com.br/_Container_x?coupon_campaign_id=13907402" };

  const abrirModal = async () => {
    coletorEntende.mockResolvedValue(true);
    testarPalavraNoChrome.mockResolvedValue({ respostas: ['{"x":1}'], muro: null });
    adminMlCuponsLocalPalavra.mockResolvedValue({ result: { word: "BRINQUEDOS", verdict: "valid", campaignId: "13907402", coupon: null } });
    fecharAbaDoColetor.mockResolvedValue({ fechada: true });
    adminMlCuponsLocalFim.mockResolvedValue({ ok: true });
    await abrirTela();
    fireEvent.change(screen.getByPlaceholderText(/BRINQUEDOS/i), { target: { value: "brinquedos" } });
    fireEvent.click(screen.getByRole("button", { name: /Testar palavra/i }));
    await screen.findByText(/não está no sistema/i);
  };

  it("procura pela extensão e traz a vitrine — sem passar pelo servidor", async () => {
    percorrerLista.mockResolvedValue({ tabId: 3, alvos: [ALVO], resumo: { cupons: 1 }, achou: true, parado: null });
    raparVitrine.mockResolvedValue({ produtos: [{ name: "Boneco", link: "https://www.mercadolivre.com.br/x/p/MLB1", price: 10 }], parcial: false });
    adminMlCuponsImportVitrine.mockResolvedValue({ ok: true, produtos: 1 });
    await abrirModal();

    fireEvent.click(screen.getByRole("button", { name: /Buscar/i }));

    await waitFor(() => expect(percorrerLista).toHaveBeenCalledWith(expect.objectContaining({ procurar: "13907402" })));
    await waitFor(() => expect(adminMlCuponsImportVitrine).toHaveBeenCalledWith("13907402", { products: expect.any(Array), parcial: false }));
    expect(adminMlCuponsImportCampaign).not.toHaveBeenCalled();
    // Sem o fim, a rodada ficaria "rodando" no servidor e recusaria a próxima.
    await waitFor(() => expect(adminMlCuponsLocalFim).toHaveBeenCalled());
    expect(fecharAbaDoColetor).toHaveBeenCalledWith(3);
  });

  it("campanha que a lista não tem vira erro, não campanha vazia gravada", async () => {
    percorrerLista.mockResolvedValue({ tabId: 3, alvos: [], resumo: null, achou: false, parado: null, paginas: 13 });
    await abrirModal();

    fireEvent.click(screen.getByRole("button", { name: /Buscar/i }));

    // A mensagem diz o que foi feito antes de dizer que não achou: sem o número de
    // páginas, "não achei" parece defeito em vez de resposta. E explica o motivo
    // de fundo — o ML valida qualquer palavra, mas só LISTA o que é segmentado
    // para esta conta (é a task 27).
    expect(await screen.findByText(/Varri 13 páginas/i)).toBeTruthy();
    expect(screen.getByText(/só oferece na lista os cupons segmentados/i)).toBeTruthy();
    await waitFor(() => expect(adminMlCuponsLocalFim).toHaveBeenCalled());
  });

  it("sem a extensão, continua o caminho do servidor", async () => {
    await abrirModal();
    coletorEntende.mockResolvedValue(false);
    adminMlCuponsImportCampaign.mockResolvedValue({ started: true });

    fireEvent.click(screen.getByRole("button", { name: /Buscar/i }));

    await waitFor(() => expect(adminMlCuponsImportCampaign).toHaveBeenCalledWith("13907402", true));
    expect(percorrerLista).not.toHaveBeenCalled();
  });
});

// O vaivém com a aba "Cupons do ML". O ML responde um NÚMERO de campanha, e até aqui
// esse número morria na tela: para ver o cupom dele era preciso trocar de aba e colar
// o número na busca à mão — o trabalho manual que o vínculo palavra↔campanha existe
// para poupar. `onVerCupom` é quem leva (AdminCupom.jsx troca a aba e semeia o filtro).
describe("ver o cupom da campanha que a palavra apontou", () => {
  const comCupom = resposta({
    coupon: { campaignId: "13907402", title: "20% OFF Brinquedos", kind: "percent", value: 20, expiresAt: "2026-09-30T12:00:00.000Z" },
  });

  it("campanha já no sistema: mostra o cupom e leva para ele", async () => {
    adminMlCuponsTestWord.mockResolvedValue(comCupom);
    const onVerCupom = vi.fn();
    await abrirTela({ onVerCupom });
    await testarPalavra();

    expect(await screen.findByText("20% OFF Brinquedos")).toBeInTheDocument();
    // O desconto e a validade são o que decide se vale repassar a palavra; só o id
    // não responde nada a quem está olhando.
    expect(screen.getByText(/20% · vence 30\/09\/2026/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /ver cupom/i }));
    expect(onVerCupom).toHaveBeenCalledWith("13907402");
  });

  it("sem cupom no sistema não há para onde ir — quem aparece é o popup de adicionar", async () => {
    adminMlCuponsTestWord.mockResolvedValue(resposta());
    await abrirTela({ onVerCupom: vi.fn() });
    await testarPalavra();

    await screen.findByText("Essa campanha não está no sistema");
    expect(screen.queryByRole("button", { name: /ver cupom/i })).toBeNull();
  });

  it("no histórico, quem já está no sistema ganha 'ver cupom' no lugar do 'adicionar'", async () => {
    adminMlCuponsCodes.mockResolvedValue({ codes: [
      { code: "REPASSE10", verdict: "valid", campaignId: "13907402", inSystem: false, checkedAt: new Date().toISOString(), message: null },
      { code: "GAMER", verdict: "valid", campaignId: "14030498", inSystem: true, couponTitle: "15% OFF", checkedAt: new Date().toISOString(), message: null },
    ] });
    const onVerCupom = vi.fn();
    await abrirTela({ onVerCupom });

    await screen.findByText("Palavras já testadas");
    expect(screen.getAllByRole("button", { name: /adicionar/i })).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: /ver cupom/i }));
    expect(onVerCupom).toHaveBeenCalledWith("14030498");
  });

  it("sem onVerCupom o botão não aparece — a aba continua montável sozinha", async () => {
    adminMlCuponsTestWord.mockResolvedValue(comCupom);
    await abrirTela();
    await testarPalavra();

    expect(await screen.findByText("20% OFF Brinquedos")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /ver cupom/i })).toBeNull();
  });
});
