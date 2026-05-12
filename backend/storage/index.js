// Façade — seleciona implementação JSON ou Postgres baseado em STORAGE_BACKEND.
// Interface pública mantida igual à versão original em JSON.
const { isPg } = require("../db");
module.exports = isPg() ? require("./pg") : require("./json");
