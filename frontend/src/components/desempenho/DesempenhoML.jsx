import StatCard from "../ui/StatCard";
import { Card, Linha, PorDia } from "./comum";
import { formatBRL, formatInt, conversao } from "../../data/desempenho";

// Célula numérica das tabelas: vão à esquerda e sem quebrar — no celular o
// "R$ 1.234,56" quebrava em duas linhas e as colunas encostavam umas nas outras.
// A tabela já mora num overflowX: auto, então ela rola em vez de espremer.
const celulaNum = { paddingLeft: 12, whiteSpace: "nowrap" };

// Números de afiliado do Mercado Livre (resposta de /api/affiliate/ml/desempenho).
// A casca (pages/Desempenho.jsx) cuida de período, carregamento e erro.

const SERIES = [
  { id: "clicks", label: "Cliques", formata: formatInt },
  { id: "orders", label: "Pedidos", formata: formatInt },
  { id: "earnings", label: "Ganhos", formata: formatBRL },
];

function variacaoTexto(v) {
  if (!v || !v.pct) return null;
  const seta = v.direction === "decrease" ? "↓" : v.direction === "increase" ? "↑" : "";
  return `${seta} ${formatInt(Math.abs(v.pct))}% vs. período anterior`.trim();
}

export default function DesempenhoML({ dados }) {
  const s = dados.summary;
  return (
    <>
      <Linha style={{ marginBottom: 8 }}>
        <StatCard label="Cliques" value={formatInt(s.clicks)} sub={variacaoTexto(s.clicksVariation)} />
        <StatCard label="Compradores" value={formatInt(s.buyers)} />
        <StatCard label="Pedidos" value={formatInt(s.orders)} sub="estimados" />
        <StatCard label="Produtos" value={formatInt(s.units)} sub="estimados" />
        <StatCard label="Conversão" value={conversao(s.orders, s.clicks)} sub="pedidos ÷ cliques" />
      </Linha>
      <Linha style={{ marginBottom: 12 }}>
        <StatCard label="Ganho estimado" value={formatBRL(s.earnings.total)} color="var(--success-text)" />
        <StatCard label="Vendas estimadas" value={formatBRL(s.estimatedSales)} />
        <StatCard label="Vendas brutas" value={formatBRL(s.grossSales)} />
        <StatCard
          label="Não efetivadas"
          value={formatBRL(s.notEffectiveSales)}
          sub={`${formatInt(s.notEffectiveCount)} ${s.notEffectiveCount === 1 ? "venda" : "vendas"}`}
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

      <PorDia dias={dados.days} series={SERIES} />

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
                    <td style={{ textAlign: "left", padding: "6px 0" }}>{t.tag}</td>
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
