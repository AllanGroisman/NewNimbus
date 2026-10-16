// O registro da última mensagem de cada grupo (ver backend/whatsapp/last-msg.js),
// que alimenta o "Limpar conversa" da limpeza automática (task 13).
//
// O Baileys recusa o intervalo de limpeza sem key completa: id, remoteJid,
// timestamp e — em grupo, quando não fomos nós que mandamos — participant. Aqui
// a mecânica: guarda só a mais nova, só de grupo, só com key utilizável, e o
// clearedTs sobrevive à chegada de mensagem nova. Memory mode: nada toca em rede.
import "../helpers/env.js";
import { describe, it, expect, beforeEach } from "vitest";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LAST_JS = path.resolve(__dirname, "..", "..", "backend", "whatsapp", "last-msg.js");
const require = createRequire(pathToFileURL(LAST_JS));
const lastMsg = require(LAST_JS);

const msg = (id, ts, extra = {}) => ({
  key: { id, remoteJid: "g1@g.us", fromMe: false, participant: "123@lid", ...extra },
  messageTimestamp: ts,
});

describe("last-msg — última mensagem por grupo", () => {
  beforeEach(() => lastMsg.__clear());

  it("guarda a key com participant e o timestamp", async () => {
    lastMsg.onUpsert("num-1", [msg("A", 100)]);
    expect(await lastMsg.get("num-1", "g1@g.us")).toEqual({
      key: { id: "A", remoteJid: "g1@g.us", fromMe: false, participant: "123@lid" },
      messageTimestamp: 100,
      clearedTs: 0,
    });
  });

  it("fica com a mais nova, mesmo chegando fora de ordem", async () => {
    lastMsg.onUpsert("num-1", [msg("B", 200), msg("A", 100)]);
    expect((await lastMsg.get("num-1", "g1@g.us")).key.id).toBe("B");
  });

  it("ignora chat que não é grupo", async () => {
    lastMsg.onUpsert("num-1", [msg("A", 100, { remoteJid: "5511@s.whatsapp.net" })]);
    expect(await lastMsg.get("num-1", "5511@s.whatsapp.net")).toBeNull();
  });

  it("ignora mensagem de outro membro sem participant e sem timestamp", async () => {
    lastMsg.onUpsert("num-1", [msg("A", 100, { participant: undefined }), msg("B", 0)]);
    expect(await lastMsg.get("num-1", "g1@g.us")).toBeNull();
  });

  it("mensagem nossa não precisa de participant", async () => {
    lastMsg.onUpsert("num-1", [msg("A", 100, { fromMe: true, participant: undefined })]);
    expect((await lastMsg.get("num-1", "g1@g.us")).key).toEqual({ id: "A", remoteJid: "g1@g.us", fromMe: true });
  });

  it("aceita timestamp Long do protobuf", async () => {
    lastMsg.onUpsert("num-1", [msg("A", { toNumber: () => 321 })]);
    expect((await lastMsg.get("num-1", "g1@g.us")).messageTimestamp).toBe(321);
  });

  it("separa por número", async () => {
    lastMsg.onUpsert("num-1", [msg("A", 100)]);
    expect(await lastMsg.get("num-2", "g1@g.us")).toBeNull();
  });

  it("clearedTs fica marcado quando chega mensagem nova", async () => {
    lastMsg.onUpsert("num-1", [msg("A", 100)]);
    lastMsg.markCleared("num-1", "g1@g.us", 100);
    lastMsg.onUpsert("num-1", [msg("B", 150)]);
    expect(await lastMsg.get("num-1", "g1@g.us")).toMatchObject({ messageTimestamp: 150, clearedTs: 100 });
  });

  it("entrada inválida não lança", () => {
    expect(() => lastMsg.onUpsert("num-1", null)).not.toThrow();
    expect(() => lastMsg.onUpsert("num-1", [null, {}, { key: null }])).not.toThrow();
  });
});
