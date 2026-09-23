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
  adminMlCupons, adminMlCuponsStatus,
  adminMlCuponsProducts, adminMlCuponsClearAll, adminMlCuponsDelete,
  adminMlCuponsAlvosProdutos, adminMlCuponsLocalFim, adminMlCuponsRodadaFim, errText,
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
import { LimitesLista, LimitesProdutos, LimitesCiclos } from "../components/admin/LimitesCupons";
import {
  segundos, brl, dia, desconto, cardStyle, inputStyle, th, td,
  botaoPrimario, botaoSecundario, botaoPerigo, botaoLink,
} from "../components/admin/cupomEstilos";

// O balanço da última vez de CADA botão, guardado no servidor — é o que sobrevive
// a um F5 e ao restart do backend (`status.ultimas`, backend/coupons/sync.js).
// Um por botão (task 17) porque os três fazem coisas diferentes: com um slot só,
// a ativação de um lote do botão 2 sobrescrevia o balanço da lista do botão 1, e
// os botões 2 e 3 nem deixavam o deles.
const BALANCOS = [
  {
    chave: "lista",
    nome: "1 · Cupons e condições",
    numeros: (r) => [
      { label: "Cupons", valor: r.cupons },
      { label: "Novos", valor: r.novos },
      { label: "Atualizados", valor: r.atualizados },
      { label: "De loja ignorados", valor: r.cuponsDeLojaIgnorados },
    ],
  },
  {
    chave: "produtos",
    nome: "2 · Produtos dos que faltam",
    numeros: (r) => [
      { label: "Lotes salvos", valor: r.lotes },
      { label: "Cupons ativados", valor: r.ativados },
      { label: "Tentados", valor: r.tentados },
      { label: "Colhidos", valor: r.colhidos },
      { label: "Produtos gravados", valor: r.produtos },
      { label: "…destas, parciais", valor: r.parciais },
      { label: "Vitrine vazia", valor: r.vazias },
      { label: "Falharam", valor: r.falharam },
    ],
  },
  {
    chave: "tudo",
    nome: "3 · Buscar TUDO",
    numeros: (r) => [
      { label: "Cupons na lista", valor: r.cuponsNaLista },
      { label: "Ciclos", valor: r.ciclos },
      { label: "Lotes salvos", valor: r.lotes },
      { label: "Cupons ativados", valor: r.ativados },
      { label: "Vitrines colhidas", valor: r.colhidos },
      { label: "Produtos gravados", valor: r.produtos },
      { label: "Ficaram de fora", valor: r.ficaramDeFora },
    ],
  },
];

function resumoDoBotao({ nome, numeros }, u) {
  return {
    titulo: `${nome} — última vez ${new Date(u.at).toLocaleString("pt-BR")}${u.interrompida ? " (interrompida)" : ""}`,
    tom: u.erro || u.interrompida ? "aviso" : "ok",
    nota: u.erro || null,
    numeros: [
      ...numeros(u.resultado || {}).filter(n => n.valor != null),
      { label: "Duração", valor: segundos(u.duracaoMs) },
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
  // De quem é o painel do "agora": "lista" | "produtos" | "tudo" | null. Só uma
  // rodada existe por vez (os três botões se desabilitam entre si), então um slot
  // basta — e é ele que leva o progresso e o resumo para dentro do card do botão que
  // foi clicado, em vez de deixá-los num rodapé comum lá embaixo (task 19). Não zera
  // quando a rodada acaba, de propósito: o resumo do que acabou de acontecer é a
  // resposta daquele card.
  const [painelDe, setPainelDe] = useState(null);
  // "Até os limites abaixo" × "tudo o que o ML tiver" (task 20). Lembrado por
  // navegador, como o `soSemProdutos`: é preferência de quem opera, não estado do
  // sistema. E é uma ESCOLHA, não um número — virar config no servidor seria criar um
  // décimo quinto campo justamente para resolver a confusão dos quatorze.
  const [listaSemTeto, setListaSemTeto] = useState(() => {
    try { return localStorage.getItem("cupons.listaSemTeto") === "1"; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem("cupons.listaSemTeto", listaSemTeto ? "1" : "0"); } catch { /* sem storage, só não lembra */ }
  }, [listaSemTeto]);
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
  const varrerLista = async ({ tudo = false, semTeto = false, resumir = true } = {}) => {
    pararRef.current = false;
    setRodandoNoChrome(true);
    setErro(null);
    // `resumir: false` é o botão 3 chamando esta etapa por dentro: o card dono do
    // painel continua sendo o dele, e não o do botão 1.
    if (resumir) { setPainelDe("lista"); setEventos([]); setResumoColheita(null); andar({ tipo: "reiniciar" }); }
    const t0 = Date.now();
    // Uma aba por trabalhador (task 21): com `paginasDeListaEmParalelo` em 1 é a
    // mesma aba única de sempre, e aí esta lista tem um item só.
    let abas = [];
    let resumoLista;
    let parado;

    try {
      const r = await percorrerLista({
        tudo,
        semTeto,
        parou: () => pararRef.current,
        log: logar,
        onProgresso: avisarMuro,
      });
      abas = r.abas || (r.tabId != null ? [r.tabId] : []);
      resumoLista = r.resumo;
      parado = r.parado;
    } catch (err) {
      parado = errText(err, "A varredura no seu Chrome parou com um erro.");
      logar("erro", parado);
    } finally {
      // `id => ...` e não a função direto: `map` passa (item, índice, lista), e o
      // índice viraria o segundo argumento de quem fecha a aba.
      await Promise.all(abas.map(id => fecharAbaDoColetor(id)));
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
      botao: "lista",
      titulo: parado ? "Varredura interrompida" : "Varredura terminada",
      tom: parado ? "aviso" : "ok",
      nota: parado
        ? `${parado}. O que já entrou está gravado — é só rodar de novo.`
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
    });
    return { parado, resumo: resumoLista };
  };

  const rodarNoChrome = () => varrerLista({ semTeto: listaSemTeto });

  // ETAPA 2 — os produtos. `campaignIds` null = todos os que faltam; com um id, é
  // o botão da linha. O laço (ativar → raspar) mora em `data/produtosNoChrome.js`,
  // que é o mesmo dos dois casos.
  const rodarProdutos = async (campaignIds = null) => {
    const umSo = campaignIds?.length === 1;
    pararRef.current = false;
    setBuscandoProdutos(true);
    // Inclusive o botão da linha da tabela: ele não é o botão 2 para efeito de
    // "última vez" (ver o `rodadaFim` lá embaixo), mas o que ele faz É buscar
    // produtos, e o card da etapa 2 é o único lugar da tela onde esse progresso tem
    // casa. Mandá-lo para lugar nenhum era a busca terminar sem dizer no que deu.
    setPainelDe("produtos");
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
    setResumoColheita({
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
    });
  };

  // O "buscar TUDO": a etapa 1 sem teto de páginas e depois a etapa 2 em ciclos,
  // até a fila esvaziar. É um botão só porque a pergunta que ele responde é uma só
  // ("traz tudo"), e porque parar no meio das duas etapas deixa cupom guardado sem
  // produto nenhum — que é exatamente o estado que ele existe para desfazer.
  const rodarTudo = async () => {
    pararRef.current = false;
    setErro(null);
    setPainelDe("tudo");
    setEventos([]);
    setResumoColheita(null);
    andar({ tipo: "reiniciar" });
    const t0 = Date.now();

    // `tudo: true` já implica o "sem teto" no servidor — e continua sendo outra
    // coisa: é ele que diz que esta passada é a do botão 3.
    const lista = await varrerLista({ tudo: true, resumir: false });
    if (lista?.parado || pararRef.current) {
      andar({ tipo: "encerrar" });
      adminMlCuponsRodadaFim({
        botao: "tudo",
        duracaoMs: Date.now() - t0,
        interrompida: true,
        erro: `${lista?.parado || "Interrompido por você"} (ainda na lista)`,
        resultado: { cuponsNaLista: lista?.resumo?.cupons ?? 0 },
      }).then(recarregar, () => {});
      setResumoColheita({ botao: "tudo",
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
    setResumoColheita({ botao: "tudo",
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

  // O balanço guardado de um botão, pronto para o `ColheitaLog`. `null` quando
  // aquele botão nunca rodou.
  const balancoDe = (chave) => {
    const b = BALANCOS.find(x => x.chave === chave);
    const u = status?.ultimas?.[chave];
    return b && u ? resumoDoBotao(b, u) : null;
  };

  // O "agora" de uma rodada, dentro do card de quem a disparou (task 19). Enquanto
  // este card não é o dono do painel, ele mostra o balanço guardado — que responde a
  // mesma pergunta ("o que este botão fez?") da última vez que ele rodou.
  const painelDaEtapa = (chave) => {
    if (painelDe !== chave) {
      const balanco = balancoDe(chave);
      return balanco ? <ColheitaLog eventos={[]} rodando={false} resumo={balanco} /> : null;
    }
    return (
      <div style={{ marginTop: 10 }}>
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
    );
  };

  // Os limites não se editam no meio de uma rodada: o `cfg` dela foi congelado lá no
  // `startLocalRun`, e deixar o campo ativo é prometer um efeito que não acontece.
  const emRodada = rodandoNoChrome || buscandoProdutos || rodando;

  return (
    <div>
      {/* CARD 0 — o que esta tela é, e os números do que já está guardado. O que
          vale para as três etapas mora aqui; o que é de uma etapa só mora no card
          dela (task 19). */}
      <div style={cardStyle}>
        <div style={{ fontWeight: 500, marginBottom: 4 }}>Puxar os cupons do Mercado Livre</div>
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 12, lineHeight: 1.5 }}>
          Três caminhos, um card para cada — com os limites e o “última vez” de cada um lá dentro.
          O <b>1</b> abre a lista geral do ML numa aba deste Chrome e guarda todos os cupons com as
          condições de cada um: é só leitura, não mexe na sua conta. O <b>2</b> busca os produtos de
          cada cupom, e precisa aceitar (“Eu quero”) os que ainda não foram aceitos — sem isso o ML
          não mostra a vitrine. O <b>3</b> faz os dois seguidos e repete a busca de produtos em
          ciclos até não sobrar cupom sem eles. Todos demoram minutos e vão se atualizando sozinhos.
        </div>

        {s && (
          <div style={{ display: "flex", gap: 18, flexWrap: "wrap", fontSize: 12, marginBottom: 12 }}>
            <Numero label="Cupons guardados" valor={s.cupons} />
            <Numero label="Ainda válidos" valor={s.validos} />
            <Numero label="Com vitrine raspada" valor={s.comVitrine} />
            <Numero label="Sem produtos ainda" valor={faltamProdutos} />
            <Numero label="Vínculos cupom↔produto" valor={s.vinculos} />
            {/* Quanto do número acima é pedaço de vitrine (ou checkout) e
                não vitrine fechada. Fica ao lado de propósito: sem ele, "3.000
                vínculos" parece cobertura que o sistema não tem. */}
            <Numero label="…destes, parciais" valor={s.parciais ?? 0} />
            <Numero label="Produtos do catálogo com cupom" valor={s.catalogo} />
            <Numero label="Com palavra descoberta" valor={s.comCodigo} />
          </div>
        )}

        {/* Sem a extensão os três botões ficam cinza — e é aqui que se diz por quê.
            Morando no card da tabela, a explicação ficava a três cards de distância
            do botão que ela explica. */}
        {temColetor === false && (
          <div style={{ marginBottom: 10 }}><ExtensaoAusente /></div>
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

        {erro && (
          <div style={{ marginTop: 8, background: "var(--danger-bg)", color: "var(--danger-text)", padding: "8px 10px", borderRadius: 8, fontSize: 12 }}>
            {erro}
          </div>
        )}
      </div>

      {/* CARD 1 — ETAPA 1. Leitura pura: dá pra clicar à vontade. */}
      <section style={cardStyle} role="region" aria-label="1 · Cupons e condições">
        <div style={{ fontWeight: 500, marginBottom: 4 }}>1 · Cupons e condições</div>
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 10, lineHeight: 1.5 }}>
          Abre a lista geral de cupons do ML numa aba deste Chrome e guarda todos, com desconto,
          mínimo, teto e validade. <b>Não mexe na sua conta.</b>
        </div>

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

        {/* Até onde ir (task 20). Rádio e não caixa de marcar: as duas saídas ficam
            escritas lado a lado, e é isso que transforma "configuração" em escolha.
            O número da primeira opção vem da config salva — ele aparece na FRASE, e
            não só num campo lá embaixo, que era o que ninguém ligava ao botão. */}
        <fieldset style={{ marginTop: 12, border: "none", padding: 0, margin: "12px 0 0" }}>
          <legend style={{ fontSize: 12, fontWeight: 500, padding: 0, marginBottom: 6 }}>Até onde ir na lista</legend>
          <label style={{ fontSize: 12, display: "flex", alignItems: "baseline", gap: 6, marginBottom: 4 }}>
            <input
              type="radio" name="ate-onde-na-lista"
              checked={!listaSemTeto}
              disabled={emRodada}
              onChange={() => setListaSemTeto(false)}
            />
            <span>
              até os limites abaixo
              <span style={{ color: "var(--color-text-secondary)" }}>
                {" "}— para em {status?.config?.maxPaginasLista ?? 40} páginas da lista geral
                (≈{((status?.config?.maxPaginasLista ?? 40) * 30).toLocaleString("pt-BR")} cupons)
                {status?.config?.limiteCupons ? `, ou em ${status.config.limiteCupons} cupons` : ""}.
              </span>
            </span>
          </label>
          <label style={{ fontSize: 12, display: "flex", alignItems: "baseline", gap: 6 }}>
            <input
              type="radio" name="ate-onde-na-lista"
              checked={listaSemTeto}
              disabled={emRodada}
              onChange={() => setListaSemTeto(true)}
            />
            <span>
              tudo o que o ML tiver
              <span style={{ color: "var(--color-text-secondary)" }}> — sem teto de páginas nem de cupons.</span>
            </span>
          </label>
          {listaSemTeto && (
            <div style={{ marginTop: 6, fontSize: 11, color: "var(--color-text-secondary)", lineHeight: 1.5 }}>
              <b>Sem teto não quer dizer sem fim.</b> A varredura para quando o ML diz que a lista
              acabou (ele declara quantas páginas tem em toda resposta), quando cinco páginas
              seguidas não trazem cupom novo, e quando você clica em Parar. O que já entrou fica
              gravado — rodar de novo não repete trabalho.
            </div>
          )}
        </fieldset>

        {painelDaEtapa("lista")}

        <details>
          <summary style={{ cursor: "pointer", fontSize: 12, marginTop: 12 }}>Limites desta etapa</summary>
          <LimitesLista
            config={status?.config}
            labels={status?.groupingLabels}
            onSaved={recarregar}
            desabilitado={emRodada}
            semTeto={listaSemTeto}
          />
        </details>
      </section>

      {/* CARD 2 — ETAPA 2. Separada porque ESCREVE na conta do ML. */}
      <section style={cardStyle} role="region" aria-label="2 · Produtos dos que faltam">
        <div style={{ fontWeight: 500, marginBottom: 4 }}>2 · Produtos dos que faltam</div>
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 10, lineHeight: 1.5 }}>
          Abre a vitrine de cada cupom que ainda não tem produtos e guarda o que ela lista. Precisa
          aceitar (“Eu quero”) os cupons ainda não aceitos: sem isso o ML não revela a vitrine.
        </div>

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

        {/* O filtro da fila (task 11). Mora AQUI, e não nos filtros da tabela, porque
            muda o que este botão vai buscar — a tabela continua mostrando todos. O
            botão 3 reusa a mesma escolha, e por isso o card dele a ecoa em vez de
            oferecer uma segunda caixa: dois controles sobre a mesma preferência é a
            cara do problema que a task 19 veio resolver. */}
        <label style={{ marginTop: 10, fontSize: 12, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
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

        {/* O aviso do que esta etapa vai escrever na conta. Fica FORA do title do
            botão de propósito: "ativar" é irreversível, e um aviso que só aparece
            no hover é um aviso que ninguém leu. */}
        {precisamAtivar > 0 && (
          <div style={{ marginTop: 8, fontSize: 11, color: "var(--color-text-secondary)", lineHeight: 1.5 }}>
            <b>{precisamAtivar}</b> cupom(ns) ainda não foram aceitos na sua conta. O ML só revela a vitrine
            depois do “Eu quero”, então a etapa 2 vai clicar nisso — <b>escrita irreversível</b>,{" "}
            {semTetoAtivacao ? <>em <b>todos</b> eles, sem teto por rodada</> : <>até <b>{tetoAtivacao}</b> por rodada</>}.{" "}
            {!tetoAtivacao && !semTetoAtivacao && "Está desligada: ligue a ativação nos limites desta etapa."}
          </div>
        )}

        {painelDaEtapa("produtos")}

        <details>
          <summary style={{ cursor: "pointer", fontSize: 12, marginTop: 12 }}>Limites desta etapa</summary>
          <LimitesProdutos config={status?.config} onSaved={recarregar} desabilitado={emRodada} />
        </details>
      </section>

      {/* CARD 3 — as duas etapas seguidas, em ciclos, até acabar. */}
      <section style={cardStyle} role="region" aria-label="3 · Buscar TUDO">
        <div style={{ fontWeight: 500, marginBottom: 4 }}>3 · Buscar TUDO (até acabar)</div>
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 10, lineHeight: 1.5 }}>
          Faz a etapa 1 e depois repete a etapa 2 em ciclos, até não sobrar cupom sem produtos. É um
          botão só porque a pergunta que ele responde é uma só — e porque parar entre as duas deixa
          cupom guardado sem produto nenhum, que é o estado que ele existe para desfazer.
        </div>

        {/* Some enquanto qualquer uma das duas roda: o "Parar" que aparece no card
            delas já interrompe este também, porque é a mesma `pararRef`. */}
        {rodandoNoChrome || buscandoProdutos ? (
          painelDe === "tudo" ? (
            <button onClick={() => { pararRef.current = true; }} style={botaoSecundario}>
              Parar
            </button>
          ) : null
        ) : (
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

        {/* O que ele herda dos outros dois cards. Eco somente-leitura, não uma
            segunda cópia dos controles: um controle, um dono. */}
        <div style={{ marginTop: 10, fontSize: 11, color: "var(--color-text-secondary)", lineHeight: 1.5 }}>
          Usa a lista <b>sem teto</b> sempre · o filtro do card 2 ({soSemProdutos ? "só os sem nenhum produto" : "todos os que faltam"}){" "}
          · {semTetoAtivacao ? "aceita todos os cupons" : `até ${tetoAtivacao} aceites`} por ciclo
          {status?.config?.maxCiclos ? ` · até ${status.config.maxCiclos} ciclos` : ""}.
        </div>

        {painelDaEtapa("tudo")}

        <details>
          <summary style={{ cursor: "pointer", fontSize: 12, marginTop: 12 }}>Limites desta etapa</summary>
          <LimitesCiclos config={status?.config} onSaved={recarregar} desabilitado={emRodada} />
        </details>
      </section>

      {/* CARD 4 — trazer UMA campanha pelo número dela (task 32). É a quarta forma
          de um cupom entrar, mas não é etapa: não tem limite, não tem "última vez" e
          não tem Parar. Fica entre os três botões e a tabela, que é a ponte entre
          "puxar do ML" e "o que está guardado". */}
      <div style={cardStyle}>
        <div style={{ fontWeight: 500, marginBottom: 8 }}>Trazer uma campanha pelo número</div>
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

// Os produtos de um cupom vêm todos da página dele (_Container_), mas valem coisas
// diferentes, então a tela não pode mostrar como se fossem a mesma coisa:
//
//   vitrine  — a lista inteira.
//   parcial  — um pedaço dela: a raspagem parou no muro ou num teto.
//   checkout — o checkout do ML aplicou o cupom naquele produto.
//
// Quem olha esta lista precisa saber qual está vendo: "5 produtos" de um pedaço
// não quer dizer que o cupom cobre só 5.
const ORIGEM = {
  vitrine: "vitrine",
  parcial: "vitrine parcial",
  checkout: "checkout",
};
// Em que pé está a lista de produtos do cupom. `productsSyncedAt` só é escrito
// quando a vitrine inteira foi raspada; vínculo sem ele é pedaço (vitrine
// parcial, checkout) — o "parcial" que o checkbox dos botões 2 e 3 pula.
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
          ? " — só um pedaço; a vitrine completa dele ainda não foi raspada"
          : parciais ? ` (${parciais} fora da vitrine completa)` : ""}
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
