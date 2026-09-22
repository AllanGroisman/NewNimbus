// O andamento de uma colheita de cupons, montado a partir dos eventos do laço.
//
// Antes a tela tinha UMA linha de texto que cada evento sobrescrevia: dava pra ver
// que algo acontecia, nunca quanto faltava nem por que a tela ficava parada nas
// pausas. Aqui os mesmos eventos (`produtosNoChrome.js`, `rodadaNoChrome.js`) viram
// um estado só — etapa, fila, lote, cupom da vez, contadores — que o
// `ProgressoColheita` desenha. Função pura para poder ser testada sem a tela.

// O que cada etapa FAZ, em palavras de quem olha a tela. É a explicação fixa que
// fica embaixo do título do painel.
export const EXPLICACAO = {
  lista: "Lendo a lista de cupons do Mercado Livre, página a página — só leitura, não mexe na sua conta.",
  ativando: "Clicando em “Eu quero” nos cupons do lote: o ML só mostra a vitrine de um cupom depois disso.",
  vitrine: "Abrindo a vitrine do cupom numa aba e lendo os produtos página a página. Cada vitrine é gravada assim que termina.",
  pausa: "Pausa de propósito entre uma aba e outra: abrir tudo de uma vez acorda o anti-robô do ML.",
  muro: "O Mercado Livre pediu verificação. Resolva na aba que veio para a frente — a busca parou aqui para não queimar a conta.",
  preparando: "Perguntando ao servidor quais cupons ainda estão sem produtos.",
};

export const ROTULO = {
  lista: "Lendo a lista de cupons",
  ativando: "Ativando cupons",
  vitrine: "Lendo vitrines",
  pausa: "Em pausa",
  muro: "Parado na verificação do ML",
  preparando: "Preparando",
};

const contagemZerada = () => ({ colhidas: 0, parciais: 0, vazias: 0, falhas: 0, produtos: 0, ativados: 0 });

export function andamentoInicial(agora = Date.now()) {
  return {
    etapa: "preparando",
    inicio: agora,
    ciclo: null,
    maxCiclos: null,
    // `encerrados` é quantos da fila já tiveram o lote aberto — um cupom que a
    // ativação não fez ganhar vitrine nunca dá `vitrine-feita`, e sem isto o
    // "X de N" terminaria o lote sem chegar em N.
    fila: null,          // { total, feitos, encerrados, aAtivar, prontos }
    lote: null,          // { k, de }
    atual: null,         // { title, i, de, pagina, produtos, maxPaginas, maxProdutos }
    // As vitrines ABERTAS agora, por campaignId (task 14: várias ao mesmo tempo).
    // `atual` continua sendo a última aberta, para quem só mostra uma.
    atuais: {},
    // A ativação do próximo lote correndo em segundo plano, enquanto este colhe.
    // Fica fora da `etapa` de propósito: senão o painel pularia de "vitrine" para
    // "ativando" e de volta a cada página da lista.
    ativacaoFundo: null, // { lote, pagina, n, vistos, total }
    // A ativação na frente: quantos cupons do lote já apareceram na lista (task 18).
    // É o aparecer que encerra a passada, não o fim das páginas.
    ativacao: null,      // { total, vistos, pagina }
    paralelo: 1,
    // `de` e o resto chegam no `pagina-lida`, depois que o servidor viu a página.
    // `abertas` são as páginas em voo agora, por aba (task 21) — o análogo do
    // `atuais` das vitrines. `emVoo` é quantas o SERVIDOR ainda espera.
    lista: null,         // { pagina, grouping, nome, de, lidas, categoria, categorias, carimbo, cupons, abertas, emVoo }
    pausa: null,         // { ate, ms, motivo }
    // A ativação de um lote É uma passada pela lista do ML (`percorrerLista` com
    // `ativarApenas`), e ela anuncia `pagina-abrindo` como a etapa 1. Sem esta
    // marca o painel diria "lendo a lista" no meio dos cliques em "Eu quero".
    ativandoLote: false,
    contagem: contagemZerada(),
    // Para a estimativa: quando o primeiro cupom desta fila começou e quantos
    // terminaram desde então.
    medidos: { desde: null, n: 0 },
    maxPaginas: null,
    maxProdutos: null,
  };
}

export function reduzirAndamento(estado, evento) {
  if (!evento || !evento.tipo) return estado;
  if (evento.tipo === "reiniciar") return andamentoInicial(evento.agora);
  if (evento.tipo === "encerrar") return null;
  const e = estado || andamentoInicial(evento.agora);
  const agora = evento.agora ?? Date.now();

  if (evento.fundo) return reduzirFundo(e, evento);
  if (evento.tipo === "ativacao-fundo-fim") return { ...e, ativacaoFundo: null };

  switch (evento.tipo) {
    case "ciclo":
      return { ...e, ciclo: evento.ciclo, maxCiclos: evento.maxCiclos ?? e.maxCiclos, etapa: "preparando", pausa: null };

    case "pagina-abrindo": {
      const grouping = evento.grouping || null;
      if (e.ativandoLote) return { ...e, etapa: "ativando", pausa: null };
      // Só se registra QUE abriu, e em qual aba. A tela não infere mais nada daqui
      // — nem "a fila andou uma casa", que ela deduzia de o grouping ter mudado.
      // Com várias abas (task 21) dois groupings intercalam eventos, e aquele
      // palpite disparava a cada alternância, corrompendo a barra de fila. Quem
      // sabe em que entrada a rodada está é o servidor, e ele diz no `pagina-lida`.
      const abertas = { ...e.lista?.abertas, [evento.aba ?? 0]: { grouping, pagina: evento.pagina } };
      const antes = e.lista || { lidas: 0 };
      return { ...e, etapa: "lista", pausa: null, lista: { ...antes, pagina: evento.pagina, grouping, abertas } };
    }

    // O servidor leu a página: é daqui que vêm os totais das barras (task 18).
    case "pagina-lida": {
      if (e.ativandoLote) {
        const total = evento.alvos?.total ?? e.ativacao?.total ?? null;
        return { ...e, ativacao: { total, vistos: evento.alvos?.vistos ?? e.ativacao?.vistos ?? 0, pagina: evento.pagina } };
      }
      // A aba que acabou de ler some das abertas. `lidas` vem do servidor, que
      // conta páginas CONCLUÍDAS — o número da página não serve de progresso
      // quando várias estão em voo, porque a 9 volta antes da 7.
      const abertas = { ...e.lista?.abertas };
      delete abertas[evento.aba ?? 0];
      return {
        ...e,
        lista: {
          pagina: evento.pagina, grouping: evento.grouping ?? null, nome: evento.nome ?? null,
          de: evento.de ?? null, lidas: evento.pagina,
          categoria: evento.categoria ?? null, categorias: evento.categorias ?? null,
          carimbo: evento.carimbo ?? null, cupons: evento.cupons ?? null,
          abertas, emVoo: evento.emVoo ?? 0,
        },
      };
    }

    case "fila":
      return {
        ...e,
        etapa: "preparando",
        pausa: null,
        fila: { total: evento.total, feitos: 0, encerrados: 0, aAtivar: evento.aAtivar || 0, prontos: evento.prontos || 0 },
        lote: null,
        atual: null,
        atuais: {},
        paralelo: evento.paralelo || 1,
        medidos: { desde: null, n: 0 },
        maxPaginas: evento.maxPaginas ?? null,
        maxProdutos: evento.maxProdutos ?? null,
      };

    case "lote": {
      const fila = e.fila
        ? { ...e.fila, feitos: Math.max(e.fila.feitos, e.fila.encerrados), encerrados: e.fila.encerrados + (evento.tamanho || 0) }
        : null;
      return { ...e, fila, lote: { k: evento.k, de: evento.de }, pausa: null, ativandoLote: false, ativacao: null };
    }

    // Vem de dois lugares: o `umCiclo` anuncia o lote a ativar (`n`), e a passada
    // pela lista anuncia os cliques de cada página (`quantos`). Só o anúncio do
    // lote traz `n`, então só ele zera a barra da ativação.
    case "ativando":
      return {
        ...e, etapa: "ativando", pausa: null, atual: null, ativandoLote: true,
        ativacao: evento.n != null ? { total: evento.n, vistos: 0, pagina: null } : e.ativacao,
      };

    case "ativou":
      return { ...e, contagem: { ...e.contagem, ativados: e.contagem.ativados + 1 } };

    case "vitrine-abrindo": {
      const atual = { campaignId: evento.campaignId, title: evento.title, i: evento.i, de: evento.de, pagina: 0, produtos: 0 };
      return {
        ...e,
        etapa: "vitrine",
        pausa: null,
        ativandoLote: false,
        ativacao: null,
        atual,
        atuais: evento.campaignId ? { ...(e.atuais || {}), [evento.campaignId]: atual } : (e.atuais || {}),
        medidos: e.medidos.desde == null ? { desde: agora, n: 0 } : e.medidos,
      };
    }

    case "pagina": {
      if (e.etapa === "lista" || e.etapa === "ativando") return e;
      const id = evento.campaignId;
      const atuais = e.atuais || {};
      if (id && atuais[id]) {
        const um = { ...atuais[id], pagina: evento.pagina, produtos: evento.produtos };
        return { ...e, atuais: { ...atuais, [id]: um }, atual: e.atual?.campaignId === id ? um : e.atual };
      }
      return { ...e, atual: { ...(e.atual || {}), pagina: evento.pagina, produtos: evento.produtos } };
    }

    case "vitrine-feita": {
      const c = { ...e.contagem };
      if (evento.ok) {
        c.colhidas++;
        c.produtos += evento.produtos || 0;
        if (evento.parcial) c.parciais++;
      } else if (evento.vazia) c.vazias++;
      else c.falhas++;
      const fila = e.fila ? { ...e.fila, feitos: Math.min(e.fila.total, e.fila.feitos + 1) } : null;
      const atuais = { ...(e.atuais || {}) };
      if (evento.campaignId) delete atuais[evento.campaignId];
      // A que terminou sai do "agora"; se ainda há outra aberta, ela passa a ser a vez.
      const restantes = Object.values(atuais);
      const atual = e.atual?.campaignId && e.atual.campaignId === evento.campaignId
        ? (restantes.at(-1) || e.atual)
        : e.atual;
      return { ...e, contagem: c, fila, atuais, atual, medidos: { ...e.medidos, n: e.medidos.n + 1 } };
    }

    case "lote-salvo":
      // Lote terminado inteiro: quem dele não deu vitrine também acabou.
      if (!evento.completo || !e.fila) return e;
      return { ...e, fila: { ...e.fila, feitos: Math.max(e.fila.feitos, e.fila.encerrados) } };

    case "pausa":
      return { ...e, etapa: "pausa", pausa: { ate: agora + (evento.ms || 0), ms: evento.ms || 0, motivo: evento.motivo || null } };

    case "muro":
      return { ...e, etapa: "muro", pausa: null };

    default:
      return e;
  }
}

// Os eventos da ativação em SEGUNDO PLANO (`fundo: true`, ver produtosNoChrome.js).
// Contam cliques e muro como qualquer outro, mas não mexem na etapa nem na vitrine
// da vez — quem está na frente é a colheita.
function reduzirFundo(e, evento) {
  const atual = e.ativacaoFundo || { lote: evento.loteFundo || null, pagina: null, n: null };
  switch (evento.tipo) {
    case "ativando":
      return { ...e, ativacaoFundo: { ...atual, lote: evento.loteFundo ?? atual.lote, n: evento.n ?? atual.n } };
    case "pagina-abrindo":
      return { ...e, ativacaoFundo: { ...atual, pagina: evento.pagina } };
    case "pagina-lida":
      return {
        ...e,
        ativacaoFundo: {
          ...atual,
          total: evento.alvos?.total ?? atual.total ?? atual.n ?? null,
          vistos: evento.alvos?.vistos ?? atual.vistos ?? 0,
        },
      };
    case "ativou":
      return { ...e, ativacaoFundo: atual, contagem: { ...e.contagem, ativados: e.contagem.ativados + 1 } };
    case "muro":
      return { ...e, etapa: "muro", pausa: null, ativacaoFundo: atual };
    default:
      return e;
  }
}

// Quanto falta, pela média dos cupons já terminados nesta fila. `null` enquanto não
// há medida que preste (menos de 2 cupons): uma estimativa de um cupom só pula de
// 10 segundos para 20 minutos e desinforma mais do que ajuda.
export function estimativaMs(estado, agora = Date.now()) {
  if (!estado?.fila || estado.medidos.desde == null || estado.medidos.n < 2) return null;
  const faltam = estado.fila.total - estado.fila.feitos;
  if (faltam <= 0) return 0;
  const porCupom = (agora - estado.medidos.desde) / estado.medidos.n;
  return Math.round(porCupom * faltam);
}

export function duracao(ms) {
  if (ms == null || !Number.isFinite(ms)) return "—";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}min ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}min`;
}
