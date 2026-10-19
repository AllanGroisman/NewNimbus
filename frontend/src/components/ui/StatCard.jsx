// Base de 130px: no celular cabem 2 por linha (com 100px eram 3 espremidos, e o
// "R$ 12.345,67" quebrava depois do "R$" ou vazava do card).
//
// `variacao` = { pct, direcao } de data/periodos.variacao (o período anterior):
// verde quando melhorou, vermelho quando piorou. `menosEhMelhor` inverte a cor
// (canceladas, saídas).
const COR_VARIACAO = { bom: "var(--success-text)", ruim: "var(--danger-text)", igual: "var(--color-text-secondary)" };

function Variacao({ variacao, menosEhMelhor }) {
  const { pct, direcao } = variacao;
  if (direcao === "igual") {
    return <div style={{ fontSize: 11, color: COR_VARIACAO.igual, marginTop: 2 }}>igual ao anterior</div>;
  }
  const subiu = direcao === "sobe";
  const bom = subiu !== !!menosEhMelhor;
  return (
    <div style={{ fontSize: 11, color: bom ? COR_VARIACAO.bom : COR_VARIACAO.ruim, marginTop: 2, whiteSpace: "nowrap" }}>
      {subiu ? "↑" : "↓"} {Math.abs(pct).toLocaleString("pt-BR")}% <span style={{ color: "var(--color-text-secondary)" }}>vs. anterior</span>
    </div>
  );
}

export default function StatCard({ label, value, sub, color, variacao, menosEhMelhor }) {
  return (
    <div style={{ background: "var(--color-background-secondary)", borderRadius: 10, padding: "12px 14px", flex: "1 1 130px", minWidth: 0 }}>
      <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 500, whiteSpace: "nowrap", color: color || "var(--color-text-primary)" }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 2 }}>{sub}</div>}
      {variacao && <Variacao variacao={variacao} menosEhMelhor={menosEhMelhor} />}
    </div>
  );
}
