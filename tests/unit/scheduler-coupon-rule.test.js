// A trava da PALAVRA no desconto do cupom.
//
// O que está sendo protegido aqui é a mensagem não anunciar um preço que o cliente
// não consegue obter. O desconto de um cupom do ML só sai no checkout de quem
// DIGITA a palavra dele; enquanto o sistema não souber qual é, o vínculo
// produto↔campanha prova que o cupom cobre o produto e nada mais.
//
// Antes desta trava o `couponRuleForItem` descia por dois fallbacks — a campanha
// carimbada no item e o melhor cupom do catálogo, com ou sem palavra — e os dois
// descontavam calados: o {preco_com_cupom} baixava o preço e o {cupom} sumia da
// mesma mensagem, porque não havia palavra pra escrever nele.
//
// Os testes vão pelo `sendItem` (e não pela função interna) de propósito: é ali
// que a palavra é herdada e o texto é montado, e é o texto que o cliente lê.

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

const TEMPLATE = [
  "{produto}",
  "Por: {preco}",
  "Com cupom: {preco_com_cupom}",
  "Cupom: {cupom}",
  "Desconto do cupom: {desconto_cupom}",
  "Economia: {economia_cupom}",
].join("\n");

const GRUPO = { id: 7, name: "Campanha", whatsappGroupIds: ["wa-1"], messageTemplate: TEMPLATE };
const WA = [{ id: "wa-1", jid: "123@g.us", numberId: "num-1" }];

// Um cupom de 10% que o sistema conhece, com e sem palavra descoberta.
const COM_PALAVRA = { campaignId: "13495993", code: "GALAXY10", kind: "percent", value: 10, title: "10% OFF" };
const SEM_PALAVRA = { campaignId: "14193894", code: null, kind: "percent", value: 25, title: "25% OFF" };

function item(extra = {}) {
  return {
    key: "k1", name: "Fone Bluetooth", store: "Mercado Livre",
    link: "https://www.mercadolivre.com.br/p/MLB1", price: 200,
    ...extra,
  };
}

describe("couponRuleForItem — sem palavra não há desconto a anunciar", () => {
  let enviadas;

  beforeEach(() => {
    vi.restoreAllMocks();
    enviadas = [];
    // Sem afiliado configurado: o link passa intacto e o envio não é descartado.
    vi.spyOn(affiliate, "status").mockReturnValue({
      ml: { configured: false }, amazon: { configured: false }, shopee: { configured: false },
    });
    vi.spyOn(affiliate, "gerarLinkAfiliadoML").mockResolvedValue(null);
    vi.spyOn(wa, "sendText").mockImplementation(async (_u, _n, _j, text) => { enviadas.push(text); });
    vi.spyOn(wa, "sendImage").mockImplementation(async (_u, _n, _j, _i, text) => { enviadas.push(text); });
  });

  it("cupom do catálogo COM palavra: desconta e herda a palavra no {cupom}", async () => {
    vi.spyOn(coupons, "couponsListForKeys").mockResolvedValue(new Map([["k1", [COM_PALAVRA]]]));

    await scheduler.sendItem("u1", GRUPO, WA, item());

    // 10% de 200 = 180, e a palavra que o cliente digita vai junto.
    expect(enviadas[0]).toContain("Com cupom: R$ 180,00");
    expect(enviadas[0]).toContain("Cupom: GALAXY10");
    expect(enviadas[0]).toContain("Desconto do cupom: 10% OFF");
    expect(enviadas[0]).toContain("Economia: R$ 20,00");
  });

  it("cupom do catálogo SEM palavra: preço normal e nenhuma linha de cupom", async () => {
    vi.spyOn(coupons, "couponsListForKeys").mockResolvedValue(new Map([["k1", [SEM_PALAVRA]]]));

    await scheduler.sendItem("u1", GRUPO, WA, item());

    // Preço normal, e a linha do {preco_com_cupom} some: o modelo já mostra o
    // {preco}, então ela só repetiria o mesmo valor.
    expect(enviadas[0]).toContain("Por: R$ 200,00");
    expect(enviadas[0]).not.toContain("Com cupom:");
    // As outras três somem inteiras: não há palavra, então não há o que anunciar.
    expect(enviadas[0]).not.toContain("Cupom:");
    expect(enviadas[0]).not.toContain("Desconto do cupom:");
    expect(enviadas[0]).not.toContain("Economia:");
  });

  it("entre dois cupons, escolhe o que tem palavra mesmo sendo o menor desconto", async () => {
    // A lista chega na ordem do couponsListForKeys: com palavra na frente. 25% sem
    // palavra não vale nada pro cliente; 10% com palavra ele consegue usar.
    vi.spyOn(coupons, "couponsListForKeys").mockResolvedValue(new Map([["k1", [COM_PALAVRA, SEM_PALAVRA]]]));

    await scheduler.sendItem("u1", GRUPO, WA, item());

    expect(enviadas[0]).toContain("Com cupom: R$ 180,00");
    expect(enviadas[0]).toContain("Cupom: GALAXY10");
  });

  it("a palavra do próprio item manda — é a que o usuário escolheu", async () => {
    // Item de repasse: a palavra veio da legenda do grupo líder. Ela é consultada
    // direto por código e o catálogo nem chega a ser perguntado.
    const porCodigo = vi.spyOn(coupons, "findCouponByCode").mockResolvedValue(COM_PALAVRA);
    const porChave = vi.spyOn(coupons, "couponsListForKeys");

    await scheduler.sendItem("u1", GRUPO, WA, item({ coupon: "GALAXY10" }));

    expect(porCodigo).toHaveBeenCalledWith("GALAXY10");
    expect(porChave).not.toHaveBeenCalled();
    expect(enviadas[0]).toContain("Com cupom: R$ 180,00");
  });

  it("produto de outra loja não pega cupom do ML", async () => {
    // `ml_coupons` é a aba de cupons do Mercado Livre: um cupom de lá não vale num
    // produto da Amazon, nem que a palavra bata por coincidência.
    const porChave = vi.spyOn(coupons, "couponsListForKeys");

    await scheduler.sendItem("u1", GRUPO, WA, item({ store: "Amazon", coupon: "GALAXY10" }));

    expect(porChave).not.toHaveBeenCalled();
    // A palavra continua (é o cupom da Amazon que o líder anunciou), mas nenhum
    // preço com desconto é inventado.
    expect(enviadas[0]).toContain("Cupom: GALAXY10");
    expect(enviadas[0]).not.toContain("Com cupom:");
    expect(enviadas[0]).not.toContain("Desconto do cupom:");
  });

  it("banco fora do ar vira preço normal, não erro no envio", async () => {
    vi.spyOn(coupons, "couponsListForKeys").mockRejectedValue(new Error("conexão perdida"));

    await scheduler.sendItem("u1", GRUPO, WA, item());

    expect(enviadas[0]).toContain("Por: R$ 200,00");
    expect(enviadas[0]).not.toContain("Com cupom:");
    expect(enviadas[0]).not.toContain("Desconto do cupom:");
  });

  it("modelo com {preco_com_cupom} como único preço: sem cupom ele vira o preço normal", async () => {
    vi.spyOn(coupons, "couponsListForKeys").mockResolvedValue(new Map());

    await scheduler.sendItem("u1", { ...GRUPO, messageTemplate: "{produto}\nSai por: {preco_com_cupom}" }, WA, item());

    expect(enviadas[0]).toBe("Fone Bluetooth\nSai por: R$ 200,00");
  });
});
