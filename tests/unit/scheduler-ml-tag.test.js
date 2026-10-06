// Etiqueta do ML por campanha (`scraping.mlTag`, aba Gerenciar — task 5).
//
// O link do ML sai com a etiqueta que a campanha escolheu (ou a padrão da conta).
// O refill já converte o link e o guarda na fila, então o item leva junto com
// qual etiqueta foi feito: se a campanha trocar de etiqueta com ele ainda na
// fila, o envio refaz o link — e, se refazer falhar, manda o de antes, que também
// tem comissão, em vez de descartar.
import "../helpers/env.js";
import { describe, it, expect, beforeEach, vi } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const backend = path.resolve(__dirname, "..", "..", "backend");
const scheduler = require(path.join(backend, "scheduler.js"));
const coupons = require(path.join(backend, "coupons"));
const affiliate = require(path.join(backend, "scraping", "affiliate.js"));
const wa = require(path.join(backend, "whatsapp"));

const WA = [{ id: "wa-1", jid: "123@g.us", numberId: "num-1" }];
const TAGS = [{ tag: "padrao", inUse: true, createdAt: null }, { tag: "grupo-b", inUse: false, createdAt: null }];
const ORIGINAL = "https://www.mercadolivre.com.br/p/MLB1";
const grupo = (mlTag) => ({
  id: 7, name: "Campanha", whatsappGroupIds: ["wa-1"], messageTemplate: "{produto} {link}",
  scraping: mlTag ? { mlTag } : {},
});
const item = (extra = {}) => ({ key: "k1", name: "Fone", store: "Mercado Livre", link: ORIGINAL, price: 200, img: "https://img/x.jpg", ...extra });

let gerar, sendImage;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(affiliate, "status").mockReturnValue({
    ml: { configured: true }, amazon: { configured: false }, shopee: { configured: false },
  });
  vi.spyOn(affiliate, "readMLConfig").mockReturnValue({ tag: "padrao", cookie: "ssid=c", tags: TAGS, source: "file" });
  gerar = vi.spyOn(affiliate, "gerarLinkAfiliadoML").mockImplementation(async (_u, _l, { tag } = {}) => `https://meli.la/${tag || "padrao"}`);
  vi.spyOn(coupons, "couponsListForKeys").mockResolvedValue(new Map());
  vi.spyOn(wa, "sendText").mockResolvedValue({ ok: true });
  sendImage = vi.spyOn(wa, "sendImage").mockResolvedValue({ ok: true });
});

const textoEnviado = () => sendImage.mock.calls[0][4];

describe("refill", () => {
  it("converte com a etiqueta da campanha e diz qual foi", async () => {
    const r = await scheduler.convertItemAffiliate("u1", item(), affiliate.status("u1"), grupo("grupo-b"));
    expect(gerar).toHaveBeenCalledWith("u1", ORIGINAL, { tag: "grupo-b" });
    expect(r).toEqual({ ok: true, link: "https://meli.la/grupo-b", tag: "grupo-b" });
  });

  it("campanha sem escolha: pede a padrão (null) e registra a padrão", async () => {
    const r = await scheduler.convertItemAffiliate("u1", item(), affiliate.status("u1"), grupo(null));
    expect(gerar).toHaveBeenCalledWith("u1", ORIGINAL, { tag: null });
    expect(r.tag).toBe("padrao");
  });
});

describe("envio", () => {
  it("item sem link de afiliado converte com a etiqueta da campanha", async () => {
    await scheduler.sendItem("u1", grupo("grupo-b"), WA, item());
    expect(gerar).toHaveBeenCalledWith("u1", ORIGINAL, { tag: "grupo-b" });
    expect(textoEnviado()).toBe("Fone https://meli.la/grupo-b");
  });

  it("item da fila com a etiqueta de agora: usa o link pronto, sem chamar o ML", async () => {
    const pronto = item({ link: "https://meli.la/ja-feito", originalLink: ORIGINAL, affiliateLink: "https://meli.la/ja-feito", affiliateTag: "grupo-b" });
    await scheduler.sendItem("u1", grupo("grupo-b"), WA, pronto);
    expect(gerar).not.toHaveBeenCalled();
    expect(textoEnviado()).toBe("Fone https://meli.la/ja-feito");
  });

  it("a campanha trocou de etiqueta: refaz a partir do link original", async () => {
    const velho = item({ link: "https://meli.la/velho", originalLink: ORIGINAL, affiliateLink: "https://meli.la/velho", affiliateTag: "padrao" });
    await scheduler.sendItem("u1", grupo("grupo-b"), WA, velho);
    expect(gerar).toHaveBeenCalledWith("u1", ORIGINAL, { tag: "grupo-b" });
    expect(textoEnviado()).toBe("Fone https://meli.la/grupo-b");
  });

  it("refazer falhou: manda o link de antes (tem comissão) em vez de descartar", async () => {
    gerar.mockResolvedValue(null);
    const velho = item({ link: "https://meli.la/velho", originalLink: ORIGINAL, affiliateLink: "https://meli.la/velho", affiliateTag: "padrao" });
    await scheduler.sendItem("u1", grupo("grupo-b"), WA, velho);
    expect(textoEnviado()).toBe("Fone https://meli.la/velho");
  });

  it("item de antes da etiqueta por campanha (sem affiliateTag) fica com o link que tem", async () => {
    const legado = item({ link: "https://meli.la/legado", originalLink: ORIGINAL, affiliateLink: "https://meli.la/legado" });
    await scheduler.sendItem("u1", grupo("grupo-b"), WA, legado);
    expect(gerar).not.toHaveBeenCalled();
    expect(textoEnviado()).toBe("Fone https://meli.la/legado");
  });

  it("etiqueta escolhida que sumiu da conta: o item feito com a padrão não é refeito", async () => {
    const feito = item({ link: "https://meli.la/padrao", originalLink: ORIGINAL, affiliateLink: "https://meli.la/padrao", affiliateTag: "padrao" });
    await scheduler.sendItem("u1", grupo("apagada-no-ml"), WA, feito);
    expect(gerar).not.toHaveBeenCalled();
  });
});
