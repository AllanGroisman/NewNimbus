import { useState } from "react";
import StatCard from "../ui/StatCard";
import Badge from "../ui/Badge";
import { Card, Linha, PorDia } from "./comum";
import { formatBRL, formatInt, diaCurto } from "../../data/desempenho";

// Célula numérica das tabelas: vão à esquerda e sem quebrar — no celular o
// "R$ 1.234,56" quebrava em duas linhas e as colunas encostavam umas nas outras.
// A tabela já mora num overflowX: auto, então ela rola em vez de espremer.
const celulaNum = { paddingLeft: 12, whiteSpace: "nowrap" };

// Números de afiliado da Shopee (resposta de /api/affiliate/shopee/desempenho).
// A casca (pages/Desempenho.jsx) cuida de período, carregamento e erro.
//
// A API da Shopee não tem cliques — só as vendas, uma por item, com o grupo que
// mandou o link (sub_id). Por isso aqui não há conversão, e há a lista de vendas.

const SERIES = [
  { id: "orders", label: "Pedidos", formata: formatInt },
  { id: "sales", label: "Vendas", formata: formatBRL },
  { id: "commission", label: "Comissão", formata: formatBRL },
];

const STATUS = {
  concluida: { label: "Concluída", cor: "green" },
  pendente: { label: "Pendente", cor: "amber" },
  cancelada: { label: "Cancelada", cor: "red" },
};

const POR_VEZ = 20;
const secundario = { fontSize: 11, color: "var(--color-text-secondary)" };

function ListaVendas({ vendas, total }) {
  const [limite, setLimite] = useState(POR_VEZ);
  if (!vendas.length) return <div style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>Nenhuma venda no período.</div>;
  return (
    <>
      {vendas.slice(0, limite).map(v => {
        const st = STATUS[v.status] || STATUS.pendente;
        return (
          <div key={v.id} style={{ display: "flex", gap: 10, alignItems: "center", padding: "8px 0", borderTop: "0.5px solid var(--color-border-tertiary)" }}>
            {v.image
              ? <img src={v.image} alt="" width={36} height={36} loading="lazy" style={{ borderRadius: 6, objectFit: "cover", flexShrink: 0 }} />
              : <div style={{ width: 36, height: 36, flexShrink: 0 }} />}
            <div style={{ flex: 1, minWidth: 0 }}>
              {/* Até 2 linhas: com uma só, no celular o nome virava "Fone Blue…" e o
                  resto ficava só no tooltip, que não existe no toque. */}
              <div title={v.name} style={{ fontSize: 13, lineHeight: 1.35, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", overflowWrap: "anywhere" }}>
                {v.qty > 1 ? `${formatInt(v.qty)}× ` : ""}{v.name}
              </div>
              <div style={{ ...secundario, marginTop: 3, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                <Badge color={st.cor}>{st.label}</Badge>
                <span>{diaCurto(v.date)}{v.shopName ? ` · ${v.shopName}` : ""}{v.group ? ` · ${v.group}` : ""}</span>
              </div>
            </div>
            <div style={{ textAlign: "right", flexShrink: 0 }}>
              <div style={{ fontSize: 13, textDecoration: v.status === "cancelada" ? "line-through" : "none" }}>{formatBRL(v.commission)}</div>
              <div style={secundario}>de {formatBRL(v.amount)}</div>
            </div>
          </div>
        );
      })}
      {vendas.length > limite && (
        <button
          onClick={() => setLimite(l => l + POR_VEZ)}
          style={{ marginTop: 2, background: "transparent", border: "none", padding: "8px 0", fontSize: 12, color: "var(--color-text-secondary)", cursor: "pointer", fontFamily: "inherit" }}
        >
          Mostrar mais ({formatInt(vendas.length - limite)})
        </button>
      )}
      {total > vendas.length && (
        <div style={{ ...secundario, marginTop: 8 }}>Mostrando as {formatInt(vendas.length)} mais recentes de {formatInt(total)}.</div>
      )}
    </>
  );
}

export default function DesempenhoShopee({ dados }) {
  const s = dados.summary;
  const grupos = dados.groups || [];
  const soSemGrupo = grupos.length > 0 && grupos.every(g => !g.groupId);
  return (
    <>
      <Linha style={{ marginBottom: 8 }}>
        <StatCard label="Pedidos" value={formatInt(s.orders)} />
        <StatCard label="Produtos" value={formatInt(s.units)} />
        <StatCard label="Vendas" value={formatBRL(s.sales)} />
      </Linha>
      <Linha style={{ marginBottom: 8 }}>
        <StatCard
          label="Comissão estimada"
          value={formatBRL(s.commission.total)}
          sub={`${formatBRL(s.commission.concluida)} concluída · ${formatBRL(s.commission.pendente)} pendente`}
          color="var(--success-text)"
        />
        <StatCard
          label="Canceladas"
          value={formatInt(s.cancelled.orders)}
          sub={s.cancelled.commission > 0 ? `${formatBRL(s.cancelled.commission)} de comissão perdida` : s.cancelled.orders === 1 ? "pedido" : "pedidos"}
        />
        {s.mcnFee > 0 && <StatCard label="Taxa da agência (MCN)" value={formatBRL(s.mcnFee)} sub="descontada da comissão" />}
      </Linha>
      <div style={{ ...secundario, marginBottom: 12 }}>
        A Shopee não informa cliques pela API — eles só aparecem no painel de afiliados dela.
      </div>

      <PorDia dias={dados.days} series={SERIES} />

      {grupos.length > 0 && (
        <Card>
          <div style={{ fontWeight: 500, marginBottom: 10 }}>Por grupo</div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ color: "var(--color-text-secondary)", fontSize: 11, textAlign: "right" }}>
                  <th style={{ textAlign: "left", fontWeight: 400, paddingBottom: 6 }}>Grupo</th>
                  <th style={{ ...celulaNum, fontWeight: 400 }}>Pedidos</th>
                  <th style={{ ...celulaNum, fontWeight: 400 }}>Vendas</th>
                  <th style={{ ...celulaNum, fontWeight: 400 }}>Comissão</th>
                </tr>
              </thead>
              <tbody>
                {grupos.map(g => (
                  <tr key={g.groupId || "sem-grupo"} style={{ textAlign: "right", borderTop: "0.5px solid var(--color-border-tertiary)" }}>
                    <td style={{ textAlign: "left", padding: "6px 0", color: g.groupId ? "inherit" : "var(--color-text-secondary)" }}>{g.name}</td>
                    <td style={celulaNum}>{formatInt(g.orders)}</td>
                    <td style={celulaNum}>{formatBRL(g.sales)}</td>
                    <td style={celulaNum}>{formatBRL(g.commission)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {soSemGrupo && (
            <div style={{ ...secundario, marginTop: 10, lineHeight: 1.6 }}>
              Os links da Shopee agora saem marcados com o grupo que os envia. As vendas desses links novos aparecem aqui separadas por grupo; as de links antigos ficam em "Sem grupo".
            </div>
          )}
        </Card>
      )}

      <Card>
        <div style={{ fontWeight: 500, marginBottom: 6 }}>Vendas</div>
        <ListaVendas key={`${dados.from}|${dados.to}`} vendas={dados.sales || []} total={dados.totalSales || 0} />
      </Card>

      <div style={{ fontSize: 11, color: "var(--color-text-secondary)", lineHeight: 1.6 }}>
        A comissão pendente pode mudar até o pedido ser concluído, e pedido cancelado não paga comissão. A Shopee só guarda as vendas dos últimos 3 meses.
      </div>
    </>
  );
}
