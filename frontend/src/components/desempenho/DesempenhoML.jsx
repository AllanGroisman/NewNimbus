import StatCard from "../ui/StatCard";
import { Card, Linha, PorDia } from "./comum";
import { formatBRL, formatInt, conversao, etiquetaEfetiva } from "../../data/desempenho";
import { variacao } from "../../data/periodos";
import { groupUsesML } from "../../data/constants";

// Célula numérica das tabelas: vão à esquerda e sem quebrar — no celular o
// "R$ 1.234,56" quebrava em duas linhas e as colunas encostavam umas nas outras.
// A tabela já mora num overflowX: auto, então ela rola em vez de espremer.
const celulaNum = { paddingLeft: 12, whiteSpace: "nowrap" };

// Números de afiliado do Mercado Livre (resposta de /api/affiliate/ml/desempenho).
// A casca (pages/Desempenho.jsx) cuida de período, carregamento e erro. Cada
// card compara com `dados.anterior` (o período anterior); sem ele, o card de
// cliques ainda usa a variação que o próprio ML manda.

const SERIES = [
  { id: "clicks", label: "Cliques", formata: formatInt },
  { id: "orders", label: "Pedidos", formata: formatInt },
  { id: "earnings", label: "Ganhos", formata: formatBRL },
];

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

export default function DesempenhoML({ dados, onDia, campanhas = [], onOpenCampanha, mlTags = [], mlDefaultTag = null }) {
  const s = dados.summary;
  const a = dados.anterior?.summary || null;
  const v = (campo) => (a ? variacao(campo(s), campo(a)) : null);
  return (
    <>
      <Linha style={{ marginBottom: 8 }}>
        <StatCard label="Cliques" value={formatInt(s.clicks)} variacao={a ? v(x => x.clicks) : variacaoDoML(s.clicksVariation)} />
        <StatCard label="Compradores" value={formatInt(s.buyers)} variacao={v(x => x.buyers)} />
        <StatCard label="Pedidos" value={formatInt(s.orders)} sub="estimados" variacao={v(x => x.orders)} />
        <StatCard label="Produtos" value={formatInt(s.units)} sub="estimados" variacao={v(x => x.units)} />
        <StatCard label="Conversão" value={conversao(s.orders, s.clicks)} sub="pedidos ÷ cliques" />
      </Linha>
      <Linha style={{ marginBottom: 12 }}>
        <StatCard label="Ganho estimado" value={formatBRL(s.earnings.total)} color="var(--success-text)" variacao={v(x => x.earnings.total)} />
        <StatCard label="Vendas estimadas" value={formatBRL(s.estimatedSales)} variacao={v(x => x.estimatedSales)} />
        <StatCard label="Vendas brutas" value={formatBRL(s.grossSales)} variacao={v(x => x.grossSales)} />
        <StatCard
          label="Não efetivadas"
          value={formatBRL(s.notEffectiveSales)}
          sub={`${formatInt(s.notEffectiveCount)} ${s.notEffectiveCount === 1 ? "venda" : "vendas"}`}
          variacao={v(x => x.notEffectiveSales)}
          menosEhMelhor
        />
      </Linha>

      <Card>
        <div style={{ fontWeight: 500, marginBottom: 10 }}>De onde vem o ganho</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr auto", rowGap: 6, fontSize: 13 }}>
          <span>Parceria do Mercado Livre</span><span>{formatBRL(s.earnings.marketplace)}</span>
          <span>Parceria do vendedor</span><span>{formatBRL(s.earnings.seller)}</span>
          <span>Patrocinado por marca</span><span>{formatBRL(s.earnings.brand)}</span>
        </div>
      </Card>

      <PorDia dias={dados.days} series={SERIES} onDia={onDia} />

      {dados.tags?.length > 0 && (
        <Card>
          <div style={{ fontWeight: 500, marginBottom: 10 }}>Por etiqueta</div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ color: "var(--color-text-secondary)", fontSize: 11, textAlign: "right" }}>
                  <th style={{ textAlign: "left", fontWeight: 400, paddingBottom: 6 }}>Etiqueta</th>
                  <th style={{ ...celulaNum, fontWeight: 400 }}>Cliques</th>
                  <th style={{ ...celulaNum, fontWeight: 400 }}>Produtos</th>
                  <th style={{ ...celulaNum, fontWeight: 400 }}>Ganho</th>
                </tr>
              </thead>
              <tbody>
                {dados.tags.map(t => (
                  <tr key={t.tag} style={{ textAlign: "right", borderTop: "0.5px solid var(--color-border-tertiary)" }}>
                    <td style={{ textAlign: "left", padding: "6px 0" }}>
                      {t.tag}
                      {campanhas.length > 0 && (
                        <CampanhasDaEtiqueta lista={campanhasDaEtiqueta(t.tag, campanhas, { mlTags, mlDefaultTag })} onOpenCampanha={onOpenCampanha} />
                      )}
                    </td>
                    <td style={celulaNum}>{formatInt(t.clicks)}</td>
                    <td style={celulaNum}>{formatInt(t.units)}</td>
                    <td style={celulaNum}>{formatBRL(t.earnings)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <div style={{ fontSize: 11, color: "var(--color-text-secondary)", lineHeight: 1.6 }}>
        O Mercado Livre atualiza estes números uma vez por dia. Pedidos, produtos e ganhos são estimados e podem mudar até a aprovação da venda.
      </div>
    </>
  );
}
