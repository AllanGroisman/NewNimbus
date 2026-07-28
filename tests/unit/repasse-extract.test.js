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
