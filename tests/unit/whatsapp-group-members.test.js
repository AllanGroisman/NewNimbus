// Para quem vai a mensagem no privado, a partir dos participantes do grupo
// (task 4). No Baileys 7 o participante chega por PN ou por LID, com o outro
// lado às vezes vazio. Errar aqui é mandar duas vezes para a mesma pessoa (PN
// num grupo, LID no outro) ou mandar para o próprio número.
import { describe, it, expect } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "backend");
const { memberJids } = require(path.join(backend, "whatsapp", "group-members.js"));

const SELF = ["5511000000000:7@s.whatsapp.net", "999000:7@lid"];

describe("memberJids", () => {
  it("participante por PN vai pelo PN, sem o sufixo de aparelho", async () => {
    const r = await memberJids([{ id: "5511111111111:3@s.whatsapp.net", lid: "111@lid" }], { selfIds: SELF });
    expect(r).toEqual([{ jid: "5511111111111@s.whatsapp.net" }]);
  });

  it("participante por LID com phoneNumber vai pelo PN", async () => {
    const r = await memberJids([{ id: "222@lid", phoneNumber: "5522222222222@s.whatsapp.net" }], { selfIds: SELF });
    expect(r).toEqual([{ jid: "5522222222222@s.whatsapp.net" }]);
  });

  it("LID sem phoneNumber usa o mapeamento LID→PN", async () => {
    const pnForLid = async (lid) => (lid === "333@lid" ? "5533333333333:1@s.whatsapp.net" : null);
    const r = await memberJids([{ id: "333@lid" }], { selfIds: SELF, pnForLid });
    expect(r).toEqual([{ jid: "5533333333333@s.whatsapp.net" }]);
  });

  it("LID sem mapeamento fica no @lid", async () => {
    const r = await memberJids([{ id: "444@lid" }], { selfIds: SELF, pnForLid: async () => null });
    expect(r).toEqual([{ jid: "444@lid" }]);
  });

  it("mapeamento que lança não derruba a lista", async () => {
    const r = await memberJids([{ id: "445@lid" }], { selfIds: SELF, pnForLid: async () => { throw new Error("db"); } });
    expect(r).toEqual([{ jid: "445@lid" }]);
  });

  it("o próprio número fica de fora, por PN, por LID e pelo mapeamento", async () => {
    const r = await memberJids([
      { id: "5511000000000@s.whatsapp.net" },
      { id: "999000@lid" },
      { id: "998@lid" },
      { id: "5566666666666@s.whatsapp.net" },
    ], { selfIds: SELF, pnForLid: async (lid) => (lid === "998@lid" ? "5511000000000@s.whatsapp.net" : null) });
    expect(r).toEqual([{ jid: "5566666666666@s.whatsapp.net" }]);
  });

  it("mesma pessoa duas vezes (PN e LID resolvido) sai uma vez", async () => {
    const r = await memberJids([
      { id: "5577777777777@s.whatsapp.net" },
      { id: "777@lid", phoneNumber: "5577777777777@s.whatsapp.net" },
    ], { selfIds: SELF });
    expect(r).toEqual([{ jid: "5577777777777@s.whatsapp.net" }]);
  });
});
