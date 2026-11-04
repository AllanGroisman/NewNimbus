// Preço do ML conferido na landing do NOSSO link antes do envio (04/11/2026):
// o líder divulgou um vendedor a R$ 599,90, o nosso link /p/ abria outro a R$ 499.
import "../helpers/env.js";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const backend = path.resolve(__dirname, "..", "..", "backend");
const scheduler = require(path.join(backend, "scheduler.js"));
const coupons = require(path.join(backend, "coupons"));
const affiliate = require(path.join(backend, "scraping", "affiliate.js"));
const mlSocial = require(path.join(backend, "scraping", "ml-social.js"));
const wa = require(path.join(backend, "whatsapp"));

const WA = [{ id: "wa-1", jid: "123@g.us", numberId: "num-1" }];
const ORIGINAL = "https://www.mercadolivre.com.br/box-pokemon/p/MLB54847876";
const grupo = { id: 7, name: "Campanha", whatsappGroupIds: ["wa-1"], messageTemplate: "{produto}\nDe {preco_antigo}\nPor {preco}\n{link}", scraping: {} };
const item = (extra = {}) => ({ key: "k1", name: "Box", store: "Mercado Livre", link: ORIGINAL, price: 599.9, img: "https://img/x.jpg", ...extra });
const landing = (product) => ({ ok: true, kind: "ok", product: { link: ORIGINAL, mlItemId: "MLB7307110012", originalPrice: null, discount: null, ...product } });

let sendImage, fetchLanding;

beforeEach(() => {
  vi.restoreAllMocks();
  scheduler._setConferirPrecoML(true);
  vi.spyOn(affiliate, "status").mockReturnValue({ ml: { configured: true }, amazon: { configured: false }, shopee: { configured: false } });
  vi.spyOn(affiliate, "readMLConfig").mockReturnValue({ tag: "padrao", cookie: "ssid=c", tags: [], source: "file" });
  vi.spyOn(affiliate, "gerarLinkAfiliadoML").mockResolvedValue("https://meli.la/nosso");
  vi.spyOn(coupons, "couponsListForKeys").mockResolvedValue(new Map());
  vi.spyOn(wa, "sendText").mockResolvedValue({ ok: true });
  sendImage = vi.spyOn(wa, "sendImage").mockResolvedValue({ ok: true });
  fetchLanding = vi.spyOn(mlSocial, "fetchSocialLanding");
});
afterEach(() => scheduler._setConferirPrecoML(false));

const textoEnviado = () => sendImage.mock.calls[0][4];

describe("preço do ML conferido no nosso link", () => {
  it("landing com outro preço: a mensagem sai com o preço da landing", async () => {
    fetchLanding.mockResolvedValue(landing({ price: 499, originalPrice: 549 }));
    await scheduler.sendItem("u1", grupo, WA, item());
    expect(fetchLanding).toHaveBeenCalledWith("https://meli.la/nosso");
    expect(textoEnviado()).toContain("Por R$ 499");
    expect(textoEnviado()).toContain("De R$ 549");
    expect(textoEnviado()).not.toContain("599");
  });

  it("landing falhou (rede): mantém o preço e envia", async () => {
    fetchLanding.mockRejectedValue(new Error("timeout"));
    await scheduler.sendItem("u1", grupo, WA, item());
    expect(textoEnviado()).toContain("599,90");
  });

  it("landing com CAPTCHA: mantém o preço e envia", async () => {
    fetchLanding.mockResolvedValue({ ok: false, kind: "captcha", product: null });
    await scheduler.sendItem("u1", grupo, WA, item());
    expect(textoEnviado()).toContain("599,90");
  });

  it("landing trouxe outro produto: mantém o preço", async () => {
    fetchLanding.mockResolvedValue(landing({ price: 10, link: "https://www.mercadolivre.com.br/outro/p/MLB999999" }));
    await scheduler.sendItem("u1", grupo, WA, item());
    expect(textoEnviado()).toContain("599,90");
  });

  it("item que não é do ML não lê landing", async () => {
    vi.spyOn(affiliate, "status").mockReturnValue({ ml: { configured: false }, amazon: { configured: false }, shopee: { configured: false } });
    await scheduler.sendItem("u1", grupo, WA, item({ store: "Amazon", link: "https://www.amazon.com.br/dp/B000" }));
    expect(fetchLanding).not.toHaveBeenCalled();
  });
});
