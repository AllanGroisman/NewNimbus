// Registro dos avisos: kind → render(payload) → { subject, html, text }.
//
// O texto de cada e-mail está em catalog.js (editável pelo Admin) e a tradução
// `payload → variáveis` nos arquivos de templates/. Aqui é só a costura entre
// os dois. Adicionar um aviso novo = uma entrada no catálogo + a função de
// variáveis da área; nada mais precisa mudar.

const catalog = require("./catalog");
const render = require("./render");
const security = require("./templates/security");
const billing = require("./templates/billing");

const VARS = { ...security, ...billing };

// Os e-mails do grupo "token" saem por auth/mailer.js (o link é gerado na hora),
// então não entram aqui — `emails.send("verify_email")` não existe de propósito.
const KINDS = catalog.notificationKeys();

function get(kind) {
  if (!KINDS.includes(kind)) return null;
  const vars = VARS[kind];
  if (!vars) return null;
  return payload => render.renderEmail(kind, vars(payload || {}));
}

module.exports = { get, kinds: () => [...KINDS] };
