// Façade — seleciona implementação JSON ou Postgres baseado em STORAGE_BACKEND.
const { isPg } = require("./db");
module.exports = isPg() ? require("./auth-pg") : require("./auth-json");
