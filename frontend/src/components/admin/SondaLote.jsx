import { useState, useEffect, useRef } from "react";
import { PRIMARY_DARK, CATEGORIES } from "../../data/constants";
import { adminSondaLoteAlvos, errText } from "../../data/api";
import { sondarLote, descreverPasso } from "../../data/sondaLote";
import { cardStyle, inputStyle, labelStyle, botaoSecundario, botaoPrimario } from "./cupomEstilos";

// Admin › Cupom › Cupons do produto › "Testar os produtos do scraping" (task 13):
// a sonda do checkout, produto a produto, com o progresso na tela.
//
// A fila e a ordem vêm do servidor (backend/coupons/checkout-lote.js). Aqui ficam
// os filtros, o botão e o andamento.

const rotuloCat = (c) => CATEGORIES[c]?.label || c;
const pct = (a, b) => (b > 0 ? `${Math.round((a / b) * 100)}%` : "—");

function Barra({ valor, total }) {
  const p = total > 0 ? Math.min(100, Math.round((valor / total) * 100)) : 0;
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={valor}
      aria-label="Produtos sondados"
      style={{ height: 6, borderRadius: 3, background: "var(--color-border-tertiary)", overflow: "hidden", marginTop: 4 }}
    >
      <div style={{ width: `${p}%`, height: "100%", background: "var(--success-text)", transition: "width .3s" }} />
    </div>
  );
}

export default function SondaLote() {
  const [categorias, setCategorias] = useState([]);
  const [limite, setLimite] = useState(20);
  const [pularDias, setPularDias] = useState(7);
  const [soSemCupom, setSoSemCupom] = useState(false);

  const [previa, setPrevia] = useState(null);
  const [erro, setErro] = useState(null);

  const [rodando, setRodando] = useState(false);
  const [parando, setParando] = useState(false);
  const [total, setTotal] = useState(0);
  const [atual, setAtual] = useState(null);
  const [passo, setPasso] = useState(null);
  const [feitos, setFeitos] = useState([]);
  const [fim, setFim] = useState(null);
  const parar = useRef(false);

  const filtros = { categorias, limite: Number(limite) || 20, pularDias: Number(pularDias) || 0, soSemCupom };
  const chaveFiltros = JSON.stringify(filtros);

  useEffect(() => {
    if (rodando) return undefined;
    let vivo = true;
    adminSondaLoteAlvos(filtros)
      .then(r => { if (vivo) { setPrevia(r); setErro(null); } })
      .catch(err => { if (vivo) setErro(errText(err, "Não foi possível montar a fila.")); });
    return () => { vivo = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chaveFiltros, rodando]);

  function alternar(cat) {
    setCategorias(cs => (cs.includes(cat) ? cs.filter(c => c !== cat) : [...cs, cat]));
  }

  async function testar() {
    parar.current = false;
    setRodando(true);
    setParando(false);
    setErro(null);
    setFeitos([]);
    setFim(null);
    setAtual(null);
    setTotal(0);
    try {
      const r = await sondarLote({
        filtros,
        parou: () => parar.current,
        onProgresso: (ev) => {
          if (ev.tipo === "fila") setTotal(ev.total);
          else if (ev.tipo === "produto") { setAtual(ev.produto); setPasso("abrindo a página do produto…"); }
          else if (ev.tipo === "passo") { const t = descreverPasso(ev.passo); if (t) setPasso(t); }
          else if (ev.tipo === "produto-feito") setFeitos(f => [...f, ev]);
          else if (ev.tipo === "pausa") setPasso(`pausa de ${Math.round(ev.ms / 1000)}s antes do próximo (pra não acordar o anti-robô)`);
        },
      });
      setFim(r);
    } catch (err) {
      setErro(errText(err, "O lote não terminou."));
    } finally {
      setRodando(false);
      setParando(false);
      setAtual(null);
      setPasso(null);
    }
  }

  const comCupom = feitos.filter(f => f.ok && f.cupons.length).length;
  const semCupom = feitos.filter(f => f.ok && !f.cupons.length).length;
  const falhas = feitos.filter(f => !f.ok).length;
  const naFila = previa?.produtos?.length ?? 0;

  return (
    <div style={cardStyle}>
      <div style={{ fontWeight: 500, marginBottom: 4 }}>Testar os produtos do scraping</div>
      <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 12, lineHeight: 1.5 }}>
        A mesma sonda de cima, produto a produto. Cada sonda já traz <b>todos</b> os cupons que o checkout
        oferece para aquele produto, então não é preciso testar cupom por cupom. O que custa é o produto
        (de 40 a 90&nbsp;s cada), e por isso a fila é escolhida assim: só os produtos do ML que estão no scraping,
        pulando os que já foram sondados há pouco e alternando entre as categorias. As categorias em que as
        sondas anteriores acharam cupom ganham mais vagas. Se o ML pedir verificação, o lote para.
      </div>

      {previa?.porCategoria?.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={labelStyle}>Categorias (nenhuma marcada = todas)</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 14px" }}>
            {previa.porCategoria.map(c => (
              <label key={c.category} style={{ fontSize: 12, display: "flex", gap: 5, alignItems: "center", cursor: "pointer" }}>
                <input type="checkbox" checked={categorias.includes(c.category)} onChange={() => alternar(c.category)} disabled={rodando} />
                {rotuloCat(c.category)}
                <span style={{ color: "var(--color-text-secondary)" }}>
                  {c.elegiveis} na fila{c.sondados ? ` · cupom em ${c.comCupom}/${c.sondados} (${pct(c.comCupom, c.sondados)})` : ""}
                </span>
              </label>
            ))}
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: 14, alignItems: "flex-end", flexWrap: "wrap", marginBottom: 12 }}>
        <div>
          <label style={labelStyle} htmlFor="lote-limite">Quantos produtos</label>
          <input id="lote-limite" type="number" min={1} max={200} value={limite} disabled={rodando}
            onChange={e => setLimite(e.target.value)} style={{ ...inputStyle, width: 90 }} />
        </div>
        <div>
          <label style={labelStyle} htmlFor="lote-pular">Pular os sondados há menos de (dias)</label>
          <input id="lote-pular" type="number" min={0} max={90} value={pularDias} disabled={rodando}
            onChange={e => setPularDias(e.target.value)} style={{ ...inputStyle, width: 90 }} />
        </div>
        <label style={{ fontSize: 12, display: "flex", gap: 6, alignItems: "center", paddingBottom: 8, cursor: "pointer" }}>
          <input type="checkbox" checked={soSemCupom} onChange={e => setSoSemCupom(e.target.checked)} disabled={rodando} />
          só os que ainda não têm cupom conhecido
        </label>
      </div>

      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <button onClick={testar} disabled={rodando || !naFila} style={botaoPrimario(rodando || !naFila)}>
          {rodando ? "⟳ testando..." : "Testar produtos"}
        </button>
        {rodando && (
          <button onClick={() => { parar.current = true; setParando(true); }} disabled={parando} style={botaoSecundario}>
            {parando ? "vai parar depois deste produto" : "Parar"}
          </button>
        )}
        {!rodando && previa && (
          <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
            {naFila
              ? `${naFila} produto(s) neste lote, de ${previa.total} elegível(is)`
              : "Nenhum produto elegível com esses filtros."}
          </span>
        )}
      </div>

      {erro && <div style={{ fontSize: 12, color: "var(--danger-text)", marginTop: 10 }}>{erro}</div>}

      {(rodando || feitos.length > 0) && (
        <div style={{ marginTop: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
            <span>
              {rodando && atual
                ? <>Produto {Math.min(feitos.length + 1, total)} de {total}: <b>{atual.name}</b></>
                : `${feitos.length} de ${total} produto(s) sondado(s)`}
            </span>
            <span style={{ color: "var(--color-text-secondary)", fontVariantNumeric: "tabular-nums" }}>
              🎟️ {comCupom} com cupom · {semCupom} sem · {falhas} não chegou
            </span>
          </div>
          <Barra valor={feitos.length} total={total} />
          {passo && <div style={{ fontSize: 12, color: PRIMARY_DARK, marginTop: 6 }}>{passo}</div>}
          {fim?.parado && (
            <div style={{ fontSize: 12, color: fim.muro ? "var(--warn-text)" : "var(--color-text-secondary)", marginTop: 6 }}>{fim.parado}</div>
          )}

          <div style={{ maxHeight: 260, overflowY: "auto", marginTop: 10, fontSize: 12, lineHeight: 1.6 }}>
            {[...feitos].reverse().map(f => (
              <div key={f.key} style={{ borderTop: "0.5px solid var(--color-border-tertiary)", padding: "4px 0" }}>
                <a href={f.link} target="_blank" rel="noreferrer" style={{ color: "var(--color-text-primary)" }}>{f.name}</a>
                <span style={{ color: "var(--color-text-secondary)" }}> · {rotuloCat(f.category)}</span>
                <div>
                  {!f.ok
                    ? <span style={{ color: "var(--warn-text)" }}>não chegou na lista de cupons{f.motivo ? ` — ${f.motivo}` : ""}</span>
                    : f.cupons.length
                      ? f.cupons.map(c => (
                          <span key={c.campaignId} style={{ color: PRIMARY_DARK, marginRight: 10 }}>
                            🎟️ {c.titulo || c.campaignId}{c.descontoNoCarrinho ? ` (−R$ ${Number(c.descontoNoCarrinho).toFixed(2).replace(".", ",")})` : ""}
                          </span>
                        ))
                      : <span style={{ color: "var(--color-text-secondary)" }}>o checkout não ofereceu cupom</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
