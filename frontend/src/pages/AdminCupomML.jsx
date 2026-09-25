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
import { Fragment, useState, useEffect, useCallback, useRef } from "react";
import { PRIMARY_DARK } from "../data/constants";
import { useLembrado, lerLembrado, gravarLembrado } from "../data/useLembrado";
import {
  adminMlCupons, adminMlCuponsStatus,
  adminMlCuponsProducts, adminMlCuponsClearAll, adminMlCuponsDelete,
  adminMlCuponsAlvosProdutos, adminMlCuponsSaveConfig, errText,
  adminMlCuponsAgendaPendentes, adminMlCuponsAgendaReivindicar, adminMlCuponsAgendaFalhou,
} from "../data/api";
import {
  useRodadaCupons, parar, rodarLista, logarNaRodada,
  rodarProdutos as rodarProdutosDoStore,
} from "../data/rodadaCupons";
import { coletorInfo } from "../data/coletor";
import { rotuloCategoria, resumoCategorias } from "../data/cupomCategorias";
import { campanhaDoTexto } from "../data/cupomId";
// O mesmo modal da aba "Descobrir palavra" — lá ele traz a campanha que uma palavra
// apontou, aqui a que alguém digitou. É a importação que a aba "Repasse" já faz
// (AdminCupomRepasse.jsx), e não fecha ciclo: AdminCupomPalavra não importa página
// nenhuma.
import { ImportarCampanhaModal } from "./AdminCupomPalavra";
import Modal from "../components/ui/Modal";
import ColheitaLog from "../components/admin/ColheitaLog";
import ProgressoColheita from "../components/admin/ProgressoColheita";
import ExtensaoAusente from "../components/admin/ExtensaoAusente";
import Numero from "../components/admin/Numero";
import { LimitesLista, LimitesProdutos } from "../components/admin/LimitesCupons";
import AgendaEtapa from "../components/admin/AgendaCupons";
import {
  segundos, brl, dia, desconto, cardStyle, inputStyle, th, td,
  botaoPrimario, botaoSecundario, botaoPerigo, botaoLink,
} from "../components/admin/cupomEstilos";

// O balanço da última vez de CADA botão, guardado no servidor — é o que sobrevive
// a um F5 e ao restart do backend (`status.ultimas`, backend/coupons/sync.js).
// Um por botão (task 17) porque eles fazem coisas diferentes: com um slot só, a
// ativação de um lote do botão 2 sobrescrevia o balanço da lista do botão 1.
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
    nome: "2 · Buscar Produtos Dos Cupons",
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

// Os filtros da tabela lembrados neste navegador (ver o `useState` de `filtros`).
const CHAVE_FILTROS = "cupons.mlFiltros";
const FILTROS_PADRAO = { q: "", scope: "", grouping: "", onlyValid: true };
const filtrosSemPagina = (f) => ({
  q: f.q ?? FILTROS_PADRAO.q, scope: f.scope ?? FILTROS_PADRAO.scope,
  grouping: f.grouping ?? FILTROS_PADRAO.grouping, onlyValid: f.onlyValid ?? FILTROS_PADRAO.onlyValid,
});
function sanearFiltros(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const f = {};
  for (const k of ["q", "scope", "grouping"]) if (typeof v[k] === "string") f[k] = v[k];
  if (typeof v.onlyValid === "boolean") f.onlyValid = v.onlyValid;
  return f;
}

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
  //
  // Sem a campanha vinda de fora, os filtros voltam como ficaram da última vez
  // neste navegador (a página não: ela sempre recomeça na 1). Com ela, a campanha
  // manda, e ela NÃO vira o filtro lembrado — senão o próximo F5 abriria preso
  // numa campanha vencida que o operador nem escolheu. Só o que ele mexer depois
  // disso é gravado.
  const [filtros, setFiltros] = useState(() => (buscaInicial
    ? { ...FILTROS_PADRAO, q: String(buscaInicial), onlyValid: false, page: 1 }
    : { ...FILTROS_PADRAO, ...lerLembrado(CHAVE_FILTROS, {}, sanearFiltros), page: 1 }));
  const semeadoRef = useRef(buscaInicial ? filtrosSemPagina({ q: String(buscaInicial), onlyValid: false }) : null);
  useEffect(() => {
    const atual = filtrosSemPagina(filtros);
    if (semeadoRef.current) {
      if (JSON.stringify(atual) === JSON.stringify(semeadoRef.current)) return;
      semeadoRef.current = null;
    }
    gravarLembrado(CHAVE_FILTROS, atual);
  }, [filtros]);
  const [erro, setErro] = useState(null);
  const [aberto, setAberto] = useState(null);        // campaignId com os produtos à mostra
  // A extensão que colhe a vitrine no Chrome do próprio admin (extension/ na raiz).
  // `null` enquanto não se sabe: o botão fica quieto em vez de piscar de cinza a
  // ativo na montagem.
  const [temColetor, setTemColetor] = useState(null);
  // A rodada em curso (ou a última) — etapa, log, andamento, o que já foi salvo.
  // Vem de fora do componente para sobreviver a sair e voltar da aba (task 6).
  const {
    rodandoNoChrome, buscandoProdutos, colhendo, painelDe, andamento, salvo,
    eventos, resumoColheita, recargas, fins,
  } = useRodadaCupons();
  // Quantos cupons ainda esperam produtos, e quantos desses precisariam de um
  // "Eu quero" antes. Vem do servidor (`/alvos-produtos`) porque é ele que sabe
  // quem já foi raspado — a página da tabela mostra só 50 de cada vez.
  const [alvos, setAlvos] = useState(null);
  // A extensão instalada entende o comando da lista? Uma cópia da versão 1.0
  // responde ao ping e não conhece "lista" — sem esta pergunta a tela ficaria
  // esperando um timeout de cinco minutos.
  const [colheLista, setColheLista] = useState(false);
  // "Só os que não têm nenhum produto": tira da fila do botão 2 os
  // PARCIAIS, que já têm prévia. Lembrado por navegador — é preferência de quem
  // opera, não estado do sistema.
  const [soSemProdutos, setSoSemProdutos] = useLembrado("cupons.soSemProdutos", false);
  // "Até os limites abaixo" × "tudo o que o ML tiver" (task 20). Lembrado por
  // navegador, como o `soSemProdutos`: é preferência de quem opera, não estado do
  // sistema. E é uma ESCOLHA, não um número — virar config no servidor seria criar um
  // décimo quinto campo justamente para resolver a confusão dos quatorze.
  const [listaSemTeto, setListaSemTeto] = useLembrado("cupons.listaSemTeto", false);
  // "Ignorar cupons de loja": a escolha fica na config do servidor (é ela que a
  // varredura lê), e aqui só o valor do clique enquanto o status não relê — sem
  // isso a caixa voltaria por um instante ao valor antigo depois de marcada.
  const [pulaLojaLocal, setPulaLojaLocal] = useState(null);
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

  // O que a rodada pede à tela (data/rodadaCupons.js): reler, e no fim fechar o
  // cupom aberto e esquecer os produtos em cache. Os contadores são comparados com
  // o valor visto na montagem — ao voltar para a aba, o que já passou não é pedido.
  const vistos = useRef({ recargas, fins });
  useEffect(() => {
    if (recargas === vistos.current.recargas) return;
    vistos.current.recargas = recargas;
    recarregar();
  }, [recargas, recarregar]);
  useEffect(() => {
    if (fins === vistos.current.fins) return;
    vistos.current.fins = fins;
    setAberto(null);
    setProdutos({});
    recarregar();
  }, [fins, recarregar]);

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

  // As rodadas moram em `data/rodadaCupons.js` (task 6): esta aba é montada do
  // zero a cada troca de aba, e a rodada precisa sobreviver a isso. Aqui fica só o
  // que é da tela — o erro some ao começar, e as preferências vão junto.
  const alternarLoja = async (valor) => {
    setPulaLojaLocal(valor);
    setErro(null);
    try {
      await adminMlCuponsSaveConfig({ skipStoreCoupons: valor });
      recarregar();
    } catch (err) {
      setPulaLojaLocal(null);
      setErro(errText(err, "Não deu pra salvar a escolha dos cupons de loja."));
    }
  };
  const rodarNoChrome = () => { setErro(null); return rodarLista({ semTeto: listaSemTeto }); };
  const rodarProdutos = (campaignIds = null) => { setErro(null); return rodarProdutosDoStore({ campaignIds, soSemProdutos }); };

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
  const pulaLoja = pulaLojaLocal ?? !!status?.config?.skipStoreCoupons;

  // A agenda (task 3). O servidor marca a etapa que venceu (backend/coupons/agenda.js)
  // e é ESTA aba que a roda, apertando o mesmo botão que o admin apertaria — as
  // etapas só existem no Chrome, pela extensão. O que a volta do intervalo precisa
  // ler é o AGORA (rodada em curso, extensão, fila), e por isso vai num ref: o efeito
  // monta uma vez e uma closure dele ficaria olhando a tela da montagem.
  const agendaRef = useRef(null);
  const olharRef = useRef(null);
  useEffect(() => {
    agendaRef.current = {
      livre: !emRodada && !limpando,
      temColetor, colheLista, faltamProdutos, alvosProntos: !!alvos,
      rodar: { lista: rodarNoChrome, produtos: () => rodarProdutos() },
      logar: logarNaRodada,
    };
  });
  useEffect(() => {
    let vivo = true;
    let ocupado = false;
    const olhar = async () => {
      const agora = agendaRef.current;
      // `temColetor === null` é "ainda não sei": esperar a próxima volta, e não
      // pular o horário por causa da montagem.
      if (ocupado || !agora?.livre || agora.temColetor === null) return;
      ocupado = true;
      try {
        const { pendentes = [] } = await adminMlCuponsAgendaPendentes();
        const p = pendentes[0];
        const x = agendaRef.current;
        if (!vivo || !p || !x.livre) return;
        if (p.botao === "produtos" && !x.alvosProntos) return;
        // Etapa que não existe mais nesta tela (o antigo botão 3): falha em vez de
        // ficar pendurada até a graça vencer.
        const motivo = !x.rodar[p.botao]
          ? "essa etapa foi removida da tela"
          : !x.temColetor || !x.colheLista
          ? "a extensão do Chrome não está instalada (ou está desatualizada) nesta aba"
          : p.botao === "produtos" && !x.faltamProdutos
            ? "não havia cupom esperando produtos — nada a fazer"
            : null;
        if (motivo) { await adminMlCuponsAgendaFalhou(p.botao, motivo); return; }
        // 409 = outra aba pegou antes; o catch engole e esta fica quieta.
        await adminMlCuponsAgendaReivindicar(p.botao);
        const rodada = x.rodar[p.botao]();
        // Depois de disparar: o botão zera o log ao começar.
        x.logar("ok", `⏰ rodando sozinha — horário agendado das ${p.slot}`);
        await rodada;
      } catch { /* a próxima volta tenta de novo */ }
      finally { ocupado = false; }
    };
    olharRef.current = olhar;
    olhar();
    const id = setInterval(olhar, 30000);
    return () => { vivo = false; clearInterval(id); olharRef.current = null; };
  }, []);
  // A primeira volta costuma chegar antes de se saber se há extensão — e sem isto
  // a etapa vencida esperaria mais 30s à toa depois que a resposta chega.
  useEffect(() => { olharRef.current?.(); }, [temColetor]);

  return (
    <div>
      {/* CARD 0 — o que esta tela é, e os números do que já está guardado. O que
          vale para as duas etapas mora aqui; o que é de uma etapa só mora no card
          dela (task 19). */}
      <div style={cardStyle}>
        <div style={{ fontWeight: 500, marginBottom: 4 }}>Puxar os cupons do Mercado Livre</div>
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 12, lineHeight: 1.5 }}>
          Dois caminhos, um card para cada — com os limites e o “última vez” de cada um lá dentro.
          O <b>1</b> abre a lista geral do ML numa aba deste Chrome e guarda todos os cupons com as
          condições de cada um: é só leitura, não mexe na sua conta. O <b>2</b> busca os produtos de
          cada cupom, e precisa aceitar (“Eu quero”) os que ainda não foram aceitos — sem isso o ML
          não mostra a vitrine. Os dois demoram minutos e vão se atualizando sozinhos.
        </div>

        {s && (
          <div style={{ display: "flex", gap: 18, flexWrap: "wrap", fontSize: 12, marginBottom: 12 }}>
            <Numero label="Cupons guardados" valor={s.cupons} />
            <Numero label="Ainda válidos" valor={s.validos} />
            <Numero label="Vínculos cupom↔produto" valor={s.vinculos} />
            {/* Quanto do número acima é pedaço de vitrine (ou checkout) e
                não vitrine fechada. Fica ao lado de propósito: sem ele, "3.000
                vínculos" parece cobertura que o sistema não tem. */}
            <Numero label="…destes, parciais" valor={s.parciais ?? 0} />
            <Numero label="Produtos do catálogo com cupom" valor={s.catalogo} />
            <Numero label="Com palavra descoberta" valor={s.comCodigo} />
          </div>
        )}

        {/* Sem a extensão os botões ficam cinza — e é aqui que se diz por quê.
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
          <button onClick={parar} style={botaoSecundario}>
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

        {/* Cupom de loja (task: tirar dos limites). Em destaque, e fora do "Limites
            desta etapa", porque não é teto: diz O QUE colher, e por isso vale nas
            duas escolhas de cima — inclusive em "tudo o que o ML tiver". Salva no
            clique: é uma escolha só, sem o "salvar" dos limites. */}
        <label style={{
          marginTop: 12, padding: "8px 10px", borderRadius: 8, fontSize: 12,
          display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap",
          border: "0.5px solid var(--color-border-secondary)",
          background: pulaLoja ? "var(--color-background-secondary)" : "transparent",
        }}>
          <input
            type="checkbox"
            checked={pulaLoja}
            disabled={emRodada || !status?.config}
            onChange={e => alternarLoja(e.target.checked)}
          />
          <span>
            <b>Ignorar cupons de loja</b>
            <span style={{ color: "var(--color-text-secondary)" }}>
              {" "}— {pulaLoja
                ? "a busca descarta os cupons de loja e guarda só os de campanha. Os de loja já guardados continuam na tabela."
                : "a busca guarda os cupons de loja junto com os de campanha."}
              {" "}Vale nas duas opções acima.
            </span>
          </span>
        </label>

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
        <details>
          <summary style={{ cursor: "pointer", fontSize: 12, marginTop: 12 }}>Agenda desta etapa{status?.config?.agenda?.lista?.enabled ? " · ⏰ ligada" : ""}</summary>
          <AgendaEtapa botao="lista" config={status?.config} proximo={status?.agenda?.proximo?.lista} onSaved={recarregar} />
        </details>
      </section>

      {/* CARD 2 — ETAPA 2. Separada porque ESCREVE na conta do ML. */}
      <section style={cardStyle} role="region" aria-label="2 · Buscar Produtos Dos Cupons">
        <div style={{ fontWeight: 500, marginBottom: 4 }}>2 · Buscar Produtos Dos Cupons</div>
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 10, lineHeight: 1.5 }}>
          Abre a vitrine de cada cupom que ainda não tem todos os produtos e guarda o que ela lista.
          Precisa aceitar (“Eu quero”) os cupons ainda não aceitos: sem isso o ML não revela a vitrine.
        </div>

        {/* O resumo rápido: todos os cupons guardados, repartidos pelo que já têm de
            produto. Os três grupos somam o total (backend/coupons/pg.js:stats). */}
        {s?.produtosPorCupom && (
          <div role="group" aria-label="Resumo dos produtos" style={{ display: "flex", gap: 18, flexWrap: "wrap", fontSize: 12, marginBottom: 4 }}>
            <Numero label="Cupons no sistema" valor={s.cupons} />
            <Numero label="Sem nenhum produto" valor={s.produtosPorCupom.semNada} />
            <Numero label="Parciais" valor={s.produtosPorCupom.parciais} />
            <Numero label="Completos" valor={s.produtosPorCupom.completos} />
          </div>
        )}
        <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 10 }}>
          A busca pula os cupons vencidos — por isso as filas abaixo podem ser menores que o resumo.
        </div>

        {buscandoProdutos ? (
          <button onClick={parar} style={botaoSecundario}>
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
            Buscar produtos{faltamProdutos ? ` (${faltamProdutos})` : ""}
          </button>
        )}

        {/* O filtro da fila (task 11). Mora AQUI, e não nos filtros da tabela, porque
            muda o que este botão vai buscar — a tabela continua mostrando todos. Rádio e
            não caixa de marcar, como o "Até onde ir na lista" do card 1: as duas filas
            ficam escritas lado a lado, cada uma com o seu tamanho. */}
        <fieldset style={{ border: "none", padding: 0, margin: "12px 0 0" }}>
          <legend style={{ fontSize: 12, fontWeight: 500, padding: 0, marginBottom: 6 }}>Buscar produtos para</legend>
          <label style={{ fontSize: 12, display: "flex", alignItems: "baseline", gap: 6, marginBottom: 4 }}>
            <input
              type="radio" name="fila-de-produtos"
              checked={!soSemProdutos}
              disabled={buscandoProdutos || rodandoNoChrome}
              onChange={() => setSoSemProdutos(false)}
            />
            <span>
              todos os que faltam{alvos?.incompletos != null ? ` (${alvos.incompletos})` : ""}
              <span style={{ color: "var(--color-text-secondary)" }}> — os sem nenhum produto e os parciais.</span>
            </span>
          </label>
          <label style={{ fontSize: 12, display: "flex", alignItems: "baseline", gap: 6 }}>
            <input
              type="radio" name="fila-de-produtos"
              checked={soSemProdutos}
              disabled={buscandoProdutos || rodandoNoChrome}
              onChange={() => setSoSemProdutos(true)}
            />
            <span>
              só os que não têm nenhum produto{alvos?.semNada != null ? ` (${alvos.semNada})` : ""}
              <span style={{ color: "var(--color-text-secondary)" }}> — pula os parciais.</span>
            </span>
          </label>
        </fieldset>

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
        <details>
          <summary style={{ cursor: "pointer", fontSize: 12, marginTop: 12 }}>Agenda desta etapa{status?.config?.agenda?.produtos?.enabled ? " · ⏰ ligada" : ""}</summary>
          <AgendaEtapa botao="produtos" config={status?.config} proximo={status?.agenda?.proximo?.produtos} onSaved={recarregar} />
        </details>
      </section>

      {/* CARD 3 — trazer UMA campanha pelo número dela (task 32). É outra forma
          de um cupom entrar, mas não é etapa: não tem limite, não tem "última vez" e
          não tem Parar. Fica entre os dois botões e a tabela, que é a ponte entre
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
                  <th style={th}>Onde vale</th>
                  <th style={th}>Desconto</th>
                  <th style={th}>Vence</th>
                  <th style={th}>Produtos</th>
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
                      <td style={{ ...td, minWidth: 200 }}>
                        <div style={{ fontWeight: 500 }}>{c.title}</div>
                        {c.subtitle && <div style={{ color: "var(--color-text-secondary)" }}>{c.subtitle}</div>}
                        <NumeroDaCampanha id={c.campaignId} />
                        {!c.activated && <div style={{ fontSize: 11, color: "var(--warn-text)" }}>não ativado</div>}
                      </td>
                      <OndeVale cupom={c} labels={labelsCategoria} />
                      <td style={td}>
                        <div style={{ fontWeight: 500 }}>{desconto(c)}</div>
                        <div style={{ fontSize: 11, color: "var(--color-text-secondary)", whiteSpace: "nowrap" }}>
                          {c.minPurchase ? `mín ${brl(c.minPurchase)}` : "sem mínimo"}
                        </div>
                        {c.maxDiscount && (
                          <div style={{ fontSize: 11, color: "var(--color-text-secondary)", whiteSpace: "nowrap" }}>teto {brl(c.maxDiscount)}</div>
                        )}
                      </td>
                      <td style={{ ...td, whiteSpace: "nowrap" }}>{dia(c.expiresAt)}</td>
                      <td style={td}>
                        {/* "45/200": guardados / o total que a vitrine do ML declara.
                            Sem o total (vitrine nunca aberta, extensão antiga) fica
                            só o que foi guardado, como antes. */}
                        <div title={c.vitrineTotal != null
                          ? `${c.products || 0} guardados de ${c.vitrineTotal} que a vitrine do ML mostra`
                          : undefined}>
                          {c.products || 0}{c.vitrineTotal != null ? `/${c.vitrineTotal}` : ""}
                        </div>
                        <div style={{ fontSize: 11, color: "var(--color-text-secondary)", whiteSpace: "nowrap" }}>{c.inCatalog || 0} no catálogo</div>
                        <EstadoProdutos cupom={c} />
                      </td>
                      <td style={td}>
                        <div style={{ fontFamily: "monospace" }}>{c.code || "—"}</div>
                        {c.code && FONTE_PALAVRA[c.codeSource] && (
                          <div style={{ color: "var(--color-text-secondary)", fontSize: 11 }}>
                            {FONTE_PALAVRA[c.codeSource]}{c.codeCheckedAt ? ` · ${dia(c.codeCheckedAt)}` : ""}
                          </div>
                        )}
                      </td>
                      <td style={td}>
                        {/* Os botões quebram linha em vez de alargar a tabela:
                            eram a coluna mais larga, e a que empurrava a rolagem
                            lateral. */}
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, maxWidth: 150 }}>
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
                        <td colSpan={7} style={{ ...td, background: "var(--color-background-secondary)" }}>
                          {/* width 0 + minWidth 100%: a lista não conta na largura
                              da tabela. Sem isso a URL de um produto sem nome
                              alargava a tabela toda e empurrava os botões do
                              cupom para fora da tela. */}
                          <div style={{ width: 0, minWidth: "100%" }}>
                            <Produtos dados={produtos[c.campaignId]} />
                          </div>
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
//   repasse  — o produto chegou com o código num grupo do repasse (não testado).
//
// Quem olha esta lista precisa saber qual está vendo: "5 produtos" de um pedaço
// não quer dizer que o cupom cobre só 5.
const ORIGEM = {
  vitrine: "vitrine",
  parcial: "vitrine parcial",
  checkout: "checkout",
  repasse: "repasse",
};
// Em que pé está a lista de produtos do cupom. `productsSyncedAt` só é escrito
// quando a vitrine inteira foi raspada; vínculo sem ele é pedaço (vitrine
// parcial, checkout) — o "parcial" que o checkbox dos botões 2 e 3 pula.
// A coluna "Onde vale": categoria e tipo juntos, porque respondiam a mesma
// pergunta — e no cupom de loja as duas repetiam o vendedor. Passando de duas
// categorias, mostra as duas primeiras e "+N"; a lista inteira fica no `title`.
function OndeVale({ cupom, labels }) {
  const { texto, resto, completo } = resumoCategorias(cupom, labels);
  return (
    <td style={{ ...td, color: "var(--color-text-secondary)", maxWidth: 180 }} title={resto ? completo : undefined}>
      {texto}
      {resto > 0 && <span style={{ marginLeft: 4, fontSize: 11, whiteSpace: "nowrap" }}>+{resto}</span>}
    </td>
  );
}

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
            {p.catalog?.img && <img src={p.catalog.img} alt="" width={34} height={34} style={{ objectFit: "contain", borderRadius: 6, flexShrink: 0 }} />}
            {/* Só o nome encolhe (cortado com "…"); o resto tem tamanho fixo. */}
            <a href={p.productUrl} target="_blank" rel="noreferrer" title={p.catalog?.name || p.productUrl} style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "inherit" }}>
              {p.catalog?.name || p.productUrl}
            </a>
            <span style={{ color: "var(--color-text-secondary)", flexShrink: 0, whiteSpace: "nowrap" }}>{brl(p.catalog?.price)}</span>
            <span style={{ color: "var(--color-text-secondary)", flexShrink: 0, whiteSpace: "nowrap" }}>
              {ORIGEM[p.origem] || p.origem || "vitrine"}
            </span>
            <span style={{ color: p.inCatalog ? PRIMARY_DARK : "var(--color-text-secondary)", flexShrink: 0, whiteSpace: "nowrap" }}>
              {p.inCatalog ? "no catálogo" : "fora do catálogo"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
