// A ETAPA 2 dos cupons: buscar os produtos de cada cupom, no Chrome do admin.
//
// Por que ela é um botão separado da etapa 1: aqui a conta do ML é ESCRITA. O ML
// só entrega a URL da vitrine (`containerUrl`) depois do "Eu quero", e clicar
// nisso é irreversível — na mesma conta que o Hub de Afiliados usa. A varredura
// da lista (rodadaNoChrome.js) virou leitura pura justamente para poder rodar à
// vontade; a escrita ficou toda aqui.
//
// Um CICLO (`umCiclo`) anda em LOTES, e em cada lote a ordem importa:
//   1. ATIVAR os do lote que ainda não têm vitrine. Os botões "Aplicar" só existem
//      na lista do ML, então isso é uma passada pela lista — a mesma do
//      `percorrerLista`, com `ativarApenas` dizendo em quem clicar.
//   2. RASPAR a vitrine de cada um do lote que já tem `containerUrl`.
// Terminado o lote, tudo dele já está no banco — é isso que faz um Parar no meio
// não jogar a varredura fora.
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
import {
  adminMlCuponsAlvosProdutos, adminMlCuponsImportVitrine, adminMlCuponsLocalFim, adminMlCuponsCarimbar,
} from "./api";

// Devolve { feitos, ativados, parado, muro, lotes }. `feitos` é uma linha por cupom
// tentado: { campaignId, title, ok, produtos, parcial, vazia, erro }.
//
// O ciclo anda em LOTES de `cfg.tamanhoLoteProdutos` cupons: ativa os do lote que
// precisam, colhe as vitrines deles e só então passa ao próximo. Antes era uma
// passada de ativação pela lista INTEIRA e só depois a colheita — e um Parar (ou
// uma chamada que falhasse) durante a ativação jogava fora tudo: nenhuma vitrine
// tinha sido aberta, e os cupons ativados nem chegavam ao banco. Agora parar perde
// no máximo o lote em andamento, e cada lote terminado é anunciado como SALVO
// (`onProgresso({ tipo: "lote-salvo" })`) — o que a tela mostra é o que está no banco.
//
// `pular` é `{ ativacao: Set, vitrine: Set }` — os campaignIds que esta execução já
// tentou, separados por ETAPA. Só o `buscarTudo` preenche. Precisam ser dois
// conjuntos e não um: o cupom recém-ativado tem que entrar na colheita de vitrine
// do mesmo lote, então marcá-lo na ativação não pode escondê-lo da vitrine.
//
// `soSemProdutos` pede ao servidor a fila SEM os parciais (quem já tem algum
// vínculo). Não vale para o botão de uma linha: ali o cupom foi escolhido a dedo.
//
// Além do passo a passo que já existia, o ciclo anuncia `fila` (o tamanho do
// serviço), `ativando`, `vitrine-feita` (o desfecho de cada cupom) e `pausa` — é o
// que deixa a tela dizer "cupom 12 de 80" e explicar por que ficou parada.
export async function umCiclo({
  campaignIds = null,
  soSemProdutos = false,
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
    campaignIds?.length === 1 ? { campaignId: campaignIds[0] } : { soSemProdutos },
  );
  const inedito = (etapa) => (c) => !pular || !pular[etapa].has(c.campaignId);
  const pedido = (c) => !campaignIds?.length || campaignIds.includes(c.campaignId);

  const alvos = await pedirAlvos();
  const cfg = alvos.config || {};
  const tamanho = Math.max(1, Number(cfg.tamanhoLoteProdutos) || 20);

  // O teto de ativações continua valendo por CICLO, não por lote: o servidor o
  // aplica a cada varredura, e cada lote é uma varredura — sem cortar aqui, um teto
  // de 10 viraria 10 por lote.
  const aAtivarNoCiclo = cfg.activateCoupons
    ? alvos.precisamAtivar.filter(pedido).filter(inedito("ativacao"))
    : [];
  const tetoAtivacao = cfg.maxActivationsPerRun == null ? Infinity : Number(cfg.maxActivationsPerRun) || 0;

  // Os que já têm vitrine vão na frente: não custam escrita na conta do ML, e são
  // produto no banco mais cedo.
  const fila = [
    ...alvos.prontos.filter(pedido).filter(inedito("vitrine")).map(c => ({ ...c, ativar: false })),
    ...aAtivarNoCiclo.slice(0, tetoAtivacao).map(c => ({ ...c, ativar: true })),
  ];

  if (!fila.length) {
    log("aviso", "nenhum cupom com vitrine pendente — todos já têm produtos");
    return { feitos, ativados, parado, muro, lotes: 0 };
  }

  const lotes = [];
  for (let i = 0; i < fila.length; i += tamanho) lotes.push(fila.slice(i, i + tamanho));
  // Quantas vitrines ao mesmo tempo (task 14). Sem o número — servidor antigo — é
  // uma por vez, como sempre foi: paralelismo é opt-in, porque o muro é da CONTA.
  const paralelo = Math.max(1, Math.min(4, Number(cfg.vitrinesEmParalelo) || 1));
  const sobrepoe = lotes.length > 1 && lotes.slice(1).some(l => l.some(c => c.ativar));
  log("info", `${fila.length} cupom(ns) em ${lotes.length} lote(s) de até ${tamanho} — cada lote é gravado antes do próximo`);
  if (paralelo > 1 || sobrepoe) {
    log("info", `${paralelo} vitrine(s) por vez${sobrepoe ? " + a ativação do próximo lote em paralelo, numa aba à parte" : ""}`);
  }
  onProgresso({
    tipo: "fila",
    total: fila.length,
    prontos: fila.filter(c => !c.ativar).length,
    aAtivar: fila.filter(c => c.ativar).length,
    lotes: lotes.length,
    tamanhoLote: tamanho,
    maxPaginas: cfg.maxPaginasVitrine ?? null,
    maxProdutos: cfg.maxProductsPerCoupon ?? null,
    paralelo,
  });

  const salvo = { lotes: 0, de: lotes.length, vitrines: 0, produtos: 0 };
  // O que a ativação EM SEGUNDO PLANO manda parar: o muro que ela viu na lista do
  // ML vale para a conta inteira, então a colheita em curso também não abre mais
  // nenhuma vitrine.
  const freio = { parado: null };
  // A ativação do PRÓXIMO lote, rodando enquanto este colhe. Uma de cada vez,
  // sempre: o servidor tem uma varredura local só (`_local`) e recusa a segunda.
  let fundo = null;   // { k, promessa }
  // Tem vitrine gravada com `carimbar: false` esperando o carimbo do catálogo.
  let semCarimbo = false;

  const carimbar = async () => {
    if (!semCarimbo) return;
    semCarimbo = false;
    await adminMlCuponsCarimbar().catch(err => log("erro", `não consegui carimbar o catálogo: ${err.message}`));
  };

  const dispararFundo = (k) => {
    const ids = lotes[k].filter(c => c.ativar).map(c => c.campaignId);
    const promessa = ativarLote(ids, {
      cfg, pular, parou, fundo: true,
      log: (tipo, texto) => log(tipo, `(lote ${k + 1}, em paralelo) ${texto}`),
      onProgresso: (ev) => onProgresso({ ...ev, fundo: true, loteFundo: k + 1 }),
    })
      .catch(err => ({ ativados: 0, parado: `a ativação do lote ${k + 1} falhou: ${err.message}` }))
      .then(r => {
        if (r.parado) freio.parado = r.parado;
        onProgresso({ tipo: "ativacao-fundo-fim", loteFundo: k + 1, ativados: r.ativados || 0 });
        return r;
      });
    fundo = { k, promessa };
  };

  try {
    for (let k = 0; k < lotes.length; k++) {
      if (parou()) { parado = "Interrompido por você"; break; }
      if (freio.parado) { parado = freio.parado; break; }
      const lote = lotes[k];
      const aAtivar = lote.filter(c => c.ativar);
      const colher = lote.filter(c => !c.ativar);
      onProgresso({ tipo: "lote", k: k + 1, de: lotes.length, tamanho: lote.length, aAtivar: aAtivar.length });
      log("info", `— lote ${k + 1}/${lotes.length}: ${lote.length} cupom(ns)${aAtivar.length ? `, ${aAtivar.length} para ativar` : ""} —`);

      // A ativação vem primeiro porque é ela que faz a vitrine EXISTIR: sem o "Eu
      // quero" o cupom não tem `containerUrl` e não há o que raspar. Se ela já
      // correu em segundo plano durante o lote anterior, aqui só se espera o fim.
      if (aAtivar.length) {
        let r;
        if (fundo?.k === k) {
          r = await fundo.promessa;
          fundo = null;
        } else {
          onProgresso({ tipo: "ativando", n: aAtivar.length });
          r = await ativarLote(aAtivar.map(c => c.campaignId), { cfg, pular, parou, log, onProgresso });
        }
        ativados += r.ativados;
        if (r.parado) { parado = r.parado; break; }
        // Relê: os recém-ativados agora têm `containerUrl`. O servidor já os gravou
        // página a página durante a varredura.
        const ids = new Set(aAtivar.map(c => c.campaignId));
        const depois = await pedirAlvos();
        const ganharam = depois.prontos.filter(c => ids.has(c.campaignId)).filter(inedito("vitrine"));
        colher.push(...ganharam);
        if (ganharam.length < aAtivar.length) {
          log("aviso", `${aAtivar.length - ganharam.length} do lote seguem sem vitrine depois da ativação (o ML não mostrou o botão, ou já venceu)`);
        }
      }

      // O próximo lote já começa a ativar enquanto este colhe: são abas diferentes,
      // e é o tempo da ativação que deixa de somar ao do ciclo.
      if (k + 1 < lotes.length && lotes[k + 1].some(c => c.ativar)) dispararFundo(k + 1);

      const r = await colherVitrines(colher, { cfg, paralelo, freio, pular, parou, log, onProgresso });
      feitos.push(...r.feitos);

      // Cada vitrine já foi gravada no momento em que foi colhida — o lote só
      // carimba o catálogo (uma vez, não uma por vitrine) e anuncia. Os números vêm
      // do que o servidor aceitou, não do que se tentou.
      const ok = r.feitos.filter(f => f.ok);
      if (ok.length) semCarimbo = true;
      await carimbar();
      salvo.lotes += r.parado ? 0 : 1;
      salvo.vitrines += ok.length;
      salvo.produtos += ok.reduce((n, f) => n + (f.produtos || 0), 0);
      onProgresso({ tipo: "lote-salvo", k: k + 1, de: lotes.length, completo: !r.parado, ...salvo, em: new Date() });
      const produtosDoLote = ok.reduce((n, f) => n + (f.produtos || 0), 0);
      log("ok", `💾 lote ${k + 1}/${lotes.length} ${r.parado ? "interrompido — o que foi colhido está salvo" : "salvo"}: ${ok.length} vitrine(s), ${produtosDoLote} produto(s) · acumulado ${salvo.vitrines} vitrine(s), ${salvo.produtos} produto(s)`);

      if (r.muro) { muro = true; parado = r.parado; break; }
      if (r.parado) { parado = r.parado; break; }
      // A pausa entre lotes só quando nada correu em paralelo: com a ativação em
      // segundo plano, o lote seguinte já tem as vitrines prontas para abrir.
      if (k < lotes.length - 1 && fundo?.k !== k + 1) {
        const ms = cfg.pausaEntreVitrinesMs || 4000;
        onProgresso({ tipo: "pausa", ms, motivo: "entre lotes" });
        await new Promise(res => setTimeout(res, ms));
      }
    }
  } finally {
    // A ativação em segundo plano PRECISA terminar antes de o ciclo devolver: é ela
    // que chama o `local/fim`, e sem ele o servidor fica "rodando" e recusa a
    // próxima varredura. Ela vê o mesmo `parou()` e para sozinha.
    if (fundo) {
      const r = await fundo.promessa;
      ativados += r.ativados || 0;
    }
    await carimbar();
  }

  return { feitos, ativados, parado, muro, lotes: salvo.lotes };
}

// Uma passada pela lista do ML clicando "Eu quero" SÓ nos ids do lote. O servidor
// encerra a varredura assim que todos eles apareceram, e grava cada um na página
// em que apareceu — um Parar aqui não perde o que já foi ativado.
//
// `fundo` = rodando em segundo plano, enquanto o lote anterior colhe vitrines.
async function ativarLote(ids, { cfg, pular, parou, log, onProgresso, fundo = false }) {
  // Marcados ANTES da passada: o que importa é que foram TENTADOS. Quem o
  // `aAtivar` recusou (vencido, rótulo repetido entre duas campanhas) nunca vai
  // ganhar `containerUrl`, e sem isto todo ciclo repetiria a varredura da lista
  // do ML para clicar em zero botões.
  for (const id of ids) pular?.ativacao.add(id);
  const teto = cfg.maxActivationsPerRun == null ? "todos eles" : `até ${cfg.maxActivationsPerRun} deles`;
  log("aviso", `${ids.length} cupom(ns) sem vitrine — vou clicar em "Eu quero" em ${teto} na sua conta do ML`);
  if (fundo) onProgresso({ tipo: "ativando", n: ids.length });
  let r = null;
  let tabId = null;
  let fim = null;
  try {
    r = await percorrerLista({ ativarApenas: ids, parou, log, onProgresso });
    tabId = r.tabId;
  } finally {
    // Num `finally`, e não em sequência, porque a varredura PODE lançar: basta
    // uma das chamadas ao servidor falhar. Quando isso acontecia, nenhuma das
    // duas linhas abaixo rodava — o servidor ficava com a rodada "running",
    // recusando a próxima tentativa com 409 até o watchdog de 5 min soltar, e a
    // aba do ML ficava aberta. Mesmo formato do `varrerLista` da etapa 1.
    await fecharAbaDoColetor(tabId);
    // O `local/fim` é obrigatório mesmo aqui: sem ele o servidor fica "running" e
    // recusa a próxima varredura e o "Apagar todos" até o processo reiniciar. É
    // também ele que GRAVA o que a varredura leu quando ela foi interrompida.
    fim = await adminMlCuponsLocalFim({ cancelada: !r || !!r.parado }).catch(() => null);
    if (fim?.resumo?.salvos) log("ok", `💾 servidor gravou ${fim.resumo.salvos} cupom(ns) lidos na lista`);
  }
  return {
    ativados: fim?.resumo?.ativados ?? r.resumo?.ativados ?? 0,
    parado: r.parado,
  };
}

// As vitrines de uma lista de cupons, `paralelo` de cada vez (task 14).
//
// Era uma por vez, e o motivo continua valendo: N abas batendo no ML com a mesma
// conta é o padrão que acorda o anti-robô, e o muro vale para a CONTA, não para
// aquela vitrine. Por isso o número vem do servidor com teto baixo, os workers
// entram escalonados (não abrem N abas no mesmo instante), cada um respeita a
// pausa entre as vitrines dele, e o primeiro muro fecha a porta para todos: quem
// já está colhendo termina (a extensão não aborta no meio), ninguém começa outra.
//
// As vitrines vão com `carimbar: false` — quem carimba o catálogo é o `umCiclo`,
// uma vez por lote.
async function colherVitrines(fila, { cfg, paralelo = 1, freio = null, pular, parou, log, onProgresso }) {
  const feitos = [];
  let parado = null;
  let muro = false;
  let proximo = 0;
  const pausa = cfg.pausaEntreVitrinesMs || 4000;
  const dormir = (ms) => new Promise(r => setTimeout(r, ms));

  const deveParar = () => {
    if (parado) return true;
    if (parou()) { parado = "Interrompido por você"; return true; }
    if (freio?.parado) { parado = freio.parado; return true; }
    return false;
  };

  async function umaVitrine(c, i) {
    pular?.vitrine.add(c.campaignId);
    onProgresso({ tipo: "vitrine-abrindo", campaignId: c.campaignId, title: c.title, i: i + 1, de: fila.length });

    // Basta o TIPO do evento: o `muro` que vem dentro dele é o rótulo do que o ML
    // pediu (captcha, verificação, login) e pode chegar vazio. Ler o rótulo em vez
    // do tipo fazia o laço seguir para o próximo cupom depois de a conta já ter
    // sido questionada — que é o oposto do que este freio existe pra fazer.
    let viuMuro = false;
    let feito;
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
        feito = { campaignId: c.campaignId, title: c.title, ok: false, vazia: true, produtos: 0, erro: r.motivo || null };
        log("aviso", `${c.title}: a vitrine veio vazia${r.motivo ? ` (${r.motivo})` : ""}`);
      } else {
        // `parcial` viaja intacto: coleta que parou no muro ou no teto de páginas
        // não pode entrar como lista fechada, senão o sistema passa a dizer "fora
        // da vitrine" para produto que o cupom cobre.
        await adminMlCuponsImportVitrine(c.campaignId, { products: r.produtos, parcial: r.parcial, carimbar: false });
        feito = { campaignId: c.campaignId, title: c.title, ok: true, produtos: r.produtos.length, parcial: r.parcial };
        log("ok", `💾 ${c.title}: ${r.produtos.length} produtos gravados${r.parcial ? " (parcial)" : ""}`);
      }
    } catch (err) {
      feito = { campaignId: c.campaignId, title: c.title, ok: false, produtos: 0, erro: err.message };
      log("erro", `${c.title}: ${err.message}`);
    }
    feitos.push(feito);
    onProgresso({ tipo: "vitrine-feita", ...feito });

    // Muro é estado da CONTA, não daquela vitrine: seguir para o próximo cupom só
    // queima a conta mais rápido, e a conta é a mesma do Hub.
    if (viuMuro && !muro) {
      muro = true;
      parado = "O Mercado Livre pediu verificação — parei aqui de propósito";
    }
  }

  async function trabalhador(w) {
    // Escalonado: o segundo entra meia pausa depois do primeiro, e assim por diante.
    if (w > 0) await dormir(Math.round((w * pausa) / paralelo));
    for (;;) {
      if (deveParar() || proximo >= fila.length) return;
      const i = proximo++;
      await umaVitrine(fila[i], i);
      if (deveParar() || proximo >= fila.length) return;
      // Com um trabalhador só, a pausa é anunciada como sempre foi; com vários, o
      // painel mostra as vitrines em curso, e uma "pausa" por cima dele mentiria.
      if (paralelo === 1) onProgresso({ tipo: "pausa", ms: pausa, motivo: "entre vitrines" });
      await dormir(pausa);
    }
  }

  const n = Math.min(paralelo, fila.length);
  await Promise.all(Array.from({ length: n }, (_, w) => trabalhador(w)));

  return { feitos, parado, muro };
}

// Um ciclo só, para o botão "2" e para o "buscar produtos" de uma linha. Mantém o
// nome antigo porque é o contrato que a tela já usa.
export function buscarProdutos(opcoes = {}) {
  return umCiclo(opcoes);
}

// O "buscar TUDO": cicla até não sobrar cupom sem produtos.
//
// Devolve { ciclos, feitos, ativados, parado, motivo, lotes } — `feitos` somado de todos
// os ciclos, e `motivo` dizendo por que parou (é o que o resumo da tela mostra:
// um laço que termina sozinho sem dizer por quê parece que desistiu).
export async function buscarTudo({
  soSemProdutos = false,
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
  let lotes = 0;
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
    onCiclo({ ciclo: ciclos, maxCiclos, tentados: tentados.vitrine.size });
    log("info", `— ciclo ${ciclos} —`);

    const r = await umCiclo({ soSemProdutos, pular: tentados, parou, log, onProgresso });
    feitos.push(...r.feitos);
    ativados += r.ativados;
    lotes += r.lotes || 0;

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
    const cfg = (await adminMlCuponsAlvosProdutos({ soSemProdutos })).config || {};
    maxCiclos = Number(cfg.maxCiclos) || maxCiclos;
    if (ciclos >= maxCiclos) { motivo = `parei no teto de ${maxCiclos} ciclos`; break; }

    const pausa = Number(cfg.pausaEntreCiclosMs) || 60000;
    log("info", `pausa de ${Math.round(pausa / 1000)}s antes do próximo ciclo`);
    onProgresso({ tipo: "pausa", ms: pausa, motivo: "entre ciclos" });
    await new Promise(r => setTimeout(r, pausa));
  }

  log(parado ? "aviso" : "ok", `fim: ${ciclos} ciclo(s) — ${motivo}`);
  return { ciclos, feitos, ativados, parado, motivo, lotes };
}
