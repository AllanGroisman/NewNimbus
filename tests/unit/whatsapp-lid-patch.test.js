// Guarda do patch de LID no Baileys instalado.
//
// O WhatsApp trocou o endereço interno dos aparelhos de PN (telefone) para LID, e
// o Baileys 6.7.23 compara a identidade própria só contra `creds.me.id` (PN). Com o
// destino em LID ele não reconhece a própria conta: o celular do usuário cai em
// `otherJids` e recebe a cópia SEM o envelope `deviceSentMessage` — que é o
// "Aguardando mensagem. Essa ação pode levar alguns instantes" que nunca some.
//
// A correção mora em backend/patches/@whiskeysockets+baileys+6.7.23.patch, aplicada
// pelo postinstall (patch-package). Ela vive em node_modules, então um `npm install`
// sem o postinstall a desfaz EM SILÊNCIO e o bug volta sem nenhum sinal. Este teste
// é o alarme: ele falha no CI/local antes de o deploy levar o Baileys cru pra prod.
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(__dirname, "..", "..", "backend");
const SEND_JS = path.join(BACKEND, "node_modules", "@whiskeysockets", "baileys", "lib", "Socket", "messages-send.js");
const PATCH = path.join(BACKEND, "patches", "@whiskeysockets+baileys+6.7.23.patch");

const src = () => fs.readFileSync(SEND_JS, "utf8");

describe("patch de LID no Baileys", () => {
  it("o arquivo .patch está versionado e o postinstall roda o patch-package", () => {
    expect(fs.existsSync(PATCH)).toBe(true);
    const pkg = JSON.parse(fs.readFileSync(path.join(BACKEND, "package.json"), "utf8"));
    expect(pkg.scripts.postinstall).toBe("patch-package");
    // Precisa ser dependência de PRODUÇÃO: deploy/update.sh roda `npm install --omit=dev`.
    expect(pkg.dependencies["patch-package"]).toBeTruthy();
    expect(pkg.devDependencies?.["patch-package"]).toBeUndefined();
  });

  it("está aplicado no node_modules — senão o patch-package não rodou", () => {
    expect(src()).toContain("const isSelfUser = (user) =>");
  });

  it("a classificação me/other conhece o LID (o auto-DM depende disso)", () => {
    // Original: `const isMe = user === meUser;` — meUser vem do id PN.
    expect(src()).not.toMatch(/const isMe = user === meUser;/);
    expect(src()).toMatch(/const isMe = isSelfUser\(user\);/);
  });

  it("o fanout pros próprios devices usa o user LID quando o destino é LID", () => {
    // Original: `if (user !== meUser) { devices.push({ user: meUser }); }` — em
    // destino LID isso vira jidEncode(meUser, 'lid'), um endereço inexistente.
    expect(src()).not.toMatch(/if \(user !== meUser\) \{\s*devices\.push\(\{ user: meUser \}\);/);
    expect(src()).toMatch(/devices\.push\(\{ user: isLid && meLidUser \? meLidUser : meUser \}\)/);
  });

  it("o stanza de reenvio pro próprio device leva o atributo recipient", () => {
    // Original: `else if (areJidsSameUser(participant.jid, meId)) {` — com o
    // participante em LID a comparação falhava e o reenvio saía malformado.
    expect(src()).toMatch(/areJidsSameUser\(participant\.jid, authState\.creds\.me\.lid\)/);
  });

  it("a usync não devolve o próprio device do socket em LID", () => {
    expect(src()).toMatch(/\.filter\(\(\{ user, device \}\) => !\(isSelfUser\(user\) && device === myDevice\)\)/);
  });

  it("não estoura quando a conta ainda não tem lid nas creds", () => {
    // Original: `authState.creds?.me?.lid.split(':')[0]` — lança se lid for undefined.
    expect(src()).not.toContain("authState.creds?.me?.lid.split(':')[0]");
  });

  it("o fanout da sender key não monta <telefone>@lid num grupo LID", () => {
    // Original: `jidEncode(user, addressingMode === 'lid' ? 'lid' : ..., device)` —
    // quando a usync devolve o aparelho em PN, isso vira `<telefone>@lid`, um
    // endereço que não existe: a chave do grupo não chega a ninguém e o grupo
    // inteiro fica em "Aguardando mensagem".
    expect(src()).not.toMatch(
      /const jid = jidEncode\(user, groupData\?\.addressingMode === 'lid' \? 'lid' : 's\.whatsapp\.net', device\);/,
    );
    // Só vai em LID quem o metadata do grupo confirma que é LID...
    expect(src()).toMatch(/let asLid = groupIsLid && lidUsers\.has\(user\);/);
    // ...e a nossa própria conta, cujo par PN↔LID nós conhecemos.
    expect(src()).toMatch(/if \(isSelfUser\(user\) && meLid\)/);
    expect(src()).toMatch(/const jid = jidEncode\(outUser, asLid \? 'lid' : 's\.whatsapp\.net', device\);/);
  });

  it("registra o fanout do grupo em nível info", () => {
    // O `logger.debug('sending new sender key')` do Baileys some na configuração
    // normal: um fanout VAZIO ficava indistinguível de um envio bom, que foi o que
    // escondeu este bug por dias. Este log é o sinal de que a chave saiu.
    expect(src()).toContain("'fanout da sender key do grupo'");
    expect(src()).toMatch(/logger\.info\(\{[\s\S]*?senderKeyJids: senderKeyJids\.length/);
  });
});
