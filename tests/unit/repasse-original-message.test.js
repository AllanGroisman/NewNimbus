// Repasse no modo "mensagem original": o texto do grupo líder sai como veio, só
// com os links trocados pelos de afiliado do usuário.

import "../helpers/env.js";
import { describe, it, expect, beforeEach, vi } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const backend = path.resolve(__dirname, "..", "..", "backend");
const { isOriginalMode, rewriteText } = require(path.join(backend, "repasse", "original-message.js"));
const { normalizeRepasse } = require(path.join(backend, "repasse", "leaders.js"));
const scheduler = require(path.join(backend, "scheduler.js"));
const affiliate = require(path.join(backend, "scraping", "affiliate.js"));
const captureLog = require(path.join(backend, "repasse", "capture-log.js"));
const wa = require(path.join(backend, "whatsapp"));

describe("isOriginalMode", () => {
  it("só liga com messageMode = original", () => {
    expect(isOriginalMode({ scraping: { repasse: { messageMode: "original" } } })).toBe(true);
    expect(isOriginalMode({ scraping: { repasse: { messageMode: "template" } } })).toBe(false);
    expect(isOriginalMode({ scraping: { repasse: { leaders: [] } } })).toBe(false);
    expect(isOriginalMode(null)).toBe(false);
  });
});

describe("rewriteText", () => {
  it("troca todas as ocorrências e preserva o resto do texto", () => {
    const text = "🔥 *Fone JBL*\n\nDe ~R$ 300~ por R$ 199\nhttps://mercadolivre.com/sec/abc\n\nCorre: https://mercadolivre.com/sec/abc.";
    const out = rewriteText(text, [{ raw: "https://mercadolivre.com/sec/abc", link: "https://meli.la/MEU" }]);
    expect(out).toBe("🔥 *Fone JBL*\n\nDe ~R$ 300~ por R$ 199\nhttps://meli.la/MEU\n\nCorre: https://meli.la/MEU.");
  });

  it("não quebra com ? e & na URL", () => {
    const raw = "https://shopee.com.br/x-i.1.2?sp_atk=a&xptdk=b";
    expect(rewriteText(`ver ${raw} agora`, [{ raw, link: "https://s.shopee.com.br/MEU" }]))
      .toBe("ver https://s.shopee.com.br/MEU agora");
  });

  it("URL que é prefixo de outra não é trocada pela metade", () => {
    const a = "https://amzn.to/abc";
    const b = "https://amzn.to/abcdef";
    const out = rewriteText(`${a} e ${b}`, [{ raw: a, link: "A" }, { raw: b, link: "B" }]);
    expect(out).toBe("A e B");
  });

  it("link novo que contém um raw não é trocado de novo", () => {
    const a = "https://www.amazon.com.br/dp/B0X";
    const b = "https://www.amazon.com.br/dp/B0X?tag=outro";
    const out = rewriteText(`${b} | ${a}`, [
      { raw: b, link: "https://www.amazon.com.br/dp/B0X?tag=meu" },
      { raw: a, link: "https://www.amazon.com.br/dp/B0X?tag=meu" },
    ]);
    expect(out).toBe("https://www.amazon.com.br/dp/B0X?tag=meu | https://www.amazon.com.br/dp/B0X?tag=meu");
  });
});

describe("normalizeRepasse guarda o messageMode", () => {
  it("mantém original/template e descarta valor inválido", () => {
    const base = { kind: "repasse", repasse: { leaders: [] } };
    expect(normalizeRepasse({ ...base, repasse: { leaders: [], messageMode: "original" } }).repasse.messageMode).toBe("original");
    expect(normalizeRepasse({ ...base, repasse: { leaders: [], messageMode: "xyz" } }).repasse.messageMode).toBeUndefined();
  });
});

describe("sendItem com mensagem original", () => {
  const GRUPO = { id: 7, name: "Rep", whatsappGroupIds: ["wa-1"], messageTemplate: "MODELO {produto} {link}" };
  const WA = [{ id: "wa-1", jid: "123@g.us", numberId: "num-1", name: "Destino" }];
  const item = () => ({
    key: "k1", name: "Fone (+1 produto)", store: "Mercado Livre", source: "repasse",
    link: "https://www.mercadolivre.com.br/p/MLB1", img: "https://img/x.jpg", price: 99,
    originalText: "*Oferta* https://ml/sec/a e https://s.shopee/b",
    originalLinks: [
      { raw: "https://ml/sec/a", link: "https://www.mercadolivre.com.br/p/MLB1", store: "Mercado Livre" },
      { raw: "https://s.shopee/b", link: "https://shopee.com.br/x-i.1.2", store: "Shopee" },
    ],
  });
  let gravadas;

  beforeEach(() => {
    vi.restoreAllMocks();
    gravadas = [];
    vi.spyOn(captureLog, "logCapture").mockImplementation(async (f) => { gravadas.push(f); });
    vi.spyOn(affiliate, "status").mockReturnValue({
      ml: { configured: true }, amazon: { configured: true }, shopee: { configured: true },
    });
    vi.spyOn(affiliate, "gerarLinkAfiliadoML").mockResolvedValue("https://meli.la/MEU");
    vi.spyOn(affiliate, "gerarLinkAfiliadoShopee").mockResolvedValue("https://s.shopee.com.br/MEU");
  });

  it("envia o texto original com os links trocados, sem o modelo", async () => {
    const send = vi.spyOn(wa, "sendImage").mockResolvedValue({});
    const r = await scheduler.sendItem("u1", GRUPO, WA, item());
    expect(r.sentCount).toBe(1);
    const caption = send.mock.calls[0][4];
    expect(caption).toBe("*Oferta* https://meli.la/MEU e https://s.shopee.com.br/MEU");
    expect(caption).not.toMatch(/MODELO/);
  });

  it("link extra que não converte sai cru, sem derrubar a mensagem", async () => {
    affiliate.gerarLinkAfiliadoShopee.mockResolvedValue(null);
    const send = vi.spyOn(wa, "sendImage").mockResolvedValue({});
    const r = await scheduler.sendItem("u1", GRUPO, WA, item());
    expect(r.sentCount).toBe(1);
    expect(send.mock.calls[0][4]).toBe("*Oferta* https://meli.la/MEU e https://s.shopee/b");
    expect(gravadas).toHaveLength(0);
  });

  it("link principal que não converte descarta a mensagem e loga", async () => {
    affiliate.gerarLinkAfiliadoML.mockResolvedValue(null);
    const send = vi.spyOn(wa, "sendImage").mockResolvedValue({});
    await expect(scheduler.sendItem("u1", GRUPO, WA, item())).rejects.toMatchObject({ code: "affiliate_conversion_failed" });
    expect(send).not.toHaveBeenCalled();
    expect(gravadas[0]).toMatchObject({ outcome: "discarded", stage: "send" });
  });
});
