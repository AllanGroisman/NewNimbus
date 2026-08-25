// Catálogo fechado dos motivos de descarte do repasse.
//
// Existe porque o log gravava só texto livre: dava pra ler UM caso e era inútil
// pra enxergar um PROBLEMA (10 descartes seguidos pela mesma causa apareciam como
// 10 frases parecidas, sem contagem nem filtro). O `errorKind` é a chave estável;
// o `reason` continua guardado ao lado, com o detalhe humano de cada caso.
//
// A outra coisa que este arquivo resolve: separar "o que aconteceu" de "o que
// fazer". A mensagem antiga do CAPTCHA do ML dizia "tente daqui a alguns minutos
// OU revise o cookie de afiliado" — quem lia não sabia se devia esperar ou agir.
// Aqui isso são dois campos, e `transient` diz qual dos dois é.
//
// Módulo folha de propósito: nada de db/prisma/scraper aqui, pra poder ser
// requerido por capture.js, scheduler.js, server.js e pelos testes sem arrastar
// dependência nenhuma.

const KIND = {
  CAPTCHA: "captcha",
  LOGIN_WALL: "login-wall",
  LANDING_EXPIRADA: "landing-expirada",
  NAO_E_PRODUTO: "nao-e-produto",
  TIMEOUT: "timeout",
  LOJA_NAO_SUPORTADA: "loja-nao-suportada",
  AFILIADO_AUSENTE: "afiliado-ausente",
  CONVERSAO_AFILIADO_FALHOU: "conversao-afiliado-falhou",
  DESCONHECIDO: "desconhecido",
};

// transient: true  → passageiro, é caso de ESPERAR
// transient: false → alguém precisa AGIR (mexer em configuração)
// transient: null  → informativo; nada quebrou, o link é que não servia
const ERROR_KINDS = {
  [KIND.CAPTCHA]: {
    label: "CAPTCHA",
    what: "A loja exigiu verificação anti-robô e a página do produto não abriu.",
    action: "Bloqueio passageiro — nada a fazer agora. Se durar horas seguidas, o jeito de raspar a página é que precisa mudar.",
    transient: true,
  },
  [KIND.LOGIN_WALL]: {
    label: "Muro de login",
    what: "A loja mandou a tela de login em vez da página do produto — o cookie de afiliado não está valendo.",
    action: "Cole um cookie de afiliado novo em Configurações. Esperar não resolve: vai bater na mesma parede.",
    transient: false,
  },
  [KIND.LANDING_EXPIRADA]: {
    label: "Landing de afiliado expirada",
    what: "O link era uma página de divulgação de afiliado e o botão \"Ir para o produto\" não abriu a página real, então não deu pra ler o produto.",
    action: "É o link postado no grupo líder que está velho ou é de outro afiliado. Peça o link direto do produto.",
    transient: false,
  },
  [KIND.NAO_E_PRODUTO]: {
    label: "Não é página de produto",
    what: "A página abriu, mas sem nome, foto ou preço — é busca, categoria ou link quebrado.",
    action: "Nada a corrigir no sistema: o link postado não era de um produto.",
    transient: null,
  },
  [KIND.TIMEOUT]: {
    label: "Tempo esgotado",
    what: "A página demorou demais pra responder e a leitura foi abortada.",
    action: "Passageiro — costuma ser lentidão da loja ou da rede. Se repetir muito, vale olhar o servidor.",
    transient: true,
  },
  [KIND.LOJA_NAO_SUPORTADA]: {
    label: "Loja não suportada",
    what: "O link não é de Mercado Livre, Amazon nem Shopee, que são as lojas que o sistema sabe monetizar.",
    action: "Nada a corrigir: links de outras lojas são ignorados de propósito.",
    transient: null,
  },
  [KIND.AFILIADO_AUSENTE]: {
    label: "Afiliado não configurado",
    what: "O link é de uma loja suportada, mas esse usuário não tem o afiliado dessa loja configurado.",
    action: "O usuário precisa configurar o afiliado dessa loja em Configurações — sem isso o envio sairia sem comissão.",
    transient: false,
  },
  [KIND.CONVERSAO_AFILIADO_FALHOU]: {
    label: "Conversão de afiliado falhou",
    what: "Na hora de enviar, gerar o link com comissão falhou — então o item foi descartado em vez de sair sem comissão.",
    action: "Verifique o afiliado dessa loja nas Configurações do usuário (token ou cookie podem ter vencido).",
    transient: false,
  },
  [KIND.DESCONHECIDO]: {
    label: "Motivo desconhecido",
    what: "Algo falhou fora dos casos previstos.",
    action: "Leia o texto do motivo ao lado — se aparecer muito, vale virar um motivo próprio nesta lista.",
    transient: null,
  },
};

// Etapas do caminho de um link, em ordem. Serve pra UI saber se uma checagem
// ("fonte habilitada", "scrape") simplesmente NÃO CHEGOU a rodar — antes disso o
// painel mostrava um traço solto, que parecia defeito.
const STAGE = {
  STORE: "store",                       // detectar de que loja é o link
  AFFILIATE_CONFIG: "affiliate-config", // usuário tem afiliado dessa loja?
  SCRAPE: "scrape",                     // abrir a página e ler o produto
  VALIDATE: "validate",                 // o que voltou é mesmo um produto?
  SOURCE: "source",                     // essa loja está habilitada NA campanha?
  QUEUE: "queue",                       // inserir na fila / revisão
  SEND: "send",                         // envio pro WhatsApp
};

const STAGE_ORDER = {
  [STAGE.STORE]: 0,
  [STAGE.AFFILIATE_CONFIG]: 1,
  [STAGE.SCRAPE]: 2,
  [STAGE.VALIDATE]: 3,
  [STAGE.SOURCE]: 4,
  [STAGE.QUEUE]: 5,
  [STAGE.SEND]: 6,
};

// Classificação a partir do texto. É o CAMINHO DE EXCEÇÃO, não o normal: quase
// todo descarte já sabe o próprio motivo no `if` que decidiu descartar, e é de lá
// que o errorKind vem. Isto aqui só cobre (a) erros vindos de fora (Puppeteer,
// urlGuard) e (b) o backfill das linhas antigas na migration
// 20260825120000_repasse_log_error_kind — os padrões dos dois têm que casar, e há
// teste garantindo isso.
function classifyFromText(text) {
  const s = (text || "").toString();
  if (!s.trim()) return KIND.DESCONHECIDO;
  if (/captcha|verifica[çc][ãa]o/i.test(s)) return KIND.CAPTCHA;
  if (/pediu login|acesse sua conta|bloqueio anti-bot \(login\)/i.test(s)) return KIND.LOGIN_WALL;
  if (/loja n[ãa]o suportada|link n[ãa]o reconhecido/i.test(s)) return KIND.LOJA_NAO_SUPORTADA;
  if (/n[ãa]o configurado/i.test(s)) return KIND.AFILIADO_AUSENTE;
  if (/timeout|ETIMEDOUT/i.test(s)) return KIND.TIMEOUT;
  if (/dados insuficientes|n[ãa]o foi poss[íi]vel encontrar|produto n[ãa]o encontrado/i.test(s)) return KIND.NAO_E_PRODUTO;
  return KIND.DESCONHECIDO;
}

module.exports = { KIND, ERROR_KINDS, STAGE, STAGE_ORDER, classifyFromText };
