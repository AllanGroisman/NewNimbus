// Repasse — pedaços puros do pipeline de captura: extração de URLs do texto,
// leitura do texto em mensagens Baileys (incl. wrappers), dedupe de mensagem
// entre sessões e serialização por usuário. O fluxo completo (campanha líder →
// fila) fica em integration/repasse-capture.test.js.

import "../helpers/env.js";
import { describe, it, expect } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const capture = require(path.resolve(__dirname, "..", "..", "backend", "repasse", "capture.js"));
const couponWords = require(path.resolve(__dirname, "..", "..", "backend", "repasse", "coupon-words.js"));

describe("extractUrls", () => {
  it("acha múltiplas URLs no meio do texto, na ordem", () => {
    const text = "Olha essa oferta https://mercadolivre.com.br/p/MLB1 e essa https://amzn.to/abc corre!";
    expect(capture.extractUrls(text)).toEqual([
      "https://mercadolivre.com.br/p/MLB1",
      "https://amzn.to/abc",
    ]);
  });

  it("remove pontuação grudada no final (ponto, vírgula, parêntese)", () => {
    expect(capture.extractUrls("veja (https://shopee.com.br/x).")).toEqual(["https://shopee.com.br/x"]);
    expect(capture.extractUrls("link: https://a.com/b, ok?")).toEqual(["https://a.com/b"]);
  });

  it("deduplica a mesma URL repetida na mensagem", () => {
    const text = "https://a.com/x https://a.com/x https://a.com/x";
    expect(capture.extractUrls(text)).toEqual(["https://a.com/x"]);
  });

  it("http e https contam; texto sem URL, vazio ou não-string devolvem []", () => {
    expect(capture.extractUrls("http://inseguro.com/p")).toEqual(["http://inseguro.com/p"]);
    expect(capture.extractUrls("promoção imperdível sem link")).toEqual([]);
    expect(capture.extractUrls("")).toEqual([]);
    expect(capture.extractUrls(null)).toEqual([]);
    expect(capture.extractUrls(42)).toEqual([]);
  });

  it("preserva query string (links de afiliado carregam a tag ali)", () => {
    const url = "https://www.mercadolivre.com.br/social/tag?matt_word=tag&ref=x";
    expect(capture.extractUrls(`veja ${url}`)).toEqual([url]);
  });
});

describe("extractCoupon", () => {
  it("acha o código nos formatos mais comuns dos grupos", () => {
    expect(capture.extractCoupon("Fone JBL R$99 🔥 use o cupom JBL20")).toBe("JBL20");
    expect(capture.extractCoupon("cupom: TECH-10 válido hoje")).toBe("TECH-10");
    expect(capture.extractCoupon("aplique o código GALAXY10 no checkout")).toBe("GALAXY10");
    expect(capture.extractCoupon("com o voucher SHOPEE50 sai mais barato")).toBe("SHOPEE50");
    expect(capture.extractCoupon("código de desconto BLACK25")).toBe("BLACK25");
  });

  it("atravessa formatação do WhatsApp, emoji e aspas entre gatilho e código", () => {
    expect(capture.extractCoupon("🎟️ Cupom: *QUEIMADEESTOQUE24*")).toBe("QUEIMADEESTOQUE24");
    expect(capture.extractCoupon("Use o cupom `QUEIMADEESTOQUE24`")).toBe("QUEIMADEESTOQUE24");
    expect(capture.extractCoupon("Cupom de desconto: _BLACK25_")).toBe("BLACK25");
    expect(capture.extractCoupon("CUPOM 🎟️ JBL20")).toBe("JBL20");
    expect(capture.extractCoupon("Cupom 👉 JBL20")).toBe("JBL20");
    expect(capture.extractCoupon("Cupom: ~JBL20~")).toBe("JBL20");
    expect(capture.extractCoupon("Cupom \"JBL20\"")).toBe("JBL20");
    expect(capture.extractCoupon("Cupom:\nJBL20")).toBe("JBL20");
  });

  it("normaliza pra maiúsculas e tira pontuação nas pontas", () => {
    expect(capture.extractCoupon("use o cupom promo15!")).toBe("PROMO15");
    expect(capture.extractCoupon("cupom: desc-20.")).toBe("DESC-20");
  });

  it("ignora frase sem código de verdade (palavra comum, sem dígito/maiúscula)", () => {
    expect(capture.extractCoupon("tem cupom disponível pra vocês")).toBeNull();
    expect(capture.extractCoupon("use o cupom aqui embaixo")).toBeNull();
  });

  it("sem gatilho de cupom, texto vazio ou não-string devolvem null", () => {
    expect(capture.extractCoupon("só um produto https://a.com/x sem cupom nenhum aplicável")).toBeNull();
    expect(capture.extractCoupon("promoção sem código")).toBeNull();
    expect(capture.extractCoupon("")).toBeNull();
    expect(capture.extractCoupon(null)).toBeNull();
    expect(capture.extractCoupon(42)).toBeNull();
  });
});

// As palavras/tamanhos da detecção viraram config editável no admin
// (app_config "repasse-coupon-config"). Aqui a config é passada direto no 2º
// argumento — os testes acima, sem argumento, provam que o DEFAULT continua
// reproduzindo o comportamento antigo.
describe("extractCoupon — lista de palavras configurável", () => {
  it("gatilho novo passa a valer, e o removido deixa de valer", () => {
    const cfg = { triggers: ["promo"] };
    expect(capture.extractCoupon("aproveita a promo NIMBUS10", cfg)).toBe("NIMBUS10");
    expect(capture.extractCoupon("use o cupom JBL20", cfg)).toBeNull();
  });

  it("gatilho vale com ou sem acento, dos dois lados", () => {
    expect(capture.extractCoupon("aplique o codigo X10AB")).toBe("X10AB");
    const cfg = { triggers: ["código"] };
    expect(capture.extractCoupon("aplique o codigo X10AB", cfg)).toBe("X10AB");
    expect(capture.extractCoupon("aplique o código X10AB", cfg)).toBe("X10AB");
  });

  it("palavra ignorada é descartada mesmo gritada em caixa alta", () => {
    // Sem a lista, "AQUI" passaria: tem maiúscula, então a heurística de forma
    // acha que é código.
    expect(capture.extractCoupon("use o cupom AQUI", { ignore: [] })).toBe("AQUI");
    expect(capture.extractCoupon("use o cupom AQUI", { ignore: ["aqui"] })).toBeNull();
    // Comparação sem acento dos dois lados: "descrição" na config barra
    // "DESCRICAO" no texto (e vice-versa).
    expect(capture.extractCoupon("use o cupom DESCRICAO", { ignore: ["descrição"] })).toBeNull();
    expect(capture.extractCoupon("use o cupom DESCRICAO", { ignore: [] })).toBe("DESCRICAO");
  });

  it("respeita os tamanhos mínimo e máximo configurados", () => {
    expect(capture.extractCoupon("use o cupom X1", { minLen: 2 })).toBe("X1");
    expect(capture.extractCoupon("use o cupom X1")).toBeNull();
    // Palavra maior que o máximo é RECUSADA, não cortada no limite: um cupom
    // truncado chegaria ao cliente como código inválido.
    expect(capture.extractCoupon("cupom ABCDEFGH1", { maxLen: 5 })).toBeNull();
    expect(capture.extractCoupon("cupom ABCDE", { maxLen: 5 })).toBe("ABCDE");
    expect(capture.extractCoupon("cupom ABCDEFGHIJKLMNOPQRSTUVWXYZ1")).toBeNull();
  });

  it("lista vazia ou inválida cai no default em vez de desligar a detecção", () => {
    expect(capture.extractCoupon("use o cupom JBL20", { triggers: [] })).toBe("JBL20");
    expect(capture.extractCoupon("use o cupom JBL20", { triggers: "cupom" })).toBe("JBL20");
  });

  it("palavra com caractere especial não quebra a regex", () => {
    // Um "c+" digitado por engano viraria "Invalid regular expression" e
    // derrubaria a captura inteira se não fosse escapado.
    expect(() => capture.extractCoupon("use o c+ JBL20", { triggers: ["c+"] })).not.toThrow();
    expect(capture.extractCoupon("use o c+ JBL20", { triggers: ["c+"] })).toBe("JBL20");
  });
});

describe("coupon-words — saneamento da config", () => {
  it("normaliza as listas: minúsculas, sem espaço, sem repetida", () => {
    const cfg = couponWords.sanitize({ triggers: [" Cupom ", "CUPOM", "Voucher"], ignore: [" Aqui "] });
    expect(cfg.triggers).toEqual(["cupom", "voucher"]);
    expect(cfg.ignore).toEqual(["aqui"]);
  });

  it("máximo menor que o mínimo não zera a detecção: o mínimo manda", () => {
    const cfg = couponWords.sanitize({ minLen: 10, maxLen: 3 });
    expect(cfg.minLen).toBe(10);
    expect(cfg.maxLen).toBe(10);
  });

  it("accentInsensitive escapa metacaractere antes de trocar a letra", () => {
    expect(couponWords.accentInsensitive("c+")).toBe("[cç]\\+");
  });
});

describe("textFromMessage / unwrapMessage", () => {
  it("lê conversation simples", () => {
    expect(capture.textFromMessage({ conversation: "oi https://a.com" })).toBe("oi https://a.com");
  });

  it("lê extendedTextMessage e captions de imagem/vídeo", () => {
    expect(capture.textFromMessage({ extendedTextMessage: { text: "t1" } })).toBe("t1");
    expect(capture.textFromMessage({ imageMessage: { caption: "c1" } })).toBe("c1");
    expect(capture.textFromMessage({ videoMessage: { caption: "c2" } })).toBe("c2");
  });

  it("desembrulha wrappers ephemeral/viewOnce até o conteúdo real", () => {
    const wrapped = {
      ephemeralMessage: {
        message: { viewOnceMessageV2: { message: { conversation: "escondida" } } },
      },
    };
    expect(capture.textFromMessage(wrapped)).toBe("escondida");
  });

  it("mensagem sem texto (sticker, áudio, null) devolve string vazia", () => {
    expect(capture.textFromMessage({ stickerMessage: {} })).toBe("");
    expect(capture.textFromMessage(null)).toBe("");
    expect(capture.textFromMessage({ ephemeralMessage: { message: null } })).toBe("");
  });
});

describe("alreadySeen — dedupe de mensagem entre sessões", () => {
  it("primeira vez é false, repetição é true", () => {
    const id = `msg-${Date.now()}-a`;
    expect(capture.alreadySeen(id)).toBe(false);
    expect(capture.alreadySeen(id)).toBe(true);
  });

  it("ids diferentes não colidem", () => {
    const a = `msg-${Date.now()}-b1`;
    const b = `msg-${Date.now()}-b2`;
    expect(capture.alreadySeen(a)).toBe(false);
    expect(capture.alreadySeen(b)).toBe(false);
  });

  it("sem id não deduplica (nunca marca como visto)", () => {
    expect(capture.alreadySeen(null)).toBe(false);
    expect(capture.alreadySeen(null)).toBe(false);
    expect(capture.alreadySeen("")).toBe(false);
  });
});

describe("runSerial — serialização por usuário", () => {
  it("executa na ordem de chegada para o mesmo usuário, mesmo com tarefas lentas", async () => {
    const order = [];
    const slow = () => new Promise(r => setTimeout(() => { order.push("lenta"); r(); }, 50));
    const fast = () => new Promise(r => setTimeout(() => { order.push("rapida"); r(); }, 5));

    const p1 = capture.runSerial("user-serial-1", slow);
    const p2 = capture.runSerial("user-serial-1", fast);
    await Promise.all([p1, p2]);
    expect(order).toEqual(["lenta", "rapida"]);
  });

  it("usuários diferentes rodam em paralelo (o rápido não espera o lento)", async () => {
    const order = [];
    const slow = () => new Promise(r => setTimeout(() => { order.push("lenta"); r(); }, 60));
    const fast = () => new Promise(r => setTimeout(() => { order.push("rapida"); r(); }, 5));

    const p1 = capture.runSerial("user-serial-A", slow);
    const p2 = capture.runSerial("user-serial-B", fast);
    await Promise.all([p1, p2]);
    expect(order).toEqual(["rapida", "lenta"]);
  });

  it("erro numa tarefa não trava a fila do usuário", async () => {
    const order = [];
    await capture.runSerial("user-serial-err", () => Promise.reject(new Error("boom")));
    await capture.runSerial("user-serial-err", async () => { order.push("seguiu"); });
    expect(order).toEqual(["seguiu"]);
  });
});
