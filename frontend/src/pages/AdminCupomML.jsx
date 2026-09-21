// Admin › Cupom › aba "Cupons do ML" — os cupons que o Mercado Livre oferece para
// a conta do sistema, e os produtos de cada um.
//
// O trabalho é feito em DUAS ETAPAS, e a separação é o desenho desta tela:
//
//   1. Buscar cupons e condições — abre a lista geral do ML
//      (`/cupons/filter?all=true&page=N`) numa aba deste Chrome e guarda TODOS os
//      cupons com nome, desconto, mínimo, teto e validade. É LEITURA PURA: nada
//      é escrito na conta do ML, então dá pra rodar à vontade.
//   2. Buscar os produtos — abre a vitrine de cada cupom. Esta etapa PRECISA
//      ativar ("Eu quero") os cupons que ainda não foram aceitos, porque sem isso
//      o ML não entrega a URL da vitrine. Ativar é escrita irreversível na conta,
//      e é por isso que ela ficou num botão só dela, com teto configurável.
//
// Tudo roda pela extensão no Chrome do admin (`extension/` na raiz): o ML responde
// CAPTCHA para navegador automatizado, dentro e fora da VPS.
//
// O testador de PALAVRA morava aqui e hoje é a aba vizinha (AdminCupomPalavra.jsx).
import { Fragment, useState, useEffect, useCallback, useRef, useReducer } from "react";
import { PRIMARY_DARK } from "../data/constants";
import {
  adminMlCupons, adminMlCuponsStatus, adminMlCuponsSaveConfig,
  adminMlCuponsProducts, adminMlCuponsClearAll, adminMlCuponsDelete,
  adminMlCuponsAlvosProdutos, adminMlCuponsLocalFim, errText,
} from "../data/api";
import { percorrerLista } from "../data/rodadaNoChrome";
import { buscarProdutos, buscarTudo } from "../data/produtosNoChrome";
import { coletorInfo, fecharAbaDoColetor } from "../data/coletor";
import { rotuloCategoria, categoriasDoCupom } from "../data/cupomCategorias";
import { campanhaDoTexto } from "../data/cupomId";
// O mesmo modal da aba "Descobrir palavra" — lá ele traz a campanha que uma palavra
// apontou, aqui a que alguém digitou. É a importação que a aba "Repasse" já faz
// (AdminCupomRepasse.jsx), e não fecha ciclo: AdminCupomPalavra não importa página
// nenhuma.
import { ImportarCampanhaModal } from "./AdminCupomPalavra";
import Modal from "../components/ui/Modal";
import ColheitaLog from "../components/admin/ColheitaLog";
import ProgressoColheita from "../components/admin/ProgressoColheita";
import { reduzirAndamento } from "../data/andamentoColheita";
import ExtensaoAusente from "../components/admin/ExtensaoAusente";
import Numero from "../components/admin/Numero";
import CouponLandingSweep from "../components/admin/CouponLandingSweep";
import {
  segundos, brl, dia, desconto, cardStyle, inputStyle, labelStyle, th, td,
  botaoPrimario, botaoSecundario, botaoPerigo, botaoLink,
} from "../components/admin/cupomEstilos";

// O balanço da última varredura, guardado no servidor — é o que sobrevive a um
// F5 e ao restart do backend. Antes isto era uma frase corrida de 300 caracteres,
// que ninguém lia.
function resumoDaRodada(status) {
  const r = status.lastResult;
  return {
    titulo: `Última varredura — ${new Date(status.lastRun).toLocaleString("pt-BR")}`,
    tom: status.lastError ? "aviso" : "ok",
    nota: status.lastError || null,
    numeros: [
      { label: "Cupons", valor: r?.cupons },
      { label: "Novos", valor: r?.novos },
      { label: "Ativados", valor: r?.ativados },
      { label: "Vínculos cupom↔produto", valor: r?.vinculos },
      { label: "Catálogo carimbado", valor: r?.catalogoCarimbado },
      { label: "De loja ignorados", valor: r?.cuponsDeLojaIgnorados },
      { label: "Duração", valor: segundos(status.lastDuration) },
    ],
  };
}

// O número da campanha — o `campaign_id` do ML.
//
// É o mesmo número em três lugares que antes não se conversavam na tela: a chave do
// cupom aqui, o `coupon_campaign_id` do link da vitrine, e a resposta que o ML dá na
// aba "Descobrir palavra" ("essa palavra é da campanha 14193894"). Mostrá-lo é o que
// permite ligar os três a olho — antes ele só aparecia quando o cupom não tinha
// subtítulo, que é justamente quando ninguém está procurando por ele.
function NumeroDaCampanha({ id }) {
  const [copiado, setCopiado] = useState(false);

  const copiar = async () => {
    // `clipboard` não existe fora de https (e nem em todo navegador de teste). Falhar
    // aqui não pode derrubar a linha: o número está escrito na tela do mesmo jeito.
    try {
      await navigator.clipboard.writeText(String(id));
      setCopiado(true);
      setTimeout(() => setCopiado(false), 1200);
    } catch { /* dá pra selecionar com o mouse */ }
  };

  return (
    <button
      onClick={copiar}
      title={`Campanha ${id} — é o mesmo número do coupon_campaign_id no link da vitrine e o que o ML responde no teste de palavra. Clique para copiar.`}
      style={{
        marginTop: 2, padding: 0, border: "none", background: "none", cursor: "pointer",
        fontFamily: "monospace", fontSize: 11, color: "var(--color-text-secondary)",
      }}
    >
      #{id}{copiado ? " ✓ copiado" : ""}
    </button>
  );
}

// De onde saiu a palavra do cupom (`codeSource`, backend/coupons/pg.js:listCoupons).
// A distinção fica na tela porque as duas não valem o mesmo: a testada é resposta do
// próprio ML, a do título é leitura de texto — e apostar uma palavra errada num
// repasse é o custo de confundi-las.
const FONTE_PALAVRA = {
  testada: "testada no ML",
  titulo: "lida do título",
};

// `buscaInicial` é um número de campanha vindo da aba "Descobrir palavra": ela
// descobre a campanha de uma palavra e manda ver o cupom aqui (AdminCupom.jsx).
export default function CuponsDoML({ buscaInicial = null }) {
  const [status, setStatus] = useState(null);
  const [lista, setLista] = useState({ items: [], total: 0, page: 1, pageSize: 50 });
  // A campanha que a outra aba mandou ver já entra como filtro no primeiro render —
  // esta aba é montada do zero quando se troca de aba (AdminCupom.jsx), então semear
  // aqui é o suficiente e não custa uma lista carregada à toa antes do filtro.
  //
  // `onlyValid: false` junto não é detalhe: a campanha que uma palavra aponta quase
  // sempre já venceu (é por isso que a palavra sobrou circulando), e o padrão a
  // esconderia — a tela responderia "nenhum cupom" para um cupom guardado bem aqui.
  const [filtros, setFiltros] = useState(() => ({
    q: buscaInicial ? String(buscaInicial) : "",
    scope: "", grouping: "", onlyValid: !buscaInicial, page: 1,
  }));
  const [erro, setErro] = useState(null);
  const [aberto, setAberto] = useState(null);        // campaignId com os produtos à mostra
  // A extensão que colhe a vitrine no Chrome do próprio admin (extension/ na raiz).
  // `null` enquanto não se sabe: o botão fica quieto em vez de piscar de cinza a
  // ativo na montagem.
  const [temColetor, setTemColetor] = useState(null);
  // A etapa 1 (a varredura da lista) rodando no Chrome do admin.
  const [rodandoNoChrome, setRodandoNoChrome] = useState(false);
  // A etapa 2 (os produtos). Estado separado porque os dois botões são
  // independentes: dá pra varrer a lista hoje e buscar os produtos amanhã.
  const [buscandoProdutos, setBuscandoProdutos] = useState(false);
  // Quantos cupons ainda esperam produtos, e quantos desses precisariam de um
  // "Eu quero" antes. Vem do servidor (`/alvos-produtos`) porque é ele que sabe
  // quem já foi raspado — a página da tabela mostra só 50 de cada vez.
  const [alvos, setAlvos] = useState(null);
  // A extensão instalada entende o comando da lista? Uma cópia da versão 1.0
  // responde ao ping e não conhece "lista" — sem esta pergunta a tela ficaria
  // esperando um timeout de cinco minutos.
  const [colheLista, setColheLista] = useState(false);
  const [colhendo, setColhendo] = useState(null);    // campaignId sendo colhido
  // `ref` e não `state`: o laço do lote precisa ler o valor ATUAL a cada volta, e
  // um state ficaria congelado na closure em que o laço começou.
  const pararRef = useRef(false);
  // O "agora" da colheita — etapa, fila, lote, cupom da vez, contadores —, montado
  // evento a evento por `data/andamentoColheita.js`. `null` fora de uma rodada.
  const [andamento, andar] = useReducer(reduzirAndamento, null);
  // "Só os que não têm nenhum produto": tira da fila do botão 2 (e do 3) os
  // PARCIAIS, que já têm prévia. Lembrado por navegador — é preferência de quem
  // opera, não estado do sistema.
  const [soSemProdutos, setSoSemProdutos] = useState(() => {
    try { return localStorage.getItem("cupons.soSemProdutos") === "1"; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem("cupons.soSemProdutos", soSemProdutos ? "1" : "0"); } catch { /* sem storage, só não lembra */ }
  }, [soSemProdutos]);
  // O que a busca de produtos JÁ GRAVOU, lote a lote. Separado do `andamento`
  // porque diz outra coisa: o andamento é o que está sendo feito, isto é o que um
  // Parar agora não perde. Fica na tela depois do fim — é a prova do que ficou.
  const [salvo, setSalvo] = useState(null);
  // O passo a passo do lote e o balanço dele. `eventos` é append-only durante a
  // colheita; `resumoColheita` só existe depois que ela termina.
  const [eventos, setEventos] = useState([]);
  const [resumoColheita, setResumoColheita] = useState(null);
  const [produtos, setProdutos] = useState({});      // campaignId → { items, total }
  const [confirmarLimpeza, setConfirmarLimpeza] = useState(false);
  const [limpando, setLimpando] = useState(false);
  const [confirmarExclusao, setConfirmarExclusao] = useState(null);  // o cupom a apagar
  // A caixa "Trazer campanha por ID": o que foi colado, o recado da última tentativa
  // e a campanha que o modal está buscando.
  const [idColado, setIdColado] = useState("");
  const [recadoId, setRecadoId] = useState(null);
  const [procurandoId, setProcurandoId] = useState(false);
  const [trazendo, setTrazendo] = useState(null);

  // `tick` é o gatilho de recarga: mexer nele refaz as duas leituras. Cada uma
  // roda dentro de um IIFE async e confere `vivo` antes de gravar — a rodada
  // demora minutos e a tela pode ser trocada no meio.
  const [tick, setTick] = useState(0);
  const recarregar = useCallback(() => setTick(t => t + 1), []);

  useEffect(() => {
    let vivo = true;
    (async () => {
      try {
        const r = await adminMlCuponsStatus();
        if (vivo) setStatus(r);
      } catch { /* status é acessório — não vale derrubar a tela */ }
    })();
    return () => { vivo = false; };
  }, [tick]);

  useEffect(() => {
    let vivo = true;
    (async () => {
      try {
        const r = await adminMlCupons({ ...filtros, pageSize: 50 });
        if (vivo) setLista(r);
      } catch (err) {
        if (vivo) setErro(errText(err, "Não deu pra carregar os cupons."));
      }
    })();
    return () => { vivo = false; };
  }, [filtros, tick]);

  // Enquanto a rodada corre, o status é a única forma de saber onde ela está.
  // O mesmo tick recarrega a lista, que só depois de terminar tem o que mostrar.
  // 2s, não 5: o passo a passo da rodada só parece ao vivo assim. Fora da rodada
  // não há poll nenhum, como antes.
  useEffect(() => {
    if (!status?.running) return undefined;
    const id = setInterval(recarregar, 2000);
    return () => clearInterval(id);
  }, [status?.running, recarregar]);

  // "Consigo buscar um cupom pelo ID dele?" (task 32). Aceita o número solto ou o
  // link do cupom — o `campanhaDoTexto` é quem sabe que o `_CustId_` da URL é o
  // vendedor, não a campanha.
  //
  // Olha PRIMEIRO no que já está guardado, e só vai ao ML quando não achar: trazer
  // uma campanha abre um Chrome com a conta do sistema e varre a lista de cupons
  // dela. É o mesmo cuidado que o `startImport` já tem no servidor (o `already`) —
  // aqui ele evita até a viagem até lá.
  const trazerPorId = async () => {
    const id = campanhaDoTexto(idColado);
    if (!id) {
      setRecadoId({ tom: "erro", texto: "Não achei um número de campanha aí. Cole o número (13495993) ou o link do cupom." });
      return;
    }
    setProcurandoId(true); setRecadoId(null);
    try {
      // `onlyValid: false` porque campanha procurada pelo ID costuma ser justamente
      // a vencida; e a comparação é EXATA porque o `q` do backend casa por pedaço
      // (buildCouponWhere), e um pedaço traria a campanha vizinha.
      const r = await adminMlCupons({ q: id, onlyValid: false, pageSize: 5 });
      const achado = (r.items || []).find(c => String(c.campaignId) === id);
      if (achado) {
        setFiltros(f => ({ ...f, q: id, onlyValid: false, page: 1 }));
        setRecadoId({ tom: "ok", texto: `A campanha ${id} já está guardada: “${achado.title}”. Filtrei a lista nela.` });
      } else {
        setTrazendo(id);
      }
    } catch (err) {
      setRecadoId({ tom: "erro", texto: errText(err, "Não deu pra procurar essa campanha.") });
    } finally {
      setProcurandoId(false);
    }
  };

  const verProdutos = async (campaignId) => {
    if (aberto === campaignId) { setAberto(null); return; }
    setAberto(campaignId);
    if (produtos[campaignId]) return;
    try {
      const r = await adminMlCuponsProducts(campaignId, { pageSize: 30 });
      setProdutos(p => ({ ...p, [campaignId]: r }));
    } catch (err) {
      setErro(errText(err, "Não deu pra carregar os produtos desse cupom."));
    }
  };

  useEffect(() => {
    coletorInfo().then(i => {
      setTemColetor(i.instalada);
      setColheLista(i.instalada && (i.comandos || []).includes("lista"));
    });
  }, []);

  // A fila da etapa 2, relida a cada recarga: é ela que dá o número do botão.
  useEffect(() => {
    let vivo = true;
    (async () => {
      try {
        const r = await adminMlCuponsAlvosProdutos({ soSemProdutos });
        if (vivo) setAlvos(r);
      } catch { /* o botão fica sem o número, e só */ }
    })();
    return () => { vivo = false; };
  }, [tick, soSemProdutos]);

  // Uma linha no log. `useCallback` não faz falta aqui: quem chama é o laço da
  // varredura, não um efeito.
  const logar = (tipo, texto) => setEventos(ev => [...ev, { at: new Date().toISOString(), tipo, texto }]);

  // O progresso que vem do laço e da extensão. Todo evento vai cru para o
  // `andamento`; aqui fica só o que mexe em outra coisa da tela — o salvo, a
  // recarga, e o muro no log (a aba veio para a frente e está esperando o humano).
  const avisarMuro = (p) => {
    andar(p);
    if (p?.tipo === "lote-salvo") {
      setSalvo({ lotes: p.lotes, de: p.de, vitrines: p.vitrines, produtos: p.produtos, em: p.em });
      // O contador "Sem produtos ainda" cai ao vivo: é o banco dizendo que gravou.
      recarregar();
    } else if (p?.tipo === "muro") {
      logar("aviso", "o Mercado Livre pediu verificação — resolva na aba que abriu");
    } else if (p?.tipo === "ativou") {
      logar("ok", `ativei “${p.rotulo}”`);
    }
  };

  // ETAPA 1 — a lista de cupons e as condições de cada um.
  //
  // Leitura pura: abre `/cupons/filter?all=true&page=N` numa aba deste Chrome,
  // página a página, e no fim grava. Nenhum clique em "Eu quero".
  //
  // O laço mora em `data/rodadaNoChrome.js` porque a busca de UMA campanha (o
  // "trazer campanha" do teste de palavra) é a mesma varredura. Aqui fica o que é
  // desta tela: o log e o resumo.
  //
  // `tudo` solta o teto de páginas da lista geral (quem decide o número é o
  // servidor). `resumir: false` é o encadeamento do botão 3: o resumo de lá é o
  // dos dois passos somados, e escrever este por cima faria a tela piscar um
  // balanço que some meio segundo depois.
  const varrerLista = async ({ tudo = false, resumir = true } = {}) => {
    pararRef.current = false;
    setRodandoNoChrome(true);
    setErro(null);
    if (resumir) { setEventos([]); setResumoColheita(null); andar({ tipo: "reiniciar" }); }
    const t0 = Date.now();
    let tabId = null;
    let resumoLista;
    let parado;

    try {
      const r = await percorrerLista({
        tudo,
        parou: () => pararRef.current,
        log: logar,
        onProgresso: avisarMuro,
      });
      tabId = r.tabId;
      resumoLista = r.resumo;
      parado = r.parado;
    } catch (err) {
      parado = errText(err, "A varredura no seu Chrome parou com um erro.");
      logar("erro", parado);
    } finally {
      await fecharAbaDoColetor(tabId);
      // O fim é sempre chamado: sem ele o servidor ficaria com a varredura
      // "rodando", e a próxima e o "Apagar todos" ficariam recusando até o
      // processo reiniciar.
      await adminMlCuponsLocalFim({ cancelada: !!parado }).catch(() => {});
      setRodandoNoChrome(false);
      if (resumir) andar({ tipo: "encerrar" });
      setAberto(null);
      recarregar();
    }

    logar(parado ? "aviso" : "ok",
      `${parado ? `${parado}. ` : ""}${resumoLista?.cupons ?? 0} cupom(ns) na lista`);
    if (!resumir) return { parado, resumo: resumoLista };
    setResumoColheita({
      titulo: parado ? "Varredura interrompida" : "Varredura terminada",
      tom: parado ? "aviso" : "ok",
      nota: parado
        ? `${parado}. O que já entrou está gravado — é só rodar de novo.`
        : "Os produtos de cada cupom são o próximo botão — ele é separado porque precisa ativar cupom na sua conta do ML.",
      numeros: [
        { label: "Cupons na lista", valor: resumoLista?.cupons ?? 0 },
        { label: "Novos", valor: resumoLista?.novos ?? 0 },
        { label: "Atualizados", valor: resumoLista?.atualizados ?? 0 },
        { label: "De loja ignorados", valor: resumoLista?.cuponsDeLojaIgnorados ?? 0 },
        { label: "Duração", valor: segundos(Date.now() - t0) },
      ],
    });
    return { parado, resumo: resumoLista };
  };

  const rodarNoChrome = () => varrerLista();

  // ETAPA 2 — os produtos. `campaignIds` null = todos os que faltam; com um id, é
  // o botão da linha. O laço (ativar → raspar) mora em `data/produtosNoChrome.js`,
  // que é o mesmo dos dois casos.
  const rodarProdutos = async (campaignIds = null) => {
    const umSo = campaignIds?.length === 1;
    pararRef.current = false;
    setBuscandoProdutos(true);
    if (umSo) setColhendo(campaignIds[0]);
    setSalvo(null);
    setErro(null);
    setEventos([]);
    setResumoColheita(null);
    andar({ tipo: "reiniciar" });
    const t0 = Date.now();
    let r = { feitos: [], ativados: 0, parado: null };

    try {
      r = await buscarProdutos({
        campaignIds,
        // O botão da linha é pedido explícito por aquele cupom: o filtro não vale.
        soSemProdutos: campaignIds?.length ? false : soSemProdutos,
        parou: () => pararRef.current,
        log: logar,
        onProgresso: avisarMuro,
      });
    } catch (err) {
      r.parado = errText(err, "A busca de produtos parou com um erro.");
      logar("erro", r.parado);
    } finally {
      setBuscandoProdutos(false);
      setColhendo(null);
      andar({ tipo: "encerrar" });
      setAberto(null);
      setProdutos({});
      recarregar();
    }

    const ok = r.feitos.filter(f => f.ok);
    const vazios = r.feitos.filter(f => !f.ok && f.vazia).length;
    const falhas = r.feitos.filter(f => !f.ok && !f.vazia).length;
    const produtosTotal = ok.reduce((n, f) => n + (f.produtos || 0), 0);
    const parciais = ok.filter(f => f.parcial).length;
    logar(r.parado ? "aviso" : "ok",
      `${r.parado ? `${r.parado}. ` : ""}${ok.length} de ${r.feitos.length} vitrine(s) colhida(s), ${produtosTotal} produto(s)`);
    setResumoColheita({
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
    });
  };

  // O "buscar TUDO": a etapa 1 sem teto de páginas e depois a etapa 2 em ciclos,
  // até a fila esvaziar. É um botão só porque a pergunta que ele responde é uma só
  // ("traz tudo"), e porque parar no meio das duas etapas deixa cupom guardado sem
  // produto nenhum — que é exatamente o estado que ele existe para desfazer.
  const rodarTudo = async () => {
    pararRef.current = false;
    setErro(null);
    setEventos([]);
    setResumoColheita(null);
    andar({ tipo: "reiniciar" });
    const t0 = Date.now();

    const lista = await varrerLista({ tudo: true, resumir: false });
    if (lista?.parado || pararRef.current) {
      andar({ tipo: "encerrar" });
      setResumoColheita({
        titulo: "Interrompido na lista",
        tom: "aviso",
        nota: `${lista?.parado || "Interrompido por você"}. Os cupons que já entraram estão gravados; os produtos ficaram para o botão 2.`,
        numeros: [{ label: "Cupons na lista", valor: lista?.resumo?.cupons ?? 0 }],
      });
      return;
    }

    // O servidor avisa quando a lista geral parou no teto de páginas em vez de no
    // fim que o ML declarou. Num "buscar TUDO" isso não pode ficar só numa linha do
    // meio do log: é a diferença entre "trouxe tudo" e "trouxe o que coube".
    const teto = (lista?.resumo?.avisos || []).find(a => /teto de \d+ p[áa]ginas/i.test(a)) || null;

    setBuscandoProdutos(true);
    setSalvo(null);
    let r = { ciclos: 0, feitos: [], ativados: 0, parado: null, motivo: null };
    try {
      r = await buscarTudo({
        soSemProdutos,
        parou: () => pararRef.current,
        log: logar,
        onCiclo: ({ ciclo, maxCiclos }) => andar({ tipo: "ciclo", ciclo, maxCiclos }),
        onProgresso: avisarMuro,
      });
    } catch (err) {
      r.parado = errText(err, "A busca em ciclos parou com um erro.");
      logar("erro", r.parado);
    } finally {
      setBuscandoProdutos(false);
      andar({ tipo: "encerrar" });
      setAberto(null);
      setProdutos({});
      recarregar();
    }

    const ok = r.feitos.filter(f => f.ok);
    const produtosTotal = ok.reduce((n, f) => n + (f.produtos || 0), 0);
    // Os que foram tentados e não vieram. Precisam aparecer: o contador "(N)" do
    // botão 2 NÃO vai zerar por causa deles, e sem essa linha parece que o "até
    // acabar" desistiu no meio.
    const sobraram = r.feitos.filter(f => !f.ok);
    setResumoColheita({
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
    });
  };

  const apagarUm = async () => {
    const c = confirmarExclusao;
    setConfirmarExclusao(null);
    setErro(null);
    try {
      await adminMlCuponsDelete(c.campaignId);
      setAberto(null);
      setProdutos(p => ({ ...p, [c.campaignId]: undefined }));
      recarregar();
    } catch (err) {
      setErro(errText(err, "Não deu pra apagar esse cupom."));
    }
  };

  const limparTudo = async () => {
    setConfirmarLimpeza(false);
    setErro(null);
    setLimpando(true);
    try {
      await adminMlCuponsClearAll();
      setAberto(null);
      setProdutos({});
      setFiltros(f => ({ ...f, page: 1 }));
      recarregar();
    } catch (err) {
      setErro(errText(err, "Não deu pra apagar os cupons."));
    } finally {
      setLimpando(false);
    }
  };

  const s = status?.stats;
  const rodando = !!status?.running;
  // O ML separa os cupons por categoria e o sistema guarda em qual (ou quais) cada
  // um apareceu. As opções do filtro saem da contagem LOCAL — categoria que o ML
  // oferece mas de que não se colheu cupom nenhum não vira opção que devolve lista
  // vazia.
  const labelsCategoria = status?.groupingLabels || {};
  const categorias = s?.porCategoria || [];
  const semCupom = !s?.cupons;
  // Quantos cupons ainda esperam produtos. Vem do servidor, não da página da
  // tabela: o botão percorre TODOS os que faltam, e prometer o número da página
  // seria mentir sobre o que ele vai fazer.
  const faltamProdutos = (alvos?.prontos?.length || 0) + (alvos?.config?.activateCoupons ? (alvos?.precisamAtivar?.length || 0) : 0);
  const precisamAtivar = alvos?.config?.activateCoupons ? (alvos?.precisamAtivar?.length || 0) : 0;
  // Três valores, e a diferença importa: `0` é ativação desligada, `null` é ligada
  // e sem teto, número é o teto por rodada. Antes eram dois 0 querendo dizer coisas
  // opostas.
  // Nada de `?? 0` aqui: `null` É o valor com significado (sem teto), e o `??`
  // justamente o trocaria por 0 — que quer dizer o oposto, ativação desligada.
  const tetoAtivacao = alvos?.config?.maxActivationsPerRun;
  const semTetoAtivacao = !!alvos?.config?.activateCoupons && tetoAtivacao === null;
  const quantosAtiva = semTetoAtivacao ? "todos eles" : `até ${tetoAtivacao}`;

  return (
    <div>
      {/* A varredura sem navegador vem primeiro: é ela que põe os produtos dos cupons
          no catálogo sozinha. Quando termina, relê a página — o botão 2 passa a
          começar pelos cupons que ela não conseguiu ler. */}
      <CouponLandingSweep onRodou={recarregar} />

      <div style={cardStyle}>
        <div style={{ fontWeight: 500, marginBottom: 4 }}>Puxar os cupons do Mercado Livre</div>
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 12, lineHeight: 1.5 }}>
          Duas etapas, em dois botões. A <b>primeira</b> abre a lista geral do ML numa aba deste
          Chrome e guarda <b>todos</b> os cupons com as condições de cada um — é só leitura, não
          mexe na sua conta. A <b>segunda</b> busca os produtos de cada cupom, e essa precisa
          aceitar (“Eu quero”) os que ainda não foram aceitos: sem isso o ML não mostra a vitrine.
          As duas demoram minutos e vão se atualizando sozinhas. A <b>terceira</b> faz as duas
          seguidas e repete a busca de produtos em ciclos até não sobrar cupom nenhum sem eles.
        </div>

        {s && (
          <div style={{ display: "flex", gap: 18, flexWrap: "wrap", fontSize: 12, marginBottom: 12 }}>
            <Numero label="Cupons guardados" valor={s.cupons} />
            <Numero label="Ainda válidos" valor={s.validos} />
            <Numero label="Com vitrine raspada" valor={s.comVitrine} />
            <Numero label="Sem produtos ainda" valor={faltamProdutos} />
            <Numero label="Vínculos cupom↔produto" valor={s.vinculos} />
            {/* Quanto do número acima é prévia (landing ou miniaturas do card) e
                não vitrine fechada. Fica ao lado de propósito: sem ele, "3.000
                vínculos" parece cobertura que o sistema não tem. */}
            <Numero label="…destes, parciais" valor={s.parciais ?? 0} />
            <Numero label="Produtos do catálogo com cupom" valor={s.catalogo} />
            <Numero label="Com palavra descoberta" valor={s.comCodigo} />
          </div>
        )}

        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {/* ETAPA 1. Leitura pura — dá pra clicar à vontade. */}
          {rodandoNoChrome ? (
            <button onClick={() => { pararRef.current = true; }} style={botaoSecundario}>
              Parar a varredura
            </button>
          ) : (
            <button
              onClick={rodarNoChrome}
              disabled={!colheLista || rodando || buscandoProdutos}
              style={botaoPrimario(!colheLista || rodando || buscandoProdutos)}
              title={!colheLista
                ? "Precisa da extensão do Chrome instalada — o ML responde CAPTCHA para navegador automatizado."
                : "Abre a lista geral de cupons do ML numa aba deste Chrome e guarda todos, com as condições. Não mexe na sua conta."}
            >
              1 · Buscar cupons e condições
            </button>
          )}

          {/* ETAPA 2. Separada porque ESCREVE na conta do ML. */}
          {buscandoProdutos ? (
            <button onClick={() => { pararRef.current = true; }} style={botaoSecundario}>
              Parar a busca
            </button>
          ) : (
            <button
              onClick={() => rodarProdutos()}
              disabled={!temColetor || rodando || rodandoNoChrome || !faltamProdutos}
              style={botaoPrimario(!temColetor || rodando || rodandoNoChrome || !faltamProdutos)}
              title={!temColetor
                ? "Precisa da extensão do Chrome instalada."
                : !faltamProdutos
                  ? "Todos os cupons guardados já têm produtos."
                  : `Abre a vitrine de ${faltamProdutos} cupom(ns), uma aba por vez.${precisamAtivar ? ` ${precisamAtivar} deles ainda não foram aceitos — o ML só mostra a vitrine depois do “Eu quero”, então ${quantosAtiva} vão ser ativados na sua conta.` : ""}`}
            >
              2 · Buscar produtos dos que faltam{faltamProdutos ? ` (${faltamProdutos})` : ""}
            </button>
          )}

          {/* ETAPA 1 + ETAPA 2 em ciclos, até acabar. Some enquanto qualquer uma das
              duas roda: o "Parar" que aparece no lugar delas já interrompe este
              também, porque é a mesma `pararRef`. */}
          {!rodandoNoChrome && !buscandoProdutos && (
            <button
              onClick={rodarTudo}
              disabled={!colheLista || !temColetor || rodando}
              style={botaoPrimario(!colheLista || !temColetor || rodando)}
              title={!colheLista || !temColetor
                ? "Precisa da extensão do Chrome instalada."
                : `Varre a lista inteira e depois busca os produtos em ciclos, até não sobrar nenhum. Ativa ${semTetoAtivacao ? "todos os cupons" : `até ${tetoAtivacao} cupons por ciclo`} na sua conta do ML.`}
            >
              3 · Buscar TUDO (até acabar)
            </button>
          )}

          {/* Desabilitado durante a varredura porque a rota devolve 409 — melhor
              não deixar clicar do que explicar o erro depois de confirmar. */}
          <button
            onClick={() => setConfirmarLimpeza(true)}
            disabled={limpando || rodando || rodandoNoChrome || buscandoProdutos || semCupom}
            style={botaoPerigo(limpando || rodando || rodandoNoChrome || buscandoProdutos || semCupom)}
          >
            {limpando ? "Apagando..." : "🗑 Apagar todos"}
          </button>
        </div>

        {/* O filtro da fila dos botões 2 e 3 (task 11). Fica colado nos botões, e
            não nos filtros da tabela, porque muda o que ELES vão buscar — a tabela
            continua mostrando todos. */}
        <label style={{ marginTop: 8, fontSize: 12, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <input
            type="checkbox"
            checked={soSemProdutos}
            disabled={buscandoProdutos || rodandoNoChrome}
            onChange={e => setSoSemProdutos(e.target.checked)}
          />
          só os que não têm nenhum produto (pula os parciais)
          {soSemProdutos && alvos?.parciaisFora > 0 && (
            <span style={{ color: "var(--color-text-secondary)" }}>
              · {alvos.parciaisFora} parcial(is) ficam de fora
            </span>
          )}
        </label>

        {/* O aviso do que a etapa 2 vai escrever na conta. Fica FORA do title do
            botão de propósito: "ativar" é irreversível, e um aviso que só aparece
            no hover é um aviso que ninguém leu. */}
        {precisamAtivar > 0 && (
          <div style={{ marginTop: 8, fontSize: 11, color: "var(--color-text-secondary)", lineHeight: 1.5 }}>
            <b>{precisamAtivar}</b> cupom(ns) ainda não foram aceitos na sua conta. O ML só revela a vitrine
            depois do “Eu quero”, então a etapa 2 vai clicar nisso — <b>escrita irreversível</b>,{" "}
            {semTetoAtivacao ? <>em <b>todos</b> eles, sem teto por rodada</> : <>até <b>{tetoAtivacao}</b> por rodada</>}.{" "}
            {!tetoAtivacao && !semTetoAtivacao && "Está desligada: ligue a ativação nos limites abaixo."}
          </div>
        )}

        {/* Trazer UMA campanha pelo número dela (task 32). Fica junto dos botões das
            etapas porque é a quarta forma de um cupom entrar aqui — e a única que
            não depende de varrer a lista inteira nem de ter testado uma palavra. */}
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: "0.5px solid var(--color-border-tertiary)" }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input
              placeholder="13495993 ou o link do cupom"
              value={idColado}
              onChange={e => { setIdColado(e.target.value); setRecadoId(null); }}
              onKeyDown={e => { if (e.key === "Enter" && !procurandoId) trazerPorId(); }}
              style={{ ...inputStyle, width: 280 }}
            />
            <button
              onClick={trazerPorId}
              disabled={procurandoId || !idColado.trim()}
              style={botaoSecundario}
              title="Procura essa campanha no que já está guardado e, se ela não estiver aqui, oferece buscá-la no ML."
            >
              {procurandoId ? "procurando..." : "Trazer campanha por ID"}
            </button>
          </div>
          <div style={{ marginTop: 6, fontSize: 11, color: "var(--color-text-secondary)", lineHeight: 1.5 }}>
            O número da campanha é o <code>coupon_campaign_id</code> do link do cupom — o mesmo{" "}
            <code>#</code> que aparece em cada linha da tabela.
          </div>
          {recadoId && (
            <div style={{ marginTop: 6, fontSize: 12, color: recadoId.tom === "erro" ? "var(--danger-text)" : "var(--color-text-secondary)" }}>
              {recadoId.texto}
            </div>
          )}
        </div>

        {/* O balanço da última varredura. O log vive na memória do processo da API
            (backend/coupons/sync.js) e some se ele reiniciar — o RESUMO é o que
            fica guardado, e é ele que responde "quando foi a última vez?". */}
        {status?.lastRun && !rodandoNoChrome && !buscandoProdutos && (
          <ColheitaLog eventos={[]} rodando={false} resumo={resumoDaRodada(status)} />
        )}
        {status?.lastError && (
          <div style={{ marginTop: 8, background: "var(--warn-bg)", color: "var(--warn-text)", padding: "8px 10px", borderRadius: 8, fontSize: 12 }}>
            {status.lastError}
          </div>
        )}
        {erro && (
          <div style={{ marginTop: 8, background: "var(--danger-bg)", color: "var(--danger-text)", padding: "8px 10px", borderRadius: 8, fontSize: 12 }}>
            {erro}
          </div>
        )}

        <Config config={status?.config} labels={status?.groupingLabels} onSaved={recarregar} />
      </div>

      <div style={cardStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
          <div style={{ fontWeight: 500 }}>Cupons guardados <span style={{ color: "var(--color-text-secondary)", fontWeight: 400 }}>({lista.total})</span></div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input
              placeholder="buscar por título, loja, palavra ou nº da campanha"
              value={filtros.q}
              onChange={e => setFiltros(f => ({ ...f, q: e.target.value, page: 1 }))}
              style={{ ...inputStyle, width: 240 }}
            />
            {/* Cupom de loja é a "categoria" que o ML não dá como categoria: ele
                vem no subtítulo ("Em produtos de X"), e o backend o separa em
                `scope`. Fica aqui, ao lado do filtro de vertical, porque para quem
                olha a tabela os dois respondem a mesma pergunta. */}
            <select value={filtros.scope} onChange={e => setFiltros(f => ({ ...f, scope: e.target.value, page: 1 }))} style={inputStyle}>
              <option value="">todos os tipos</option>
              <option value="campaign">campanha do ML</option>
              <option value="store">cupom de loja</option>
            </select>
            {categorias.length > 0 && (
              <select value={filtros.grouping} onChange={e => setFiltros(f => ({ ...f, grouping: e.target.value, page: 1 }))} style={inputStyle}>
                <option value="">todas as categorias</option>
                {categorias.map(g => (
                  <option key={g.chave} value={g.chave}>{rotuloCategoria(g.chave, labelsCategoria)} ({g.n})</option>
                ))}
              </select>
            )}
            <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}>
              <input type="checkbox" checked={filtros.onlyValid} onChange={e => setFiltros(f => ({ ...f, onlyValid: e.target.checked, page: 1 }))} />
              só os que ainda valem
            </label>
          </div>
        </div>

        {(andamento || salvo || eventos.length > 0 || resumoColheita) && (
          <div style={{ marginBottom: 10 }}>
            <ProgressoColheita andamento={andamento} />
            {salvo && (
              <div style={{ fontSize: 12, color: "var(--color-text-primary)", fontWeight: 600, marginTop: 2 }}>
                💾 salvo: {salvo.lotes}/{salvo.de} lote(s) · {salvo.vitrines} vitrine(s) · {salvo.produtos.toLocaleString("pt-BR")} produto(s)
                {salvo.em ? ` · ${new Date(salvo.em).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}` : ""}
              </div>
            )}
            <ColheitaLog
              eventos={eventos}
              resumo={resumoColheita}
              rodando={buscandoProdutos || rodandoNoChrome}
              titulo={buscandoProdutos || rodandoNoChrome ? "O que está acontecendo agora" : "O que aconteceu"}
            />
          </div>
        )}

        {/* Sem a extensão o botão "no meu Chrome" some — e sumir sem explicação é
            pior do que não existir. Esta linha diz onde ele foi parar. */}
        {temColetor === false && (
          <div style={{ marginBottom: 10 }}><ExtensaoAusente /></div>
        )}

        {lista.items.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
            Nenhum cupom guardado ainda — clique em “1 · Buscar cupons e condições”.
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ textAlign: "left", color: "var(--color-text-secondary)" }}>
                  <th style={th}>Cupom</th>
                  <th style={th}>Categoria</th>
                  <th style={th}>Desconto</th>
                  <th style={th}>Mín / Teto</th>
                  <th style={th}>Tipo</th>
                  <th style={th}>Vence</th>
                  <th style={th}>Produtos</th>
                  <th style={th}>No catálogo</th>
                  <th style={th}>Palavra</th>
                  <th style={th}></th>
                </tr>
              </thead>
              <tbody>
                {lista.items.map(c => (
                  // Fragment com key: a linha do cupom e a linha expandida dos
                  // produtos são dois <tr> irmãos para o mesmo item da lista.
                  <Fragment key={c.campaignId}>
                    <tr style={{ borderTop: "0.5px solid var(--color-border-tertiary)" }}>
                      <td style={td}>
                        <div style={{ fontWeight: 500 }}>{c.title}</div>
                        {c.subtitle && <div style={{ color: "var(--color-text-secondary)" }}>{c.subtitle}</div>}
                        <NumeroDaCampanha id={c.campaignId} />
                      </td>
                      <td style={{ ...td, color: "var(--color-text-secondary)" }}>{categoriasDoCupom(c, labelsCategoria)}</td>
                      <td style={td}>{desconto(c)}</td>
                      <td style={td}>{c.minPurchase ? brl(c.minPurchase) : "sem mínimo"}{c.maxDiscount ? ` / ${brl(c.maxDiscount)}` : ""}</td>
                      <td style={td}>{c.scope === "store" ? `loja${c.sellerName ? ` (${c.sellerName})` : ""}` : "campanha"}{!c.activated && " · não ativado"}</td>
                      <td style={td}>{dia(c.expiresAt)}</td>
                      <td style={td}>
                        <div>{c.products || 0}</div>
                        <EstadoProdutos cupom={c} />
                      </td>
                      <td style={td}>{c.inCatalog || 0}</td>
                      <td style={td}>
                        <div style={{ fontFamily: "monospace" }}>{c.code || "—"}</div>
                        {c.code && FONTE_PALAVRA[c.codeSource] && (
                          <div style={{ color: "var(--color-text-secondary)", fontSize: 11 }}>
                            {FONTE_PALAVRA[c.codeSource]}{c.codeCheckedAt ? ` · ${dia(c.codeCheckedAt)}` : ""}
                          </div>
                        )}
                      </td>
                      <td style={td}>
                        <div style={{ display: "flex", gap: 6 }}>
                          <button onClick={() => verProdutos(c.campaignId)} style={botaoLink}>
                            {aberto === c.campaignId ? "fechar" : "produtos"}
                          </button>
                          {/* A etapa 2 para UM cupom. Passa pelo mesmo laço do
                              botão em lote: se este cupom ainda não foi aceito,
                              ele ativa só ele antes de abrir a vitrine. */}
                          {temColetor && (
                            <button
                              onClick={() => rodarProdutos([c.campaignId])}
                              disabled={buscandoProdutos || rodandoNoChrome}
                              style={botaoLink}
                              title={c.containerUrl
                                ? "Abre a vitrine deste cupom numa aba e guarda os produtos."
                                : "Este cupom ainda não foi aceito: vou clicar no “Eu quero” dele na sua conta e então abrir a vitrine."}
                            >
                              {colhendo === c.campaignId ? "⟳ buscando" : "buscar produtos"}
                            </button>
                          )}
                          <button
                            onClick={() => setConfirmarExclusao(c)}
                            disabled={rodandoNoChrome || buscandoProdutos || limpando}
                            style={botaoLink}
                            title="Apaga este cupom, os vínculos dele e o carimbo que ele deixou no catálogo."
                          >🗑</button>
                          {c.containerUrl ? (
                            <a href={c.containerUrl} target="_blank" rel="noreferrer" style={{ ...botaoLink, textDecoration: "none" }}>ML ↗</a>
                          ) : (
                            // Sem containerUrl não há vitrine para abrir: o ML só
                            // revela a URL dela depois do "Eu quero". O link vai
                            // para a lista de cupons da conta, e NÃO para este
                            // cupom — porque cupom não ativado não tem página
                            // própria no ML. O texto diz isso, senão parece que o
                            // sistema errou o endereço.
                            <a
                              href="https://www.mercadolivre.com.br/cupons"
                              target="_blank"
                              rel="noreferrer"
                              title={'Este cupom ainda não foi ativado, e cupom não ativado não tem página própria no ML — o link abre a lista dos seus cupons. A rodada ativa sozinha até o teto que você definiu; cupons cujo rótulo o ML repete entre campanhas diferentes ficam de fora, porque não dá para saber qual botão é qual.'}
                              style={{ ...botaoLink, textDecoration: "none", color: "var(--color-text-secondary)" }}
                            >meus cupons ↗</a>
                          )}
                        </div>
                      </td>
                    </tr>
                    {aberto === c.campaignId && (
                      <tr>
                        <td colSpan={10} style={{ ...td, background: "var(--color-background-secondary)" }}>
                          <Produtos dados={produtos[c.campaignId]} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {lista.total > lista.pageSize && (
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10, fontSize: 12 }}>
            <button disabled={filtros.page <= 1} onClick={() => setFiltros(f => ({ ...f, page: f.page - 1 }))} style={botaoSecundario}>anterior</button>
            <span style={{ color: "var(--color-text-secondary)" }}>
              página {lista.page} de {Math.ceil(lista.total / lista.pageSize)}
            </span>
            <button
              disabled={lista.page >= Math.ceil(lista.total / lista.pageSize)}
              onClick={() => setFiltros(f => ({ ...f, page: f.page + 1 }))}
              style={botaoSecundario}
            >próxima</button>
          </div>
        )}
      </div>

      {/* A campanha digitada que não estava aqui. O modal é o mesmo da aba
          "Descobrir palavra" — sem `word`, porque desta vez ninguém testou palavra
          nenhuma: veio um número. */}
      {trazendo && (
        <ImportarCampanhaModal
          campaignId={trazendo}
          onClose={() => setTrazendo(null)}
          onDone={(feito) => {
            // Filtra a lista na campanha que acabou de entrar, senão ela cai no meio
            // de 50 linhas e parece que nada aconteceu.
            setFiltros(f => ({ ...f, q: trazendo, onlyValid: false, page: 1 }));
            setRecadoId({ tom: "ok", texto: `${feito?.coupon?.title || `Campanha ${trazendo}`} entrou no sistema.` });
            recarregar();
          }}
        />
      )}

      {confirmarExclusao && (
        <Modal title="Apagar este cupom?" onClose={() => setConfirmarExclusao(null)} danger>
          <p style={{ fontSize: 13, marginBottom: 16, color: "var(--color-text-secondary)", lineHeight: 1.5 }}>
            <strong style={{ color: "var(--color-text-primary)" }}>{confirmarExclusao.title}</strong> sai da lista, junto com os{" "}
            <strong style={{ color: "var(--color-text-primary)" }}>{confirmarExclusao.products || 0}</strong> vínculos com produtos, e os
            produtos do catálogo que ele carimbava perdem o carimbo. A palavra dele, se houver, continua guardada.
            Ele volta na próxima varredura se o ML ainda o oferecer.
          </p>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button onClick={() => setConfirmarExclusao(null)} style={botaoSecundario}>Cancelar</button>
            <button
              onClick={apagarUm}
              style={{ padding: "8px 16px", borderRadius: 8, background: "#E24B4A", color: "#fff", border: "none", fontSize: 13, fontWeight: 500, cursor: "pointer" }}
            >Apagar cupom</button>
          </div>
        </Modal>
      )}

      {confirmarLimpeza && (
        <Modal title="Apagar todos os cupons?" onClose={() => setConfirmarLimpeza(false)} danger>
          <p style={{ fontSize: 13, marginBottom: 16, color: "var(--color-text-secondary)", lineHeight: 1.5 }}>
            Os <strong style={{ color: "var(--color-text-primary)" }}>{s?.cupons ?? 0}</strong> cupons guardados e os{" "}
            <strong style={{ color: "var(--color-text-primary)" }}>{s?.vinculos ?? 0}</strong> vínculos com produtos serão apagados, e os{" "}
            <strong style={{ color: "var(--color-text-primary)" }}>{s?.catalogo ?? 0}</strong> produtos do catálogo perdem o carimbo de cupom.
            As <strong style={{ color: "var(--color-text-primary)" }}>palavras já testadas continuam guardadas</strong> — cada uma custa um
            Chrome aberto com a conta do sistema pra redescobrir, e elas voltam a carimbar o cupom na próxima rodada.
            Esta ação não pode ser desfeita.
          </p>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button onClick={() => setConfirmarLimpeza(false)} style={botaoSecundario}>Cancelar</button>
            <button
              onClick={limparTudo}
              style={{ padding: "8px 16px", borderRadius: 8, background: "#E24B4A", color: "#fff", border: "none", fontSize: 13, fontWeight: 500, cursor: "pointer" }}
            >Apagar tudo</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// Os produtos de um cupom vêm de três lugares e valem coisas diferentes, então a
// tela não pode mostrar os três como se fossem a mesma coisa:
//
//   vitrine — a lista inteira, raspada da página do cupom (_Container_).
//   landing — a prévia de 3-8 itens que a landing de afiliado entrega sem abrir
//             navegador. É o que funciona hoje, com o muro anti-bot de pé.
//   amostra — as 4 miniaturas que o card do cupom mostra na aba /cupons, e o
//             ÚNICO vínculo possível do cupom não ativado.
//
// Quem olha esta lista precisa saber qual está vendo: "5 produtos" de prévia não
// quer dizer que o cupom cobre só 5.
const ORIGEM = {
  vitrine: "vitrine",
  landing: "prévia (landing)",
  amostra: "miniatura do card",
};
// Em que pé está a lista de produtos do cupom. `productsSyncedAt` só é escrito
// quando a vitrine inteira foi raspada; vínculo sem ele é prévia (landing,
// miniaturas, checkout) — o "parcial" que o checkbox dos botões 2 e 3 pula.
function EstadoProdutos({ cupom }) {
  const [texto, cor] = cupom.productsSyncedAt
    ? ["completa", "var(--success-text)"]
    : cupom.products > 0
      ? ["parcial", "var(--warn-text)"]
      : ["nenhum", "var(--color-text-secondary)"];
  return <div style={{ fontSize: 11, color: cor }}>{texto}</div>;
}

function Produtos({ dados }) {
  if (!dados) return <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>carregando…</span>;
  if (!dados.items.length) {
    return (
      <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
        Nenhum produto guardado para este cupom — clique em “raspar” para abrir a vitrine dele no ML.
      </span>
    );
  }
  const parciais = dados.items.filter(p => p.origem !== "vitrine").length;
  const soParcial = parciais === dados.items.length;
  return (
    <div>
      <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 6 }}>
        {dados.total} produto(s) neste cupom
        {soParcial
          ? " — só uma prévia; a vitrine completa dele ainda não foi raspada"
          : parciais ? ` (${parciais} de prévia, não da vitrine completa)` : ""}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {dados.items.map(p => (
          <div key={p.productKey} style={{ display: "flex", gap: 10, alignItems: "center", fontSize: 12 }}>
            {p.catalog?.img && <img src={p.catalog.img} alt="" width={34} height={34} style={{ objectFit: "contain", borderRadius: 6 }} />}
            <a href={p.productUrl} target="_blank" rel="noreferrer" style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "inherit" }}>
              {p.catalog?.name || p.productUrl}
            </a>
            <span style={{ color: "var(--color-text-secondary)" }}>{brl(p.catalog?.price)}</span>
            <span style={{ color: "var(--color-text-secondary)" }}>
              {ORIGEM[p.origem] || p.origem || "vitrine"}
            </span>
            <span style={{ color: p.inCatalog ? PRIMARY_DARK : "var(--color-text-secondary)" }}>
              {p.inCatalog ? "no catálogo" : "fora do catálogo"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Os tetos da rodada. Ficam à vista porque são eles que seguram o tempo (e o
// atrito com o ML): a conta enxerga milhares de cupons, e cada um é uma página.
// Um campo numérico da config. Existem doze deles agora — repetir o label + input
// + onChange doze vezes é onde um `min` errado passa despercebido.
function Numerico({ cfg, setCfg, chave, label, min, max, dica, largura = 120 }) {
  return (
    <div>
      <label style={labelStyle} title={dica}>{label}</label>
      <input
        type="number" min={min} max={max} value={cfg[chave] ?? ""}
        onChange={e => setCfg(c => ({ ...c, [chave]: Number(e.target.value) }))}
        style={{ ...inputStyle, width: largura }}
      />
    </div>
  );
}

function Marcador({ cfg, setCfg, chave, label }) {
  return (
    <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 6, paddingBottom: 8 }}>
      <input type="checkbox" checked={cfg[chave] !== false} onChange={e => setCfg(c => ({ ...c, [chave]: e.target.checked }))} />
      {label}
    </label>
  );
}

export function Config({ config, labels, onSaved }) {
  // O que está sendo editado, se alguém mexeu; senão, o que o servidor mandou.
  // Estado derivado em vez de efeito copiando prop pra estado — que é o que
  // desfaria a edição sozinho a cada volta do poll de status.
  const [edit, setEdit] = useState(null);
  const [salvando, setSalvando] = useState(false);
  const cfg = edit || config;
  const setCfg = (fn) => setEdit(typeof fn === "function" ? fn(cfg) : fn);
  if (!cfg) return null;

  const salvar = async () => {
    setSalvando(true);
    try { await adminMlCuponsSaveConfig(cfg); onSaved?.(); } catch { /* o erro aparece na próxima leitura */ }
    finally { setSalvando(false); }
  };

  // As categorias que dá pra escolher para o CARIMBO. Só as VERTICAIS: o
  // dicionário do ML mistura filtro com categoria — `price` ("Mais de R$100"),
  // `percentage`, `recommended` estão na mesma lista, e carimbar por eles poria no
  // cupom uma "categoria" que não existe. O sufixo é o que o próprio ML usa.
  const verticais = Object.keys(labels || {})
    .filter(k => /_vertical$/.test(k))
    .sort((a, b) => rotuloCategoria(a, labels).localeCompare(rotuloCategoria(b, labels), "pt-BR"));
  const escolhidas = Array.isArray(cfg.categorias) ? cfg.categorias : [];
  const alternar = (chave) => setCfg(c => {
    const atuais = Array.isArray(c.categorias) ? c.categorias : [];
    return { ...c, categorias: atuais.includes(chave) ? atuais.filter(k => k !== chave) : [...atuais, chave] };
  });

  const linha = { display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end", marginTop: 10 };
  const titulo = { fontWeight: 500, fontSize: 12, marginTop: 16 };
  const nota = { fontSize: 11, color: "var(--color-text-secondary)", marginTop: 8, lineHeight: 1.5 };

  return (
    <div style={{ marginTop: 16, borderTop: "0.5px solid var(--color-border-tertiary)", paddingTop: 12 }}>
      <div style={{ fontWeight: 500, marginBottom: 2 }}>Limites</div>
      <div style={nota}>
        Tudo o que as duas etapas fazem cabe aqui. Cada página aberta é uma visita ao ML com a
        sua conta — a mesma do Hub de Afiliados —, então subir muito estes números aumenta a
        chance de o ML pedir verificação.
      </div>

      <div style={titulo}>Etapa 1 — a lista</div>
      <div style={linha}>
        <Numerico cfg={cfg} setCfg={setCfg} chave="maxPaginasLista" label="Páginas da lista geral" min={1} max={200}
          dica="A lista traz 30 cupons por página. 40 páginas = 1.200 cupons." />
        <Numerico cfg={cfg} setCfg={setCfg} chave="limiteCupons" label="Teto de cupons (0 = todos)" min={0} max={20000} largura={140} />
        <Marcador cfg={cfg} setCfg={setCfg} chave="carimbarCategorias" label="carimbar a categoria (passada por vertical)" />
        <Numerico cfg={cfg} setCfg={setCfg} chave="maxPaginasPorCategoria" label="Páginas por categoria" min={1} max={200}
          dica="Também 30 por página. A maior vertical da conta tem ~1.170 cupons: 40 páginas cobrem 1.200. Cupom além deste teto fica sem categoria." />
        <Marcador cfg={cfg} setCfg={setCfg} chave="skipStoreCoupons" label="ignorar cupom de loja" />
      </div>
      <div style={nota}>
        A coleta é a <b>lista geral</b> (<code>?all=true</code>), que traz todos os cupons da conta.
        As passadas por categoria vêm depois e servem só para <b>carimbar</b> a vertical em quem já
        entrou: a lista do ML não diz a que categoria cada cupom pertence — quem diz é o filtro que
        a gente pede na URL. Sem elas a coluna Categoria fica vazia. <b>Quais</b> categorias existem
        a rodada descobre sozinha, na primeira página: o ML manda a lista delas em toda página da
        lista de cupons, e é por isso que a caixa abaixo pode ficar em branco sem prejuízo.
        Cupom de <b>loja</b> agora entra por padrão e aparece separado na tabela; ligar o último
        marcador volta ao comportamento antigo, em que ele era descartado. Cupom de loja não entra
        em vertical nenhuma no ML — a Categoria dele é “—” por natureza, e quem o identifica é a
        coluna Tipo.
      </div>

      {verticais.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", marginBottom: 6 }}>
            <label style={labelStyle}>Categorias a carimbar</label>
            <span style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>
              {escolhidas.length ? `${escolhidas.length} escolhida${escolhidas.length === 1 ? "" : "s"}` : "carimba todas"}
            </span>
            {escolhidas.length > 0 && (
              <button type="button" onClick={() => setCfg(c => ({ ...c, categorias: [] }))} style={botaoLink}>
                carimbar todas
              </button>
            )}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px" }}>
            {verticais.map(chave => (
              <label key={chave} style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}>
                <input type="checkbox" checked={escolhidas.includes(chave)} onChange={() => alternar(chave)} />
                {rotuloCategoria(chave, labels)}
              </label>
            ))}
          </div>
        </div>
      )}

      <div style={titulo}>Etapa 2 — os produtos</div>
      <div style={linha}>
        <Numerico cfg={cfg} setCfg={setCfg} chave="maxProductsPerCoupon" label="Produtos por cupom" min={10} max={500} />
        <Numerico cfg={cfg} setCfg={setCfg} chave="maxPaginasVitrine" label="Páginas da vitrine" min={1} max={20}
          dica="A vitrine anda de 48 em 48 produtos. 11 páginas = até 528, o suficiente pro teto de 500." />
        <Numerico cfg={cfg} setCfg={setCfg} chave="pausaEntreVitrinesMs" label="Pausa entre vitrines (ms)" min={500} max={30000} largura={140} />
        <Numerico cfg={cfg} setCfg={setCfg} chave="vitrinesEmParalelo" label="Vitrines em paralelo" min={1} max={4}
          dica="Quantas vitrines abrem ao mesmo tempo (1 a 4). Mais abas é mais rápido, e também mais chance de o ML pedir verificação: o primeiro pedido para todas." />
        <Numerico cfg={cfg} setCfg={setCfg} chave="tamanhoLoteProdutos" label="Cupons por lote" min={1} max={200}
          dica="Ativa, colhe e grava este tanto de cupons antes de passar aos próximos. Parar no meio perde no máximo o lote em andamento." />
        <Marcador cfg={cfg} setCfg={setCfg} chave="activateCoupons" label="aceitar os cupons automaticamente (“Eu quero”)" />
        <Numerico cfg={cfg} setCfg={setCfg} chave="maxActivationsPerRun" label="Aceites por rodada" min={0} max={500}
          dica="0 = sem teto (aceita todos). Para não aceitar nenhum, desmarque a caixa acima." />
      </div>
      <div style={nota}>
        <b>Aceitar é ESCRITA na sua conta do Mercado Livre</b> — é o mesmo “Eu quero” que você
        clicaria à mão, e não há como desfazer por aqui. É também a única forma de o cupom ter
        vitrine: sem aceitar, o ML não diz quais produtos ele cobre. A conta é a mesma do Hub de
        Afiliados, então a etapa 2 vai com pausa entre as abas e para no primeiro pedido de
        verificação — mas <b>sem teto de aceites ela clica em todos de uma vez</b>, que é o padrão
        que mais acorda o anti-robô. O mesmo vale para as <b>vitrines em paralelo</b>: cada aba a mais
        é mais uma batendo no ML com a mesma conta. Enquanto um lote colhe, o próximo já vai sendo
        aceito numa aba à parte. Se o teto de produtos cortar a vitrine no meio, ela entra
        marcada como <b>parcial</b> — prévia, não lista fechada.
      </div>

      <div style={titulo}>Buscar TUDO — os ciclos</div>
      <div style={linha}>
        <Numerico cfg={cfg} setCfg={setCfg} chave="pausaEntreCiclosMs" label="Pausa entre ciclos (ms)" min={5000} max={600000} largura={150} />
        <Numerico cfg={cfg} setCfg={setCfg} chave="maxCiclos" label="Máximo de ciclos" min={1} max={200} />
      </div>
      <div style={nota}>
        O botão 3 repete a etapa 2 até a fila esvaziar. Ele já para sozinho quando não sobra
        cupom, quando o ML pede verificação e quando um ciclo inteiro não move nada — o
        <b> máximo de ciclos</b> é só rede de segurança. A pausa entre ciclos é o intervalo em que
        a sua conta fica quieta; é maior que a pausa entre vitrines de propósito.
      </div>

      <div style={{ marginTop: 12 }}>
        <button onClick={salvar} disabled={salvando} style={botaoSecundario}>{salvando ? "salvando…" : "salvar"}</button>
      </div>
    </div>
  );
}
