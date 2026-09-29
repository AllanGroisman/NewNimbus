// O fim da história de um item de repasse.
//
// Um item podia passar por toda a captura, entrar na fila, e só morrer na hora do
// envio, quando gerar o link com comissão falhava. Até aqui esse descarte não
// deixava rastro nenhum no painel de Repasse: o item já tinha saído da fila e o
// erro virava só uma linha de log do servidor. Estes testes travam o registro.

import "../helpers/env.js";
import { describe, it, expect, beforeEach, vi } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const backend = path.resolve(__dirname, "..", "..", "backend");
const scheduler = require(path.join(backend, "scheduler.js"));
const affiliate = require(path.join(backend, "scraping", "affiliate.js"));
const captureLog = require(path.join(backend, "repasse", "capture-log.js"));

const GRUPO = { id: 4242, name: "Campanha Repasse", whatsappGroupIds: ["wa-1"], messageTemplate: "{produto} {link}" };
const WA = [{ id: "wa-1", jid: "123@g.us", numberId: "num-1" }];

function itemRepasse(extra = {}) {
  return {
    name: "Fone Bluetooth", store: "Mercado Livre",
    link: "https://www.mercadolivre.com.br/p/MLB1", rawUrl: "https://mercadolivre.com/sec/abc",
    price: 99.9, originalPrice: 149.9, discount: 33, img: "https://img/x.jpg",
    source: "repasse", manual: true,
    ...extra,
  };
}

describe("descarte no envio vira linha no log de repasse", () => {
  let gravadas;

  beforeEach(() => {
    vi.restoreAllMocks();
    gravadas = [];
    vi.spyOn(captureLog, "logCapture").mockImplementation(async (f) => { gravadas.push(f); });
    // Afiliado configurado, mas a conversão falha: é exatamente a situação em que
    // mandar o link sem comissão seria pior do que descartar.
    vi.spyOn(affiliate, "status").mockReturnValue({
      ml: { configured: true }, amazon: { configured: true }, shopee: { configured: true },
    });
    vi.spyOn(affiliate, "gerarLinkAfiliadoML").mockResolvedValue(null);
  });

  it("grava o motivo fechado e a etapa do envio", async () => {
    await expect(scheduler.sendItem("u1", GRUPO, WA, itemRepasse())).rejects.toThrow(/sem link com comissão/);

    expect(gravadas.length).toBe(1);
    expect(gravadas[0]).toMatchObject({
      groupId: 4242,
      userId: "u1",
      outcome: "discarded",
      errorKind: "conversao-afiliado-falhou",
      stage: "send",
      store: "Mercado Livre",
    });
    // O texto humano continua ao lado do motivo fechado.
    expect(gravadas[0].reason).toMatch(/Afiliado ML falhou/);
  });

  it("guarda o link original do grupo líder, que é o que identifica a captura", async () => {
    await expect(scheduler.sendItem("u1", GRUPO, WA, itemRepasse())).rejects.toThrow();
    expect(gravadas[0].rawUrl).toBe("https://mercadolivre.com/sec/abc");
    expect(gravadas[0].resolvedUrl).toBe("https://www.mercadolivre.com.br/p/MLB1");
    // waJid é NOT NULL e aqui não existe grupo líder de origem: string vazia, e
    // não um jid inventado.
    expect(gravadas[0].waJid).toBe("");
  });

  it("continua lançando o mesmo erro — o log não pode mudar o fluxo do envio", async () => {
    // Regressão: se o descarte deixasse de lançar, o item sairia sem comissão.
    await expect(scheduler.sendItem("u1", GRUPO, WA, itemRepasse())).rejects.toMatchObject({
      code: "affiliate_conversion_failed",
    });
  });

  it("item que não veio do repasse não gera linha nenhuma", async () => {
    // Item de catálogo não tem histórico nesse log; inventar uma linha estragaria
    // a contagem do resumo.
    await expect(
      scheduler.sendItem("u1", GRUPO, WA, itemRepasse({ source: "catalogo" })),
    ).rejects.toThrow();
    expect(gravadas.length).toBe(0);
  });

  it("falha ao gravar o log não impede o descarte", async () => {
    captureLog.logCapture.mockRejectedValue(new Error("banco fora"));
    await expect(scheduler.sendItem("u1", GRUPO, WA, itemRepasse())).rejects.toThrow(/sem link com comissão/);
  });

  it("item Shopee sem link pronto é convertido com o sub_id do grupo", async () => {
    const shopee = vi.spyOn(affiliate, "gerarLinkAfiliadoShopee").mockResolvedValue(null);
    await expect(scheduler.sendItem("u1", GRUPO, WA, itemRepasse({
      store: "Shopee", link: "https://shopee.com.br/x-i.1.2",
    }))).rejects.toThrow(/Afiliado Shopee falhou/);
    expect(shopee).toHaveBeenCalledWith("u1", "https://shopee.com.br/x-i.1.2", { subId: "g4242" });
  });

  it("conversão bem-sucedida não gera descarte nem log", async () => {
    affiliate.gerarLinkAfiliadoML.mockResolvedValue("https://mercadolivre.com/sec/COMISSAO");
    // O envio em si falha porque não há WhatsApp de verdade neste teste — o que
    // importa é que não passou pelo caminho do descarte.
    await scheduler.sendItem("u1", GRUPO, WA, itemRepasse()).catch(() => {});
    expect(gravadas.filter(g => g.errorKind === "conversao-afiliado-falhou").length).toBe(0);
  });
});
