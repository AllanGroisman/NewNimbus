import { useState, useEffect } from "react";
import StatCard from "../ui/StatCard";
import Badge from "../ui/Badge";
import InfoTip from "../ui/InfoTip";
import AlertBanner from "../ui/AlertBanner";
import {
  Card, Linha, ChipsRolaveis, AbasMantidas, BotaoVerMais, Vazio, LinhaProduto, Produtos, NaoEfetivadas,
  Tabela, Categorias, DiasComTabela, BarrasAudiencia,
} from "./comum";
import { formatBRL, formatInt, conversao, diaCurto, pct, etiquetaEfetiva } from "../../data/desempenho";
import { variacao } from "../../data/periodos";
import { groupUsesML } from "../../data/constants";
import { getMLDesempenhoLista, errText } from "../../data/api";

// Números de afiliado do Mercado Livre, no desenho do painel de Métricas do
// próprio ML (mercadolivre.com.br/afiliados/dashboard), simplificado: os cards
// de cima, o detalhe dos ganhos e as abas de baixo.
//
// A casca (pages/Desempenho.jsx) cuida de período, carregamento e erro do
// resumo (/api/affiliate/ml/desempenho, que traz `summary`, `days` e `tags`).
// Cada card compara com `dados.anterior` (o período anterior); sem ele, o card de
// cliques ainda usa a variação que o próprio ML manda. As abas Vendas, Produtos
// vendidos, Categorias, Audiências e Não efetivadas buscam a lista delas
// (/api/affiliate/ml/desempenho/lista) só quando abrem.

// O texto do (i) de cada número: o do painel do ML, palavra por palavra, onde ele
// tem um. Compradores e Conversão não têm lá.
const TEXTOS = {
  clicks: "É a quantidade de vezes que os compradores clicaram no link compartilhado.",
  buyers: "É a quantidade de pessoas diferentes que compraram pelos seus links.",
  orders: "É a quantidade de pedidos feitos pelos compradores. Pode variar após o processo de aprovação.",
  units: "São as unidades dos produtos vendidos. Pode variar após o processo de aprovação.",
  conversion: "Pedidos ÷ cliques: de cada 100 cliques, quantos viraram pedido.",
  earnings: "São as receitas das porcentagens de parceria por vendas e podem variar após o processo de aprovação.",
  estimatedSales: "É o resultado das suas vendas totais ao descontar as não efetivadas. Pode variar após o processo de aprovação.",
  grossSales: "É o valor total das suas vendas geradas.",
  notEffective: "É o valor das suas vendas que foram canceladas pelo comprador ou não cumprem os requisitos do Programa.",
  marketplace: "São as porcentagens de parceria definidas pelo Programa, de acordo com a categoria do produto.",
  brand: "São os ganhos oferecidos por uma marca.",
  seller: "São as porcentagens de parceria definidas pelo vendedor.",
  lostEarnings: "São os ganhos que não foram pagos porque as vendas foram canceladas ou não aprovadas.",
};

const SERIES = [
  { id: "clicks", label: "Cliques", formata: formatInt },
  { id: "orders", label: "Pedidos", formata: formatInt },
  { id: "earnings", label: "Ganhos", formata: formatBRL },
];

// As colunas da tabela da aba Data, depois do dia.
const COLUNAS_DIA = [
  { label: "Cliques", campo: "clicks", formata: formatInt },
  { label: "Pedidos", campo: "orders", formata: formatInt },
  { label: "Produtos", campo: "units", formata: formatInt },
  { label: "Ganho", campo: "earnings", formata: formatBRL },
];

// As abas de baixo, na ordem do painel do ML. `busca` = a aba pede a lista dela
// ao backend; as outras saem do resumo que já chegou.
const ABAS = [
  { id: "vendas", label: "Vendas", busca: true },
  { id: "produtos", label: "Produtos vendidos", busca: true },
  { id: "categorias", label: "Categorias", busca: true },
  { id: "etiquetas", label: "Etiquetas" },
  { id: "data", label: "Data" },
  { id: "audiencias", label: "Audiências", busca: true },
  { id: "nao-efetivadas", label: "Não efetivadas", busca: true },
];

// O status de uma venda, com o nome e a cor que o painel do ML usa.
const STATUS_VENDA = {
  APPROVED: { label: "Aprovada", cor: "green" },
  PAYMENT_COMPLETED: { label: "Paga", cor: "green" },
  IN_REVIEW: { label: "Em revisão", cor: "gray" },
  PAYMENT_DECLINED: { label: "Ação pendente", cor: "amber" },
  REJECTED: { label: "Recusada", cor: "red" },
  CANCELED: { label: "Cancelada", cor: "red" },
};

// O motivo que o ML põe ao lado do status (recusada por quê, pagamento parado…).
const DETALHE_VENDA = {
  MINIMUM_PAYMENT: "Mínimo não atingido",
  PAYMENT_IN_PROCESS: "Em processo de pagamento",
  DEVOLUTION: "Por devolução",
  UNKNOWN_PURCHASE: "Compra desconhecida",
  SUSPENDED: "Afiliado suspenso",
  PERSONAL_PURCHASE: "Conta vinculada",
  PUBLICITY_NOT_ALLOWED: "Publicidade não permitida",
  OTHER: "Outro motivo",
};

function detalheDaVenda(v) {
  if (v.status === "IN_REVIEW" && v.statusUntil) return `até ${diaCurto(v.statusUntil)}`;
  return DETALHE_VENDA[v.statusDetail] || null;
}

// A variação de cliques que o painel do ML manda (vs. o período anterior dele),
// no formato de data/periodos.variacao.
function variacaoDoML(v) {
  if (!v || !v.pct) return null;
  const direcao = v.direction === "decrease" ? "desce" : v.direction === "increase" ? "sobe" : null;
  return direcao ? { pct: Math.abs(v.pct), direcao } : null;
}

// Campanhas cujos links saem com a etiqueta (a escolhida nela, ou a padrão).
function campanhasDaEtiqueta(tag, campanhas, opcoes) {
  return campanhas.filter(c => groupUsesML(c) && etiquetaEfetiva(c.scraping, opcoes) === tag);
}

// "Campanhas: A, B" embaixo da etiqueta — o ML separa o ganho por etiqueta, e
// é por ela que dá pra saber de qual campanha veio. Nome vira link pra campanha.
function CampanhasDaEtiqueta({ lista, onOpenCampanha }) {
  return (
    <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 2, lineHeight: 1.5 }}>
      {lista.length === 0 ? "Nenhuma campanha" : (
        <>
          {lista.length === 1 ? "Campanha: " : "Campanhas: "}
          {lista.map((c, i) => (
            <span key={c.id}>
              {i > 0 && ", "}
              {onOpenCampanha
                ? <button type="button" onClick={() => onOpenCampanha(c.id)} style={linkCampanha}>{c.name}</button>
                : c.name}
            </span>
          ))}
        </>
      )}
    </div>
  );
}

const linkCampanha = { background: "transparent", border: "none", padding: 0, color: "inherit", textDecoration: "underline", fontSize: "inherit", fontFamily: "inherit", cursor: "pointer" };

// ── Busca de uma aba ──────────────────────────────────────────────────────

// A lista de uma aba, de 10 em 10. Mora dentro de um bloco remontado a cada
// resumo novo (período trocado ou "Atualizar"), então período e `refresh` não
// mudam durante a vida dela. `refresh` só vale pra primeira página: é ela que o
// "Atualizar" quis renovar.
function useListaML(aba, { from, to, refresh }) {
  const [pedido, setPedido] = useState({ page: 1, n: 0 });
  const [estado, setEstado] = useState({ itens: [], resposta: null, page: 0, hasMore: false, carregando: true, erro: null });

  useEffect(() => {
    let viva = true;
    setEstado(e => ({ ...e, carregando: true, erro: null }));
    getMLDesempenhoLista(aba, from, to, { page: pedido.page, refresh: refresh && pedido.page === 1 })
      .then(r => {
        if (!viva) return;
        setEstado(e => ({
          itens: pedido.page === 1 ? (r.items || []) : [...e.itens, ...(r.items || [])],
          resposta: r,
          page: pedido.page,
          hasMore: !!r.hasMore,
          carregando: false,
          erro: null,
        }));
      })
      .catch(err => {
        if (viva) setEstado(e => ({ ...e, carregando: false, erro: errText(err, "Não foi possível buscar no Mercado Livre.") }));
      });
    return () => { viva = false; };
  }, [aba, from, to, refresh, pedido]);

  return {
    ...estado,
    verMais: () => setPedido(p => ({ page: estado.page + 1, n: p.n + 1 })),
    tentarDeNovo: () => setPedido(p => ({ ...p, n: p.n + 1 })),
  };
}

// Casca de uma aba que busca: "Buscando…", erro com "tentar de novo", vazio e o
// "Ver mais". `children(lista)` desenha o conteúdo.
function AbaComBusca({ aba, from, to, refresh, children }) {
  const lista = useListaML(aba, { from, to, refresh });
  const temAlgo = lista.itens.length > 0 || (lista.resposta && !Array.isArray(lista.resposta.items));
  return (
    <>
      {lista.erro && <AlertBanner tone="error" message={lista.erro} onRetry={lista.tentarDeNovo} style={{ marginBottom: 10 }} />}
      {!temAlgo && lista.carregando && <div style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>Buscando no Mercado Livre…</div>}
      {!temAlgo && !lista.carregando && !lista.erro && <Vazio />}
      {temAlgo && children(lista)}
      {lista.hasMore && lista.itens.length > 0 && <BotaoVerMais onClick={lista.verMais} carregando={lista.carregando} />}
    </>
  );
}

// ── Linhas das listas ─────────────────────────────────────────────────────

function Vendas({ itens }) {
  return itens.map((v, i) => {
    const st = STATUS_VENDA[v.status] || { label: v.status ? v.status.toLowerCase() : "—", cor: "gray" };
    const detalhe = detalheDaVenda(v);
    const tipo = v.saleType === "INDIRECT" ? "indireta " : v.saleType === "DIRECT" ? "direta " : "";
    const meta = [
      v.date && diaCurto(v.date),
      v.store,
      v.commissionPct != null && `${tipo}${pct(v.commissionPct)}`,
    ].filter(Boolean).join(" · ");
    return (
      <LinhaProduto
        key={v.id || i}
        image={v.image}
        nome={`${v.units > 1 ? `${formatInt(v.units)}× ` : ""}${v.product || ""}`.trim()}
        link={v.link}
        embaixo={<>
          <Badge color={st.cor}>{st.label}</Badge>
          {detalhe && <span>{detalhe}</span>}
          {meta && <span>{meta}</span>}
        </>}
        direita={formatBRL(v.commission)}
        direitaEmbaixo={`de ${formatBRL(v.value)}`}
        riscado={v.status === "CANCELED" || v.status === "REJECTED"}
      />
    );
  });
}

function Etiquetas({ tags, campanhas, onOpenCampanha, mlTags, mlDefaultTag }) {
  if (!tags.length) return <Vazio />;
  return (
    <Tabela
      colunas={["Etiqueta", "Cliques", "Produtos", "Ganho"]}
      linhas={tags.map(t => ({
        key: t.tag,
        celulas: [
          <>
            {t.tag}
            {campanhas.length > 0 && (
              <CampanhasDaEtiqueta lista={campanhasDaEtiqueta(t.tag, campanhas, { mlTags, mlDefaultTag })} onOpenCampanha={onOpenCampanha} />
            )}
          </>,
          formatInt(t.clicks),
          formatInt(t.units),
          formatBRL(t.earnings),
        ],
      }))}
    />
  );
}

function Audiencias({ resposta }) {
  const age = resposta?.age || [];
  const gender = resposta?.gender || [];
  const location = resposta?.location || [];
  const soma = (l) => l.reduce((a, x) => a + x.value, 0);
  if (!soma(age) && !soma(gender) && !soma(location)) return <Vazio />;
  return (
    <>
      <BarrasAudiencia titulo="Idade" itens={age} />
      <BarrasAudiencia titulo="Gênero" itens={gender} />
      <BarrasAudiencia titulo="Localização" itens={location} limite={10} />
    </>
  );
}

// ── Abas ──────────────────────────────────────────────────────────────────

// O conteúdo das abas de um resumo. A aba já aberta continua montada (escondida)
// quando a pessoa troca, pra voltar sem buscar de novo; o bloco inteiro é
// remontado quando chega um resumo novo (ver `versao` em DesempenhoML).
function ConteudoAbas({ aba, dados, refresh, onDia, campanhas, onOpenCampanha, mlTags, mlDefaultTag }) {
  const periodo = { from: dados.from, to: dados.to, refresh };

  const conteudo = (id) => {
    switch (id) {
      case "vendas": return <AbaComBusca aba="vendas" {...periodo}>{l => <Vendas itens={l.itens} />}</AbaComBusca>;
      case "produtos": return <AbaComBusca aba="produtos" {...periodo}>{l => <Produtos itens={l.itens} />}</AbaComBusca>;
      case "categorias": return <AbaComBusca aba="categorias" {...periodo}>{l => <Categorias itens={l.itens} />}</AbaComBusca>;
      case "nao-efetivadas": return <AbaComBusca aba="nao-efetivadas" {...periodo}>{l => <NaoEfetivadas itens={l.itens} info={TEXTOS.lostEarnings} />}</AbaComBusca>;
      case "audiencias": return <AbaComBusca aba="audiencias" {...periodo}>{l => <Audiencias resposta={l.resposta} />}</AbaComBusca>;
      case "etiquetas": return <Etiquetas tags={dados.tags || []} campanhas={campanhas} onOpenCampanha={onOpenCampanha} mlTags={mlTags} mlDefaultTag={mlDefaultTag} />;
      case "data": return <DiasComTabela dias={dados.days} series={SERIES} colunas={COLUNAS_DIA} onDia={onDia} />;
      default: return null;
    }
  };

  return <AbasMantidas aba={aba} conteudo={conteudo} />;
}

// `versao` muda a cada resumo novo que chega (período trocado ou "Atualizar"), e
// `atualizado` diz se ele veio do "Atualizar" — aí as abas também furam o cache.
export default function DesempenhoML({ dados, onDia, campanhas = [], onOpenCampanha, mlTags = [], mlDefaultTag = null, versao, atualizado = false }) {
  const [aba, setAba] = useState("vendas");
  const s = dados.summary;
  const a = dados.anterior?.summary || null;
  const v = (campo) => (a ? variacao(campo(s), campo(a)) : null);
  return (
    <>
      <Linha style={{ marginBottom: 8 }}>
        <StatCard label="Cliques" info={TEXTOS.clicks} value={formatInt(s.clicks)} variacao={a ? v(x => x.clicks) : variacaoDoML(s.clicksVariation)} />
        <StatCard label="Compradores" info={TEXTOS.buyers} value={formatInt(s.buyers)} variacao={v(x => x.buyers)} />
        <StatCard label="Pedidos" info={TEXTOS.orders} value={formatInt(s.orders)} sub="estimados" variacao={v(x => x.orders)} />
        <StatCard label="Produtos" info={TEXTOS.units} value={formatInt(s.units)} sub="estimados" variacao={v(x => x.units)} />
        <StatCard label="Conversão" info={TEXTOS.conversion} value={conversao(s.orders, s.clicks)} sub="pedidos ÷ cliques" />
      </Linha>
      <Linha style={{ marginBottom: 12 }}>
        <StatCard label="Ganho estimado" info={TEXTOS.earnings} value={formatBRL(s.earnings.total)} color="var(--success-text)" variacao={v(x => x.earnings.total)} />
        <StatCard label="Vendas estimadas" info={TEXTOS.estimatedSales} value={formatBRL(s.estimatedSales)} variacao={v(x => x.estimatedSales)} />
        <StatCard label="Vendas brutas" info={TEXTOS.grossSales} value={formatBRL(s.grossSales)} variacao={v(x => x.grossSales)} />
        <StatCard
          label="Não efetivadas"
          info={TEXTOS.notEffective}
          value={formatBRL(s.notEffectiveSales)}
          sub={`${formatInt(s.notEffectiveCount)} ${s.notEffectiveCount === 1 ? "venda" : "vendas"}`}
          variacao={v(x => x.notEffectiveSales)}
          menosEhMelhor
        />
      </Linha>

      <Card>
        <div style={{ fontWeight: 500, marginBottom: 10 }}>Detalhe dos ganhos</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr auto", rowGap: 6, fontSize: 13 }}>
          {[
            ["Parceria do Mercado Livre", TEXTOS.marketplace, s.earnings.marketplace],
            ["Patrocinado por marca", TEXTOS.brand, s.earnings.brand],
            ["Parceria do vendedor", TEXTOS.seller, s.earnings.seller],
          ].map(([label, info, valor]) => (
            <div key={label} style={{ display: "contents" }}>
              <span style={{ display: "flex", alignItems: "center", gap: 4 }}>{label} <InfoTip label={`O que é ${label}`}>{info}</InfoTip></span>
              <span>{formatBRL(valor)}</span>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <ChipsRolaveis opcoes={ABAS} ativo={aba} onChange={setAba} style={{ marginBottom: 12 }} />
        <ConteudoAbas
          key={versao}
          aba={aba}
          dados={dados}
          refresh={atualizado}
          onDia={onDia}
          campanhas={campanhas}
          onOpenCampanha={onOpenCampanha}
          mlTags={mlTags}
          mlDefaultTag={mlDefaultTag}
        />
      </Card>
    </>
  );
}
