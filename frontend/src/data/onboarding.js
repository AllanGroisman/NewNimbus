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
      { anchor: "help-button", title: "Ajuda a qualquer hora", text: "Este botão está sempre no canto: ele oferece o tour da tela em que você está e leva pros tutoriais." },
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
      { tab: "overview", anchor: "tab-overview", title: "Visão geral", text: "É o resumo da campanha, pra bater o olho e ver se está rodando. Não se configura nada aqui." },
      { tab: "overview", anchor: "ov-stats", title: "Os números do topo", text: "Quantas mensagens saíram hoje e na semana, quantos produtos estão esperando na fila (só o total) e a hora do último envio." },
      { tab: "overview", anchor: "ov-last-sent", title: "Últimos produtos enviados", text: "Os últimos que já foram pros grupos. Pra ver quais ainda estão esperando pra sair, a aba é a Fila." },

      // ── Gerenciar
      { tab: "manage", anchor: "tab-manage", title: "Gerenciar", text: "O nome da campanha e a espera pra repetir um produto. As lojas e as categorias ficam na aba Busca de Produtos." },
      { tab: "manage", anchor: "mg-info", title: "Nome da campanha", text: "Só o apelido que aparece no menu e nos avisos. Pode trocar quando quiser." },
      { tab: "manage", anchor: "mg-sources", title: "As lojas do repasse", text: "De quais lojas os links postados nos grupos líderes podem ser repassados. Link de outra loja é ignorado." },
      { tab: "manage", anchor: "mg-cooldown", title: "Espera pra repetir um produto", text: "Quanto tempo um produto já enviado tem que esperar pra poder ir de novo — é o que evita repetir a mesma oferta no grupo." },
      { tab: "manage", anchor: "mg-save", title: "Salvar", text: "O que você mudou nesta aba só passa a valer depois de clicar aqui. O botão acende quando tem algo pra salvar." },

      // ── Busca de produtos / Repasse
      { tab: "products", anchor: "tab-products", title: "De onde vêm os produtos", text: "Numa campanha de busca, é aqui que você diz o que procurar no catálogo. Numa de repasse, é onde escolhe os grupos líderes que vão ser copiados. Colar um link na mão não é aqui — isso fica na aba Fila." },
      { tab: "products", anchor: "pr-leader", title: "Grupos líderes", text: "Os grupos que o sistema fica escutando: todo link de produto postado neles é capturado e re-afiliado com a sua tag. Quantos você pode ter depende do seu plano." },
      { tab: "products", anchor: "pr-where", title: "Onde buscar", text: "As lojas e as categorias que esta campanha vasculha. Aparecem só as categorias ligadas; o botão \"Adicionar categoria\" abre a lista pra marcar mais, até o limite do seu plano." },
      { tab: "products", anchor: "pr-queue", title: "Preenchimento automático", text: "A chave liga e desliga o preenchimento sozinho. Em \"Configurar\" você escolhe quando ele acontece — quando a fila estiver acabando ou em horários fixos do dia —, quantos produtos entram por vez e em que ordem." },
      { tab: "products", anchor: "pr-run", title: "Preencher fila agora", text: "Salva as escolhas e completa a fila na hora, sem esperar o horário. Bom pra testar se os filtros não ficaram apertados demais." },
      { tab: "products", anchor: "pr-search", title: "Busca por palavras-chave", text: "As palavras que o produto precisa ter no nome. Vários termos separados por vírgula; vazio traz tudo das categorias marcadas." },
      { tab: "products", anchor: "pr-filters", title: "Filtros", text: "Este botão abre faixa de preço, desconto mínimo, avaliação e vendas. Produto que não passa em todos é ignorado." },
      { tab: "products", anchor: "pr-results", title: "Os produtos encontrados", text: "A lista que os filtros trazem, na mesma ordem que o preenchimento usa. Dá pra mandar um produto específico pra fila pelo botão do card, e as duas chaves escondem o que já foi enviado há pouco e o que já está na fila." },
      { tab: "products", anchor: "pr-pending", title: "Aguardando revisão", text: "No repasse, os links capturados param aqui até você aprovar ou rejeitar. Numa campanha de busca isso só aparece se sobrou algo da revisão antiga." },

      // ── Fila
      { tab: "queue", anchor: "tab-queue", title: "Fila", text: "A ordem de quem vai ser enviado — é aqui que você vê o que está esperando pra sair." },
      { tab: "queue", anchor: "qu-list", title: "A fila em ordem", text: "O de cima é o próximo. Dá pra arrastar pra reordenar, tirar da fila ou mandar um produto furar a fila." },
      { tab: "queue", anchor: "qu-manual-add", title: "Adicionar um link na mão", text: "Cole o link de um produto e ele entra na fila, mesmo que a busca não tenha encontrado. Esta é a opção que faz isso." },
      { tab: "queue", anchor: "qu-send-now", title: "Enviar agora", text: "Manda o próximo da fila na hora, sem esperar o horário. O intervalo recomeça a contar a partir daí." },

      // ── Grupos
      { tab: "whatsapp", anchor: "tab-whatsapp", title: "Grupos", text: "Os grupos do WhatsApp que recebem as ofertas desta campanha. Sem grupo aqui, não tem pra quem enviar." },
      { tab: "whatsapp", anchor: "wg-add", title: "Adicionar um grupo", text: "Cria um grupo novo ou vincula um que já existe, usando um dos números que você conectou." },
      { tab: "whatsapp", anchor: "wg-list", title: "Situação de cada grupo", text: "A bolinha diz se o grupo está conectado. Aqui você vê membros, envios de hoje e o último envio." },

      // ── Modelos de mensagem
      { tab: "messages", anchor: "tab-messages", title: "Modelos de mensagem", text: "É onde você escolhe como vai ser a mensagem enviada nos grupos: o texto que acompanha cada oferta." },
      { tab: "messages", anchor: "ms-picker", title: "Escolher o modelo", text: "Modelos prontos e os seus. Escolha na lista, ou use \"+ Novo modelo\" pra criar um do zero." },
      { tab: "messages", anchor: "ms-vars", title: "Campos automáticos", text: "Clique num destes pra inserir um campo que o sistema preenche na hora do envio: nome, preço, desconto, link." },
      { tab: "messages", anchor: "ms-editor", title: "Escrever e conferir", text: "Você digita à esquerda e vê à direita como a mensagem vai chegar no WhatsApp." },
      { tab: "messages", anchor: "ms-activate", title: "Ativar na campanha", text: "O modelo só passa a ser usado nos envios depois de ativado — e as edições precisam ser salvas." },

      // ── Janelas de envio
      { tab: "schedule", anchor: "tab-schedule", title: "Janelas de envio", text: "Os horários em que a campanha pode enviar. Fora deles, ela não manda nada." },
      { tab: "schedule", anchor: "sc-window", title: "Início, fim e intervalo", text: "Cada janela tem hora de começar, hora de terminar e quanto tempo esperar entre uma mensagem e a próxima." },
      { tab: "schedule", anchor: "sc-add", title: "Mais de uma janela", text: "Dá pra ter vários períodos no mesmo dia — de manhã e no fim da tarde, por exemplo." },

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
