// A ETAPA 2 dos cupons: buscar os produtos de cada cupom, no Chrome do admin.
//
// Por que ela é um botão separado da etapa 1: aqui a conta do ML é ESCRITA. O ML
// só entrega a URL da vitrine (`containerUrl`) depois do "Eu quero", e clicar
// nisso é irreversível — na mesma conta que o Hub de Afiliados usa. A varredura
// da lista (rodadaNoChrome.js) virou leitura pura justamente para poder rodar à
// vontade; a escrita ficou toda aqui.
//
// Um CICLO (`umCiclo`) tem duas partes, e a ordem importa:
//   1. ATIVAR os que ainda não têm vitrine. Os botões "Aplicar" só existem na
//      lista do ML, então isso é uma passada pela lista — a mesma do
//      `percorrerLista`, com `ativarApenas` dizendo em quem clicar.
//   2. RASPAR a vitrine de cada um que já tem `containerUrl`.
//
// O `buscarTudo` repete o ciclo até a fila esvaziar. Ele existe porque um ciclo
// só nunca termina o serviço: a fila vem em lotes e um cupom recém-ativado só
// ganha `containerUrl` depois — então "pegar tudo" era clicar o botão à mão, olhar
// o contador cair e clicar de novo.
//
// Como sempre nesta pasta: quem decide é o servidor. Os alvos, os tetos e as pausas
// vêm do `/alvos-produtos`; aqui só se abre página e se devolve o que veio.
import { percorrerLista } from "./rodadaNoChrome";
import { raparVitrine, fecharAbaDoColetor } from "./coletor";
import { adminMlCuponsAlvosProdutos, adminMlCuponsImportVitrine, adminMlCuponsLocalFim } from "./api";

// Devolve { feitos, ativados, parado, muro }. `feitos` é uma linha por cupom
// tentado: { campaignId, title, ok, produtos, parcial, vazia, erro }.
//
// `pular` é `{ ativacao: Set, vitrine: Set }` — os campaignIds que esta execução já
// tentou, separados por ETAPA. Só o `buscarTudo` preenche. Precisam ser dois
// conjuntos e não um: o cupom recém-ativado tem que entrar na colheita de vitrine
// do mesmo ciclo, então marcá-lo na ativação não pode escondê-lo da vitrine.
export async function umCiclo({
  campaignIds = null,
  pular = null,
  parou = () => false,
  log = () => {},
  onProgresso = () => {},
} = {}) {
  const feitos = [];
  let ativados = 0;
  let parado = null;
  let muro = false;

  const pedirAlvos = () => adminMlCuponsAlvosProdutos(
    campaignIds?.length === 1 ? { campaignId: campaignIds[0] } : {},
  );
  const inedito = (etapa) => (c) => !pular || !pular[etapa].has(c.campaignId);

  let alvos = await pedirAlvos();
  const cfg = alvos.config || {};

  // A ativação vem primeiro porque é ela que faz a vitrine EXISTIR: sem o "Eu
  // quero" o cupom não tem `containerUrl` e não há o que raspar.
  const paraAtivar = alvos.precisamAtivar.filter(inedito("ativacao"));
  if (cfg.activateCoupons && paraAtivar.length && !parou()) {
    const ids = paraAtivar.map(c => c.campaignId);
    // Marcados ANTES da passada: o que importa é que foram TENTADOS. Quem o
    // `aAtivar` recusou (vencido, rótulo repetido entre duas campanhas) nunca vai
    // ganhar `containerUrl`, e sem isto todo ciclo repetiria a varredura inteira
    // da lista do ML para clicar em zero botões.
    for (const id of ids) pular?.ativacao.add(id);
    const teto = cfg.maxActivationsPerRun == null ? "todos eles" : `até ${cfg.maxActivationsPerRun} deles`;
    log("aviso", `${ids.length} cupom(ns) sem vitrine — vou clicar em "Eu quero" em ${teto} na sua conta do ML`);
    const r = await percorrerLista({ ativarApenas: ids, parou, log, onProgresso });
    await fecharAbaDoColetor(r.tabId);
    // O `local/fim` é obrigatório mesmo aqui: sem ele o servidor fica "running" e
    // recusa a próxima varredura e o "Apagar todos" até o processo reiniciar.
    await adminMlCuponsLocalFim({ cancelada: !!r.parado }).catch(() => {});
    ativados = r.resumo?.ativados || 0;
    if (r.parado) return { feitos, ativados, parado: r.parado, muro };
    // Relê: os recém-ativados agora têm `containerUrl`.
    alvos = await pedirAlvos();
  }

  const fila = (campaignIds?.length
    ? alvos.prontos.filter(c => campaignIds.includes(c.campaignId))
    : alvos.prontos).filter(inedito("vitrine"));

  if (!fila.length) {
    log("aviso", ativados
      ? "ativei, mas o ML ainda não devolveu vitrine para nenhum deles"
      : "nenhum cupom com vitrine pendente — todos já têm produtos");
    return { feitos, ativados, parado, muro };
  }

  log("info", `${fila.length} vitrine(s) para colher`);

  // Uma de cada vez, com pausa. Em paralelo seriam N abas do Chrome batendo no ML
  // com a mesma conta — que é o padrão que acorda o anti-robô, e o muro vale para
  // a CONTA, não para aquela vitrine.
  for (let i = 0; i < fila.length; i++) {
    if (parou()) { parado = "Interrompido por você"; break; }
    const c = fila[i];
    pular?.vitrine.add(c.campaignId);
    onProgresso({ tipo: "vitrine-abrindo", campaignId: c.campaignId, title: c.title, i: i + 1, de: fila.length });

    // Basta o TIPO do evento: o `muro` que vem dentro dele é o rótulo do que o ML
    // pediu (captcha, verificação, login) e pode chegar vazio. Ler o rótulo em vez
    // do tipo fazia o laço seguir para o próximo cupom depois de a conta já ter
    // sido questionada — que é o oposto do que este freio existe pra fazer.
    let viuMuro = false;
    try {
      const r = await raparVitrine(c.containerUrl, {
        paginas: cfg.maxPaginasVitrine,
        // O teto de produtos é do servidor e a extensão precisa dele: uma vitrine
        // grande demais chegava lá acima do limite e era recusada INTEIRA — abas
        // abertas na conta do ML para gravar zero produto.
        maxProdutos: cfg.maxProductsPerCoupon,
        onProgresso: (ev) => { if (ev?.tipo === "muro") viuMuro = true; onProgresso({ ...ev, campaignId: c.campaignId }); },
      });
      if (!r.produtos.length) {
        feitos.push({ campaignId: c.campaignId, title: c.title, ok: false, vazia: true, produtos: 0, erro: r.motivo || null });
        log("aviso", `${c.title}: a vitrine veio vazia${r.motivo ? ` (${r.motivo})` : ""}`);
      } else {
        // `parcial` viaja intacto: coleta que parou no muro ou no teto de páginas
        // não pode entrar como lista fechada, senão o sistema passa a dizer "fora
        // da vitrine" para produto que o cupom cobre.
        await adminMlCuponsImportVitrine(c.campaignId, { products: r.produtos, parcial: r.parcial });
        feitos.push({ campaignId: c.campaignId, title: c.title, ok: true, produtos: r.produtos.length, parcial: r.parcial });
        log("ok", `${c.title}: ${r.produtos.length} produtos${r.parcial ? " (parcial)" : ""}`);
      }
    } catch (err) {
      feitos.push({ campaignId: c.campaignId, title: c.title, ok: false, produtos: 0, erro: err.message });
      log("erro", `${c.title}: ${err.message}`);
    }

    // Muro é estado da CONTA, não daquela vitrine: seguir para o próximo cupom só
    // queima a conta mais rápido, e a conta é a mesma do Hub.
    if (viuMuro) {
      muro = true;
      parado = "O Mercado Livre pediu verificação — parei aqui de propósito";
      break;
    }
    if (i < fila.length - 1) await new Promise(r => setTimeout(r, cfg.pausaEntreVitrinesMs || 4000));
  }

  return { feitos, ativados, parado, muro };
}

// Um ciclo só, para o botão "2" e para o "buscar produtos" de uma linha. Mantém o
// nome antigo porque é o contrato que a tela já usa.
export function buscarProdutos(opcoes = {}) {
  return umCiclo(opcoes);
}

// O "buscar TUDO": cicla até não sobrar cupom sem produtos.
//
// Devolve { ciclos, feitos, ativados, parado, motivo } — `feitos` somado de todos
// os ciclos, e `motivo` dizendo por que parou (é o que o resumo da tela mostra:
// um laço que termina sozinho sem dizer por quê parece que desistiu).
export async function buscarTudo({
  parou = () => false,
  log = () => {},
  onProgresso = () => {},
  onCiclo = () => {},
} = {}) {
  // Os que esta execução já tentou. É a trava que o modo cíclico OBRIGA a existir:
  // vitrine que volta vazia não chega a gravar nada, então `productsSyncedAt` fica
  // nulo e o cupom reaparece no `/alvos-produtos` do ciclo seguinte. Num clique só
  // isso é inofensivo; em ciclo é abrir a mesma aba para sempre. Vale igual para o
  // cupom que o `aAtivar` recusa (vencido, rótulo repetido entre duas campanhas):
  // ele nunca vai ganhar `containerUrl`, e sem esta lista todo ciclo repetiria a
  // varredura inteira da lista para clicar em zero botões.
  const tentados = { ativacao: new Set(), vitrine: new Set() };
  const feitos = [];
  let ativados = 0;
  let ciclos = 0;
  let parado = null;
  // Sem valor inicial de propósito: todo caminho de saída do laço abaixo atribui um
  // motivo antes do `break`, e um `= null` aqui só esconderia o dia em que um deles
  // deixar de atribuir.
  let motivo;
  let maxCiclos = 20;      // sobrescrito pelo servidor no primeiro ciclo

  for (;;) {
    if (parou()) { parado = "Interrompido por você"; motivo = parado; break; }

    ciclos++;
    onCiclo({ ciclo: ciclos, tentados: tentados.vitrine.size });
    log("info", `— ciclo ${ciclos} —`);

    const r = await umCiclo({ pular: tentados, parou, log, onProgresso });
    feitos.push(...r.feitos);
    ativados += r.ativados;

    // O muro é da CONTA: o próximo ciclo encontraria o mesmo muro, só que uma aba
    // mais tarde.
    if (r.muro) { parado = r.parado; motivo = "o Mercado Livre pediu verificação"; break; }
    if (r.parado) { parado = r.parado; motivo = r.parado; break; }

    // Nada se moveu: nem ativou nem colheu. O próximo ciclo faria exatamente o
    // mesmo, então isto é o fim normal — a fila acabou, ou o que sobrou nela é o
    // que o `tentados` já descartou.
    if (!r.ativados && !r.feitos.length) { motivo = "a fila acabou"; break; }

    // A config vem do servidor a cada `/alvos-produtos`; ler do último ciclo é o
    // suficiente e evita mais uma chamada só para saber a pausa.
    const cfg = (await adminMlCuponsAlvosProdutos({})).config || {};
    maxCiclos = Number(cfg.maxCiclos) || maxCiclos;
    if (ciclos >= maxCiclos) { motivo = `parei no teto de ${maxCiclos} ciclos`; break; }

    const pausa = Number(cfg.pausaEntreCiclosMs) || 60000;
    log("info", `pausa de ${Math.round(pausa / 1000)}s antes do próximo ciclo`);
    await new Promise(r => setTimeout(r, pausa));
  }

  log(parado ? "aviso" : "ok", `fim: ${ciclos} ciclo(s) — ${motivo}`);
  return { ciclos, feitos, ativados, parado, motivo };
}
