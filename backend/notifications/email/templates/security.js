// Avisos de segurança da conta.
//
// Regra de ouro destes e-mails: eles NÃO carregam token nenhum. São aviso, não
// ação — quem recebe um "sua senha foi alterada" que não reconhece deve entrar
// pelo caminho normal e usar "Esqueci minha senha". Um link com token aqui daria
// ao invasor um segundo jeito de entrar.

const { esc, render } = require("../layout");
const { loginUrl } = require("../../../config/publicUrl");

const NAO_FOI_VOCE =
  'Se não foi você, redefina sua senha imediatamente em "Esqueci minha senha" e fale com o suporte.';

function nome(payload) {
  return payload?.name ? String(payload.name).trim().split(/\s+/)[0] : "";
}

function password_changed(p) {
  return render({
    subject: "Sua senha do Nimbus foi alterada",
    title: "Senha alterada",
    greeting: nome(p),
    paragraphs: [
      "A senha da sua conta do Nimbus acabou de ser alterada. As outras sessões abertas foram encerradas.",
    ],
    cta: { label: "Entrar no Nimbus", url: loginUrl },
    footnote: NAO_FOI_VOCE,
  });
}

function password_reset_done(p) {
  return render({
    subject: "Sua senha do Nimbus foi redefinida",
    title: "Senha redefinida",
    greeting: nome(p),
    paragraphs: [
      "Sua senha foi redefinida pelo link de recuperação. As sessões abertas anteriormente foram encerradas.",
    ],
    cta: { label: "Entrar no Nimbus", url: loginUrl },
    footnote: NAO_FOI_VOCE,
  });
}

function admin_password_set(p) {
  return render({
    subject: "Sua senha do Nimbus foi redefinida pelo suporte",
    title: "Senha redefinida pelo suporte",
    greeting: nome(p),
    paragraphs: [
      "Um administrador do Nimbus redefiniu a senha da sua conta e suas sessões foram encerradas. " +
      "Isso normalmente acontece a pedido seu ou quando há suspeita de acesso indevido.",
      "Você vai receber a senha nova pelo mesmo canal em que pediu o atendimento. Troque-a assim que entrar.",
    ],
    cta: { label: "Entrar no Nimbus", url: loginUrl },
    footnote: "Se você não pediu esta redefinição, fale com o suporte agora.",
  });
}

function account_suspended(p) {
  return render({
    subject: "Sua conta do Nimbus foi suspensa",
    title: "Conta suspensa",
    greeting: nome(p),
    tone: "warn",
    paragraphs: [
      "Sua conta do Nimbus foi suspensa e o acesso está bloqueado por enquanto. " +
      "Suas campanhas, números e configurações continuam guardados — nada foi apagado.",
      "Para entender o motivo e reativar a conta, responda este e-mail ou fale com o suporte.",
    ],
    footnote: "Este é um aviso automático do sistema.",
  });
}

function account_reactivated(p) {
  return render({
    subject: "Sua conta do Nimbus foi reativada",
    title: "Conta reativada",
    greeting: nome(p),
    paragraphs: [
      "Sua conta voltou a funcionar normalmente. Entre para conferir se suas campanhas e números estão como você deixou.",
    ],
    cta: { label: "Entrar no Nimbus", url: loginUrl },
  });
}

// Vai para o endereço ANTIGO. O endereço novo recebe o link de confirmação
// (auth/mailer.js); este aqui é a rede de segurança: se alguém entrou na conta
// e está tentando levá-la embora, o dono fica sabendo pelo e-mail que ainda é dele.
function email_change_requested(p) {
  return render({
    subject: "Pediram para trocar o e-mail da sua conta Nimbus",
    title: "Pedido de troca de e-mail",
    greeting: nome(p),
    tone: "warn",
    paragraphs: [
      `Foi solicitada a troca do e-mail de acesso desta conta para <strong>${esc(p.newEmail)}</strong>.`,
      "A troca só acontece quando alguém clicar no link de confirmação enviado para o endereço novo. " +
      "Enquanto isso, seu login continua sendo este e-mail.",
    ],
    footnote:
      "Se não foi você, troque sua senha agora — quem pediu tem acesso à sua conta. O pedido expira em 1 hora.",
  });
}

// Também para o endereço antigo, depois de a troca virar realidade.
function email_changed(p) {
  return render({
    subject: "O e-mail da sua conta Nimbus foi alterado",
    title: "E-mail de acesso alterado",
    greeting: nome(p),
    tone: "warn",
    paragraphs: [
      `A partir de agora o login desta conta é <strong>${esc(p.newEmail)}</strong>. Este endereço não entra mais.`,
    ],
    footnote: "Se não foi você, fale com o suporte imediatamente.",
  });
}

module.exports = {
  password_changed,
  password_reset_done,
  admin_password_set,
  account_suspended,
  account_reactivated,
  email_change_requested,
  email_changed,
};
