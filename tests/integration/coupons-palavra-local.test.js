// A palavra testada na aba do próprio admin (a extensão).
//
// O caminho antigo abre um Chrome no servidor, e é ele que o Mercado Livre barra
// com CAPTCHA. O novo entrega o mesmo material — os corpos crus das respostas que
// a página buscou depois do "Aplicar" —, colhido numa aba do Chrome do admin.
//
// O que este arquivo protege é que só o CARREGADOR mudou: a leitura da resposta é
// a mesma função pura dos dois caminhos, o cache de 12h continua valendo e a
// gravação em `ml_coupon_codes` é a mesma. Se a leitura divergisse, a mesma palavra
// passaria a ter dois vereditos dependendo de quem abriu a página.
import { describe, it, expect } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const backendDir = path.resolve(__dirname, "..", "..", "backend");
const sync = require(path.join(backendDir, "coupons", "sync.js"));
const coupons = require(path.join(backendDir, "coupons"));

// As três respostas que o ML dá de verdade, no formato que ele manda.
const RECONHECEU = JSON.stringify({
  coupon: { campaignId: "13907402" },
  responseMessage: { type: "success", text: "Cupom adicionado" },
  tracking: { event: { eventData: { response_code: "VALID_1" } } },
});
const NAO_EXISTE = JSON.stringify({
  coupon: { campaign_id: "0" },
  responseMessage: { type: "error", text: "Confira se o cupom está correto" },
  tracking: { event: { eventData: { response_code: "INVALID_1" } } },
});
// O engasgo: nem tracking, nem coupon, nem código. Ele NÃO avaliou a palavra.
const ENGASGO = JSON.stringify({ responseMessage: { type: "error", text: "Tivemos um problema" } });

const palavra = () => `TESTE${Math.floor(Math.random() * 1e9)}`;

describe("checkWordLocal", () => {
  it("a palavra reconhecida vira veredito e linha guardada", async () => {
    const word = palavra();
    const r = await sync.checkWordLocal({ word, respostas: [RECONHECEU], source: "admin" });
    expect(r.verdict).toBe("valid");
    expect(r.campaignId).toBe("13907402");
    expect(r.cached).toBe(false);

    const guardada = await coupons.findCodeCheck(word, { maxAgeHours: 12 });
    expect(guardada.verdict).toBe("valid");
    expect(guardada.source).toBe("admin");
  });

  it("distingue “não existe” de “o ML engasgou” — os dois são resposta de erro", async () => {
    const naoExiste = await sync.checkWordLocal({ word: palavra(), respostas: [NAO_EXISTE] });
    expect(naoExiste.verdict).toBe("invalid");

    // Tratar isto como "invalid" jogaria fora uma palavra boa por causa de um
    // engasgo do ML.
    const engasgo = await sync.checkWordLocal({ word: palavra(), respostas: [ENGASGO] });
    expect(engasgo.verdict).toBe("indeterminado");
    expect(engasgo.reason).toMatch(/não chegou a avaliar/i);
  });

  it("ignora o que não fala da palavra: a página busca várias coisas ao mesmo tempo", async () => {
    const r = await sync.checkWordLocal({
      word: palavra(),
      respostas: ["<html>não é json</html>", JSON.stringify({ tema: "claro" }), RECONHECEU],
    });
    expect(r.verdict).toBe("valid");
  });

  it("sem resposta nenhuma, responde “não sei” — nunca “não existe”", async () => {
    const r = await sync.checkWordLocal({ word: palavra(), respostas: [], bodyText: "a página abriu" });
    expect(r.verdict).toBe("indeterminado");
  });

  it("a palavra vinda do repasse fica marcada como tal", async () => {
    const word = palavra();
    await sync.checkWordLocal({ word, respostas: [RECONHECEU], source: "repasse" });
    expect((await coupons.findCodeCheck(word, { maxAgeHours: 12 })).source).toBe("repasse");
  });

  it("o cache de 12h vale aqui também — cada teste é uma escrita na conta do ML", async () => {
    const word = palavra();
    await sync.checkWordLocal({ word, respostas: [RECONHECEU] });
    // Material diferente, resposta do cache: o ML não foi consultado de novo.
    const segundo = await sync.checkWordLocal({ word, respostas: [NAO_EXISTE] });
    expect(segundo.cached).toBe(true);
    expect(segundo.verdict).toBe("valid");
    // …e `force` fura o cache, que é o que o botão "testar de novo" faz.
    const forcado = await sync.checkWordLocal({ word, respostas: [NAO_EXISTE], force: true });
    expect(forcado.cached).toBe(false);
    expect(forcado.verdict).toBe("invalid");
  });

  it("palavra vazia é recusada antes de qualquer gravação", async () => {
    await expect(sync.checkWordLocal({ word: "  ", respostas: [RECONHECEU] })).rejects.toThrow(/Escreva a palavra/i);
  });
});
