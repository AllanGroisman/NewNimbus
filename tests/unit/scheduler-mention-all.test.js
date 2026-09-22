// {todos} no modelo: o texto mostra "@todos" e o envio pede ao WhatsApp pra
// marcar o grupo inteiro. Sem {todos}, a chamada fica idêntica à de antes.
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
const grupo = (messageTemplate) => ({ id: 7, name: "Campanha", whatsappGroupIds: ["wa-1"], messageTemplate });
const item = (extra = {}) => ({
  key: "k1", name: "Fone Bluetooth", store: "Mercado Livre",
  link: "https://www.mercadolivre.com.br/p/MLB1", price: 200, ...extra,
});

describe("{todos} no modelo da campanha", () => {
  let sendText, sendImage;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(affiliate, "status").mockReturnValue({
      ml: { configured: false }, amazon: { configured: false }, shopee: { configured: false },
    });
    vi.spyOn(affiliate, "gerarLinkAfiliadoML").mockResolvedValue(null);
    vi.spyOn(coupons, "couponsListForKeys").mockResolvedValue(new Map());
    sendText = vi.spyOn(wa, "sendText").mockResolvedValue({ ok: true });
    sendImage = vi.spyOn(wa, "sendImage").mockResolvedValue({ ok: true });
  });

  it("vira @todos no texto e pede mentionAll", async () => {
    await scheduler.sendItem("u1", grupo("{produto}\n{todos}"), WA, item());

    expect(sendText).toHaveBeenCalledWith("u1", "num-1", "123@g.us", "Fone Bluetooth\n@todos", { mentionAll: true });
  });

  it("com imagem, o mentionAll vai no sendImage", async () => {
    await scheduler.sendItem("u1", grupo("{produto} {todos}"), WA, item({ img: "https://img/x.jpg" }));

    expect(sendImage).toHaveBeenCalledWith("u1", "num-1", "123@g.us", "https://img/x.jpg", "Fone Bluetooth @todos", { mentionAll: true });
  });

  it("sem {todos} a chamada não ganha argumento extra", async () => {
    await scheduler.sendItem("u1", grupo("{produto}"), WA, item());

    expect(sendText).toHaveBeenCalledWith("u1", "num-1", "123@g.us", "Fone Bluetooth");
  });

  it("repasse no modo original não marca ninguém, mesmo com {todos} no modelo", async () => {
    vi.spyOn(affiliate, "gerarLinkAfiliadoML").mockResolvedValue("https://meli.la/MEU");
    await scheduler.sendItem("u1", grupo("{produto} {todos}"), WA, item({
      originalText: "Olha isso https://ml/sec/a",
      originalLinks: [{ raw: "https://ml/sec/a", link: "https://www.mercadolivre.com.br/p/MLB1", store: "Mercado Livre" }],
    }));

    expect(sendText.mock.calls[0]).toEqual(["u1", "num-1", "123@g.us", "Olha isso https://meli.la/MEU"]);
  });

  it("renderTemplate troca {todos} por @todos", () => {
    expect(scheduler.renderTemplate("a {todos} b", item())).toBe("a @todos b");
  });
});
