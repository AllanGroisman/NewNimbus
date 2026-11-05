// Buscar UMA campanha no ML e gravá-la no sistema — o "trazer a campanha que a
// palavra apontou". Dois usuários: o modal "Essa campanha não está no sistema"
// (AdminCupomPalavra.jsx) e o "Buscar condições" da aba Cupons com Palavras, que
// chama isto uma campanha de cada vez.
//
// Dois caminhos, na mesma ordem de preferência do modal:
//   - no Chrome do admin, pela extensão (`buscarNoChrome`): não apanha CAPTCHA,
//     porque o ML barra navegador automatizado;
//   - no servidor (`buscarNoServidor`): dispara a busca e acompanha pelo status —
//     a varredura passa dos 90s do nginx, então ela roda solta lá.
import {
  adminMlCuponsImportVitrine, adminMlCuponsLocalFim,
  adminMlCuponsImportCampaign, adminMlCuponsImportStatus,
} from "./api";
import { percorrerLista } from "./rodadaNoChrome";
import { raparVitrine, fecharAbaDoColetor } from "./coletor";

const MURO = "o Mercado Livre pediu verificação — resolva na aba que abriu";

// O "não achei" que explica o porquê: o validador de palavra conhece qualquer
// campanha, mas a lista de ofertas desta conta é segmentada.
export function naoAchei(paginas) {
  const varri = paginas > 0
    ? `Varri ${paginas} página${paginas === 1 ? "" : "s"} da lista de cupons desta conta e essa campanha não apareceu.`
    : "Essa campanha não apareceu na lista de cupons desta conta.";
  return `${varri} Isso não quer dizer que o cupom não existe: o ML valida qualquer palavra digitada, mas só oferece na lista os cupons segmentados para esta conta — ela pode ter vencido, ser de outro segmento ou já ter sido usada.`;
}

// Erro com o motivo de ter parado, pra quem chama separar "muro"/"parou" de "não achei".
function erro(msg, tipo) {
  const e = new Error(msg);
  e.tipo = tipo;
  return e;
}

// A busca numa aba do Chrome do admin. Devolve { ok, campaignId, produtos,
// avisoVitrine, coupon }; lança com `tipo` "parado" (muro/Parar) ou "naoAchou".
export async function buscarNoChrome(campaignId, { comProdutos = true, onProgresso = () => {}, parou = () => false } = {}) {
  let tabId = null;
  let produtos = 0;
  let avisoVitrine = null;
  try {
    const r = await percorrerLista({
      procurar: campaignId,
      parou,
      onProgresso: (p) => onProgresso(p.tipo === "muro" ? { etapa: MURO } : { etapa: "cupons", pagina: p.pagina }),
    });
    tabId = r.tabId;
    if (r.parado) throw erro(r.parado, "parado");
    if (!r.achou) throw erro(naoAchei(r.paginas), "naoAchou");

    const alvo = r.alvos[0];
    if (comProdutos && alvo) {
      onProgresso({ etapa: "vitrine" });
      const v = await raparVitrine(alvo.containerUrl, {
        onProgresso: (p) => onProgresso(p.tipo === "muro" ? { etapa: MURO } : { etapa: "vitrine", pagina: p.pagina }),
      });
      if (v.produtos.length) {
        const salvo = await adminMlCuponsImportVitrine(campaignId, { products: v.produtos, parcial: v.parcial });
        produtos = salvo.produtos;
      } else {
        avisoVitrine = v.motivo || "a vitrine abriu, mas veio vazia";
      }
    } else if (comProdutos) {
      // Achou a campanha e ela veio sem `containerUrl`: o ML só revela a vitrine
      // depois do "Eu quero", e o clique não valeu (cupom de loja, vencido, sem
      // botão). A campanha entra assim mesmo, sem produtos.
      avisoVitrine = "o cupom entrou, mas continua sem “Eu quero” dado na conta — sem isso o ML não dá a vitrine dele";
    }
    return { ok: true, campaignId, produtos, avisoVitrine, coupon: alvo || null };
  } finally {
    await fecharAbaDoColetor(tabId);
    // Sempre: sem o fim, o servidor ficaria com a rodada "rodando" e recusaria
    // a próxima — inclusive a rodada de cupons.
    await adminMlCuponsLocalFim({ vitrines: produtos ? 1 : 0, produtos }).catch(() => {});
  }
}

const dormir = (ms) => new Promise(r => setTimeout(r, ms));

// A busca no servidor, esperando ela terminar (o modal tem o seu próprio
// acompanhamento, que deixa fechar a janela no meio; aqui quem chama quer o
// desfecho pra seguir pra próxima campanha).
export async function buscarNoServidor(campaignId, { comProdutos = true, onProgresso = () => {}, parou = () => false } = {}) {
  const r = await adminMlCuponsImportCampaign(campaignId, comProdutos);
  if (r.already) return r;
  for (;;) {
    await dormir(3000);
    let s;
    try { s = await adminMlCuponsImportStatus(); } catch { continue; }
    if (s.progress) onProgresso(s.progress);
    if (s.running) {
      // A busca do servidor não tem cancelamento: o Parar só deixa de esperar
      // a próxima — esta termina sozinha lá.
      if (parou()) throw erro("Interrompido por você (a busca em curso termina no servidor)", "parado");
      continue;
    }
    if (s.error) throw erro(s.error, "erro");
    if (s.result?.ok) return s.result;
    throw erro(s.result?.reason || "O ML não devolveu essa campanha.", "naoAchou");
  }
}
