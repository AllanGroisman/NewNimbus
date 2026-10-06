// Modo da foto na mensagem (`scraping.imageMode`, aba Modelos Mensagens):
// "product" (padrão) manda a foto do produto com o texto de legenda; "link" manda
// texto com o cartão da prévia do link, como quando se cola o link no WhatsApp.
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
const grupo = (messageTemplate, imageMode) => ({
  id: 7, name: "Campanha", whatsappGroupIds: ["wa-1"], messageTemplate,
  scraping: imageMode ? { imageMode } : {},
});
const IMG = "https://img/x.jpg";
const item = (extra = {}) => ({
  key: "k1", name: "Fone Bluetooth", store: "Mercado Livre",
  link: "https://www.mercadolivre.com.br/p/MLB1", price: 200, img: IMG, ...extra,
});

describe("modo da foto na mensagem", () => {
  let sendText, sendImage;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(affiliate, "status").mockReturnValue({
      ml: { configured: true }, amazon: { configured: false }, shopee: { configured: false },
    });
    vi.spyOn(affiliate, "gerarLinkAfiliadoML").mockResolvedValue("https://meli.la/MEU");
    vi.spyOn(coupons, "couponsListForKeys").mockResolvedValue(new Map());
    sendText = vi.spyOn(wa, "sendText").mockResolvedValue({ ok: true });
    sendImage = vi.spyOn(wa, "sendImage").mockResolvedValue({ ok: true });
  });

  it("padrão (sem imageMode) manda a foto do produto, como antes", async () => {
    await scheduler.sendItem("u1", grupo("{produto} {link}"), WA, item());

    expect(sendText).not.toHaveBeenCalled();
    expect(sendImage.mock.calls[0]).toEqual(["u1", "num-1", "123@g.us", IMG, "Fone Bluetooth https://meli.la/MEU"]);
  });

  it("\"link\" manda texto com a prévia do link afiliado, sem sendImage", async () => {
    await scheduler.sendItem("u1", grupo("{produto} {link}", "link"), WA, item());

    expect(sendImage).not.toHaveBeenCalled();
    expect(sendText.mock.calls[0]).toEqual(["u1", "num-1", "123@g.us", "Fone Bluetooth https://meli.la/MEU", {
      linkPreview: { url: "https://meli.la/MEU", title: "Fone Bluetooth", img: IMG },
    }]);
  });

  it("\"link\" com {todos} leva o mentionAll junto", async () => {
    await scheduler.sendItem("u1", grupo("{produto} {link} {todos}", "link"), WA, item());

    expect(sendText.mock.calls[0][4]).toEqual({
      mentionAll: true,
      linkPreview: { url: "https://meli.la/MEU", title: "Fone Bluetooth", img: IMG },
    });
  });

  it("\"link\" sem {link} no modelo cai na foto do produto", async () => {
    await scheduler.sendItem("u1", grupo("{produto} por {preco}", "link"), WA, item());

    expect(sendText).not.toHaveBeenCalled();
    expect(sendImage).toHaveBeenCalledTimes(1);
  });

  it("\"link\" sem foto no item ainda manda o cartão (só com título)", async () => {
    await scheduler.sendItem("u1", grupo("{produto} {link}", "link"), WA, item({ img: undefined }));

    expect(sendText.mock.calls[0][4]).toEqual({
      linkPreview: { url: "https://meli.la/MEU", title: "Fone Bluetooth", img: null },
    });
  });

  it("repasse no modo original usa o link principal já afiliado", async () => {
    await scheduler.sendItem("u1", grupo("{produto}", "link"), WA, item({
      originalText: "Olha isso https://ml/sec/a",
      originalLinks: [{ raw: "https://ml/sec/a", link: "https://www.mercadolivre.com.br/p/MLB1", store: "Mercado Livre" }],
    }));

    expect(sendImage).not.toHaveBeenCalled();
    expect(sendText.mock.calls[0]).toEqual(["u1", "num-1", "123@g.us", "Olha isso https://meli.la/MEU", {
      linkPreview: { url: "https://meli.la/MEU", title: "Fone Bluetooth", img: IMG },
    }]);
  });
});
