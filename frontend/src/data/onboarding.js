// ─── TOUR DE PRIMEIROS PASSOS ─────────────────────────────────────────────
// Fonte única dos roteiros do tour e do que já foi visto.
//
// Onde isso é guardado: settings.onboarding, ou seja, dentro do mesmo blob que
// já vai pro servidor no autosave (PUT /api/state). Fica na conta, não no
// navegador — quem viu o tour no computador não vê de novo no celular.
// ──────────────────────────────────────────────────────────────────────────

export const DEFAULT_ONBOARDING = {
  version: 1,
  tours: {}, // { [tourId]: true } — tours já vistos
};

// Normaliza o que veio do servidor (pode ser undefined, de uma versão antiga,
// ou com campos faltando) pro formato completo.
export function mergeOnboarding(raw) {
  const o = raw && typeof raw === "object" ? raw : {};
  return {
    ...DEFAULT_ONBOARDING,
    ...o,
    tours: o.tours && typeof o.tours === "object" ? o.tours : {},
  };
}

// Evento que o tour dispara pra abrir uma aba de dentro da campanha. Quem
// escuta é o GroupDashboard (a aba aberta é estado interno dele). É por evento
// e não por prop porque o tour roda por cima de qualquer tela, sem saber quem
// está montado embaixo.
export const TOUR_TAB_EVENT = "nimbus:tour-tab";

// ─── Roteiros (task 38) ───────────────────────────────────────────────────
// Cada passo é { anchor, title, text, page?, tab? }:
//   anchor — data-tour="..." do elemento a iluminar. Pode ser uma lista, e aí
//            o holofote abre num retângulo que cobre todos.
//   page   — troca de tela antes de iluminar.
//   tab    — abre essa aba da campanha antes de iluminar.
// Passo cujo alvo não existe naquela tela é pulado sozinho pelo TourOverlay —
// assim um tour nunca trava (ex.: "Aguardando revisão" quando não tem nenhum).
export const TOURS = {
  main: {
    id: "main",
    title: "Tour do painel",
    description: "Uma volta rápida pelo menu e pelas telas principais.",
    page: "dashboard",
    steps: [
      { anchor: "nav-dashboard", title: "Suas campanhas", text: "Aqui ficam todas as suas campanhas. Cada uma tem suas categorias, seus grupos e seus horários de envio." },
      { anchor: "new-campaign", title: "Criar uma campanha", text: "Por aqui você cria uma campanha nova — de busca no catálogo ou de repasse de outro grupo." },
      { anchor: "nav-whatsapp", title: "Seus números", text: "É onde você conecta o WhatsApp lendo o QR Code, e onde vê se ele continua conectado." },
      {
        anchor: ["nav-mercado-livre", "nav-amazon", "nav-shopee"],
        title: "As três lojas",
        text: "Mercado Livre, Amazon e Shopee: uma tela por loja pra guardar seus dados de afiliado. É o que garante que os links saiam com a sua comissão.",
      },
      { anchor: "nav-subscription", title: "Plano e cobrança", text: "Aqui você assina, troca de plano, vê até quando está pago e cancela. Sem plano ativo o sistema não envia." },
      { anchor: "nav-tutorials", title: "Tutoriais e guias", text: "Passo a passo escrito e os tours — dá pra refazer qualquer um deles quando quiser." },
      { anchor: "support-button", title: "Suporte a qualquer hora", text: "Este botão está sempre no canto: ele abre uma conversa no WhatsApp com a gente." },
    ],
  },

  // Tour da campanha: entra em cada aba e ilumina as partes principais dela.
  // Serve pras duas famílias de campanha — os passos que só existem na busca
  // (pesquisa, filtros) ou só no repasse (grupos líderes) se pulam sozinhos.
  campaign: {
    id: "campaign",
    title: "Tour da campanha",
    description: "Entra em cada aba e mostra pra que serve cada parte dela.",
    steps: [
      // ── Visão geral
      { tab: "overview", anchor: "tab-overview", title: "Visão geral", text: "O resumo da campanha, pra bater o olho e ver se está rodando: envios de hoje e da semana, quantos produtos esperam na fila, a hora do último envio e os últimos produtos que foram pros grupos. Não se configura nada aqui." },

      // ── Gerenciar
      { tab: "manage", anchor: "tab-manage", title: "Gerenciar", text: "O nome da campanha, as lojas que ela aceita e a espera pra repetir um produto já enviado. O que você mudar aqui só passa a valer depois de clicar em Salvar." },

      // ── Busca de produtos (a campanha de repasse não tem esta aba: os grupos
      //    líderes ficam na aba Grupos e a revisão dos links, na aba Fila)
      { tab: "products", anchor: "tab-products", title: "De onde vêm os produtos", text: "É aqui que você diz o que procurar no catálogo: categorias, palavras-chave e filtros de preço, desconto e avaliação. Colar um link na mão não é aqui — isso fica na aba Fila." },
      { tab: "products", anchor: "pr-where", title: "Onde buscar", text: "As lojas e as categorias que esta campanha vasculha. Aparecem só as categorias ligadas; o botão \"Adicionar categoria\" abre a lista pra marcar mais, até o limite do seu plano." },
      { tab: "products", anchor: "pr-queue", title: "Preenchimento automático", text: "A chave liga e desliga o preenchimento sozinho. Em \"Configurar\" você escolhe quando ele acontece — quando a fila estiver acabando ou em horários fixos do dia — e o máximo de produtos que a fila pode ter — o preenchimento completa até esse número e para. A ordem fica no seletor em cima da lista de produtos." },

      // ── Fila
      { tab: "queue", anchor: "tab-queue", title: "Fila", text: "A ordem de quem vai ser enviado — é aqui que você vê o que está esperando pra sair." },
      { tab: "queue", anchor: "qu-list", title: "A fila em ordem", text: "O de cima é o próximo. Dá pra arrastar pra reordenar, tirar da fila, mandar um produto furar a fila ou enviar na hora. Nesta aba também dá pra colar o link de um produto na mão." },

      // ── Grupos
      { tab: "whatsapp", anchor: "tab-whatsapp", title: "Grupos", text: "Os grupos destino, que recebem as ofertas desta campanha. Sem grupo aqui, não tem pra quem enviar." },
      // Líderes antes do "+ Adicionar grupo": no repasse a aba abre pela
      // captura, e o tour segue a mesma ordem da tela. Na campanha de busca a
      // âncora pr-leader não existe e o passo é pulado.
      { tab: "whatsapp", anchor: "pr-leader", title: "Grupos líderes", text: "No repasse, os grupos que o sistema fica escutando: todo link de produto postado neles é capturado e re-afiliado com a sua tag. Com a aprovação automática ligada eles entram direto na fila; desligada, esperam você aprovar na aba Fila." },
      { tab: "whatsapp", anchor: "wg-add", title: "Adicionar um grupo", text: "Cria um grupo novo ou vincula um que já existe, usando um dos números que você conectou. A bolinha de cada grupo na lista diz se ele está conectado." },

      // ── Modelos de mensagem
      { tab: "messages", anchor: "tab-messages", title: "Modelos de mensagem", text: "É onde você escolhe como vai ser a mensagem enviada nos grupos: o texto que acompanha cada oferta." },
      { tab: "messages", anchor: "ms-picker", title: "Escolher e ativar o modelo", text: "Modelos prontos e os seus. Escolha na lista ou crie um do zero; o modelo só passa a ser usado nos envios depois de ativado na campanha." },

      // ── Janelas de envio
      { tab: "schedule", anchor: "tab-schedule", title: "Janelas de envio", text: "Os horários em que a campanha pode enviar. Fora deles ela não manda nada — e sem nenhuma janela ela fica pausada, então use \"+ Adicionar janela\" pra criar a primeira." },
      { tab: "schedule", anchor: "sc-window", title: "Início, fim e intervalo", text: "Cada janela tem hora de começar, hora de terminar e quanto tempo esperar entre uma mensagem e a próxima. Dá pra ter vários períodos no mesmo dia." },

      // ── Histórico
      { tab: "history", anchor: "tab-history", title: "Histórico", text: "Tudo que esta campanha já enviou, com data, hora, preço e o link que foi pro grupo." },
    ],
  },
};

// Tour que faz sentido oferecer na tela atual (usado pelo botão de ajuda).
// Só existem dois: dentro de uma campanha, o da campanha; no resto, o do painel.
export function tourForPage(page, hasGroupOpen) {
  return hasGroupOpen ? TOURS.campaign : TOURS.main;
}
