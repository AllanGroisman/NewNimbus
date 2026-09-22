// O painel do "agora" de uma colheita de cupons: em que etapa está, o que ela
// faz, quanto da fila já foi e o que veio até aqui.
//
// Toma o lugar da linha única que se sobrescrevia (`⟳ lote 2/5 · …`). O estado vem
// pronto de `data/andamentoColheita.js`. Aqui só se desenha, mais o relógio de 1s
// que faz as pausas contarem para trás — sem ele, os 60s entre dois ciclos pareciam
// tela travada.
import { useEffect, useState } from "react";
import Numero from "./Numero";
import Barra from "./Barra";
import { EXPLICACAO, ROTULO, estimativaMs, duracao } from "../../data/andamentoColheita";

const PAUSA = {
  "entre vitrines": "próxima vitrine",
  "entre lotes": "próximo lote",
  "entre ciclos": "próximo ciclo",
};

export default function ProgressoColheita({ andamento }) {
  const [agora, setAgora] = useState(() => Date.now());
  const ativo = !!andamento;
  useEffect(() => {
    if (!ativo) return undefined;
    const id = setInterval(() => setAgora(Date.now()), 1000);
    return () => clearInterval(id);
  }, [ativo]);
  if (!andamento) return null;

  const { etapa, fila, lote, atual, lista, pausa, contagem, ciclo, maxCiclos, maxPaginas, maxProdutos, ativacao, ativacaoFundo } = andamento;
  // Várias vitrines ao mesmo tempo (task 14): lista todas as abertas.
  const abertas = Object.values(andamento.atuais || {});
  const variasAbertas = abertas.length > 1;
  const muro = etapa === "muro";
  const eta = estimativaMs(andamento, agora);
  const restaPausa = pausa ? Math.max(0, pausa.ate - agora) : 0;

  let titulo = ROTULO[etapa] || etapa;
  // Com várias páginas em voo (task 21) o número da página corrente deixa de
  // querer dizer progresso — a 9 volta antes da 7. Aí o título passa a contar
  // páginas LIDAS, que é monotônico, e diz quantas abas estão abertas.
  const paginasAbertas = Object.values(lista?.abertas || {});
  if (etapa === "lista" && lista) {
    titulo += paginasAbertas.length > 1
      ? ` · ${lista.lidas || 0}${lista.de ? ` de ${lista.de}` : ""} páginas${lista.grouping ? ` de ${lista.nome || lista.grouping}` : " (geral)"}`
      : ` · página ${lista.pagina}${lista.grouping ? ` de ${lista.nome || lista.grouping}` : " (geral)"}`;
  }
  if (etapa === "pausa" && pausa) titulo = `Em pausa · ${PAUSA[pausa.motivo] || "continua"} em ${Math.ceil(restaPausa / 1000)}s`;

  return (
    <div
      style={{
        marginTop: 4, padding: "10px 12px", borderRadius: 10,
        background: muro ? "var(--warn-bg)" : "var(--color-background-secondary)",
        border: `0.5px solid ${muro ? "var(--warn-border)" : "var(--color-border-tertiary)"}`,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "baseline" }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: muro ? "var(--warn-text)" : "var(--color-text-primary)" }}>
          {muro ? "⚠️" : "⟳"} {titulo}
        </div>
        <div style={{ fontSize: 11, color: "var(--color-text-secondary)", fontVariantNumeric: "tabular-nums" }}>
          {ciclo ? `ciclo ${ciclo}${maxCiclos ? ` de até ${maxCiclos}` : ""} · ` : ""}
          rodando há {duracao(agora - andamento.inicio)}
          {eta != null && eta > 0 ? ` · faltam ~${duracao(eta)}` : ""}
        </div>
      </div>
      <div style={{ fontSize: 12, color: muro ? "var(--warn-text)" : "var(--color-text-secondary)", marginTop: 3, lineHeight: 1.5 }}>
        {EXPLICACAO[etapa]}
      </div>

      {etapa === "lista" && lista && <BarrasDaLista lista={lista} />}
      {etapa === "ativando" && ativacao?.total > 0 && (
        <Barra
          valor={ativacao.vistos}
          total={ativacao.total}
          rotulo={`Cupons do lote já achados na lista: ${ativacao.vistos} de ${ativacao.total}${ativacao.pagina ? ` · página ${ativacao.pagina}` : ""}`}
        />
      )}

      {fila && (
        <Barra
          valor={fila.feitos}
          total={fila.total}
          rotulo={`Cupons desta fila: ${fila.feitos} de ${fila.total}${fila.aAtivar ? ` (${fila.aAtivar} precisam de “Eu quero”)` : ""}`}
        />
      )}
      {lote && lote.de > 1 && (
        <Barra valor={lote.k - 1} total={lote.de} rotulo={`Lote ${lote.k} de ${lote.de}`} direita={`${lote.k - 1} gravado(s)`} />
      )}

      {variasAbertas && (etapa === "vitrine" || muro) && (
        <div style={{ marginTop: 8, fontSize: 12, lineHeight: 1.5 }}>
          <div>{abertas.length} vitrines abertas agora:</div>
          {abertas.map(v => (
            <div key={v.campaignId} style={{ color: "var(--color-text-secondary)" }}>
              <b style={{ color: "var(--color-text-primary)" }}>{v.title}</b>
              {v.de ? ` (${v.i}/${v.de} do lote)` : ""} · página {v.pagina || 0}{maxPaginas ? ` de até ${maxPaginas}` : ""} · {v.produtos || 0} produto(s)
            </div>
          ))}
        </div>
      )}

      {paginasAbertas.length > 1 && (etapa === "lista" || muro) && (
        <div style={{ marginTop: 8, fontSize: 12, lineHeight: 1.5 }}>
          <div>{paginasAbertas.length} páginas abertas agora:</div>
          <div style={{ color: "var(--color-text-secondary)" }}>
            {paginasAbertas
              .map(v => `${v.grouping ? (lista.nome || v.grouping) : "geral"} p.${v.pagina}`)
              .join(" · ")}
          </div>
        </div>
      )}

      {!variasAbertas && atual && (etapa === "vitrine" || etapa === "pausa" || muro) && (
        <div style={{ marginTop: 8, fontSize: 12, lineHeight: 1.5 }}>
          <div>
            Vitrine agora: <b>{atual.title}</b>
            {atual.de ? <span style={{ color: "var(--color-text-secondary)" }}> ({atual.i}/{atual.de} do lote)</span> : null}
          </div>
          <div style={{ color: "var(--color-text-secondary)" }}>
            página {atual.pagina || 0}{maxPaginas ? ` de até ${maxPaginas}` : ""} ·{" "}
            {atual.produtos || 0} produto(s) lidos{maxProdutos ? ` (teto ${maxProdutos})` : ""}
          </div>
        </div>
      )}

      {ativacaoFundo && (
        <div style={{ marginTop: 8, fontSize: 12, color: "var(--color-text-secondary)" }}>
          ⟳ Em paralelo: clicando em “Eu quero” no lote {ativacaoFundo.lote ?? "seguinte"}
          {ativacaoFundo.n ? ` (${ativacaoFundo.n} cupom(ns))` : ""}
          {ativacaoFundo.pagina ? ` · página ${ativacaoFundo.pagina} da lista` : ""}
          {ativacaoFundo.total > 0 && (
            <Barra valor={ativacaoFundo.vistos || 0} total={ativacaoFundo.total} rotulo={`Achados na lista: ${ativacaoFundo.vistos || 0} de ${ativacaoFundo.total}`} />
          )}
        </div>
      )}

      {(fila || contagem.ativados > 0) && (
        <div style={{ display: "flex", gap: 18, flexWrap: "wrap", fontSize: 12, marginTop: 10 }}>
          <Numero label="Vitrines colhidas" valor={contagem.colhidas} />
          <Numero label="…parciais" valor={contagem.parciais} />
          <Numero label="Vazias" valor={contagem.vazias} />
          <Numero label="Falharam" valor={contagem.falhas} />
          <Numero label="Produtos gravados" valor={contagem.produtos.toLocaleString("pt-BR")} />
          <Numero label="Cupons ativados" valor={contagem.ativados} />
        </div>
      )}
    </div>
  );
}

// As barras da etapa 1 (task 18). A lista não tem um "de N" só: a fila é a lista
// geral e depois as categorias, cada uma com as páginas dela — e no carimbo o que
// encerra de verdade é achar o último cupom sem categoria, não a última página.
function BarrasDaLista({ lista }) {
  const { grouping, nome, lidas, de, categoria, categorias, carimbo, cupons } = lista;
  const onde = grouping ? `de ${nome || grouping}` : "da lista geral";
  return (
    <>
      {categorias > 1 && categoria != null && (
        <Barra
          valor={Math.min(categoria - 1, categorias)}
          total={categorias}
          rotulo={`Fila: ${grouping ? `categoria ${nome || grouping}` : "lista geral"} (${Math.min(categoria, categorias)} de ${categorias})`}
        />
      )}
      {de > 0 && (
        <Barra
          valor={lidas || 0}
          total={de}
          rotulo={`Páginas ${onde}: ${lidas || 0} de ${de}${cupons != null ? ` · ${cupons.toLocaleString("pt-BR")} cupons até aqui` : ""}`}
        />
      )}
      {carimbo?.total > 0 && (
        <Barra valor={carimbo.feitos} total={carimbo.total} rotulo={`Cupons sem categoria já carimbados: ${carimbo.feitos} de ${carimbo.total}`} />
      )}
    </>
  );
}
