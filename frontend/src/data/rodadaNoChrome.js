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
  parou = () => false,
  log = () => {},
  onProgresso = () => {},
} = {}) {
  let tabId = null;
  let alvos = [];
  let resumo = null;
  let achou = false;
  let parado = null;
  // Quantas páginas da lista foram de fato abertas. Só interessa quando a busca
  // NÃO acha: "varri 13 páginas e não estava lá" é uma resposta; "não achei",
  // sozinho, parece defeito.
  let paginas = 0;

  const inicio = await adminMlCuponsLocalStart(
    procurar ? { procurar } : (ativarApenas?.length ? { ativarApenas } : (tudo ? { tudo: true } : {})),
  );
  // As categorias vêm resolvidas do servidor (`categorias`), não da config: "todas
  // as categorias" sem dizer QUAIS foi o que escondeu uma config presa em
  // Brinquedos. `null` na lista é a lista geral, sem filtro.
  const categorias = inicio.categorias || [];
  const verticais = categorias.filter(Boolean);
  const nomeDasCategorias = verticais.length
    ? `a lista geral + carimbo de ${verticais.length} categorias (${verticais.join(", ")})`
    : "a lista geral (sem carimbo de categoria)";
  log("info", procurar
    ? `procurando a campanha ${procurar} numa aba deste Chrome`
    : ativarApenas?.length
      ? `ativando ${ativarApenas.length} cupom(ns) numa aba deste Chrome`
      : `começando: ${nomeDasCategorias}`);

  let proxima = inicio.proxima;
  while (proxima) {
    if (parou()) { parado = "Interrompido por você"; break; }
    onProgresso({ tipo: "pagina-abrindo", pagina: proxima.pagina, grouping: proxima.grouping });

    let r = await paginaDeCupons({ url: proxima.url, tabId }, { onProgresso });
    tabId = r.tabId ?? tabId;
    if (r.muro) { parado = r.motivo || "O Mercado Livre pediu verificação — parei aqui de propósito"; break; }

    // Quem ativar sai do modelo DESTA página, e quem escolhe é o servidor: dois
    // cupons diferentes já apareceram com o mesmo rótulo "Aplicar", e ativar é
    // escrita irreversível na conta.
    if (inicio.ativa) {
      const { labels } = await adminMlCuponsLocalAtivar({ grouping: proxima.grouping, props: r.props });
      if (labels.length) {
        onProgresso({ tipo: "ativando", quantos: labels.length, pagina: proxima.pagina });
        const depois = await paginaDeCupons({ tabId, rotulos: labels }, { onProgresso });
        tabId = depois.tabId ?? tabId;
        // A leitura de DEPOIS do clique é a que traz a vitrine do cupom
        // recém-ativado; a de antes não tem `containerUrl`.
        if (depois.props) r = depois;
      }
    }

    const p = await adminMlCuponsLocalPagina({
      grouping: proxima.grouping,
      props: r.props,
      ativados: r.clicados || 0,
      semBotao: (r.semBotao || []).length,
    });
    log("info", `página ${proxima.pagina}${p.de ? `/${p.de}` : ""}${proxima.grouping ? ` de ${proxima.grouping}` : " da lista geral"} · ${p.cupons} cupom(ns)${p.ignoradosLoja ? `, ${p.ignoradosLoja} de loja ignorados` : ""}`);
    proxima = p.proxima;
    achou = !!p.achou;
    if (Number.isFinite(p.paginasLidas)) paginas = p.paginasLidas;
    // `resumo` chega na última página, junto com a gravação. `alvos` só vem numa
    // BUSCA — na varredura normal os produtos são a etapa 2, num botão separado.
    if (p.resumo) resumo = p.resumo;
    if (p.alvos) alvos = p.alvos;
  }

  return { tabId, alvos, resumo, achou, parado, paginas };
}
