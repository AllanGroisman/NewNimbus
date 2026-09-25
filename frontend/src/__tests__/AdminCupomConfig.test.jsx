// Admin › Cupom › Config Test — o diagnóstico do que a colheita precisa.
//
// O que estes testes protegem é o veredito, não o layout: a aba existe porque
// "cookie salvo" e "cookie funcionando" não são a mesma coisa, e a tela antiga
// mostrava só o primeiro. Um card que diz ✅ quando o ML recusaria é pior do que
// não ter card nenhum.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("../data/api", () => ({
  errText: (err, fallback) => err?.message || fallback,
  adminScraperMLSession: vi.fn(),
  adminScraperMLSessionSave: vi.fn(),
  adminScraperMLSessionTest: vi.fn(),
  adminScraperMLSources: vi.fn(),
  adminScraperMLSourcesSave: vi.fn(),
  adminMlCupons: vi.fn(),
  adminMlCuponsStatus: vi.fn(),
  adminMlCuponsSaveConfig: vi.fn(),
  adminMlCuponsDiagnosticoLink: vi.fn(),
}));

vi.mock("../data/coletor", () => ({
  coletorInfo: vi.fn(),
  raparVitrine: vi.fn(),
  esvaziarCarrinhoNoChrome: vi.fn(),
  _resetColetor: vi.fn(),
}));

import ConfigTest from "../pages/AdminCupomConfig.jsx";
import {
  adminScraperMLSession, adminScraperMLSessionSave, adminScraperMLSessionTest,
  adminScraperMLSources, adminMlCupons, adminMlCuponsStatus, adminMlCuponsDiagnosticoLink,
} from "../data/api";
import { coletorInfo, raparVitrine, esvaziarCarrinhoNoChrome } from "../data/coletor";

const SESSAO_OK = {
  configured: true, cookieLength: 4200, source: "db", tag: "pb20260221170529",
  updatedAt: new Date().toISOString(),
  lastCheckAt: new Date().toISOString(), lastCheckOk: true, lastCheckReason: "o Hub abriu",
};

const CUPOM = {
  campaignId: "13471229", title: "Cupom de teste", scope: "campaign",
  containerUrl: "https://lista.mercadolivre.com.br/_Container_1?coupon_campaign_id=13471229",
};

const produto = { link: "https://www.mercadolivre.com.br/p/MLB123", price: 99, title: "Coisa" };

async function abrirTela() {
  render(<ConfigTest />);
  await waitFor(() => expect(adminScraperMLSession).toHaveBeenCalled());
}

beforeEach(() => {
  vi.clearAllMocks();
  adminScraperMLSession.mockResolvedValue(SESSAO_OK);
  adminScraperMLSources.mockResolvedValue({ sources: { vitrine: true, hub: true, priority: "hub" }, hubAvailable: true });
  adminMlCuponsStatus.mockResolvedValue({ config: {}, running: false });
  adminMlCupons.mockResolvedValue({ items: [CUPOM], total: 1, page: 1, pageSize: 20 });
  coletorInfo.mockResolvedValue({ instalada: true, versao: "2.0.0", comandos: ["lista", "raspar", "palavra", "checkout", "props"] });
});

describe("os semáforos", () => {
  it("extensão ausente vira ❌ com as instruções de instalar", async () => {
    coletorInfo.mockResolvedValue({ instalada: false, versao: null, comandos: [] });
    await abrirTela();

    expect(await screen.findByText(/não respondeu\. Sem ela os cupons/)).toBeInTheDocument();
    expect(screen.getByText(/Carregar sem compactação/)).toBeInTheDocument();
  });

  it("extensão presente diz a versão — 'instalada' sozinho não distingue cópia velha", async () => {
    await abrirTela();
    expect(await screen.findByText(/respondeu — versão 2\.0\.0/)).toBeInTheDocument();
  });

  it("tag vazia é ❌ e diz o que quebra por causa disso", async () => {
    adminScraperMLSession.mockResolvedValue({ ...SESSAO_OK, tag: null });
    await abrirTela();

    // O ponto do card: sem tag a landing não abre, e a vitrine cai no caminho
    // caro que o ML barra. Contar só "vazia" esconde a consequência.
    expect(await screen.findByText(/landing de afiliado abrir/)).toBeInTheDocument();
  });

  it("cookie que falhou no último teste é ❌ com o motivo do ML", async () => {
    adminScraperMLSession.mockResolvedValue({
      ...SESSAO_OK, lastCheckOk: false, lastCheckReason: "o cookie venceu",
    });
    await abrirTela();

    expect(await screen.findByText(/último teste falhou: o cookie venceu/)).toBeInTheDocument();
  });

  it("cookie velho vira ⚠️ mesmo com o último teste tendo passado", async () => {
    const dezDiasAtras = new Date(Date.now() - 10 * 86400000).toISOString();
    adminScraperMLSession.mockResolvedValue({ ...SESSAO_OK, updatedAt: dezDiasAtras });
    await abrirTela();

    expect(await screen.findByText(/salvo há 10 dia\(s\)/)).toBeInTheDocument();
  });

  it("cookie vindo do ambiente não oferece edição — o servidor recusaria a gravação", async () => {
    adminScraperMLSession.mockResolvedValue({ ...SESSAO_OK, source: "env" });
    await abrirTela();

    expect(await screen.findByText(/ML_AFFILIATE_COOKIE/)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/Cole aqui o cookie/)).not.toBeInTheDocument();
  });
});

describe("o conserto na própria aba", () => {
  it("salva a tag sem mexer no cookie", async () => {
    adminScraperMLSessionSave.mockResolvedValue({ ok: true });
    await abrirTela();

    const campo = await screen.findByPlaceholderText(/pb2026/);
    fireEvent.change(campo, { target: { value: "novatag123" } });
    fireEvent.click(screen.getByRole("button", { name: /Salvar tag/i }));

    // Campo ausente é "não mexi nisso" — mandar o cookie junto apagaria o que
    // está salvo em troca de nada.
    await waitFor(() => expect(adminScraperMLSessionSave).toHaveBeenCalledWith({ tag: "novatag123" }));
  });
});

describe("o diagnóstico ponta a ponta", () => {
  it("prova cookie e tag gerando um link de afiliado de verdade", async () => {
    adminScraperMLSessionTest.mockResolvedValue({ ok: true, reason: "o Hub abriu", session: SESSAO_OK });
    raparVitrine.mockResolvedValue({ produtos: [produto], parcial: false, motivo: null, paginas: 1 });
    adminMlCuponsDiagnosticoLink.mockResolvedValue({ ok: true, shortUrl: "https://mercadolivre.com/sec/abc", kind: "ok" });
    await abrirTela();

    fireEvent.click(await screen.findByRole("button", { name: /Rodar diagnóstico completo/i }));

    expect(await screen.findByText("Tudo funcionando")).toBeInTheDocument();
    expect(adminMlCuponsDiagnosticoLink).toHaveBeenCalledWith(produto.link);
    // Diagnóstico não grava: a vitrine lida é jogada fora.
    expect(await screen.findByText(/descartados, isto é só o teste/)).toBeInTheDocument();
  });

  it("para no primeiro ❌ em vez de acumular erro derivado", async () => {
    adminScraperMLSessionTest.mockResolvedValue({ ok: false, reason: "o cookie venceu" });
    await abrirTela();

    fireEvent.click(await screen.findByRole("button", { name: /Rodar diagnóstico completo/i }));

    expect(await screen.findByText("Diagnóstico interrompido")).toBeInTheDocument();
    // Duas vezes de propósito: a linha do log e a nota do resumo.
    expect((await screen.findAllByText(/O cookie não entrou no Hub: o cookie venceu/)).length).toBe(2);
    // Nem chegou a abrir aba nenhuma — o passo 5 depende do 2.
    expect(raparVitrine).not.toHaveBeenCalled();
    expect(adminMlCuponsDiagnosticoLink).not.toHaveBeenCalled();
  });

  it("sem cupom com vitrine, o veredito é parcial — não é falha de configuração", async () => {
    adminScraperMLSessionTest.mockResolvedValue({ ok: true, reason: "o Hub abriu", session: SESSAO_OK });
    adminMlCupons.mockResolvedValue({ items: [{ ...CUPOM, containerUrl: null }], total: 1, page: 1, pageSize: 20 });
    await abrirTela();

    fireEvent.click(await screen.findByRole("button", { name: /Rodar diagnóstico completo/i }));

    expect(await screen.findByText("Diagnóstico parcial")).toBeInTheDocument();
    expect(screen.getByText(/Extensão, cookie e tag estão de pé/)).toBeInTheDocument();
  });

  it("link recusado pelo ML é ❌ com o motivo que o ML deu", async () => {
    adminScraperMLSessionTest.mockResolvedValue({ ok: true, reason: "o Hub abriu", session: SESSAO_OK });
    raparVitrine.mockResolvedValue({ produtos: [produto], parcial: false, motivo: null, paginas: 1 });
    adminMlCuponsDiagnosticoLink.mockResolvedValue({
      ok: false, shortUrl: null, kind: "afiliado-ausente", reason: "Sem a tag de afiliado da conta do sistema",
    });
    await abrirTela();

    fireEvent.click(await screen.findByRole("button", { name: /Rodar diagnóstico completo/i }));

    expect((await screen.findAllByText(/não gerou o link de afiliado \(afiliado-ausente\)/)).length).toBe(2);
  });
});

// Uma cópia antiga da extensão responde ao ping e não conhece os comandos novos.
// Sem esta conferência, os botões da tela ficam cinza sem explicação e o
// diagnóstico diz "tudo certo" — que é o pior desfecho possível para ele.
describe("extensão instalada, mas velha", () => {
  it("o semáforo fica amarelo e nomeia o que aquela cópia não faz", async () => {
    coletorInfo.mockResolvedValue({ instalada: true, versao: "1.0.0", comandos: ["raspar"] });
    await abrirTela();

    expect(await screen.findByText(/cópia antiga/)).toBeInTheDocument();
    expect(screen.getByText(/puxar a lista de cupons/)).toBeInTheDocument();
    // …e não some com o botão: o que falta continua rodando pelo servidor.
    expect(screen.getByText(/continua rodando pelo servidor/)).toBeInTheDocument();
  });
});

describe("esvaziar o carrinho do ML (task 18)", () => {
  const COM_CARRINHO = { instalada: true, versao: "2.4.6", comandos: ["lista", "raspar", "palavra", "checkout", "esvaziar-carrinho"] };

  it("cópia da extensão sem o comando deixa o botão cinza e diz por quê", async () => {
    await abrirTela();
    expect(await screen.findByText(/anterior à 2\.4\.6/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Esvaziar carrinho do ML" })).toBeDisabled();
  });

  it("pede confirmação e não faz nada se o admin desistir", async () => {
    coletorInfo.mockResolvedValue(COM_CARRINHO);
    vi.spyOn(window, "confirm").mockReturnValue(false);
    await abrirTela();
    fireEvent.click(await screen.findByRole("button", { name: "Esvaziar carrinho do ML" }));
    expect(esvaziarCarrinhoNoChrome).not.toHaveBeenCalled();
  });

  it("carrinho esvaziado diz quantos itens saíram", async () => {
    coletorInfo.mockResolvedValue(COM_CARRINHO);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    esvaziarCarrinhoNoChrome.mockResolvedValue({ removidos: 3, itens: [], restantes: 0, vazio: true, motivo: null });
    await abrirTela();
    const botao = await screen.findByRole("button", { name: "Esvaziar carrinho do ML" });
    await waitFor(() => expect(botao).not.toBeDisabled());
    fireEvent.click(botao);
    expect(await screen.findByText("Carrinho vazio — tirei 3 item(ns).")).toBeInTheDocument();
  });

  it("sobra no carrinho aparece com o motivo, não como sucesso", async () => {
    coletorInfo.mockResolvedValue(COM_CARRINHO);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    esvaziarCarrinhoNoChrome.mockResolvedValue({ removidos: 1, itens: [], restantes: 2, vazio: false, motivo: "cliquei em excluir e o carrinho não mudou" });
    await abrirTela();
    const botao = await screen.findByRole("button", { name: "Esvaziar carrinho do ML" });
    await waitFor(() => expect(botao).not.toBeDisabled());
    fireEvent.click(botao);
    expect(await screen.findByText(/Tirei 1 item\(ns\), sobraram 2: cliquei em excluir/)).toBeInTheDocument();
  });
});
