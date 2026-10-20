import { useState } from "react";
import { PRIMARY } from "../../data/constants";
import { formatBRL, formatInt, diaCurto, pct } from "../../data/desempenho";
import BarrasPorDia from "../ui/BarrasPorDia";
import BarrasSaldo from "../grupos/BarrasSaldo";
import InfoTip from "../ui/InfoTip";

// Peças da tela Desempenho usadas pela casca (pages/Desempenho.jsx) e pelo
// conteúdo de cada loja. As das abas de baixo (listas, tabelas, audiências) são
// as do painel do ML: a Shopee devolve as listas no mesmo formato e usa as mesmas.

// Célula numérica das tabelas: vão à esquerda e sem quebrar — no celular o
// "R$ 1.234,56" quebrava em duas linhas e as colunas encostavam umas nas outras.
// A tabela já mora num overflowX: auto, então ela rola em vez de espremer.
const celulaNum = { paddingLeft: 12, whiteSpace: "nowrap" };
const secundario = { fontSize: 11, color: "var(--color-text-secondary)" };

export function Card({ children, style }) {
  return (
    <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: 16, marginBottom: 12, ...style }}>
      {children}
    </div>
  );
}

export function Linha({ children, style }) {
  return <div style={{ display: "flex", gap: 8, flexWrap: "wrap", ...style }}>{children}</div>;
}

export function Chip({ ativo, onClick, children, disabled }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-pressed={ativo}
      style={{
        padding: "7px 12px", borderRadius: 999, fontSize: 12, fontFamily: "inherit",
        cursor: disabled ? "default" : "pointer",
        border: `0.5px solid ${ativo ? PRIMARY : "var(--color-border-secondary)"}`,
        background: ativo ? PRIMARY : "transparent",
        color: ativo ? "var(--color-background-primary)" : "var(--color-text-primary)",
      }}
    >
      {children}
    </button>
  );
}

// Fileira de chips que rola de lado em vez de quebrar linha — pra muitas
// opções no celular. `opcoes` = [{ id, label }].
export function ChipsRolaveis({ opcoes, ativo, onChange, style }) {
  return (
    <div style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 4, margin: "0 -2px", scrollbarWidth: "thin", ...style }}>
      {opcoes.map(o => (
        <span key={o.id} style={{ flexShrink: 0, padding: "0 2px" }}>
          <Chip ativo={o.id === ativo} onClick={() => onChange(o.id)}>{o.label}</Chip>
        </span>
      ))}
    </div>
  );
}

// Card "Por dia": chips pra escolher a série e as barras. Dia sem nada vira a
// frase "Sem <série> no período." em vez de barras vazias. Série com
// `tipo: "saldo"` desenha entradas e saídas (BarrasSaldo) a partir dos campos
// `entradas`/`saidas` do dia; as outras leem `d[id]`. `onDia(date)` leva a tela
// pro dia tocado. `semCard` devolve só o conteúdo, pra morar dentro de outro card.
export function PorDia({ dias, series, onDia, semCard = false }) {
  const [serie, setSerie] = useState(series[0].id);
  const atual = series.find(x => x.id === serie) || series[0];
  const lista = dias || [];
  const ehSaldo = atual.tipo === "saldo";
  const pontos = ehSaldo ? [] : lista.map(d => ({ date: d.date, value: d[atual.id] || 0 }));
  const vazio = ehSaldo
    ? lista.every(d => !d.entradas && !d.saidas)
    : pontos.every(p => !p.value);
  const Casca = semCard ? "div" : Card;
  return (
    <Casca>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        <div style={{ fontWeight: 500 }}>Por dia</div>
        {series.length > 1 && (
          <Linha>
            {series.map(x => <Chip key={x.id} ativo={x.id === atual.id} onClick={() => setSerie(x.id)}>{x.label}</Chip>)}
          </Linha>
        )}
      </div>
      {vazio
        ? <div style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>Sem {atual.label.toLowerCase()} no período.</div>
        : ehSaldo
          ? <BarrasSaldo dias={lista} onDia={onDia} />
          : <BarrasPorDia dias={pontos} formata={atual.formata} onDia={onDia} />}
    </Casca>
  );
}

// ── Abas de baixo ─────────────────────────────────────────────────────────

const VAZIO = "Nenhum dado registrado para este período.";

export function Vazio() {
  return <div style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>{VAZIO}</div>;
}

// O conteúdo das abas. A aba já aberta continua montada (escondida) quando a
// pessoa troca, pra voltar sem buscar de novo nem perder o "Ver mais".
// `conteudo(id)` desenha uma aba.
export function AbasMantidas({ aba, conteudo }) {
  const [abertas, setAbertas] = useState([aba]);
  if (!abertas.includes(aba)) setAbertas([...abertas, aba]);
  return abertas.map(id => <div key={id} hidden={id !== aba}>{conteudo(id)}</div>);
}

export function BotaoVerMais({ onClick, carregando = false }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={carregando}
      style={{ width: "100%", marginTop: 8, padding: "9px 0", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", color: "var(--color-text-primary)", fontSize: 12, fontFamily: "inherit", cursor: carregando ? "default" : "pointer", opacity: carregando ? 0.6 : 1 }}
    >
      {carregando ? "Buscando…" : "Ver mais"}
    </button>
  );
}

// Foto + nome (até 2 linhas, link pro anúncio quando tem) + linha de baixo +
// valor à direita. As vendas e os produtos das duas lojas.
export function LinhaProduto({ image, nome, link, embaixo, direita, direitaEmbaixo, riscado }) {
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "center", padding: "8px 0", borderTop: "0.5px solid var(--color-border-tertiary)" }}>
      {image
        ? <img src={image} alt="" width={36} height={36} loading="lazy" style={{ borderRadius: 6, objectFit: "cover", flexShrink: 0 }} />
        : <div style={{ width: 36, height: 36, flexShrink: 0 }} />}
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Até 2 linhas: com uma só, no celular o nome virava "Fone Blue…" e o
            resto ficava só no tooltip, que não existe no toque. */}
        <div title={nome || undefined} style={{ fontSize: 13, lineHeight: 1.35, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", overflowWrap: "anywhere" }}>
          {link && nome
            ? <a href={link} target="_blank" rel="noopener noreferrer" style={{ color: "inherit", textDecoration: "none" }}>{nome}</a>
            : nome || "—"}
        </div>
        <div style={{ ...secundario, marginTop: 3, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>{embaixo}</div>
      </div>
      <div style={{ textAlign: "right", flexShrink: 0 }}>
        <div style={{ fontSize: 13, whiteSpace: "nowrap", textDecoration: riscado ? "line-through" : "none" }}>{direita}</div>
        {direitaEmbaixo && <div style={{ ...secundario, whiteSpace: "nowrap" }}>{direitaEmbaixo}</div>}
      </div>
    </div>
  );
}

// A aba "Produtos vendidos": { product, image, link, units, sales, feePct, earnings }.
export function Produtos({ itens }) {
  return itens.map((p, i) => (
    <LinhaProduto
      key={`${p.product}-${i}`}
      image={p.image}
      nome={p.product}
      link={p.link}
      embaixo={<span>{[
        `${formatInt(p.units)} ${p.units === 1 ? "unidade" : "unidades"}`,
        `${formatBRL(p.sales)} em vendas`,
        p.feePct != null && pct(p.feePct),
      ].filter(Boolean).join(" · ")}</span>}
      direita={<span style={{ color: "var(--success-text)" }}>{formatBRL(p.earnings)}</span>}
    />
  ));
}

// A aba "Não efetivadas": { product, image, link, canceled, notApproved,
// category, lostEarnings }. `info` = o texto do (i) de "Valor não recebido".
export function NaoEfetivadas({ itens, info }) {
  return (
    <>
      <div style={{ ...secundario, display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 4, marginBottom: 2 }}>
        Valor não recebido <InfoTip label="O que é Valor não recebido">{info}</InfoTip>
      </div>
      {itens.map((p, i) => (
        <LinhaProduto
          key={`${p.product}-${i}`}
          image={p.image}
          nome={p.product}
          link={p.link}
          embaixo={<span>{[
            p.canceled > 0 && `${formatInt(p.canceled)} ${p.canceled === 1 ? "cancelada" : "canceladas"}`,
            p.notApproved > 0 && `${formatInt(p.notApproved)} não ${p.notApproved === 1 ? "aprovada" : "aprovadas"}`,
            p.category,
          ].filter(Boolean).join(" · ")}</span>}
          direita={<span style={{ color: "var(--danger-text)" }}>{formatBRL(p.lostEarnings)}</span>}
        />
      ))}
    </>
  );
}

// `linhas` = [{ key, celulas }]; a primeira coluna é o nome, as outras números.
export function Tabela({ colunas, linhas }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ color: "var(--color-text-secondary)", fontSize: 11, textAlign: "right" }}>
            {colunas.map((c, i) => (
              <th key={c} style={i === 0 ? { textAlign: "left", fontWeight: 400, paddingBottom: 6 } : { ...celulaNum, fontWeight: 400 }}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {linhas.map(({ key, celulas }) => (
            <tr key={key} style={{ textAlign: "right", borderTop: "0.5px solid var(--color-border-tertiary)" }}>
              {celulas.map((c, i) => (
                <td key={i} style={i === 0 ? { textAlign: "left", padding: "6px 0" } : celulaNum}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// A aba "Categorias": { category, units, feePct, earnings }. `ganho` = o nome
// da última coluna (o ML diz Ganho; a Shopee, Comissão).
export function Categorias({ itens, ganho = "Ganho" }) {
  return (
    <Tabela
      colunas={["Categoria", "Unidades", "Taxa", ganho]}
      linhas={itens.map((c, i) => ({
        key: `${c.category}-${i}`,
        celulas: [c.category || "—", formatInt(c.units), c.feePct != null ? pct(c.feePct) : "—", formatBRL(c.earnings)],
      }))}
    />
  );
}

// A aba "Data": o gráfico por dia + a mesma coisa em tabela, só os dias com
// movimento, do mais recente pro mais antigo. `colunas` = [{ label, campo,
// formata }] depois da do dia; dia com movimento = algum desses campos ≠ 0.
export function DiasComTabela({ dias, series, colunas, onDia }) {
  const comMovimento = (dias || []).filter(d => colunas.some(c => d[c.campo])).reverse();
  return (
    <>
      <PorDia dias={dias} series={series} onDia={onDia} semCard />
      {comMovimento.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <Tabela
            colunas={["Dia", ...colunas.map(c => c.label)]}
            linhas={comMovimento.map(d => ({
              key: d.date,
              celulas: [diaCurto(d.date), ...colunas.map(c => c.formata(d[c.campo]))],
            }))}
          />
        </div>
      )}
    </>
  );
}

// Barras horizontais de um grupo da audiência, em % do total do grupo.
export function BarrasAudiencia({ titulo, itens, limite }) {
  const total = itens.reduce((a, x) => a + x.value, 0);
  const lista = limite ? itens.slice(0, limite) : itens;
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 6 }}>{titulo}</div>
      {total === 0 ? <div style={secundario}>Sem dados.</div> : lista.map(x => {
        const parte = (x.value / total) * 100;
        return (
          <div key={x.label} style={{ display: "grid", gridTemplateColumns: "minmax(70px, 30%) 1fr auto", gap: 8, alignItems: "center", fontSize: 12, marginBottom: 4 }}>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{x.label}</span>
            <span style={{ height: 8, borderRadius: 4, background: "var(--color-background-secondary)", overflow: "hidden" }}>
              <span style={{ display: "block", height: "100%", width: `${parte}%`, background: "var(--success-text)", opacity: 0.75 }} />
            </span>
            <span style={{ ...secundario, minWidth: 34, textAlign: "right" }}>{pct(parte)}</span>
          </div>
        );
      })}
    </div>
  );
}
