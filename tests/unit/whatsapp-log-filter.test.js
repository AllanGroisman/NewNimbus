// Filtro do log do Baileys — a diferença entre "o envio falhou em silêncio" e
// "dá pra ver o que aconteceu".
//
// O worker roda o logger do Baileys em `debug` com um destino que filtra: warn e
// acima passam sempre, e abaixo disso só o que casa com KEEP_LINES. Sem esse
// filtro o log afogaria em ~6.700 `Bad MAC`/dia; com ele filtrando DEMAIS, some
// justamente a evidência de bug.
//
// Duas linhas precisam passar, e cada uma custou dias de diagnóstico:
//
//   - `recv retry request` e companhia — por que o "Aguardando mensagem" não some.
//   - `sending new sender key` — o fanout da sender key de grupo. No Baileys 6
//     esse sinal só existia porque o nosso patch o promovia a `info`; no 7 ele
//     nasce em `debug` (Socket/messages-send.ts). Um fanout VAZIO
//     (`senderKeyJids: []` num grupo com participantes) é o bug acontecendo, e
//     sem esta linha no log ele é indistinguível de um envio bom.
//
// Este teste é o que impede a regressão de observabilidade quando alguém mexer
// no regex.

import "../helpers/env.js";
import { describe, it, expect } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { keepLogLine } =
  require(path.resolve(__dirname, "..", "..", "backend", "whatsapp", "local.js"));

const DEBUG = 20;
const INFO = 30;
const WARN = 40;
const ERROR = 50;

describe("keepLogLine", () => {
  it("warn e acima passam sempre, qualquer que seja a mensagem", () => {
    expect(keepLogLine({ level: WARN, msg: "qualquer coisa" })).toBe(true);
    expect(keepLogLine({ level: ERROR, msg: "" })).toBe(true);
  });

  it("deixa passar o fanout da sender key de grupo (nasce em debug no Baileys 7)", () => {
    expect(keepLogLine({ level: DEBUG, msg: "sending new sender key" })).toBe(true);
    expect(keepLogLine({ level: DEBUG, msg: "sending message to 12 devices" })).toBe(true);
  });

  it("deixa passar o marco do mapa LID nativo, que nasce em info (30 < 40)", () => {
    expect(keepLogLine({ level: INFO, msg: "Own LID session created successfully" })).toBe(true);
  });

  it("deixa passar o caminho de retry", () => {
    expect(keepLogLine({ level: DEBUG, msg: "recv retry request" })).toBe(true);
    expect(keepLogLine({ level: DEBUG, msg: "message not available in cache" })).toBe(true);
    expect(keepLogLine({ level: DEBUG, msg: "forced new session for retry recp" })).toBe(true);
    expect(keepLogLine({ level: DEBUG, msg: "fetching sessions" })).toBe(true);
  });

  it("barra o debug comum — é ele que afogaria o log", () => {
    expect(keepLogLine({ level: DEBUG, msg: "Bad MAC" })).toBe(false);
    expect(keepLogLine({ level: DEBUG, msg: "closing stale open session" })).toBe(false);
    expect(keepLogLine({ level: INFO, msg: "opened connection to WA" })).toBe(false);
    expect(keepLogLine({ level: DEBUG })).toBe(false);
  });

  it("linha sem level numérico passa — ruído é melhor que engolir o desconhecido", () => {
    expect(keepLogLine({ msg: "sem level" })).toBe(true);
    expect(keepLogLine(null)).toBe(true);
  });
});
