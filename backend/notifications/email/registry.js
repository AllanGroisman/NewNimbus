// Registro de templates: kind → render(payload) → { subject, html, text }.
//
// Adicionar um e-mail novo = adicionar uma função pura no arquivo de templates
// da área e um teste. Nada mais precisa mudar: index.js resolve pelo kind.

const security = require("./templates/security");
const billing = require("./templates/billing");

const TEMPLATES = { ...security, ...billing };

function get(kind) {
  return TEMPLATES[kind] || null;
}

module.exports = { TEMPLATES, get, kinds: () => Object.keys(TEMPLATES) };
