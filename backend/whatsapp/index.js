// Facade WhatsApp — seleciona local vs proxy em runtime (Fase 2.1).
//
// - Memory mode (single process): sempre local.
// - Redis mode + WORKER_PROCESS=true (worker.js): local. Worker é dono da sessão.
// - Redis mode + server (default): proxy. Server fala com worker via control queue.

const isWorker = process.env.WORKER_PROCESS === "true";
const isRedis = (process.env.QUEUE_BACKEND || "memory").toLowerCase() === "redis";

module.exports = (isRedis && !isWorker)
  ? require("./proxy")
  : require("./local");
