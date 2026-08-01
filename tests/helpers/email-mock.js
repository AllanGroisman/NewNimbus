// Mock do modulo notifications/email — instalado no require.cache antes do
// server.js carregar, igual ao mailer-mock.
//
// Diferença: este mock é GENÉRICO. Ele registra (kind, payload, opts) em vez de
// ter um método por e-mail, então adicionar um template novo no backend não
// exige mexer aqui. Os testes checam por kind: emailByKind("payment_failed").
//
// Com o mock instalado a tabela email_log NÃO é escrita — a dedupe real é
// testada à parte, chamando o módulo verdadeiro.

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

const calls = [];

function reset() {
  calls.length = 0;
}

function byKind(kind) {
  return calls.filter(c => c.kind === kind);
}

const mock = {
  __calls: calls,
  __reset: reset,
  __byKind: byKind,
  async send(kind, payload = {}, opts = {}) {
    calls.push({ kind, payload, opts });
    return { ok: true, sent: true, mocked: true };
  },
  sendAsync(kind, payload = {}, opts = {}) {
    calls.push({ kind, payload, opts });
  },
  kinds: () => [],
};

function installMock() {
  const target = path.resolve(__dirname, "..", "..", "backend", "notifications", "email", "index.js");
  require.cache[target] = {
    id: target,
    filename: target,
    loaded: true,
    children: [],
    paths: [],
    exports: mock,
  };
  return mock;
}

export { installMock, mock, calls, reset, byKind };
