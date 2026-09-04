// Ops pontual: mata uma sessão pendente/fantasma no worker via control-queue.
// Uso: node scripts/kill-pending-session.js <userId> <numberId>
//
// Carrega o env do mesmo jeito que server/worker e usa o facade whatsapp (que
// resolve pra proxy quando NÃO é o worker), enfileirando deleteSession pro worker.
require("../config/loadEnv");

const queue = require("../infra/queue");
const wa = require("../whatsapp"); // resolve pra proxy (WORKER_PROCESS não setado)

(async () => {
  const [userId, numberId] = process.argv.slice(2);
  if (!userId || !numberId) {
    console.error("uso: node scripts/kill-pending-session.js <userId> <numberId>");
    process.exit(1);
  }
  // O backend/worker chamam queue.init() no boot; um script avulso não. Sem isso,
  // callControl (usado por deleteSession no proxy) falha com "producer não
  // inicializado". Só precisamos do producer pra enfileirar e aguardar a resposta.
  await queue.init({ producer: true, consumer: false });
  console.log(`deleteSession(${userId}, ${numberId}) via control-queue…`);
  try {
    const res = await wa.deleteSession(userId, numberId);
    console.log("OK:", JSON.stringify(res));
  } catch (e) {
    console.error("ERRO:", e.message);
    process.exitCode = 1;
  } finally {
    // dá um tempinho pra flush de qualquer conexão redis e sai.
    setTimeout(() => process.exit(process.exitCode || 0), 500);
  }
})();
