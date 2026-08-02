// Tratamento de erro HTTP num lugar só.
//
// Regra: o cliente nunca recebe mensagem de exceção interna. Erro de biblioteca
// ("Can't reach database server at localhost:5432") é log e Sentry — pro
// usuário vai um texto em português e um requestId pra citar no suporte.
//
// Contrato de resposta (o mesmo que as rotas já usam em ~193 lugares):
//   { error: "<mensagem pt-BR>", code: "<slug>", requestId? }

const crypto = require("crypto");
const logger = require("./logger");
const sentry = require("./sentry");

const MSG_INTERNAL = "Algo deu errado do nosso lado. Tente novamente em instantes.";

function newRequestId() {
  return crypto.randomUUID().slice(0, 8);
}

// Erro cuja mensagem PODE ir pra tela. Use quando o texto já é escrito pro
// usuário, em português — sem isso o handler troca por MSG_INTERNAL.
class AppError extends Error {
  constructor(message, { status = 400, code = null } = {}) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.expose = true;
  }
}

// Responde um 500 sem vazar detalhe interno. Substitui o padrão
// `res.status(500).json({ error: err.message })` espalhado pelas rotas.
//
// `expose: true` só nas rotas cujo módulo de domínio escreve a mensagem pro
// usuário em português (backup/api.js, scraping/affiliate.js). No resto, o que
// chega aqui é erro de biblioteca em inglês — e às vezes com host e porta do
// banco dentro.
function serverError(res, err, { req = null, ctx = "", expose = false } = {}) {
  const requestId = newRequestId();
  logger.error(
    { err: err?.message, stack: err?.stack, ctx, requestId, path: req?.path, method: req?.method, userId: req?.user?.id },
    `[erro] ${ctx || req?.path || "interno"}`
  );
  sentry.captureException(err, {
    extra: { ctx, requestId, path: req?.path, method: req?.method, userId: req?.user?.id },
  });
  // Erros do próprio domínio já trazem texto de usuário — esses passam.
  const message = (expose || err?.expose) && err?.message ? err.message : MSG_INTERNAL;
  return res.status(err?.status && err.status >= 400 && err.status < 600 ? err.status : 500)
    .json({ error: message, code: err?.code || "internal", requestId });
}

// 404 de API. Fora de /api/ a requisição é do frontend e quem responde é o
// nginx (SPA fallback), então este handler é montado só em /api.
function notFound(req, res) {
  res.status(404).json({ error: "Rota não encontrada.", code: "not_found" });
}

// Handler global do Express. Precisa dos 4 argumentos — é assim que o Express
// distingue error handler de middleware comum.
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  // Resposta já começou a sair: não dá pra trocar o corpo, delega pro default.
  if (res.headersSent) return next(err);

  // JSON malformado no body (express.json)
  if (err?.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Requisição inválida.", code: "bad_request" });
  }
  // Body maior que o limite de 2mb
  if (err?.type === "entity.too.large") {
    return res.status(413).json({ error: "Dados grandes demais (máximo 2 MB).", code: "too_large" });
  }
  // Origem barrada pelo cors() — hoje isso virava um 500 em HTML.
  if (typeof err?.message === "string" && err.message.startsWith("Origin não permitido")) {
    logger.warn({ origin: req.headers?.origin }, "[cors] origem barrada");
    return res.status(403).json({ error: "Origem não autorizada.", code: "cors_denied" });
  }

  return serverError(res, err, { req, ctx: "unhandled" });
}

// Registra os dois na ordem certa. Chame DEPOIS de todas as rotas.
function install(app) {
  app.use("/api", notFound);
  app.use(sentry.errorHandler());
  app.use(errorHandler);
}

module.exports = { AppError, MSG_INTERNAL, serverError, notFound, errorHandler, install };
