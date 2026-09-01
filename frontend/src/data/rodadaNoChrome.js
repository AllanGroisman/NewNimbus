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

  const inicio = await adminMlCuponsLocalStart(procurar ? { procurar } : {});
  // As categorias vêm resolvidas do servidor (`categorias`), não da config: "todas
  // as categorias" sem dizer QUAIS foi o que escondeu uma config presa em
  // Brinquedos. `null` na lista é a lista geral, sem filtro.
  const categorias = inicio.categorias || [];
  const nomeDasCategorias = (!categorias.length || (categorias.length === 1 && !categorias[0]))
    ? "a lista geral (sem categoria)"
    : `${categorias.length} categorias (${categorias.join(", ")})`;
  log("info", procurar
    ? `procurando a campanha ${procurar} numa aba deste Chrome`
    : `começando: ${nomeDasCategorias}, até ${inicio.config?.limitPerGrouping} cupons por categoria`);

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
    log("info", `página ${proxima.pagina}${p.de ? `/${p.de}` : ""}${proxima.grouping ? ` de ${proxima.grouping}` : ""} · ${p.cupons} cupom(ns)${p.ignoradosLoja ? `, ${p.ignoradosLoja} de loja ignorados` : ""}`);
    proxima = p.proxima;
    achou = !!p.achou;
    if (Number.isFinite(p.paginasLidas)) paginas = p.paginasLidas;
    if (p.alvos) { alvos = p.alvos; resumo = p.resumo; }
  }

  return { tabId, alvos, resumo, achou, parado, paginas };
}
