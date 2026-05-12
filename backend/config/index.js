// Façade de key-value store pra configs simples (afiliado, scraper-config).
// JSON: cada key mapeia pra um arquivo dedicado em data/ (compat com layout legado).
// PG: tudo na tabela AppConfig (key/value jsonb).
const { isPg } = require("../db");
module.exports = isPg() ? require("./pg") : require("./json");
