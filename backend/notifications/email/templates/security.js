// Avisos de segurança da conta — as VARIÁVEIS de cada e-mail.
//
// O texto mora em catalog.js (e pode ser reescrito pelo Admin). Aqui fica só a
// tradução `payload → variáveis`: é onde os `if` do código continuam morando,
// resolvidos em frases prontas pra quem edita não precisar de condicional.
//
// Regra de ouro destes e-mails: eles NÃO carregam token. São aviso, não ação —
// quem recebe um "sua senha foi alterada" que não reconhece deve entrar pelo
// caminho normal e usar "Esqueci minha senha". Um link com token aqui daria ao
// invasor um segundo jeito de entrar.

function nome(payload) {
  return payload?.name ? String(payload.name).trim().split(/\s+/)[0] : "";
}

function soNome(p) {
  return { nome: nome(p) };
}

module.exports = {
  password_changed: soNome,
  password_reset_done: soNome,
  admin_password_set: soNome,
  account_suspended: soNome,
  account_reactivated: soNome,

  email_change_requested: p => ({ nome: nome(p), email_novo: p.newEmail || "" }),
  email_changed:         p => ({ nome: nome(p), email_novo: p.newEmail || "" }),
};
