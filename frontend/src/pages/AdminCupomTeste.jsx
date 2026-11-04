// Admin › Scraping Cupons › aba "Cupons Teste" — o preço com cupom que a mensagem
// prometeu é o que o Mercado Livre cobra?
//
// Para cada envio recente com cupom, a extensão abre no Chrome do admin o link que
// foi pro grupo, leva o produto ao checkout, digita o cupom e lê quanto o ML
// desconta. O servidor compara com o que a mensagem disse
// (backend/coupons/preco-teste.js); o laço mora em data/precoTeste.js.
import { useState, useEffect, useRef } from "react";
import { PRIMARY_DARK } from "../data/constants";
import {
  adminCuponsTesteConfig, adminCuponsTesteSalvarConfig, adminCuponsTesteAlvos,
  adminCuponsTesteRuns, adminCuponsTesteRun, errText,
} from "../data/api";
import { conferirPrecos, extensaoConfere } from "../data/precoTeste";
import { cardStyle, inputStyle, labelStyle, botaoPrimario, botaoSecundario, botaoLink, th, td, segundos } from "../components/admin/cupomEstilos";
import Barra from "../components/admin/Barra";
import ExtensaoAusente from "../components/admin/ExtensaoAusente";

const reais = (v) => (v == null ? "—" : `R$ ${Number(v).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const dataHora = (v) => (v ? new Date(v).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—");

// Como cada desfecho aparece. A cor diz a gravidade: divergente e "não pegou" são
// promessa errada pro cliente; "falhou" é só que não deu pra conferir.
export const STATUS = {
  ok: { rotulo: "✅ bate", cor: "var(--success-text)" },
  divergente: { rotulo: "⚠️ divergente", cor: "var(--warn-text)" },
  "prometeu-sem-desconto": { rotulo: "⚠️ saiu sem o desconto", cor: "var(--warn-text)" },
  "cupom-nao-pegou": { rotulo: "❌ cupom não pegou", cor: "var(--danger-text)" },
  falhou: { rotulo: "• não deu pra conferir", cor: "var(--color-text-secondary)" },
};

const STATUS_RUN = {
  rodando: "rodando",
  concluida: "concluída",
  cancelada: "parada por você",
  interrompida: "interrompida",
};

// Os campos numéricos da config. Na tela a pausa é em segundos; no servidor, ms.
const CAMPOS = [
  { chave: "dias", rotulo: "Envios dos últimos (dias)", passo: 1, ajuda: "Quanto pra trás olhar no histórico de envios." },
  { chave: "maxProdutos", rotulo: "No máximo (produtos)", passo: 1, ajuda: "Teto por rodada. Cada um leva de 20 s a 1 min." },
  { chave: "toleranciaReais", rotulo: "Diferença aceitável (R$)", passo: 0.01, ajuda: "Até quanto de diferença ainda conta como “bate”." },
  { chave: "pausaEntreMs", rotulo: "Pausa entre produtos (s)", passo: 1, ms: true, ajuda: "Respiro pro anti-robô do ML." },
];
const paraTela = (c, v) => (c.ms ? v / 1000 : v);
const paraServidor = (c, v) => (c.ms ? Math.round(Number(v) * 1000) : Number(v));

function Explicacao() {
  return (
    <div style={{ fontSize: 12, color: "var(--color-text-secondary)", lineHeight: 1.6, marginBottom: 14 }}>
      <b style={{ color: "var(--color-text-primary)" }}>O que este teste faz:</b> pega os produtos que foram
      enviados com cupom nos últimos dias e, um por um, abre <b>neste Chrome</b> (pela extensão) o mesmo link que
      foi pro grupo. Leva o produto até o checkout, digita o cupom e lê quanto o Mercado Livre desconta de
      verdade. Depois compara com o preço que a mensagem prometeu.
      <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
        <li><b>Nunca compra nada</b> — só clica em “Comprar agora”, no quadro dos cupons e em “Inserir”.</li>
        <li>Não muda nada no sistema: o resultado do cupom e os produtos ficam como estão. Só mostra.</li>
        <li>Se o ML pedir verificação, a aba vem pra frente e espera você resolver; se ninguém resolver, a rodada para.</li>
        <li>Envios de antes de 05/11 não guardaram o preço com cupom: a conta é refeita com as regras de hoje e aparece como <i>estimado</i>.</li>
      </ul>
    </div>
  );
}

function Config({ desabilitado, onSalvo }) {
  const [dados, setDados] = useState(null);
  const [editado, setEditado] = useState({});
  const [salvando, setSalvando] = useState(false);
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    let vivo = true;
    adminCuponsTesteConfig()
      .then(r => { if (vivo) setDados(r); })
      .catch(err => { if (vivo) setMsg(errText(err, "Não foi possível ler a configuração.")); });
    return () => { vivo = false; };
  }, []);

  if (!dados) return msg ? <div style={{ fontSize: 12, color: "var(--danger-text)", marginBottom: 12 }}>{msg}</div> : null;
  const cfg = dados.config;
  const valor = (k, padrao) => (k in editado ? editado[k] : padrao);
  const mudou = Object.keys(editado).length > 0;
  const campanhas = valor("campanhas", cfg.campanhas);

  function mexer(k, v) { setEditado(e => ({ ...e, [k]: v })); setMsg(null); }
  function alternarCampanha(id) {
    mexer("campanhas", campanhas.includes(id) ? campanhas.filter(c => c !== id) : [...campanhas, id]);
  }

  async function salvar() {
    setSalvando(true);
    setMsg(null);
    try {
      const patch = {};
      for (const c of CAMPOS) if (c.chave in editado) patch[c.chave] = paraServidor(c, editado[c.chave]);
      for (const k of ["soRepasse", "umPorProduto", "campanhas"]) if (k in editado) patch[k] = editado[k];
      const r = await adminCuponsTesteSalvarConfig(patch);
      // O servidor prende cada número na faixa dele — o que foi cortado aparece.
      const ajustes = CAMPOS
        .filter(c => c.chave in patch && patch[c.chave] !== r.config[c.chave])
        .map(c => `${c.rotulo.replace(/\s*\(.*\)$/, "")} ajustado para ${paraTela(c, r.config[c.chave])}`);
      setDados(d => ({ ...d, config: r.config }));
      setEditado({});
      setMsg(ajustes.length ? `${ajustes.join("; ")}.` : "Configuração salva.");
      onSalvo?.();
    } catch (err) {
      setMsg(errText(err, "Não foi possível salvar."));
    } finally {
      setSalvando(false);
    }
  }

  const visiveis = (dados.campanhas || []).filter(g => !valor("soRepasse", cfg.soRepasse) || g.repasse);

  return (
    <div style={{ border: "0.5px solid var(--color-border-tertiary)", borderRadius: 10, padding: 12, marginBottom: 14 }}>
      <div style={{ fontWeight: 500, fontSize: 13, marginBottom: 10 }}>Configuração</div>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 10 }}>
        {CAMPOS.map(c => (
          <div key={c.chave} style={{ maxWidth: 190 }}>
            <label style={labelStyle} htmlFor={`ct-${c.chave}`}>{c.rotulo}</label>
            <input
              id={`ct-${c.chave}`} type="number" step={c.passo} disabled={desabilitado}
              value={valor(c.chave, paraTela(c, cfg[c.chave]))}
              onChange={e => mexer(c.chave, e.target.value)}
              style={{ ...inputStyle, width: 110 }}
            />
            <div style={{ fontSize: 10, color: "var(--color-text-secondary)", marginTop: 3 }}>{c.ajuda}</div>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 18, flexWrap: "wrap", marginBottom: 10 }}>
        <label style={{ fontSize: 12, display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
          <input type="checkbox" disabled={desabilitado} checked={valor("soRepasse", cfg.soRepasse)} onChange={e => mexer("soRepasse", e.target.checked)} />
          só campanhas de repasse
        </label>
        <label style={{ fontSize: 12, display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
          <input type="checkbox" disabled={desabilitado} checked={valor("umPorProduto", cfg.umPorProduto)} onChange={e => mexer("umPorProduto", e.target.checked)} />
          conferir cada produto+cupom uma vez só (mesmo se foi pra vários grupos)
        </label>
      </div>
      {visiveis.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div style={labelStyle}>Campanhas (nenhuma marcada = todas)</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px", maxHeight: 120, overflowY: "auto" }}>
            {visiveis.map(g => (
              <label key={g.id} style={{ fontSize: 12, display: "flex", gap: 5, alignItems: "center", cursor: "pointer" }}>
                <input type="checkbox" disabled={desabilitado} checked={campanhas.includes(g.id)} onChange={() => alternarCampanha(g.id)} />
                {g.name}{g.repasse ? <span style={{ color: "var(--color-text-secondary)" }}> · repasse</span> : null}
              </label>
            ))}
          </div>
        </div>
      )}
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <button onClick={salvar} disabled={!mudou || salvando || desabilitado} style={botaoPrimario(!mudou || salvando || desabilitado)}>
          {salvando ? "salvando…" : "Salvar configuração"}
        </button>
        {mudou && !salvando && <button onClick={() => { setEditado({}); setMsg(null); }} style={botaoSecundario}>Desfazer</button>}
        {msg && <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>{msg}</span>}
      </div>
    </div>
  );
}

// A tabela de resultados — da rodada em curso ou de uma do histórico.
export function TabelaItens({ itens }) {
  const [filtro, setFiltro] = useState("todos");
  const contagem = itens.reduce((m, i) => ({ ...m, [i.status]: (m[i.status] || 0) + 1 }), {});
  const lista = filtro === "todos" ? itens : itens.filter(i => i.status === filtro);
  if (!itens.length) return null;
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
        {[["todos", `todos (${itens.length})`], ...Object.keys(STATUS).filter(s => contagem[s]).map(s => [s, `${STATUS[s].rotulo} (${contagem[s]})`])].map(([id, rotulo]) => (
          <button key={id} onClick={() => setFiltro(id)} style={{ ...botaoLink, fontWeight: filtro === id ? 600 : 400, border: `1px solid ${filtro === id ? PRIMARY_DARK : "var(--color-border-tertiary)"}` }}>
            {rotulo}
          </button>
        ))}
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--color-text-secondary)" }}>
              <th style={th}>Produto</th>
              <th style={th}>Cupom</th>
              <th style={th}>Mensagem disse</th>
              <th style={th}>ML cobra</th>
              <th style={th}>Diferença</th>
              <th style={th}>Resultado</th>
            </tr>
          </thead>
          <tbody>
            {lista.map(i => {
              const st = STATUS[i.status] || STATUS.falhou;
              return (
                <tr key={i.id} style={{ borderTop: "0.5px solid var(--color-border-tertiary)" }}>
                  <td style={{ ...td, minWidth: 200 }}>
                    <div style={{ display: "flex", gap: 8 }}>
                      {i.img && <img src={i.img} alt="" width={36} height={36} style={{ objectFit: "contain", borderRadius: 4, flexShrink: 0 }} />}
                      <div>
                        <a href={i.link} target="_blank" rel="noreferrer" style={{ color: "var(--color-text-primary)" }}>{i.name || i.link}</a>
                        <div style={{ color: "var(--color-text-secondary)", fontSize: 11 }}>
                          {i.groupName || "—"} · enviado {dataHora(i.sentAt)}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td style={td}><code>{i.coupon}</code></td>
                  <td style={{ ...td, whiteSpace: "nowrap" }}>
                    {reais(i.prometidoComCupom ?? i.prometidoPreco)}
                    {i.prometidoComCupom == null && <div style={{ fontSize: 10, color: "var(--color-text-secondary)" }}>sem desconto</div>}
                    {i.estimado && <div style={{ fontSize: 10, color: "var(--warn-text)" }} title="Envio antigo: refeito com as regras de hoje">estimado</div>}
                  </td>
                  <td style={{ ...td, whiteSpace: "nowrap" }}>
                    {reais(i.realComCupom)}
                    {i.precoPagina != null && (
                      <div style={{ fontSize: 10, color: "var(--color-text-secondary)" }}>
                        {reais(i.precoPagina)} − {reais(i.descontoMl)}
                      </div>
                    )}
                  </td>
                  <td style={{ ...td, whiteSpace: "nowrap", color: i.diferenca < 0 ? "var(--danger-text)" : "inherit" }}>
                    {i.diferenca == null ? "—" : `${i.diferenca > 0 ? "+" : ""}${reais(i.diferenca)}`}
                  </td>
                  <td style={{ ...td, minWidth: 220 }}>
                    <div style={{ color: st.cor, fontWeight: 500 }}>{st.rotulo}</div>
                    {i.motivo && <div style={{ color: "var(--color-text-secondary)", fontSize: 11, lineHeight: 1.5 }}>{i.motivo}</div>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 6 }}>
        Diferença = mensagem − ML. Negativa (vermelha) é o caso grave: a mensagem prometeu mais barato do que o cliente vai pagar.
      </div>
    </div>
  );
}

function Historico({ versao }) {
  const [runs, setRuns] = useState(null);
  const [aberta, setAberta] = useState(null);
  const [itens, setItens] = useState(null);
  const [erro, setErro] = useState(null);

  useEffect(() => {
    let vivo = true;
    adminCuponsTesteRuns()
      .then(r => { if (vivo) setRuns(r.runs || []); })
      .catch(err => { if (vivo) setErro(errText(err, "Não foi possível ler o histórico.")); });
    return () => { vivo = false; };
  }, [versao]);

  async function abrir(id) {
    if (aberta === id) { setAberta(null); setItens(null); return; }
    setAberta(id);
    setItens(null);
    try {
      setItens((await adminCuponsTesteRun(id)).itens || []);
    } catch (err) {
      setErro(errText(err, "Não foi possível abrir a rodada."));
    }
  }

  if (erro) return <div style={{ fontSize: 12, color: "var(--danger-text)", marginTop: 14 }}>{erro}</div>;
  if (!runs?.length) return null;
  return (
    <div style={{ marginTop: 18 }}>
      <div style={{ fontWeight: 500, fontSize: 13, marginBottom: 6 }}>Rodadas anteriores</div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--color-text-secondary)" }}>
              <th style={th}>Quando</th><th style={th}>Conferidos</th><th style={th}>✅</th><th style={th}>⚠️</th><th style={th}>❌</th><th style={th}>•</th><th style={th}>Situação</th><th style={th} />
            </tr>
          </thead>
          <tbody>
            {runs.map(r => (
              <tr key={r.id} style={{ borderTop: "0.5px solid var(--color-border-tertiary)" }}>
                <td style={td}>{dataHora(r.startedAt)}</td>
                <td style={td}>{r.feitos} de {r.total}</td>
                <td style={td}>{r.ok}</td>
                <td style={td}>{r.divergente}</td>
                <td style={td}>{r.naoPegou}</td>
                <td style={td}>{r.falhou}</td>
                <td style={{ ...td, color: "var(--color-text-secondary)" }} title={r.motivoFim || ""}>{STATUS_RUN[r.status] || r.status}</td>
                <td style={td}><button onClick={() => abrir(r.id)} style={botaoLink}>{aberta === r.id ? "fechar" : "ver"}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {aberta && (itens ? <TabelaItens itens={itens} /> : <div style={{ fontSize: 12, marginTop: 8 }}>carregando…</div>)}
    </div>
  );
}

export default function CuponsTeste() {
  const [temExtensao, setTemExtensao] = useState(null);
  const [previa, setPrevia] = useState(null);
  const [erro, setErro] = useState(null);
  const [versaoCfg, setVersaoCfg] = useState(0);

  const [rodando, setRodando] = useState(false);
  const [parando, setParando] = useState(false);
  const [total, setTotal] = useState(0);
  const [atual, setAtual] = useState(null);   // { i, alvo, passo, desde }
  const [aviso, setAviso] = useState(null);   // pausa / muro
  const [itens, setItens] = useState([]);
  const [fim, setFim] = useState(null);
  const [inicio, setInicio] = useState(null);
  const [agora, setAgora] = useState(Date.now());
  const [execucoes, setExecucoes] = useState(0);
  const parar = useRef(false);

  useEffect(() => {
    let vivo = true;
    extensaoConfere().then(v => { if (vivo) setTemExtensao(!!v); }).catch(() => { if (vivo) setTemExtensao(false); });
    return () => { vivo = false; };
  }, []);

  useEffect(() => {
    if (rodando) return undefined;
    let vivo = true;
    adminCuponsTesteAlvos()
      .then(r => { if (vivo) { setPrevia(r); setErro(null); } })
      .catch(err => { if (vivo) setErro(errText(err, "Não foi possível montar a lista de envios.")); });
    return () => { vivo = false; };
  }, [versaoCfg, rodando]);

  // O relógio do "tempo decorrido / falta mais ou menos".
  useEffect(() => {
    if (!rodando) return undefined;
    const t = setInterval(() => setAgora(Date.now()), 1000);
    return () => clearInterval(t);
  }, [rodando]);

  // Sair da página no meio: o navegador pergunta antes.
  useEffect(() => {
    if (!rodando) return undefined;
    const segurar = (e) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", segurar);
    return () => window.removeEventListener("beforeunload", segurar);
  }, [rodando]);

  async function rodar() {
    parar.current = false;
    setRodando(true);
    setParando(false);
    setErro(null);
    setItens([]);
    setFim(null);
    setAtual(null);
    setAviso(null);
    setTotal(0);
    setInicio(Date.now());
    try {
      const r = await conferirPrecos({
        parou: () => parar.current,
        onProgresso: (ev) => {
          if (ev.tipo === "inicio") setTotal(ev.total);
          else if (ev.tipo === "produto") { setAtual({ i: ev.i, alvo: ev.alvo, passo: "abrindo o link que foi pro grupo…", desde: Date.now() }); setAviso(null); }
          else if (ev.tipo === "passo") setAtual(a => (a ? { ...a, passo: ev.texto } : a));
          else if (ev.tipo === "muro") setAviso({ muro: true, texto: "O Mercado Livre pediu verificação. Resolva na aba que veio pra frente — a rodada continua sozinha depois." });
          else if (ev.tipo === "feito") { setItens(l => [...l, ev.item]); setAtual(null); }
          else if (ev.tipo === "pausa") setAviso({ texto: `Pausa de ${Math.round(ev.ms / 1000)} s antes do próximo, pra não acordar o anti-robô do ML.` });
        },
      });
      setFim(r);
    } catch (err) {
      setErro(errText(err, "A rodada não terminou."));
    } finally {
      setRodando(false);
      setParando(false);
      setAtual(null);
      setAviso(null);
      setExecucoes(n => n + 1);
    }
  }

  const feitos = itens.length;
  const decorrido = inicio ? agora - inicio : 0;
  const media = feitos ? decorrido / feitos : null;
  const falta = media && total > feitos ? media * (total - feitos) : null;
  const conta = (s) => itens.filter(i => s.includes(i.status)).length;
  const n = previa?.total ?? 0;

  return (
    <div style={cardStyle}>
      <div style={{ fontWeight: 500, marginBottom: 6 }}>Conferir o preço com cupom dos envios</div>
      <Explicacao />

      <Config desabilitado={rodando} onSalvo={() => setVersaoCfg(v => v + 1)} />

      {temExtensao === false && (
        <div style={{ border: "0.5px solid var(--warn-text)", borderRadius: 8, padding: 10, marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 4 }}>A extensão não respondeu (ou é antiga demais para testar cupom no checkout).</div>
          <ExtensaoAusente compacto />
        </div>
      )}

      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <button onClick={rodar} disabled={rodando || !n || !temExtensao} style={botaoPrimario(rodando || !n || !temExtensao)}>
          {rodando ? "⟳ conferindo…" : "Conferir preços"}
        </button>
        {rodando && (
          <button onClick={() => { parar.current = true; setParando(true); }} disabled={parando} style={botaoSecundario}>
            {parando ? "parando depois do produto aberto…" : "Parar"}
          </button>
        )}
        {!rodando && previa && (
          <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
            {n
              ? `Vai conferir ${n} produto(s) de ${previa.campanhas} campanha(s)${previa.disponiveis > n ? ` (de ${previa.disponiveis} com cupom no período)` : ""}${previa.estimados ? ` · ${previa.estimados} estimado(s)` : ""} · uns ${segundos(n * (40000 + (previa.config?.pausaEntreMs || 0)))}.`
              : `Nenhum envio com cupom no período (${previa.envios} envio(s) do ML olhados, ${previa.semCupom} sem cupom).`}
          </span>
        )}
      </div>

      {erro && <div style={{ fontSize: 12, color: "var(--danger-text)", marginTop: 10 }}>{erro}</div>}

      {(rodando || feitos > 0) && (
        <div style={{ marginTop: 14 }}>
          <Barra
            valor={feitos}
            total={total}
            rotulo={`${feitos} de ${total} conferido(s)`}
            direita={rodando ? `${segundos(decorrido) || "0s"}${falta ? ` · falta ~${segundos(falta)}` : ""}` : undefined}
          />
          <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 6, fontVariantNumeric: "tabular-nums" }}>
            ✅ {conta(["ok"])} bate · ⚠️ {conta(["divergente", "prometeu-sem-desconto"])} divergente · ❌ {conta(["cupom-nao-pegou"])} não pegou · • {conta(["falhou"])} não deu pra conferir
          </div>
          {rodando && atual && (
            <div style={{ fontSize: 12, marginTop: 8, display: "flex", gap: 8, alignItems: "center" }}>
              {atual.alvo?.img && <img src={atual.alvo.img} alt="" width={32} height={32} style={{ objectFit: "contain", borderRadius: 4 }} />}
              <div>
                <div><b>{atual.i}/{total}</b> · {atual.alvo?.name} · cupom <code>{atual.alvo?.coupon}</code></div>
                <div style={{ color: PRIMARY_DARK }}>{atual.passo} <span style={{ color: "var(--color-text-secondary)" }}>({segundos(agora - atual.desde) || "0s"})</span></div>
              </div>
            </div>
          )}
          {aviso && <div style={{ fontSize: 12, marginTop: 6, color: aviso.muro ? "var(--warn-text)" : PRIMARY_DARK }}>{aviso.texto}</div>}
          {fim && (
            <div style={{ fontSize: 12, marginTop: 8, color: fim.status === "concluida" ? "var(--success-text)" : "var(--warn-text)" }}>
              {fim.status === "concluida" ? "Rodada concluída." : fim.motivo || STATUS_RUN[fim.status]}
            </div>
          )}
          <TabelaItens itens={itens} />
        </div>
      )}

      <Historico versao={execucoes} />
    </div>
  );
}
