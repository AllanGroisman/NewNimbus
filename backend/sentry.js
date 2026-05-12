// Sentry integration (Fase 4).
//
// Sem SENTRY_DSN no env: tudo vira no-op. Pra ativar, cria conta em sentry.io,
// pega o DSN e seta no .env (ou docker secrets).
//
// Uso:
//   sentry.init({ context: "server" })   // chama UMA vez no boot
//   sentry.captureException(err, { extra: { ... } })

let _initialized = false;
let _Sentry = null;

function init({ context = "server", release = null } = {}) {
  if (_initialized) return;
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    console.log(`[sentry] SENTRY_DSN não definido — captura desativada (${context})`);
    return;
  }
  try {
    _Sentry = require("@sentry/node");
    _Sentry.init({
      dsn,
      environment: process.env.NODE_ENV || "development",
      release: release || process.env.SENTRY_RELEASE || undefined,
      // Performance: 10% das transações em prod, 100% em dev
      tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,
      // Não envie payloads grandes acidentalmente
      maxValueLength: 2000,
      initialScope: { tags: { component: context } },
    });
    _initialized = true;
    console.log(`[sentry] iniciado (env=${process.env.NODE_ENV || "development"} context=${context})`);
  } catch (err) {
    console.error(`[sentry] falha ao iniciar: ${err.message}`);
  }
}

function captureException(err, extras = {}) {
  if (!_Sentry || !_initialized) return;
  try {
    _Sentry.withScope(scope => {
      if (extras.user) scope.setUser(extras.user);
      if (extras.tags) Object.entries(extras.tags).forEach(([k, v]) => scope.setTag(k, v));
      if (extras.extra) Object.entries(extras.extra).forEach(([k, v]) => scope.setExtra(k, v));
      _Sentry.captureException(err);
    });
  } catch {}
}

function captureMessage(message, level = "info", extras = {}) {
  if (!_Sentry || !_initialized) return;
  try {
    _Sentry.withScope(scope => {
      scope.setLevel(level);
      if (extras.tags) Object.entries(extras.tags).forEach(([k, v]) => scope.setTag(k, v));
      if (extras.extra) Object.entries(extras.extra).forEach(([k, v]) => scope.setExtra(k, v));
      _Sentry.captureMessage(message);
    });
  } catch {}
}

// Express middleware — wrappa rotas pra capturar erros automáticos.
// Aplique APÓS as rotas mas ANTES de error handlers próprios:
//   app.use(...routes...);
//   app.use(sentry.errorHandler());
function errorHandler() {
  if (!_Sentry || !_initialized) return (err, req, res, next) => next(err);
  return _Sentry.expressErrorHandler ? _Sentry.expressErrorHandler() : (err, req, res, next) => {
    _Sentry.captureException(err);
    next(err);
  };
}

async function flush(timeoutMs = 2000) {
  if (!_Sentry || !_initialized) return;
  try { await _Sentry.flush(timeoutMs); } catch {}
}

module.exports = { init, captureException, captureMessage, errorHandler, flush };
