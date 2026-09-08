// Guarda da versão do Baileys instalado.
//
// Substitui o antigo whatsapp-lid-patch.test.js, que lia o FONTE de
// node_modules/@whiskeysockets/baileys/lib/Socket/messages-send.js e assertava
// strings literais do nosso patch. Aquele teste morreu com o patch: a correção
// de LID agora é nativa (LIDMappingStore do Baileys 7), não mais um remendo
// nosso em cima de uma versão específica.
//
// O que continua precisando de alarme é o DESCASAMENTO silencioso: a lib do
// WhatsApp é a peça mais frágil do sistema, um release candidate, e nada no
// runtime reclama se o node_modules ficar numa versão diferente da que o
// package.json declara. Foi exatamente o que aconteceu nesta máquina em 09/2026
// — o patch tinha sido estendido no repo e o node_modules seguia com a versão
// antiga aplicada, então a correção de fanout de grupo simplesmente não estava
// no ar. Este teste é o que torna isso visível.
//
// Também guarda o NOME COM ESCOPO do pacote: tests/unit/whatsapp-close.test.js e
// tests/unit/whatsapp-pairing-code.test.js importam o Baileys pelo caminho FÍSICO
// backend/node_modules/@whiskeysockets/baileys, e quebrariam à toa se alguém
// trocasse para o alias sem escopo (`baileys`), que publica as mesmas versões.

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(__dirname, "..", "..", "backend");
const PKG_NAME = "@whiskeysockets/baileys";

const pkg = JSON.parse(fs.readFileSync(path.join(BACKEND, "package.json"), "utf8"));
const declared = pkg.dependencies?.[PKG_NAME];

describe("versão do Baileys", () => {
  it("está declarada com o nome COM ESCOPO, em dependencies", () => {
    expect(declared).toBeTruthy();
    expect(pkg.dependencies?.baileys).toBeUndefined();
  });

  it("é um pin exato — range em release candidate é surpresa garantida", () => {
    expect(declared).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("o node_modules instalado bate com o pin do package.json", () => {
    const installed = JSON.parse(
      fs.readFileSync(path.join(BACKEND, "node_modules", PKG_NAME, "package.json"), "utf8"),
    );
    expect(installed.version).toBe(declared);
  });

  it("não sobrou patch pendurado de outra versão em backend/patches/", () => {
    const dir = path.join(BACKEND, "patches");
    const patches = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith(".patch")) : [];
    for (const f of patches) {
      // patch-package nomeia como <pacote>+<versão>.patch e IGNORA em silêncio o
      // patch cuja versão não bate com a instalada — um patch órfão não protege
      // nada e só faz acreditar que protege.
      if (f.startsWith("@whiskeysockets+baileys+")) {
        expect(f).toBe(`@whiskeysockets+baileys+${declared}.patch`);
      }
    }
  });

  it("o postinstall continua rodando o patch-package, com ele em dependencies", () => {
    // deploy/update.sh roda `npm install --omit=dev`: se o patch-package cair em
    // devDependencies, o postinstall quebra o deploy inteiro.
    expect(pkg.scripts.postinstall).toBe("patch-package");
    expect(pkg.dependencies["patch-package"]).toBeTruthy();
    expect(pkg.devDependencies?.["patch-package"]).toBeUndefined();
  });
});
