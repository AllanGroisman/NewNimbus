// Logger estruturado (pino). Por enquanto usado só pra erros de processo.
// TODO Fase 4: migrar console.log/console.error de todos os módulos pra cá.
const pino = require("pino");

const isProd = process.env.NODE_ENV === "production";

const logger = pino({
  level: process.env.LOG_LEVEL || (isProd ? "info" : "debug"),
  // Em dev: pretty-print; em prod: JSON puro (pra ingestion em Datadog/CloudWatch/etc)
  ...(isProd ? {} : {
    transport: {
      target: "pino/file",
      options: { destination: 1 }, // stdout
    },
  }),
  base: { app: "nimbus" },
  timestamp: pino.stdTimeFunctions.isoTime,
});

module.exports = logger;
