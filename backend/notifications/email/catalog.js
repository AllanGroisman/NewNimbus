// Catálogo dos e-mails do sistema — a fonte ÚNICA do texto de cada um.
//
// Até a task 54 o texto vivia espalhado: os avisos em templates/security.js e
// templates/billing.js, os e-mails com link em auth/mailer.js (HTML na mão).
// Agora todo e-mail é declarado aqui como um "bloco" editável, e o Admin pode
// reescrever esse bloco pela tela Admin › E-mails (render.js aplica o override).
//
// O que é editável: assunto, título, saudação, parágrafos, rótulo do botão,
// rodapé e tom. O que NÃO é editável, de propósito:
//   - o visual (cores, largura, botão) → vem de layout.js, um arquivo só;
//   - a URL do botão → vem do código (publicUrl.js ou o link com token gerado
//     na hora). Link com token editável seria um jeito fácil de vazar token.
//
// Convenções do texto:
//   {variavel}  → trocada pelo valor real no envio (a lista de cada e-mail está
//                 em `variables`, e é o que a tela mostra como chips clicáveis).
//   *negrito*   → vira <strong>, mesma convenção dos modelos de WhatsApp.
//   quebra de linha → vira <br>.
// Tudo o mais é escapado: não existe HTML digitado na tela chegando no e-mail.
//
// Variável marcada com `condicional: true` some quando não há valor — e o
// parágrafo inteiro que a usa some junto (ex.: só faz sentido falar em campanhas
// pausadas quando alguma foi pausada). Ver render.js.

const { loginUrl, billingUrl } = require("../../config/publicUrl");

// Grupos que a tela usa pra separar a lista.
const GROUPS = [
  { id: "token",    label: "Links de conta" },
  { id: "security", label: "Segurança" },
  { id: "billing",  label: "Cobrança" },
];

const NAO_FOI_VOCE =
  'Se não foi você, redefina sua senha imediatamente em "Esqueci minha senha" e fale com o suporte.';

const V_NOME = { name: "nome", desc: "Primeiro nome de quem recebe" };
const V_LINK = { name: "link", desc: "O link do botão, em texto (pra quem não consegue clicar)" };

// ── Os 20 e-mails ─────────────────────────────────────────────────────────
//
// `ctaUrl` só existe nos e-mails cujo botão aponta pra um endereço fixo. Nos do
// grupo "token" o link é gerado no envio e chega por parâmetro (render.js).

const EMAILS = [
  // ── Links de conta (auth/mailer.js) ────────────────────────────────────
  {
    key: "verify_email",
    group: "token",
    label: "Confirmar e-mail (conta nova)",
    description: "Enviado no cadastro. O link ativa a conta e vale 24 horas.",
    canDisable: false,
    variables: [V_NOME, { name: "email", desc: "E-mail de quem recebe" }, V_LINK],
    example: { nome: "Ana", email: "ana@exemplo.com", link: "https://sistema.nimbuspromocoes.com/?verify=abc123" },
    default: {
      subject: "Confirme seu email — Nimbus",
      title: "Bem-vindo ao Nimbus, {nome}!",
      greeting: "",
      tone: "normal",
      paragraphs: ["Clique no botão abaixo para confirmar seu email e ativar sua conta."],
      ctaLabel: "Confirmar email",
      footnote: "Link válido por 24 horas. Se não criou uma conta, ignore este email.\nOu copie: {link}",
    },
  },
  {
    key: "password_reset_link",
    group: "token",
    label: "Redefinir senha (link)",
    description: 'Enviado quando alguém usa "Esqueci minha senha". O link vale 1 hora.',
    canDisable: false,
    variables: [V_NOME, { name: "email", desc: "E-mail da conta" }, V_LINK],
    example: { nome: "Ana", email: "ana@exemplo.com", link: "https://sistema.nimbuspromocoes.com/?reset=abc123" },
    default: {
      subject: "Redefinir senha — Nimbus",
      title: "Redefinir senha",
      greeting: "",
      tone: "normal",
      paragraphs: ["Recebemos uma solicitação para redefinir a senha de *{email}*."],
      ctaLabel: "Redefinir senha",
      footnote: "Link válido por 1 hora. Se não solicitou, ignore este email.\nOu copie: {link}",
    },
  },
  {
    key: "welcome_set_password",
    group: "token",
    label: "Boas-vindas — criar senha (assinou pela landing)",
    description:
      "Quem assina pela landing tem a conta criada pelo pagamento e ainda não tem senha. O link vale 24 horas.",
    canDisable: false,
    variables: [
      V_NOME,
      { name: "plano", desc: 'Frase com o plano assinado (ex.: "do plano *Pro*"); vazia se não houver' },
      V_LINK,
    ],
    example: { nome: "Ana", plano: "do plano *Pro*", link: "https://sistema.nimbuspromocoes.com/?reset=abc123" },
    default: {
      subject: "Sua assinatura está ativa — crie sua senha | Nimbus",
      title: "Pagamento confirmado, {nome}!",
      greeting: "",
      tone: "normal",
      paragraphs: [
        "Sua assinatura {plano} já está ativa. Criamos sua conta com este e-mail — falta só definir uma senha para entrar.",
      ],
      ctaLabel: "Criar minha senha",
      footnote: 'Link válido por 24 horas — depois é só usar "Esqueci minha senha".\nOu copie: {link}',
    },
  },
  {
    key: "email_change_confirm",
    group: "token",
    label: "Confirmar novo e-mail",
    description:
      "Vai para o endereço NOVO — é o clique aqui que efetiva a troca. O link vale 1 hora.",
    canDisable: false,
    variables: [
      V_NOME,
      { name: "email_novo", desc: "O endereço novo, que está sendo confirmado" },
      { name: "email_atual", desc: "Frase com o endereço atual da conta; vazia se não houver", condicional: false },
      V_LINK,
    ],
    example: {
      nome: "Ana",
      email_novo: "ana.nova@exemplo.com",
      email_atual: " de *ana@exemplo.com*",
      link: "https://sistema.nimbuspromocoes.com/?trocaemail=abc123",
    },
    default: {
      subject: "Confirme seu novo email — Nimbus",
      title: "Confirme seu novo email",
      greeting: "",
      tone: "normal",
      paragraphs: [
        "A conta do Nimbus{email_atual} pediu para passar a usar *{email_novo}* para entrar. Confirme abaixo para valer.",
      ],
      ctaLabel: "Confirmar novo email",
      footnote:
        "Link válido por 1 hora. Se não foi você, ignore este email — nada muda sem este clique.\nOu copie: {link}",
    },
  },

  // ── Segurança (templates/security.js) ──────────────────────────────────
  //
  // Regra de ouro: estes e-mails NÃO carregam token. São aviso, não ação — quem
  // recebe um "sua senha foi alterada" que não reconhece entra pelo caminho
  // normal e usa "Esqueci minha senha". Um link com token aqui daria ao invasor
  // um segundo jeito de entrar.
  {
    key: "password_changed",
    group: "security",
    label: "Senha alterada",
    description: "Enviado quando a pessoa troca a própria senha estando logada.",
    canDisable: true,
    variables: [V_NOME],
    example: { nome: "Ana" },
    ctaUrl: loginUrl,
    default: {
      subject: "Sua senha do Nimbus foi alterada",
      title: "Senha alterada",
      greeting: "{nome}",
      tone: "normal",
      paragraphs: [
        "A senha da sua conta do Nimbus acabou de ser alterada. As outras sessões abertas foram encerradas.",
      ],
      ctaLabel: "Entrar no Nimbus",
      footnote: NAO_FOI_VOCE,
    },
  },
  {
    key: "password_reset_done",
    group: "security",
    label: "Senha redefinida pelo link",
    description: 'Enviado depois que a senha é redefinida pelo link de "Esqueci minha senha".',
    canDisable: true,
    variables: [V_NOME],
    example: { nome: "Ana" },
    ctaUrl: loginUrl,
    default: {
      subject: "Sua senha do Nimbus foi redefinida",
      title: "Senha redefinida",
      greeting: "{nome}",
      tone: "normal",
      paragraphs: [
        "Sua senha foi redefinida pelo link de recuperação. As sessões abertas anteriormente foram encerradas.",
      ],
      ctaLabel: "Entrar no Nimbus",
      footnote: NAO_FOI_VOCE,
    },
  },
  {
    key: "admin_password_set",
    group: "security",
    label: "Senha redefinida pelo suporte",
    description: "Enviado quando um administrador redefine a senha de alguém.",
    canDisable: true,
    variables: [V_NOME],
    example: { nome: "Ana" },
    ctaUrl: loginUrl,
    default: {
      subject: "Sua senha do Nimbus foi redefinida pelo suporte",
      title: "Senha redefinida pelo suporte",
      greeting: "{nome}",
      tone: "normal",
      paragraphs: [
        "Um administrador do Nimbus redefiniu a senha da sua conta e suas sessões foram encerradas. Isso normalmente acontece a pedido seu ou quando há suspeita de acesso indevido.",
        "Você vai receber a senha nova pelo mesmo canal em que pediu o atendimento. Troque-a assim que entrar.",
      ],
      ctaLabel: "Entrar no Nimbus",
      footnote: "Se você não pediu esta redefinição, fale com o suporte agora.",
    },
  },
  {
    key: "account_suspended",
    group: "security",
    label: "Conta suspensa",
    description: "Enviado quando um administrador bloqueia o acesso de uma conta.",
    canDisable: true,
    variables: [V_NOME],
    example: { nome: "Ana" },
    default: {
      subject: "Sua conta do Nimbus foi suspensa",
      title: "Conta suspensa",
      greeting: "{nome}",
      tone: "warn",
      paragraphs: [
        "Sua conta do Nimbus foi suspensa e o acesso está bloqueado por enquanto. Suas campanhas, números e configurações continuam guardados — nada foi apagado.",
        "Para entender o motivo e reativar a conta, responda este e-mail ou fale com o suporte.",
      ],
      ctaLabel: "",
      footnote: "Este é um aviso automático do sistema.",
    },
  },
  {
    key: "account_reactivated",
    group: "security",
    label: "Conta reativada",
    description: "Enviado quando a suspensão é desfeita.",
    canDisable: true,
    variables: [V_NOME],
    example: { nome: "Ana" },
    ctaUrl: loginUrl,
    default: {
      subject: "Sua conta do Nimbus foi reativada",
      title: "Conta reativada",
      greeting: "{nome}",
      tone: "normal",
      paragraphs: [
        "Sua conta voltou a funcionar normalmente. Entre para conferir se suas campanhas e números estão como você deixou.",
      ],
      ctaLabel: "Entrar no Nimbus",
      footnote: "",
    },
  },
  {
    key: "email_change_requested",
    group: "security",
    label: "Pedido de troca de e-mail (aviso ao endereço antigo)",
    description:
      "Rede de segurança: se alguém entrou na conta e está tentando levá-la embora, o dono fica sabendo pelo e-mail que ainda é dele.",
    canDisable: true,
    variables: [V_NOME, { name: "email_novo", desc: "O endereço para onde querem trocar" }],
    example: { nome: "Ana", email_novo: "outro@exemplo.com" },
    default: {
      subject: "Pediram para trocar o e-mail da sua conta Nimbus",
      title: "Pedido de troca de e-mail",
      greeting: "{nome}",
      tone: "warn",
      paragraphs: [
        "Foi solicitada a troca do e-mail de acesso desta conta para *{email_novo}*.",
        "A troca só acontece quando alguém clicar no link de confirmação enviado para o endereço novo. Enquanto isso, seu login continua sendo este e-mail.",
      ],
      ctaLabel: "",
      footnote:
        "Se não foi você, troque sua senha agora — quem pediu tem acesso à sua conta. O pedido expira em 1 hora.",
    },
  },
  {
    key: "email_changed",
    group: "security",
    label: "E-mail alterado (aviso ao endereço antigo)",
    description: "Enviado ao endereço antigo depois que a troca se efetivou.",
    canDisable: true,
    variables: [V_NOME, { name: "email_novo", desc: "O novo e-mail de login da conta" }],
    example: { nome: "Ana", email_novo: "ana.nova@exemplo.com" },
    default: {
      subject: "O e-mail da sua conta Nimbus foi alterado",
      title: "E-mail de acesso alterado",
      greeting: "{nome}",
      tone: "warn",
      paragraphs: [
        "A partir de agora o login desta conta é *{email_novo}*. Este endereço não entra mais.",
      ],
      ctaLabel: "",
      footnote: "Se não foi você, fale com o suporte imediatamente.",
    },
  },

  // ── Cobrança (templates/billing.js) ────────────────────────────────────
  //
  // O tom destes textos vem de um detalhe: quando o cartão falha o cliente não
  // perde o acesso na hora — billing/limits.js dá 3 dias de carência. Esses 3
  // dias só valem alguma coisa se alguém avisar a pessoa. Todos apontam pra tela
  // de Assinatura, onde já existe o botão do Customer Portal (a URL do portal
  // expira em minutos, então não vai em e-mail).
  //
  // Os três primeiros são os avisos de dinheiro que ENTROU (ou voltou). Cada
  // cobrança gera exatamente um deles: a primeira fatura é
  // `subscription_started`, as seguintes são `payment_receipt`. Ver
  // billing/notify.js.
  {
    key: "subscription_started",
    group: "billing",
    label: "Assinatura confirmada (primeira cobrança)",
    description:
      "Enviado quando a assinatura paga começa — inclusive no teste de R$ 1,00. É o comprovante de que o pagamento entrou.",
    canDisable: true,
    variables: [
      V_NOME,
      { name: "plano", desc: "Nome do plano assinado" },
      { name: "valor", desc: 'Quanto foi pago agora (ex.: "R$ 1,00"; "R$ 0,00" quando a cobrança foi adiada)' },
      {
        name: "abertura",
        desc: "Primeira frase — confirma o pagamento, ou avisa que nada foi cobrado quando a assinatura começou durante uma cortesia",
      },
      {
        name: "cobranca",
        desc: "Frase pronta sobre a próxima cobrança — muda se for teste, cortesia ou assinatura cheia",
      },
    ],
    example: {
      nome: "Ana",
      plano: "Básico",
      valor: "R$ 1,00",
      abertura:
        "Recebemos seu pagamento de *R$ 1,00* e sua assinatura do plano *Básico* já está ativa.",
      cobranca:
        "Seu teste vai até *22 de agosto de 2026*. A partir daí a assinatura passa a *R$ 69,90 por mês*, cobrada automaticamente no mesmo cartão.",
    },
    ctaUrl: billingUrl,
    default: {
      subject: "Assinatura confirmada — bem-vindo ao Nimbus",
      title: "Pagamento confirmado!",
      greeting: "{nome}",
      tone: "normal",
      paragraphs: [
        "{abertura}",
        "{cobranca}",
        "Tudo pronto pra usar: é só entrar no sistema, conectar seu WhatsApp e criar a primeira campanha.",
      ],
      ctaLabel: "Ver minha assinatura",
      footnote:
        "Você pode cancelar quando quiser pela tela de Assinatura — sem multa e sem falar com ninguém.",
    },
  },
  {
    key: "payment_receipt",
    group: "billing",
    label: "Recibo de cobrança (renovação)",
    description:
      "Enviado a cada cobrança recorrente aprovada. A primeira cobrança não entra aqui — ela tem o e-mail de assinatura confirmada.",
    canDisable: true,
    variables: [
      V_NOME,
      { name: "plano", desc: "Nome do plano cobrado" },
      { name: "valor", desc: 'Valor cobrado (ex.: "R$ 69,90")' },
      { name: "data_pagamento", desc: "Data da cobrança, por extenso" },
      {
        name: "proxima_cobranca",
        desc: 'Frase pronta da próxima cobrança (ex.: "em *07 de setembro de 2026*")',
        condicional: true,
      },
      { name: "link_fatura", desc: "Link da fatura no Stripe", condicional: true },
    ],
    example: {
      nome: "Ana",
      plano: "Básico",
      valor: "R$ 69,90",
      data_pagamento: "07 de agosto de 2026",
      proxima_cobranca: "em *07 de setembro de 2026*",
      link_fatura: "https://invoice.stripe.com/i/exemplo",
    },
    ctaUrl: billingUrl,
    default: {
      subject: "Recibo do seu pagamento — Nimbus",
      title: "Pagamento recebido",
      greeting: "{nome}",
      tone: "normal",
      paragraphs: [
        "Recebemos *{valor}* referente à assinatura do plano *{plano}* em {data_pagamento}. Nada precisa ser feito — está tudo em dia.",
        "A próxima cobrança é {proxima_cobranca}.",
        "Segunda via da fatura: {link_fatura}",
      ],
      ctaLabel: "Ver minha assinatura",
      footnote: "",
    },
  },
  {
    key: "refund_issued",
    group: "billing",
    label: "Reembolso processado",
    description: "Enviado quando um pagamento é estornado, no todo ou em parte.",
    canDisable: true,
    variables: [
      V_NOME,
      { name: "valor", desc: 'Valor devolvido (ex.: "R$ 69,90")' },
      { name: "tipo", desc: '"integral" ou "parcial"' },
      { name: "data_reembolso", desc: "Data do estorno, por extenso" },
    ],
    example: { nome: "Ana", valor: "R$ 69,90", tipo: "integral", data_reembolso: "07 de agosto de 2026" },
    ctaUrl: billingUrl,
    default: {
      subject: "Seu reembolso do Nimbus foi processado",
      title: "Reembolso processado",
      greeting: "{nome}",
      tone: "normal",
      paragraphs: [
        "Processamos o reembolso {tipo} de *{valor}* em {data_reembolso}.",
        "O valor volta pra mesma forma de pagamento usada na compra. O banco costuma levar de 5 a 10 dias úteis pra mostrar o crédito na fatura — esse prazo é do cartão, não nosso.",
      ],
      ctaLabel: "Ver minha assinatura",
      footnote: "Ficou alguma dúvida sobre o valor? É só responder este e-mail.",
    },
  },
  {
    key: "payment_failed",
    group: "billing",
    label: "Falha no pagamento",
    description: "Enviado quando o banco recusa a cobrança da assinatura.",
    canDisable: true,
    variables: [
      V_NOME,
      { name: "prazo", desc: 'Até quando as campanhas continuam rodando (ex.: "até *04 de agosto de 2026*")' },
    ],
    example: { nome: "Ana", prazo: "até *04 de agosto de 2026*" },
    ctaUrl: billingUrl,
    default: {
      subject: "Não conseguimos cobrar sua assinatura do Nimbus",
      title: "Falha no pagamento",
      greeting: "{nome}",
      tone: "warn",
      paragraphs: [
        "A cobrança da sua assinatura não foi aprovada pelo banco. Pode ser cartão vencido, limite ou uma recusa pontual.",
        "Suas campanhas continuam rodando normalmente {prazo}. Se o pagamento não for regularizado até lá, o acesso é pausado — nada é apagado, tudo volta quando o pagamento entrar.",
      ],
      ctaLabel: "Atualizar forma de pagamento",
      footnote:
        "O Stripe ainda vai tentar cobrar de novo automaticamente. Se você já atualizou o cartão, pode ignorar este aviso.",
    },
  },
  {
    key: "payment_recovered",
    group: "billing",
    label: "Pagamento recuperado",
    description: "Enviado quando a assinatura volta de pendente para em dia.",
    canDisable: true,
    variables: [V_NOME],
    example: { nome: "Ana" },
    ctaUrl: billingUrl,
    default: {
      subject: "Pagamento confirmado — sua assinatura do Nimbus está em dia",
      title: "Pagamento em dia",
      greeting: "{nome}",
      tone: "normal",
      paragraphs: [
        "Recebemos seu pagamento e sua assinatura voltou ao normal. Nenhuma ação é necessária.",
      ],
      ctaLabel: "Ver minha assinatura",
      footnote: "",
    },
  },
  {
    key: "plan_changed",
    group: "billing",
    label: "Plano alterado",
    description: "Enviado na troca de um plano pago por outro.",
    canDisable: true,
    variables: [
      V_NOME,
      { name: "plano_novo", desc: "Nome do plano novo" },
      { name: "plano_anterior", desc: "Nome do plano antigo (vazio se não houver)" },
      { name: "mudanca", desc: 'Frase pronta da mudança (ex.: "mudou de *Básico* para *Pro*")' },
      {
        name: "itens_pausados",
        desc: 'O que foi pausado por limite menor (ex.: "2 campanhas e 1 número")',
        condicional: true,
      },
      { name: "verbo_pausado", desc: '"foi pausado" ou "foram pausados", conforme a quantidade' },
    ],
    example: {
      nome: "Ana",
      plano_novo: "Pro",
      plano_anterior: "Básico",
      mudanca: "mudou de *Básico* para *Pro*",
      itens_pausados: "2 campanhas e 1 número",
      verbo_pausado: "foram pausados",
    },
    ctaUrl: billingUrl,
    default: {
      subject: "Seu plano do Nimbus agora é {plano_novo}",
      title: "Plano alterado",
      greeting: "{nome}",
      tone: "normal",
      paragraphs: [
        "Seu plano {mudanca}.",
        "Como o plano novo tem limites menores, {itens_pausados} {verbo_pausado} automaticamente. Nada foi apagado — você escolhe o que fica ativo na tela de Assinatura.",
      ],
      ctaLabel: "Ver minha assinatura",
      footnote: "",
    },
  },
  {
    key: "cancel_scheduled",
    group: "billing",
    label: "Cancelamento agendado",
    description: "Enviado quando a assinatura é marcada para não renovar.",
    canDisable: true,
    variables: [
      V_NOME,
      { name: "data_fim", desc: 'Até quando o acesso continua (ex.: "*15 de agosto de 2026*")' },
    ],
    example: { nome: "Ana", data_fim: "*15 de agosto de 2026*" },
    ctaUrl: billingUrl,
    default: {
      subject: "Sua assinatura do Nimbus foi cancelada",
      title: "Cancelamento agendado",
      greeting: "{nome}",
      tone: "warn",
      paragraphs: [
        "Sua assinatura não será renovada. Você continua com acesso completo até {data_fim}.",
        "Mudou de ideia? Dá pra reativar a qualquer momento antes dessa data, sem perder nada do que já está configurado.",
      ],
      ctaLabel: "Reativar assinatura",
      footnote: "",
    },
  },
  {
    key: "cancel_reverted",
    group: "billing",
    label: "Cancelamento desfeito",
    description: "Enviado quando a pessoa volta atrás e reativa a assinatura.",
    canDisable: true,
    variables: [
      V_NOME,
      { name: "renovacao", desc: 'Quando volta a renovar (ex.: "em *15 de agosto de 2026*")' },
    ],
    example: { nome: "Ana", renovacao: "em *15 de agosto de 2026*" },
    ctaUrl: billingUrl,
    default: {
      subject: "Sua assinatura do Nimbus foi reativada",
      title: "Assinatura reativada",
      greeting: "{nome}",
      tone: "normal",
      paragraphs: ["O cancelamento foi desfeito e sua assinatura volta a renovar {renovacao}."],
      ctaLabel: "Ver minha assinatura",
      footnote: "",
    },
  },
  {
    key: "subscription_canceled",
    group: "billing",
    label: "Assinatura encerrada",
    description: "Enviado quando a assinatura chega ao fim de verdade.",
    canDisable: true,
    variables: [V_NOME],
    example: { nome: "Ana" },
    ctaUrl: billingUrl,
    default: {
      subject: "Sua assinatura do Nimbus foi encerrada",
      title: "Assinatura encerrada",
      greeting: "{nome}",
      tone: "warn",
      paragraphs: [
        "Sua assinatura chegou ao fim e suas campanhas e números foram pausados.",
        "Nada foi apagado: suas campanhas, grupos e configurações continuam guardados e voltam exatamente como estavam quando você assinar de novo.",
      ],
      ctaLabel: "Assinar novamente",
      footnote: "",
    },
  },
  {
    key: "trial_ending",
    group: "billing",
    label: "Período de teste acabando",
    description: "Enviado pelo lembrete automático quando faltam 2 dias ou menos de teste.",
    canDisable: true,
    variables: [
      V_NOME,
      { name: "prazo_teste", desc: 'Quando o teste acaba (ex.: "em *2 dias* (15 de agosto de 2026)")' },
      { name: "dias", desc: "Quantos dias faltam" },
      { name: "data_fim", desc: "Data em que o teste termina" },
    ],
    example: {
      nome: "Ana",
      prazo_teste: "em *2 dias* (15 de agosto de 2026)",
      dias: "2",
      data_fim: "15 de agosto de 2026",
    },
    ctaUrl: billingUrl,
    default: {
      subject: "Seu período de teste do Nimbus está acabando",
      title: "Teste acabando",
      greeting: "{nome}",
      tone: "normal",
      paragraphs: [
        "Seu período de teste termina {prazo_teste}.",
        "Depois disso a cobrança do plano começa automaticamente, e é só continuar usando — não precisa fazer nada.",
        "Se preferir não continuar, dá pra cancelar antes na tela de Assinatura.",
      ],
      ctaLabel: "Ver minha assinatura",
      footnote: "",
    },
  },
  {
    key: "grace_ending",
    group: "billing",
    label: "Último aviso antes de pausar",
    description: "Enviado pelo lembrete automático quando a carência acaba em 24 horas ou menos.",
    canDisable: true,
    variables: [
      V_NOME,
      { name: "prazo_pausa", desc: 'Quando as campanhas param (ex.: "em *04 de agosto de 2026*")' },
    ],
    example: { nome: "Ana", prazo_pausa: "em *04 de agosto de 2026*" },
    ctaUrl: billingUrl,
    default: {
      subject: "Último aviso: seu acesso ao Nimbus será pausado",
      title: "Seu acesso será pausado",
      greeting: "{nome}",
      tone: "warn",
      paragraphs: [
        "O pagamento da sua assinatura continua pendente. Suas campanhas serão pausadas {prazo_pausa}.",
        "Atualize a forma de pagamento para não ter interrupção. Nada é apagado — só deixa de enviar até o pagamento entrar.",
      ],
      ctaLabel: "Atualizar forma de pagamento",
      footnote: "",
    },
  },
  {
    key: "access_paused",
    group: "billing",
    label: "Acesso pausado por falta de pagamento",
    description: "Enviado pelo lembrete automático quando a carência estourou.",
    canDisable: true,
    variables: [V_NOME, { name: "endereco_sistema", desc: "Endereço do sistema, em texto" }],
    example: { nome: "Ana", endereco_sistema: loginUrl },
    ctaUrl: billingUrl,
    default: {
      subject: "Seu acesso ao Nimbus foi pausado por falta de pagamento",
      title: "Acesso pausado",
      greeting: "{nome}",
      tone: "warn",
      paragraphs: [
        "Como o pagamento não foi regularizado, suas campanhas e números foram pausados e pararam de enviar.",
        "Suas configurações continuam intactas: assim que o pagamento entrar, é só reativar o que estava rodando.",
      ],
      ctaLabel: "Atualizar forma de pagamento",
      footnote: "Precisa de ajuda? Entre em {endereco_sistema} e fale com o suporte.",
    },
  },
];

const BY_KEY = Object.fromEntries(EMAILS.map(e => [e.key, e]));
const KEYS = EMAILS.map(e => e.key);

function get(key) {
  return BY_KEY[key] || null;
}

// Só os kinds enviados por notifications/email (registry). Os do grupo "token"
// saem por auth/mailer.js, com o link gerado na hora.
function notificationKeys() {
  return EMAILS.filter(e => e.group !== "token").map(e => e.key);
}

// Descrição pra tela: tudo menos o bloco padrão (que vai separado, pra o botão
// "Restaurar padrão" comparar).
function meta() {
  return EMAILS.map(({ default: _omit, ctaUrl, ...rest }) => ({
    ...rest,
    ctaUrl: ctaUrl || null,
  }));
}

function defaults() {
  return Object.fromEntries(EMAILS.map(e => [e.key, { ...e.default, paragraphs: [...e.default.paragraphs] }]));
}

module.exports = { EMAILS, KEYS, GROUPS, get, notificationKeys, meta, defaults };
