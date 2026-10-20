import { useState } from "react";
import StatCard from "../ui/StatCard";
import Badge from "../ui/Badge";
import InfoTip from "../ui/InfoTip";
import {
  Card, Linha, ChipsRolaveis, AbasMantidas, BotaoVerMais, Vazio, LinhaProduto, Produtos, NaoEfetivadas,
  Tabela, Categorias, DiasComTabela, BarrasAudiencia,
} from "./comum";
import { formatBRL, formatInt, diaCurto, pct } from "../../data/desempenho";
import { variacao } from "../../data/periodos";

// Números de afiliado da Shopee (resposta de /api/affiliate/shopee/desempenho),
// no mesmo desenho da aba do ML (DesempenhoML): os cards de cima, o detalhe dos
// ganhos e as abas de baixo. A casca (pages/Desempenho.jsx) cuida de período,
// carregamento e erro. Os cards comparam com `dados.anterior` (o período anterior).
//
// A API da Shopee não tem cliques — só as vendas, uma por item, com a campanha
// que mandou o link (sub_id). Por isso aqui não há Cliques nem Conversão, e a aba
// das etiquetas do ML vira a das campanhas. As listas das abas já chegam junto
// com o resumo (o backend baixa o período inteiro): nada é buscado ao abrir.

// O texto do (i) de cada número, no tom dos do ML.
const TEXTOS = {
  orders: "É a quantidade de pedidos feitos pelos seus links, sem os cancelados. Pode variar até o pedido ser concluído.",
  units: "São as unidades dos produtos vendidos, sem as canceladas. Pode variar até o pedido ser concluído.",
  newBuyers: "Das compras feitas pelos seus links, quantas a Shopee marca como de comprador novo. Ela não informa quantas pessoas diferentes compraram.",
  commission: "É a comissão das vendas válidas. A concluída já está garantida; a pendente pode variar até o pedido ser concluído.",
  estimatedSales: "É o valor das suas vendas ao descontar as não efetivadas. Pode variar até o pedido ser concluído.",
  grossSales: "É o valor total das vendas geradas pelos seus links, contando as canceladas.",
  notEffective: "É o valor das vendas canceladas pelo comprador ou recusadas pela Shopee (fraude). Elas não pagam comissão.",
  shopee: "É a comissão paga pela própria Shopee, de acordo com a categoria do produto. Tem um teto por item.",
  seller: "É a comissão extra oferecida pelo vendedor (Comissão Xtra).",
  brand: "É a comissão oferecida por uma marca.",
  mcn: "É a taxa da agência (MCN) a que sua conta está vinculada. Ela sai da sua comissão.",
  lostEarnings: "É a comissão que não foi paga porque a venda foi cancelada ou recusada.",
};

const SERIES = [
  { id: "orders", label: "Pedidos", formata: formatInt },
  { id: "sales", label: "Vendas", formata: formatBRL },
  { id: "commission", label: "Comissão", formata: formatBRL },
];

// As colunas da tabela da aba Data, depois do dia.
const COLUNAS_DIA = [
  { label: "Pedidos", campo: "orders", formata: formatInt },
  { label: "Produtos", campo: "units", formata: formatInt },
  { label: "Vendas", campo: "sales", formata: formatBRL },
  { label: "Comissão", campo: "commission", formata: formatBRL },
];

// As abas de baixo, na ordem das do ML; Campanhas no lugar de Etiquetas.
const ABAS = [
  { id: "vendas", label: "Vendas" },
  { id: "produtos", label: "Produtos vendidos" },
  { id: "categorias", label: "Categorias" },
  { id: "campanhas", label: "Campanhas" },
  { id: "data", label: "Data" },
  { id: "audiencias", label: "Audiências" },
  { id: "nao-efetivadas", label: "Não efetivadas" },
];

const STATUS = {
  concluida: { label: "Concluída", cor: "green" },
  pendente: { label: "Pendente", cor: "amber" },
  cancelada: { label: "Cancelada", cor: "red" },
};

const POR_VEZ = 10;
const secundario = { fontSize: 11, color: "var(--color-text-secondary)" };

// Mostra a lista de POR_VEZ em POR_VEZ, com o "Ver mais" das abas do ML.
// `children(visiveis)` desenha as linhas.
function VerMais({ itens, children }) {
  const [limite, setLimite] = useState(POR_VEZ);
  if (!itens.length) return <Vazio />;
  return (
    <>
      {children(itens.slice(0, limite))}
      {itens.length > limite && <BotaoVerMais onClick={() => setLimite(l => l + POR_VEZ)} />}
    </>
  );
}

// A aba Vendas, e também a lista da visão geral de uma campanha
// (campaign/DesempenhoCampanha). `total` = quantas o período tem; o backend
// manda só as mais recentes.
export function ListaVendas({ vendas, total }) {
  if (!vendas.length) return <div style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>Nenhuma venda no período.</div>;
  return (
    <>
      <VerMais itens={vendas}>
        {visiveis => visiveis.map(v => {
          const st = STATUS[v.status] || STATUS.pendente;
          const taxa = v.amount > 0 ? pct((v.commission / v.amount) * 100) : null;
          const meta = [
            v.date && diaCurto(v.date),
            v.shopName,
            v.group,
            taxa && (v.attribution ? `${v.attribution} ${taxa}` : taxa),
          ].filter(Boolean).join(" · ");
          return (
            <LinhaProduto
              key={v.id}
              image={v.image}
              nome={`${v.qty > 1 ? `${formatInt(v.qty)}× ` : ""}${v.name || ""}`.trim()}
              link={v.link}
              embaixo={<>
                <Badge color={st.cor}>{st.label}</Badge>
                {meta && <span>{meta}</span>}
              </>}
              direita={formatBRL(v.commission)}
              direitaEmbaixo={`de ${formatBRL(v.amount)}`}
              riscado={v.status === "cancelada"}
            />
          );
        })}
      </VerMais>
      {total > vendas.length && (
        <div style={{ ...secundario, marginTop: 8 }}>Mostrando as {formatInt(vendas.length)} mais recentes de {formatInt(total)}.</div>
      )}
    </>
  );
}

const linkCampanha = { background: "transparent", border: "none", padding: 0, color: "inherit", textDecoration: "underline", fontSize: "inherit", fontFamily: "inherit", cursor: "pointer", textAlign: "left" };

// O equivalente das etiquetas do ML: as vendas por campanha (sub_id do link).
// Só campanha que ainda existe vira link (a apagada sai como "Campanha apagada").
function Campanhas({ grupos, campanhas, onOpenCampanha }) {
  if (!grupos.length) return <Vazio />;
  const existe = new Set(campanhas.map(c => String(c.id)));
  const soSemGrupo = grupos.every(g => !g.groupId);
  return (
    <>
      <Tabela
        colunas={["Campanha", "Pedidos", "Vendas", "Comissão"]}
        linhas={grupos.map(g => {
          const viva = g.groupId && existe.has(g.groupId);
          return {
            key: g.groupId || "sem-grupo",
            celulas: [
              viva && onOpenCampanha
                ? <button type="button" onClick={() => onOpenCampanha(Number(g.groupId))} style={linkCampanha}>{g.name}</button>
                : <span style={{ color: viva ? "inherit" : "var(--color-text-secondary)" }}>{g.name}</span>,
              formatInt(g.orders),
              formatBRL(g.sales),
              formatBRL(g.commission),
            ],
          };
        })}
      />
      {soSemGrupo && (
        <div style={{ ...secundario, marginTop: 10, lineHeight: 1.6 }}>
          Os links da Shopee agora saem marcados com a campanha que os envia. As vendas desses links novos aparecem aqui separadas por campanha; as de links antigos ficam em "Sem campanha".
        </div>
      )}
    </>
  );
}

function Audiencias({ audiencia }) {
  const grupos = [
    ["Compradores", audiencia?.buyers],
    ["Dispositivo", audiencia?.device],
    ["Origem do clique", audiencia?.referrer],
    ["Onde comprou", audiencia?.attribution],
  ].map(([titulo, itens]) => [titulo, itens || []]);
  if (grupos.every(([, itens]) => !itens.some(x => x.value))) return <Vazio />;
  return (
    <>
      <div style={{ ...secundario, marginBottom: 10 }}>Em % dos pedidos válidos do período.</div>
      {grupos.map(([titulo, itens]) => <BarrasAudiencia key={titulo} titulo={titulo} itens={itens} limite={10} />)}
    </>
  );
}

// O conteúdo das abas de um resumo; o bloco inteiro é remontado quando chega
// um resumo novo (ver `versao` em DesempenhoShopee), e o "Ver mais" volta ao começo.
function ConteudoAbas({ aba, dados, onDia, campanhas, onOpenCampanha }) {
  const conteudo = (id) => {
    switch (id) {
      case "vendas": return <ListaVendas vendas={dados.sales || []} total={dados.totalSales || 0} />;
      case "produtos": return <VerMais itens={dados.products || []}>{l => <Produtos itens={l} />}</VerMais>;
      case "categorias": return dados.categories?.length ? <Categorias itens={dados.categories} ganho="Comissão" /> : <Vazio />;
      case "campanhas": return <Campanhas grupos={dados.groups || []} campanhas={campanhas} onOpenCampanha={onOpenCampanha} />;
      case "data": return <DiasComTabela dias={dados.days} series={SERIES} colunas={COLUNAS_DIA} onDia={onDia} />;
      case "audiencias": return <Audiencias audiencia={dados.audience} />;
      case "nao-efetivadas": return <VerMais itens={dados.notEffective || []}>{l => <NaoEfetivadas itens={l} info={TEXTOS.lostEarnings} />}</VerMais>;
      default: return null;
    }
  };
  return <AbasMantidas aba={aba} conteudo={conteudo} />;
}

// `versao` muda a cada resumo novo que chega (período trocado ou "Atualizar").
export default function DesempenhoShopee({ dados, onDia, campanhas = [], onOpenCampanha, versao }) {
  const [aba, setAba] = useState("vendas");
  const s = dados.summary;
  const a = dados.anterior?.summary || null;
  const v = (campo) => (a ? variacao(campo(s), campo(a)) : null);
  const ganhos = [
    ["Comissão da Shopee", TEXTOS.shopee, s.commission.shopee],
    ["Comissão Xtra do vendedor", TEXTOS.seller, s.commission.seller],
    ["Comissão de marca", TEXTOS.brand, s.commission.brand],
  ];
  return (
    <>
      <Linha style={{ marginBottom: 8 }}>
        <StatCard label="Pedidos" info={TEXTOS.orders} value={formatInt(s.orders)} sub="estimados" variacao={v(x => x.orders)} />
        <StatCard label="Produtos" info={TEXTOS.units} value={formatInt(s.units)} sub="estimados" variacao={v(x => x.units)} />
        <StatCard
          label="Compradores novos"
          info={TEXTOS.newBuyers}
          value={formatInt(s.newBuyers)}
          sub={`de ${formatInt(s.purchases)} ${s.purchases === 1 ? "compra" : "compras"}`}
          variacao={v(x => x.newBuyers)}
        />
      </Linha>
      <Linha style={{ marginBottom: 12 }}>
        <StatCard
          label="Comissão estimada"
          info={TEXTOS.commission}
          value={formatBRL(s.commission.total)}
          sub={`${formatBRL(s.commission.concluida)} concluída · ${formatBRL(s.commission.pendente)} pendente`}
          color="var(--success-text)"
          variacao={v(x => x.commission.total)}
        />
        <StatCard label="Vendas estimadas" info={TEXTOS.estimatedSales} value={formatBRL(s.sales)} variacao={v(x => x.sales)} />
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
          {ganhos.map(([label, info, valor]) => (
            <div key={label} style={{ display: "contents" }}>
              <span style={{ display: "flex", alignItems: "center", gap: 4 }}>{label} <InfoTip label={`O que é ${label}`}>{info}</InfoTip></span>
              <span>{formatBRL(valor)}</span>
            </div>
          ))}
          {s.mcnFee > 0 && (
            <div style={{ display: "contents" }}>
              <span style={{ display: "flex", alignItems: "center", gap: 4 }}>Taxa da agência (MCN) <InfoTip label="O que é Taxa da agência (MCN)">{TEXTOS.mcn}</InfoTip></span>
              <span style={{ color: "var(--danger-text)" }}>− {formatBRL(s.mcnFee)}</span>
            </div>
          )}
        </div>
      </Card>

      <Card>
        <ChipsRolaveis opcoes={ABAS} ativo={aba} onChange={setAba} style={{ marginBottom: 12 }} />
        <ConteudoAbas
          key={versao ?? `${dados.from}|${dados.to}`}
          aba={aba}
          dados={dados}
          onDia={onDia}
          campanhas={campanhas}
          onOpenCampanha={onOpenCampanha}
        />
      </Card>

      <div style={{ ...secundario, lineHeight: 1.6 }}>
        A Shopee não informa cliques pela API — eles só aparecem no painel de afiliados dela. A comissão pendente pode mudar até o pedido ser concluído, e pedido cancelado não paga comissão. A Shopee só guarda as vendas dos últimos 3 meses.
      </div>
    </>
  );
}
