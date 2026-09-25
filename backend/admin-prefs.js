// Preferências de tela do admin — filtros, modos, caixinhas — lembradas no
// servidor e iguais para TODOS os admins: um escolhe "Nunca testados", o próximo
// que abrir a tela já vem assim. Quem lê e grava é frontend/src/data/preferenciasAdmin.js.
//
// Uma chave só em app_config (`admin-prefs` = { [chave]: valor }), e a gravação é
// por CHAVE, fundida sobre o que já está lá: dois admins mexendo em filtros
// diferentes não apagam um ao outro — mandar o objeto inteiro apagaria.
//
// O servidor não conhece as chaves (cada tela inventa as suas); ele só impede a
// tela de encher o app_config: nome de chave curto, valor pequeno, teto de chaves.
const appConfig = require("./config");

const CONFIG_KEY = "admin-prefs";
const CHAVE_OK = /^[a-zA-Z0-9._-]{1,80}$/;
const MAX_BYTES_VALOR = 4096;
const MAX_CHAVES = 300;

function lerTodas() {
  const raw = appConfig.get(CONFIG_KEY);
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

// `valor` null/undefined apaga a chave. Erro de validação sai com `status = 400`.
function gravar(chave, valor) {
  const erro = (msg) => Object.assign(new Error(msg), { status: 400 });
  if (typeof chave !== "string" || !CHAVE_OK.test(chave)) throw erro("Chave de preferência inválida.");

  const atual = lerTodas();
  const next = { ...atual };
  if (valor === null || valor === undefined) {
    if (!(chave in atual)) return next;
    delete next[chave];
  } else {
    const json = JSON.stringify(valor);
    if (json === undefined) throw erro("Valor de preferência inválido.");
    if (Buffer.byteLength(json, "utf8") > MAX_BYTES_VALOR) throw erro("Valor de preferência grande demais.");
    if (!(chave in atual) && Object.keys(atual).length >= MAX_CHAVES) throw erro("Preferências demais guardadas.");
    next[chave] = JSON.parse(json);
  }
  appConfig.set(CONFIG_KEY, next);
  return next;
}

module.exports = { CONFIG_KEY, MAX_BYTES_VALOR, MAX_CHAVES, lerTodas, gravar };
