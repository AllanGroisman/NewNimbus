import { useState, useEffect, useRef } from "react";
import { PRIMARY_DARK, CATEGORIES } from "../../data/constants";
import { adminSondaLoteAlvos, adminSondaLoteConfig, adminSondaLoteSalvarConfig, adminSondaLoteRuns, errText } from "../../data/api";
import { sondarLote, descreverPasso } from "../../data/sondaLote";
import { cardStyle, inputStyle, labelStyle, botaoSecundario, botaoPrimario } from "./cupomEstilos";

// Admin › Cupom › Cupons do produto › "Testar os produtos do scraping" (task 13):
// a sonda do checkout, produto a produto, com o progresso na tela.
//
// A fila e a ordem vêm do servidor (backend/coupons/checkout-lote.js). Aqui ficam
// os filtros, o botão e o andamento.

const rotuloCat = (c) => CATEGORIES[c]?.label || c;

// Os campos do ritmo (backend/coupons/checkout-lote-config.js). Na tela tudo em
// segundos; no servidor, ms.
const CAMPOS_RITMO = [
  { chave: "paralelo", rotulo: "Abas ao mesmo tempo", ms: false, passo: 1 },
  { chave: "pausaMs", rotulo: "Pausa entre produtos, por aba (s)", ms: true, passo: 0.5 },
  { chave: "settleMs", rotulo: "Assentar a página (s)", ms: true, passo: 0.1 },
  { chave: "esperaNavMs", rotulo: "Teto para sair rumo ao checkout (s)", ms: true, passo: 1 },
  { chave: "esperaCheckoutMs", rotulo: "Teto para o checkout montar (s)", ms: true, passo: 1 },
];
const paraTela = (campo, v) => (campo.ms ? v / 1000 : v);
const paraServidor = (campo, v) => (campo.ms ? Math.round(Number(v) * 1000) : Number(v));

// O ritmo do lote: carregado do servidor, editado aqui, gravado no "Salvar".
function Ritmo({ desabilitado }) {
  const [cfg, setCfg] = useState(null);
  const [faixas, setFaixas] = useState({});
  const [editado, setEditado] = useState({});
  const [salvando, setSalvando] = useState(false);
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    let vivo = true;
    adminSondaLoteConfig()
      .then(r => { if (vivo) { setCfg(r.config); setFaixas(r.faixas || {}); } })
      .catch(err => { if (vivo) setMsg(errText(err, "Não foi possível ler o ritmo.")); });
    return () => { vivo = false; };
  }, []);

  if (!cfg) return msg ? <div style={{ fontSize: 12, color: "var(--danger-text)", marginBottom: 12 }}>{msg}</div> : null;

  const valor = (campo) => (campo.chave in editado ? editado[campo.chave] : paraTela(campo, cfg[campo.chave]));
  const mudou = Object.keys(editado).length > 0;

  async function salvar() {
    setSalvando(true);
    setMsg(null);
    try {
      const patch = {};
      for (const campo of CAMPOS_RITMO) if (campo.chave in editado) patch[campo.chave] = paraServidor(campo, editado[campo.chave]);
      if ("modoRapido" in editado) patch.modoRapido = editado.modoRapido;
      const r = await adminSondaLoteSalvarConfig(patch);
      // O servidor prende cada número na faixa dele. O que foi cortado precisa
      // aparecer — senão o 9 digitado vira 8 sem ninguém saber.
      const ajustes = CAMPOS_RITMO
        .filter(campo => campo.chave in patch && patch[campo.chave] !== r.config[campo.chave])
        .map(campo => {
          const [, max] = faixas[campo.chave] || [];
          return `${campo.rotulo.replace(/\s*\(s\)$/, "")} ajustado para ${paraTela(campo, r.config[campo.chave])}${max != null ? ` (máximo ${paraTela(campo, max)})` : ""}`;
        });
      setCfg(r.config);
      setEditado({});
      setMsg(ajustes.length ? `${ajustes.join("; ")}.` : "Ritmo salvo — vale a partir do próximo lote.");
    } catch (err) {
      setMsg(errText(err, "Não foi possível salvar o ritmo."));
    } finally {
      setSalvando(false);
    }
  }

  const rapido = "modoRapido" in editado ? editado.modoRapido : cfg.modoRapido;
  const abas = Number(valor(CAMPOS_RITMO[0]));
  return (
    <details style={{ marginBottom: 12 }}>
      <summary style={{ fontSize: 12, cursor: "pointer" }}>
        Ritmo: {cfg.paralelo} aba(s), pausa de {cfg.pausaMs / 1000}s{cfg.modoRapido ? ", modo rápido" : ""}
      </summary>
      <div style={{ fontSize: 12, color: "var(--color-text-secondary)", margin: "6px 0 10px", lineHeight: 1.5 }}>
        Mais abas e menos pausa sondam mais produtos por minuto, mas aumentam a chance de o ML pedir verificação.
        E o muro vale para a <b>conta</b>, que é a mesma do Hub. Com mais de uma aba, o caminho pelo carrinho fica
        desligado (o carrinho é um só), e o produto que só chegaria ao checkout por ele volta como falha.
      </div>
      <div style={{ display: "flex", gap: 14, alignItems: "flex-end", flexWrap: "wrap" }}>
        {CAMPOS_RITMO.map(campo => {
          const [min, max] = faixas[campo.chave] || [];
          return (
            <div key={campo.chave}>
              <label style={labelStyle} htmlFor={`ritmo-${campo.chave}`}>{campo.rotulo}</label>
              <input id={`ritmo-${campo.chave}`} type="number" step={campo.passo} disabled={desabilitado || salvando}
                min={min != null ? paraTela(campo, min) : undefined} max={max != null ? paraTela(campo, max) : undefined}
                value={valor(campo)} onChange={e => setEditado(ed => ({ ...ed, [campo.chave]: e.target.value }))}
                style={{ ...inputStyle, width: 90 }} />
            </div>
          );
        })}
        <label style={{ fontSize: 12, display: "flex", gap: 6, alignItems: "center", paddingBottom: 8, cursor: "pointer" }}>
          <input type="checkbox" checked={!!rapido} disabled={desabilitado || salvando}
            onChange={e => setEditado(ed => ({ ...ed, modoRapido: e.target.checked }))} />
          modo rápido (para assim que a página dos cupons foi lida)
        </label>
        <button onClick={salvar} disabled={desabilitado || salvando || !mudou} style={botaoSecundario}>
          {salvando ? "salvando..." : "Salvar ritmo"}
        </button>
      </div>
      {abas > 4 && (
        <div style={{ fontSize: 12, color: "var(--warn-text)", marginTop: 6 }}>
          Acima de 4 abas, o risco de o ML pedir verificação sobe bastante. Comece baixo e suba olhando o histórico.
        </div>
      )}
      {msg && <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 6 }}>{msg}</div>}
    </details>
  );
}
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

const segundos = (ms) => (ms == null ? "—" : `${(ms / 1000).toFixed(1).replace(".", ",")} s`);
const duracao = (ms) => {
  if (ms == null) return "—";
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return m ? `${m} min ${s} s` : `${s} s`;
};
const quando = (iso) => new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const th = { textAlign: "left", fontWeight: 500, padding: "4px 8px 4px 0", whiteSpace: "nowrap" };
const td = { padding: "4px 8px 4px 0", borderTop: "0.5px solid var(--color-border-tertiary)", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" };

// As últimas execuções do lote, a mais nova primeiro. "Por produto" é o RITMO
// (duração ÷ produtos): é o número que as abas em paralelo e a pausa mexem. "Sonda
// média" é quanto UMA sonda leva, que com várias abas é maior que o ritmo.
function Historico({ versao }) {
  const [runs, setRuns] = useState(null);
  const [erro, setErro] = useState(null);

  useEffect(() => {
    let vivo = true;
    adminSondaLoteRuns()
      .then(r => { if (vivo) { setRuns(r.runs || []); setErro(null); } })
      .catch(err => { if (vivo) setErro(errText(err, "Não foi possível ler o histórico.")); });
    return () => { vivo = false; };
  }, [versao]);

  if (erro) return <div style={{ fontSize: 12, color: "var(--danger-text)", marginTop: 14 }}>{erro}</div>;
  if (!runs?.length) return null;

  return (
    <div style={{ marginTop: 18 }}>
      <div style={{ fontWeight: 500, fontSize: 13, marginBottom: 6 }}>Últimas execuções</div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ fontSize: 12, borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr>
              <th style={th}>Quando</th>
              <th style={th}>Produtos</th>
              <th style={th}>Duração</th>
              <th style={th}>Por produto</th>
              <th style={th}>Sonda média</th>
              <th style={th}>Com cupom</th>
              <th style={th}>Falhas</th>
              <th style={th}>Ritmo</th>
              <th style={th}>Fim</th>
            </tr>
          </thead>
          <tbody>
            {runs.map(r => (
              <tr key={r.inicio}>
                <td style={td}>{quando(r.inicio)}</td>
                <td style={td}>{r.produtos}{r.naFila > r.produtos ? ` de ${r.naFila}` : ""}</td>
                <td style={td}>{duracao(r.duracaoMs)}</td>
                <td style={td}><b>{r.produtos ? segundos(r.duracaoMs / r.produtos) : "—"}</b></td>
                <td style={td}>{segundos(r.mediaSondaMs)}</td>
                <td style={td}>{r.comCupom}</td>
                <td style={td}>{r.falhas}</td>
                <td style={{ ...td, color: "var(--color-text-secondary)" }}>
                  {r.ritmo?.paralelo ?? "?"} aba(s) · pausa {segundos(r.ritmo?.pausaMs)}{r.ritmo?.modoRapido ? " · rápido" : ""}
                </td>
                <td style={{ ...td, color: r.muro ? "var(--warn-text)" : "var(--color-text-secondary)" }}>
                  {r.muro ? "verificação do ML" : r.parado ? "interrompido" : "completo"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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
  // O que cada aba está fazendo agora: { [aba]: { produto, passo } }.
  const [emCurso, setEmCurso] = useState({});
  const [passo, setPasso] = useState(null);
  const [feitos, setFeitos] = useState([]);
  const [fim, setFim] = useState(null);
  const parar = useRef(false);
  // Muda no fim de cada execução: é o que faz o histórico reler.
  const [execucoes, setExecucoes] = useState(0);

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
    setEmCurso({});
    setTotal(0);
    try {
      const r = await sondarLote({
        filtros,
        parou: () => parar.current,
        onProgresso: (ev) => {
          if (ev.tipo === "fila") setTotal(ev.total);
          else if (ev.tipo === "produto") { setEmCurso(c => ({ ...c, [ev.aba ?? 0]: { produto: ev.produto, passo: "abrindo a página do produto…" } })); setPasso(null); }
          else if (ev.tipo === "passo") {
            const t = descreverPasso(ev.passo);
            if (t) setEmCurso(c => (c[ev.aba ?? 0] ? { ...c, [ev.aba ?? 0]: { ...c[ev.aba ?? 0], passo: t } } : c));
          }
          else if (ev.tipo === "produto-feito") {
            setFeitos(f => [...f, ev]);
            setEmCurso(c => { const n = { ...c }; if (n[ev.aba ?? 0]?.produto?.key === ev.key) delete n[ev.aba ?? 0]; return n; });
          }
          else if (ev.tipo === "pausa") setPasso(`pausa de ${Math.round(ev.ms / 1000)}s antes do próximo (pra não acordar o anti-robô)`);
        },
      });
      setFim(r);
    } catch (err) {
      setErro(errText(err, "O lote não terminou."));
    } finally {
      setRodando(false);
      setParando(false);
      setExecucoes(n => n + 1);
      setEmCurso({});
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
        (de 10 a 20&nbsp;s cada no modo rápido; mais quando o checkout pede passos), e por isso a fila é escolhida assim: só os produtos do ML que estão no scraping,
        pulando os que já foram sondados há pouco e alternando entre as categorias. As categorias em que as
        sondas anteriores acharam cupom ganham mais vagas. Se o ML pedir verificação, o lote para.
      </div>

      <Ritmo desabilitado={rodando} />

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
            {parando ? "vai parar depois dos produtos em curso" : "Parar"}
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
            <span>{feitos.length} de {total} produto(s) sondado(s)</span>
            <span style={{ color: "var(--color-text-secondary)", fontVariantNumeric: "tabular-nums" }}>
              🎟️ {comCupom} com cupom · {semCupom} sem · {falhas} não chegou
            </span>
          </div>
          <Barra valor={feitos.length} total={total} />
          {rodando && Object.entries(emCurso).map(([aba, c]) => (
            <div key={aba} style={{ fontSize: 12, marginTop: 6 }}>
              {Object.keys(emCurso).length > 1 && <span style={{ color: "var(--color-text-secondary)" }}>aba {Number(aba) + 1}: </span>}
              <b>{c.produto?.name}</b>
              {c.passo && <span style={{ color: PRIMARY_DARK }}> — {c.passo}</span>}
            </div>
          ))}
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

      <Historico versao={execucoes} />
    </div>
  );
}
