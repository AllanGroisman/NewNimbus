// A rodada dos cupons do ML (as três etapas da aba "Cupons do ML") FORA da tela.
//
// O laço roda no Chrome do admin e demora minutos; a aba (AdminCupomML.jsx) é
// montada do zero toda vez que se troca de aba ou de página (task 6). Com o estado
// da rodada dentro do componente, sair e voltar deixava o laço correndo às cegas:
// sem barra, sem log, sem "Parar" (a ref antiga ficava órfã) e com os botões
// ativos para disparar uma segunda rodada por cima. Aqui o estado vive no módulo,
// que dura enquanto a página estiver aberta — um F5 continua matando a rodada,
// porque o laço é JS desta página.
//
// A tela lê com `useRodadaCupons()`. O store não chama a tela: o que antes era
// `recarregar()` / "fecha o cupom aberto" vira contador (`recargas`, `fins`), e a
// tela reage a ele com um efeito.
import { useSyncExternalStore } from "react";
import { adminMlCuponsLocalFim, adminMlCuponsRodadaFim, errText } from "./api";
import { percorrerLista } from "./rodadaNoChrome";
import { buscarProdutos, buscarTudo } from "./produtosNoChrome";
import { fecharAbaDoColetor } from "./coletor";
import { reduzirAndamento } from "./andamentoColheita";
import { segundos } from "../components/admin/cupomEstilos";

const INICIAL = {
  // A etapa 1 (a varredura da lista) rodando no Chrome do admin.
  rodandoNoChrome: false,
  // A etapa 2 (os produtos). Separado porque os dois botões são independentes.
  buscandoProdutos: false,
  colhendo: null,        // campaignId sendo colhido pelo botão da linha
  // De quem é o painel do "agora": "lista" | "produtos" | "tudo" | null. Não zera
  // quando a rodada acaba, de propósito: o resumo do que acabou de acontecer é a
  // resposta daquele card.
  painelDe: null,
  // O "agora" da colheita, montado evento a evento por `andamentoColheita.js`.
  andamento: null,
  // O que a busca de produtos JÁ GRAVOU, lote a lote — o que um Parar não perde.
  salvo: null,
  // O passo a passo (append-only durante a rodada) e o balanço do fim.
  eventos: [],
  resumoColheita: null,
  // Pedidos à tela: `recargas` = releia status/lista; `fins` = uma rodada acabou
  // (feche o cupom aberto, esqueça os produtos em cache, releia).
  recargas: 0,
  fins: 0,
};

let estado = INICIAL;
const ouvintes = new Set();
// O "Parar". Lido pelo laço a cada volta — por isso não é estado de React.
let parado = false;
// Uma rodada por vez. É flag própria, e não `rodandoNoChrome || buscandoProdutos`,
// porque o botão 3 tem um vão entre a lista e os produtos em que nenhum dos dois
// está ligado.
let emCurso = false;

function set(patch) {
  estado = { ...estado, ...(typeof patch === "function" ? patch(estado) : patch) };
  ouvintes.forEach(f => f());
}

const andar = (evento) => set(e => ({ andamento: reduzirAndamento(e.andamento, evento) }));
const recarregar = () => set(e => ({ recargas: e.recargas + 1 }));
const fim = () => set(e => ({ fins: e.fins + 1 }));
const logar = (tipo, texto) => set(e => ({ eventos: [...e.eventos, { at: new Date().toISOString(), tipo, texto }] }));

// O progresso que vem do laço e da extensão. Todo evento vai cru para o
// `andamento`; aqui fica só o que mexe em outra coisa da tela — o salvo, a
// recarga, e o muro no log (a aba veio para a frente e está esperando o humano).
function avisarMuro(p) {
  andar(p);
  if (p?.tipo === "lote-salvo") {
    set({ salvo: { lotes: p.lotes, de: p.de, vitrines: p.vitrines, produtos: p.produtos, em: p.em } });
    // O contador "Sem produtos ainda" cai ao vivo: é o banco dizendo que gravou.
    recarregar();
  } else if (p?.tipo === "muro") {
    logar("aviso", "o Mercado Livre pediu verificação — resolva na aba que abriu");
  } else if (p?.tipo === "ativou") {
    logar("ok", `ativei “${p.rotulo}”`);
  }
}

function subscribe(f) {
  ouvintes.add(f);
  return () => ouvintes.delete(f);
}

export function useRodadaCupons() {
  return useSyncExternalStore(subscribe, () => estado);
}

export function parar() {
  parado = true;
}

// Só para os testes: o módulo dura a suíte inteira, e um teste herdaria a rodada
// do outro.
export function _zerarParaTestes() {
  estado = INICIAL;
  parado = false;
  emCurso = false;
  ouvintes.forEach(f => f());
}

// Uma rodada por vez: o segundo clique (ou a agenda) numa rodada em curso não faz
// nada. Os botões já ficam desabilitados; isto é a rede para o que escapar.
const exclusiva = (fn) => async (...args) => {
  if (emCurso) return undefined;
  emCurso = true;
  try { return await fn(...args); } finally { emCurso = false; }
};

// ETAPA 1 — a lista de cupons e as condições de cada um.
//
// Leitura pura: abre `/cupons/filter?all=true&page=N` numa aba deste Chrome,
// página a página, e no fim grava. Nenhum clique em "Eu quero".
//
// O laço mora em `rodadaNoChrome.js` porque a busca de UMA campanha (o "trazer
// campanha" do teste de palavra) é a mesma varredura. Aqui fica o log e o resumo.
//
// `tudo` solta o teto de páginas da lista geral (quem decide o número é o
// servidor). `resumir: false` é o encadeamento do botão 3: o resumo de lá é o dos
// dois passos somados, e escrever este por cima faria a tela piscar um balanço que
// some meio segundo depois.
async function varrerLista({ tudo = false, semTeto = false, resumir = true } = {}) {
  parado = false;
  set({ rodandoNoChrome: true });
  // `resumir: false` é o botão 3 chamando esta etapa por dentro: o card dono do
  // painel continua sendo o dele, e não o do botão 1.
  if (resumir) {
    set({ painelDe: "lista", eventos: [], resumoColheita: null });
    andar({ tipo: "reiniciar" });
  }
  const t0 = Date.now();
  // Uma aba por trabalhador (task 21): com `paginasDeListaEmParalelo` em 1 é a
  // mesma aba única de sempre, e aí esta lista tem um item só.
  let abas = [];
  let resumoLista;
  let interrompida;

  try {
    const r = await percorrerLista({
      tudo,
      semTeto,
      parou: () => parado,
      log: logar,
      onProgresso: avisarMuro,
    });
    abas = r.abas || (r.tabId != null ? [r.tabId] : []);
    resumoLista = r.resumo;
    interrompida = r.parado;
  } catch (err) {
    interrompida = errText(err, "A varredura no seu Chrome parou com um erro.");
    logar("erro", interrompida);
  } finally {
    // `id => ...` e não a função direto: `map` passa (item, índice, lista), e o
    // índice viraria o segundo argumento de quem fecha a aba.
    await Promise.all(abas.map(id => fecharAbaDoColetor(id)));
    // O fim é sempre chamado: sem ele o servidor ficaria com a varredura
    // "rodando", e a próxima e o "Apagar todos" ficariam recusando até o
    // processo reiniciar.
    await adminMlCuponsLocalFim({ cancelada: !!interrompida }).catch(() => {});
    set({ rodandoNoChrome: false });
    if (resumir) andar({ tipo: "encerrar" });
    fim();
  }

  logar(interrompida ? "aviso" : "ok",
    `${interrompida ? `${interrompida}. ` : ""}${resumoLista?.cupons ?? 0} cupom(ns) na lista`);
  if (!resumir) return { parado: interrompida, resumo: resumoLista };
  set({
    resumoColheita: {
      botao: "lista",
      titulo: interrompida ? "Varredura interrompida" : "Varredura terminada",
      tom: interrompida ? "aviso" : "ok",
      nota: interrompida
        ? `${interrompida}. O que já entrou está gravado — é só rodar de novo.`
        : semTeto
          ? "Sem teto: parei onde o ML disse que a lista acaba. Os produtos de cada cupom são o próximo botão."
          : "Os produtos de cada cupom são o próximo botão — ele é separado porque precisa ativar cupom na sua conta do ML.",
      numeros: [
        { label: "Cupons na lista", valor: resumoLista?.cupons ?? 0 },
        { label: "Novos", valor: resumoLista?.novos ?? 0 },
        { label: "Atualizados", valor: resumoLista?.atualizados ?? 0 },
        { label: "De loja ignorados", valor: resumoLista?.cuponsDeLojaIgnorados ?? 0 },
        { label: "Duração", valor: segundos(Date.now() - t0) },
      ],
    },
  });
  return { parado: interrompida, resumo: resumoLista };
}

export const rodarLista = exclusiva(({ semTeto = false } = {}) => varrerLista({ semTeto }));

// ETAPA 2 — os produtos. `campaignIds` null = todos os que faltam; com um id, é
// o botão da linha. O laço (ativar → raspar) mora em `produtosNoChrome.js`, que é
// o mesmo dos dois casos.
export const rodarProdutos = exclusiva(async ({ campaignIds = null, soSemProdutos = false } = {}) => {
  const umSo = campaignIds?.length === 1;
  parado = false;
  // Inclusive o botão da linha da tabela: ele não é o botão 2 para efeito de
  // "última vez" (ver o `rodadaFim` lá embaixo), mas o que ele faz É buscar
  // produtos, e o card da etapa 2 é o único lugar da tela onde esse progresso tem
  // casa. Mandá-lo para lugar nenhum era a busca terminar sem dizer no que deu.
  set({
    buscandoProdutos: true,
    painelDe: "produtos",
    colhendo: umSo ? campaignIds[0] : null,
    salvo: null,
    eventos: [],
    resumoColheita: null,
  });
  andar({ tipo: "reiniciar" });
  const t0 = Date.now();
  let r = { feitos: [], ativados: 0, parado: null };

  try {
    r = await buscarProdutos({
      campaignIds,
      // O botão da linha é pedido explícito por aquele cupom: o filtro não vale.
      soSemProdutos: campaignIds?.length ? false : soSemProdutos,
      parou: () => parado,
      log: logar,
      onProgresso: avisarMuro,
    });
  } catch (err) {
    r.parado = errText(err, "A busca de produtos parou com um erro.");
    logar("erro", r.parado);
  } finally {
    set({ buscandoProdutos: false, colhendo: null });
    andar({ tipo: "encerrar" });
    fim();
  }

  const ok = r.feitos.filter(f => f.ok);
  const vazios = r.feitos.filter(f => !f.ok && f.vazia).length;
  const falhas = r.feitos.filter(f => !f.ok && !f.vazia).length;
  const produtosTotal = ok.reduce((n, f) => n + (f.produtos || 0), 0);
  const parciais = ok.filter(f => f.parcial).length;
  // O botão da linha é um cupom escolhido a dedo, não o botão 2: não vira o
  // "última vez" dele.
  if (!umSo) {
    adminMlCuponsRodadaFim({
      botao: "produtos",
      duracaoMs: Date.now() - t0,
      interrompida: !!r.parado,
      erro: r.parado || null,
      resultado: {
        lotes: r.lotes || 0, ativados: r.ativados, tentados: r.feitos.length, colhidos: ok.length,
        produtos: produtosTotal, parciais, vazias: vazios, falharam: falhas,
      },
    }).then(recarregar, () => {});
  }
  logar(r.parado ? "aviso" : "ok",
    `${r.parado ? `${r.parado}. ` : ""}${ok.length} de ${r.feitos.length} vitrine(s) colhida(s), ${produtosTotal} produto(s)`);
  set({
    resumoColheita: {
      botao: "produtos",
      titulo: r.parado ? "Busca de produtos interrompida" : "Busca de produtos terminada",
      tom: r.parado || falhas ? "aviso" : "ok",
      nota: r.parado
        ? `${r.parado}. Ficou gravado: ${ok.length} vitrine(s) e ${produtosTotal} produto(s)${r.lotes ? ` (${r.lotes} lote(s) completos)` : ""}. Os que ficaram de fora continuam na fila — é só rodar de novo.`
        : parciais
          ? `${parciais} vitrine(s) vieram parciais: entram como prévia, não como lista fechada.`
          : null,
      numeros: [
        { label: "Lotes salvos", valor: r.lotes || 0 },
        { label: "Cupons ativados", valor: r.ativados },
        { label: "Tentados", valor: r.feitos.length },
        { label: "Colhidos", valor: ok.length },
        { label: "Produtos gravados", valor: produtosTotal },
        { label: "…destas, parciais", valor: parciais },
        { label: "Vitrine vazia", valor: vazios },
        { label: "Falharam", valor: falhas },
        { label: "Duração", valor: segundos(Date.now() - t0) },
      ],
      colunas: r.feitos.length ? ["Cupom", "Produtos", "Desfecho"] : null,
      linhas: r.feitos.map(f => [
        f.title || f.campaignId,
        f.ok ? f.produtos : "—",
        f.ok
          ? (f.parcial ? "colhida (parcial)" : "colhida")
          : (f.vazia ? `vitrine vazia${f.erro ? ` — ${f.erro}` : ""}` : f.erro),
      ]),
    },
  });
});

// O "buscar TUDO": a etapa 1 sem teto de páginas e depois a etapa 2 em ciclos,
// até a fila esvaziar. É um botão só porque a pergunta que ele responde é uma só
// ("traz tudo"), e porque parar no meio das duas etapas deixa cupom guardado sem
// produto nenhum — que é exatamente o estado que ele existe para desfazer.
export const rodarTudo = exclusiva(async ({ soSemProdutos = false } = {}) => {
  parado = false;
  set({ painelDe: "tudo", eventos: [], resumoColheita: null });
  andar({ tipo: "reiniciar" });
  const t0 = Date.now();

  // `tudo: true` já implica o "sem teto" no servidor — e continua sendo outra
  // coisa: é ele que diz que esta passada é a do botão 3.
  const lista = await varrerLista({ tudo: true, resumir: false });
  if (lista?.parado || parado) {
    andar({ tipo: "encerrar" });
    adminMlCuponsRodadaFim({
      botao: "tudo",
      duracaoMs: Date.now() - t0,
      interrompida: true,
      erro: `${lista?.parado || "Interrompido por você"} (ainda na lista)`,
      resultado: { cuponsNaLista: lista?.resumo?.cupons ?? 0 },
    }).then(recarregar, () => {});
    set({
      resumoColheita: {
        botao: "tudo",
        titulo: "Interrompido na lista",
        tom: "aviso",
        nota: `${lista?.parado || "Interrompido por você"}. Os cupons que já entraram estão gravados; os produtos ficaram para o botão 2.`,
        numeros: [{ label: "Cupons na lista", valor: lista?.resumo?.cupons ?? 0 }],
      },
    });
    return;
  }

  // O servidor avisa quando a lista geral parou no teto de páginas em vez de no
  // fim que o ML declarou. Num "buscar TUDO" isso não pode ficar só numa linha do
  // meio do log: é a diferença entre "trouxe tudo" e "trouxe o que coube".
  const teto = (lista?.resumo?.avisos || []).find(a => /teto de \d+ p[áa]ginas/i.test(a)) || null;

  set({ buscandoProdutos: true, salvo: null });
  let r = { ciclos: 0, feitos: [], ativados: 0, parado: null, motivo: null };
  try {
    r = await buscarTudo({
      soSemProdutos,
      parou: () => parado,
      log: logar,
      onCiclo: ({ ciclo, maxCiclos }) => andar({ tipo: "ciclo", ciclo, maxCiclos }),
      onProgresso: avisarMuro,
    });
  } catch (err) {
    r.parado = errText(err, "A busca em ciclos parou com um erro.");
    logar("erro", r.parado);
  } finally {
    set({ buscandoProdutos: false });
    andar({ tipo: "encerrar" });
    fim();
  }

  const ok = r.feitos.filter(f => f.ok);
  const produtosTotal = ok.reduce((n, f) => n + (f.produtos || 0), 0);
  // Os que foram tentados e não vieram. Precisam aparecer: o contador "(N)" do
  // botão 2 NÃO vai zerar por causa deles, e sem essa linha parece que o "até
  // acabar" desistiu no meio.
  const sobraram = r.feitos.filter(f => !f.ok);
  adminMlCuponsRodadaFim({
    botao: "tudo",
    duracaoMs: Date.now() - t0,
    interrompida: !!r.parado,
    erro: [teto, r.motivo ? `Parou porque ${r.motivo}.` : null].filter(Boolean).join(" ") || null,
    resultado: {
      cuponsNaLista: lista?.resumo?.cupons ?? 0, ciclos: r.ciclos, lotes: r.lotes || 0,
      ativados: r.ativados, colhidos: ok.length, produtos: produtosTotal, ficaramDeFora: sobraram.length,
    },
  }).then(recarregar, () => {});
  set({
    resumoColheita: {
      botao: "tudo",
      titulo: r.parado ? "Buscar tudo — interrompido" : "Buscar tudo — terminado",
      tom: r.parado || teto ? "aviso" : "ok",
      nota: [
        teto,
        r.motivo ? `Parou porque ${r.motivo}.` : null,
        sobraram.length ? `${sobraram.length} cupom(ns) foram tentados e não deram vitrine — eles continuam contando no botão 2.` : null,
      ].filter(Boolean).join(" ") || null,
      numeros: [
        { label: "Cupons na lista", valor: lista?.resumo?.cupons ?? 0 },
        { label: "Ciclos", valor: r.ciclos },
        { label: "Lotes salvos", valor: r.lotes || 0 },
        { label: "Cupons ativados", valor: r.ativados },
        { label: "Vitrines colhidas", valor: ok.length },
        { label: "Produtos gravados", valor: produtosTotal },
        { label: "Ficaram de fora", valor: sobraram.length },
        { label: "Duração", valor: segundos(Date.now() - t0) },
      ],
      colunas: sobraram.length ? ["Cupom", "Desfecho"] : null,
      linhas: sobraram.map(f => [
        f.title || f.campaignId,
        f.vazia ? `vitrine vazia${f.erro ? ` — ${f.erro}` : ""}` : f.erro,
      ]),
    },
  });
});

// A agenda dispara `logar` na tela logo depois de disparar a rodada.
export { logar as logarNaRodada };
