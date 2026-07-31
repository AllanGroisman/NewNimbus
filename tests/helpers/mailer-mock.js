// Mock do modulo auth/mailer — instalado no require.cache antes do server.js
// carregar. Impede envio REAL de e-mails durante os testes (register/reset
// disparam sendVerificationEmail/sendPasswordResetEmail; sem mock, o SMTP de
// produção é acionado e bate na cota horária). O token de verificação continua
// sendo gravado no DB por auth/pg.js, então os testes que leem o token direto
// do banco seguem funcionando.

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

const calls = {
  sendVerificationEmail: [],
  sendPasswordResetEmail: [],
  sendWelcomeSetPasswordEmail: [],
  sendEmailChangeEmail: [],
};

function reset() {
  for (const k of Object.keys(calls)) calls[k].length = 0;
}

const mock = {
  __calls: calls,
  __reset: reset,
  async sendVerificationEmail(args) {
    calls.sendVerificationEmail.push(args);
    return { ok: true, mocked: true };
  },
  async sendPasswordResetEmail(args) {
    calls.sendPasswordResetEmail.push(args);
    return { ok: true, mocked: true };
  },
  // Boas-vindas de quem assinou pela landing (conta criada pelo pagamento).
  async sendWelcomeSetPasswordEmail(args) {
    calls.sendWelcomeSetPasswordEmail.push(args);
    return { ok: true, mocked: true };
  },
  // Confirmação de troca de email — vai pro endereço novo.
  async sendEmailChangeEmail(args) {
    calls.sendEmailChangeEmail.push(args);
    return { ok: true, mocked: true };
  },
  verifyUrl(token) { return `https://test.local/verify?token=${token}`; },
  resetUrl(token) { return `https://test.local/reset?token=${token}`; },
  emailChangeUrl(token) { return `https://test.local/trocaemail?token=${token}`; },
};

function installMock() {
  const target = path.resolve(__dirname, "..", "..", "backend", "auth", "mailer.js");
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

export { installMock, mock, calls, reset };
