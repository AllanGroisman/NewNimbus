// O laço da lista de cupons, no Chrome do admin.
//
// Duas telas precisam dele: a rodada inteira ("Cupons do ML") e a busca de UMA
// campanha (o "trazer campanha" do teste de palavra). São a mesma varredura — a
// segunda só para mais cedo —, e por isso ela mora aqui e não em nenhuma das duas.
//
// A regra que vale a pena reler antes de mexer: **este arquivo não decide nada**.
// Qual URL abrir, quem ativar e quando parar vem do servidor, a cada página
// (`/ml-cupons/local/*`). Aqui só se abre a página que ele mandou, entrega o modelo
// cru de volta e pede a próxima. As regras caras — teto de páginas, rótulo de
// "Aplicar" repetido entre dois cupons — já estão escritas e testadas lá.
import { paginaDeCupons } from "./coletor";
import {
  adminMlCuponsLocalStart, adminMlCuponsLocalAtivar, adminMlCuponsLocalPagina,
  adminMlCuponsLocalProximas,
} from "./api";

// Devolve { tabId, alvos, resumo, achou, parado, paginas }. A aba fica ABERTA de propósito:
// quem chamou normalmente segue para as vitrines, e fechá-la aqui faria o ML ver
// uma aba nova logo em seguida. Quem chama fecha (`fecharAbaDoColetor`).
export async function percorrerLista({
  procurar = null,
  ativarApenas = null,
  // "Buscar TUDO": manda o servidor soltar o teto de páginas da lista geral. É um
  // flag e não um número porque quem decide o teto é o servidor — ver `startLocalRun`.
  tudo = false,
  // "Tudo o que o ML tiver" (task 20): solta os mesmos três tetos SEM dizer que esta
  // passada é a do botão 3. A diferença não é estética — é o `tudo` que faz o
  // servidor pular a gravação do "última vez" da lista (`resumoDoFim`), para a
  // passada do botão 3 não sobrescrever o balanço do botão 1.
  semTeto = false,
  parou = () => false,
  log = () => {},
  onProgresso = () => {},
} = {}) {
  let alvos = [];
  let resumo = null;
  let achou = false;
  // Quantas páginas da lista foram de fato abertas. Só interessa quando a busca
  // NÃO acha: "varri 13 páginas e não estava lá" é uma resposta; "não achei",
  // sozinho, parece defeito.
  let paginas = 0;

  const inicio = await adminMlCuponsLocalStart(
    procurar ? { procurar }
      : ativarApenas?.length ? { ativarApenas }
        : tudo ? { tudo: true }
          : semTeto ? { semTeto: true }
            : {},
  );
  // As categorias vêm resolvidas do servidor (`categorias`), não da config: "todas
  // as categorias" sem dizer QUAIS foi o que escondeu uma config presa em
  // Brinquedos. `null` na lista é a lista geral, sem filtro.
  const categorias = inicio.categorias || [];
  const verticais = categorias.filter(Boolean);
  const nomeDasCategorias = verticais.length
    ? `a lista geral + carimbo de ${verticais.length} categorias (${verticais.join(", ")})`
    : "a lista geral (sem carimbo de categoria)";

  // Quantas abas abrir. Quem decide é o SERVIDOR, não a config que esta tela leu:
  // é ele que sabe se a rodada clica em "Eu quero" (aí é sempre uma só). O `|| 1`
  // não é enfeite — um servidor antigo, ou um teste que não simula o campo, tem de
  // continuar rodando exatamente como antes.
  const abas = Math.max(1, Number(inicio.paralelo) || 1);

  log("info", procurar
    ? `procurando a campanha ${procurar} numa aba deste Chrome`
    : ativarApenas?.length
      ? `ativando ${ativarApenas.length} cupom(ns) numa aba deste Chrome`
      : `começando: ${nomeDasCategorias}${abas > 1 ? ` — ${abas} páginas por vez` : ""}`);

  // A fila que os trabalhadores consomem, e o freio que o primeiro muro fecha
  // para todos. Mesma forma do pool de vitrines da etapa 2 (`produtosNoChrome.js`)
  // de propósito: quem leu aquele arquivo lê este de graça.
  const fila = [...(inicio.proximas || (inicio.proxima ? [inicio.proxima] : []))];
  const freio = { parado: null };
  const tabIds = [];
  let acabou = false;

  const deveParar = () => {
    if (freio.parado) return true;
    if (parou()) { freio.parado = "Interrompido por você"; return true; }
    return false;
  };

  // Uma página de cada vez por aba, mas com uma pausa entre elas quando há mais de
  // uma aba. O laço nunca teve pausa — com uma aba só ele já era a cadência
  // máxima, e é assim que ele continua. Com várias, rajada é exatamente o padrão
  // que acorda o anti-robô do ML, e a conta é a mesma do Hub de Afiliados.
  const PAUSA_ENTRE_PAGINAS_MS = 900;
  const dormir = (ms) => new Promise(r => setTimeout(r, ms));

  // O que abrir agora: da fila, ou pedindo ao servidor. `proximas` vazio com
  // `fim: false` quer dizer "espere" — a página 1 de uma entrada corre sozinha, e
  // enquanto ela não volta não há o que dar às outras abas. Ler isso como "acabou"
  // faria as abas saírem e o paralelismo virar serial no primeiro instante.
  async function pegar() {
    if (fila.length) return fila.shift();
    if (acabou) return null;
    const r = await adminMlCuponsLocalProximas({ n: 1 });
    if (r.proximas?.length) fila.push(...r.proximas);
    if (r.fim) acabou = true;
    return fila.length ? fila.shift() : (acabou ? null : "espere");
  }

  async function trabalhador(w) {
    // Escalonado: o segundo entra meia pausa depois do primeiro. Não abrir N abas
    // no mesmo instante é metade do que faz o paralelismo passar despercebido.
    if (w > 0) await dormir(Math.round((w * PAUSA_ENTRE_PAGINAS_MS) / abas));
    let tabId = null;
    try {
      for (;;) {
        if (deveParar() || acabou) return;
        const alvo = await pegar();
        if (alvo === null) return;
        if (alvo === "espere") { await dormir(250); continue; }
        if (deveParar()) return;

        onProgresso({ tipo: "pagina-abrindo", pagina: alvo.pagina, grouping: alvo.grouping, aba: w });

        let r = await paginaDeCupons({ url: alvo.url, tabId }, { onProgresso });
        tabId = r.tabId ?? tabId;
        if (r.muro) {
          // O muro é da CONTA, não daquela página: seguir abrindo em outra aba só
          // queima a conta mais rápido, e ela é a mesma do Hub.
          freio.parado = r.motivo || "O Mercado Livre pediu verificação — parei aqui de propósito";
          return;
        }

        // Quem ativar sai do modelo DESTA página, e quem escolhe é o servidor: dois
        // cupons diferentes já apareceram com o mesmo rótulo "Aplicar", e ativar é
        // escrita irreversível na conta. Este ramo só roda com uma aba — quando há
        // alvos, o servidor devolve `paralelo: 1`.
        if (inicio.ativa) {
          const { labels } = await adminMlCuponsLocalAtivar({ grouping: alvo.grouping, props: r.props });
          if (labels.length) {
            onProgresso({ tipo: "ativando", quantos: labels.length, pagina: alvo.pagina });
            const depois = await paginaDeCupons({ tabId, rotulos: labels }, { onProgresso });
            tabId = depois.tabId ?? tabId;
            // A leitura de DEPOIS do clique é a que traz a vitrine do cupom
            // recém-ativado; a de antes não tem `containerUrl`.
            if (depois.props) r = depois;
          }
        }

        const p = await adminMlCuponsLocalPagina({
          grouping: alvo.grouping,
          // A página vai no corpo: com várias em voo, o servidor não tem como
          // adivinhar QUAL delas acabou de voltar.
          pagina: alvo.pagina,
          props: r.props,
          ativados: r.clicados || 0,
          semBotao: (r.semBotao || []).length,
        });
        log("info", `página ${alvo.pagina}${p.de ? `/${p.de}` : ""}${alvo.grouping ? ` de ${alvo.grouping}` : " da lista geral"} · ${p.cupons} cupom(ns)${p.ignoradosLoja ? `, ${p.ignoradosLoja} de loja ignorados` : ""}`);
        // Na ativação (etapa 2) o servidor grava os alvos na página em que apareceram.
        // Dizer isso é o que prova que um Parar daqui pra frente não perde o clique.
        if (p.salvosNestaPagina) {
          log("ok", `💾 ${p.salvosNestaPagina} cupom(ns) do lote gravados (${p.salvosTotal} até aqui)`);
          onProgresso({ tipo: "cupons-salvos", nestaPagina: p.salvosNestaPagina, total: p.salvosTotal });
        }
        // As barras da lista e da ativação (task 18). Quem sabe o "de N" é o servidor:
        // o teto de páginas, a fila de categorias e os alvos são dele.
        if (p.progresso) onProgresso({ tipo: "pagina-lida", ...p.progresso, cupons: p.cupons, aba: w });
        if (p.proximas?.length) fila.push(...p.proximas);
        else if (p.proxima) fila.push(p.proxima);
        if (p.fim === true) acabou = true;
        // Servidor sem `fim` no corpo: ali "não tem próxima" era a única forma de
        // dizer que acabou, e continua sendo. Só o servidor que manda `fim: false`
        // pode pedir que a aba espere — ele é o que sabe distinguir "não tenho
        // página agora" de "a rodada terminou".
        else if (p.fim === undefined && !p.proximas?.length && !p.proxima) acabou = true;
        if (p.achou) achou = true;
        if (Number.isFinite(p.paginasLidas)) paginas = Math.max(paginas, p.paginasLidas);
        // `resumo` chega na última página, junto com a gravação. `alvos` só vem numa
        // BUSCA — na varredura normal os produtos são a etapa 2, num botão separado.
        if (p.resumo) resumo = p.resumo;
        if (p.alvos) alvos = p.alvos;

        if (abas > 1 && !acabou && !deveParar()) {
          await dormir(PAUSA_ENTRE_PAGINAS_MS + Math.floor(Math.random() * 400));
        }
      }
    } finally {
      if (tabId != null) tabIds.push(tabId);
    }
  }

  // `Promise.all` e não um laço: as abas têm de TERMINAR antes de quem chamou
  // avisar o `/local/fim`. Sem isso, uma página que volta depois encontra a rodada
  // já solta.
  await Promise.all(Array.from({ length: abas }, (_, w) => trabalhador(w)));
  const parado = freio.parado;

  // `tabId` continua saindo: quem chamou fecha a aba, e com uma aba só (o caso
  // da ativação e o padrão de hoje) ele é a aba. `abas` é a lista inteira.
  return { tabId: tabIds[0] ?? null, abas: tabIds, alvos, resumo, achou, parado, paginas };
}
