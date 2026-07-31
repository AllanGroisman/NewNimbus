// CPF — validação e formatação.
//
// Uma conta = um CPF. O documento é o único jeito de amarrar a pessoa: e-mail
// é infinito e o teste de R$ 1,00 seria repetido à vontade só trocando de
// endereço. Guardamos SÓ os 11 dígitos (sem ponto e sem traço), que é o que o
// índice único do Postgres compara.
//
// O mesmo algoritmo está espelhado em frontend/src/data/cpf.js, para o campo
// avisar o usuário antes de bater no servidor. Se mudar aqui, mude lá.

function normalizeCpf(value) {
  return String(value || "").replace(/\D/g, "");
}

// Dígitos verificadores oficiais (módulo 11). Sequências repetidas
// (000.000.000-00, 111.111.111-11, …) passam na conta mas não existem na
// Receita — por isso a rejeição explícita.
function isValidCpf(value) {
  const cpf = normalizeCpf(value);
  if (cpf.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(cpf)) return false;

  for (const [len, pos] of [[9, 10], [10, 11]]) {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(cpf[i]) * (pos - i);
    const rest = (sum * 10) % 11;
    const digit = rest === 10 ? 0 : rest;
    if (digit !== Number(cpf[len])) return false;
  }
  return true;
}

// 12345678909 → 123.456.789-09
function formatCpf(value) {
  const cpf = normalizeCpf(value);
  if (cpf.length !== 11) return cpf;
  return `${cpf.slice(0, 3)}.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-${cpf.slice(9)}`;
}

// 12345678909 → 123.***.***-09. Para mostrar de volta pro dono sem expor o
// documento inteiro em tela ou log.
function maskCpf(value) {
  const cpf = normalizeCpf(value);
  if (cpf.length !== 11) return "";
  return `${cpf.slice(0, 3)}.***.***-${cpf.slice(9)}`;
}

// fulano@gmail.com → f*****@gmail.com. Usado na mensagem de "CPF já cadastrado":
// a pessoa precisa reconhecer a própria conta sem que o CPF de terceiros vire
// uma consulta de e-mail.
function maskEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  const at = email.indexOf("@");
  if (at < 1) return "";
  const user = email.slice(0, at);
  const domain = email.slice(at);
  return `${user[0]}${"*".repeat(Math.max(user.length - 1, 1))}${domain}`;
}

module.exports = { normalizeCpf, isValidCpf, formatCpf, maskCpf, maskEmail };
