import { useState, useEffect, useCallback } from "react";
import Toggle from "../components/ui/Toggle";
import Modal from "../components/ui/Modal";
import ScheduleField from "../components/ui/ScheduleField";
import Barra from "../components/admin/Barra";
import Numero from "../components/admin/Numero";
import { cardStyle, inputStyle, labelStyle, botaoPrimario, botaoSecundario, botaoPerigo, segundos } from "../components/admin/cupomEstilos";
import {
  adminFaxinaStatus, adminFaxinaSalvarConfig, adminFaxinaPrevia, adminFaxinaLimpar,
  adminFaxinaRebuscar, adminFaxinaCancelar, errText,
} from "../data/api";

// Admin › Faxina: a limpeza (cupons que não funcionam + produtos antigos) e a
// re-busca do catálogo, cada uma com sua agenda (backend/faxina/).

const POLL_MS = 15000;
const POLL_RODANDO_MS = 2000;

const quando = (iso) => (iso ? new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "—");
const sub = { fontSize: 12, color: "var(--color-text-secondary)", lineHeight: 1.5 };

export default function PageAdminFaxina() {
  const [st, setSt] = useState(null);
  const [cfg, setCfg] = useState(null);
  const [erro, setErro] = useState(null);
  const [salvo, setSalvo] = useState(null);
  const [salvando, setSalvando] = useState(false);
  const [previa, setPrevia] = useState(null);       // abre o modal de confirmação
  const [ocupado, setOcupado] = useState(null);     // "previa" | "limpar" | "rebusca" | "cancelar"

  const atualizar = useCallback(async ({ comConfig = false } = {}) => {
    try {
      const s = await adminFaxinaStatus();
      setSt(s);
      if (comConfig) setCfg(s.config);
    } catch (err) {
      setErro(errText(err, "Não foi possível ler o status da faxina."));
    }
  }, []);

  useEffect(() => { atualizar({ comConfig: true }); }, [atualizar]);

  const rodando = !!(st?.limpeza?.running || st?.rebusca?.running);
  useEffect(() => {
    const id = setInterval(atualizar, rodando ? POLL_RODANDO_MS : POLL_MS);
    return () => clearInterval(id);
  }, [atualizar, rodando]);

  const mudar = (rotina, patch) => setCfg(c => ({ ...c, [rotina]: { ...c[rotina], ...patch } }));

  async function salvar(patch) {
    setSalvando(true); setErro(null); setSalvo(null);
    try {
      const novo = patch ? { ...cfg, ...Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, { ...cfg[k], ...v }])) } : cfg;
      setCfg(novo);
      const r = await adminFaxinaSalvarConfig(novo);
      setCfg(r.config);
      setSalvo("Salvo.");
      await atualizar();
    } catch (err) {
      setErro(errText(err, "Não foi possível salvar."));
    } finally {
      setSalvando(false);
    }
  }

  async function abrirPrevia() {
    setOcupado("previa"); setErro(null);
    try {
      // A prévia usa os dias SALVOS — salva antes, pra não mostrar outra conta.
      await adminFaxinaSalvarConfig(cfg);
      setPrevia(await adminFaxinaPrevia());
    } catch (err) {
      setErro(errText(err, "Não foi possível calcular a prévia."));
    } finally {
      setOcupado(null);
    }
  }

  async function limpar() {
    setPrevia(null); setOcupado("limpar"); setErro(null);
    try {
      await adminFaxinaLimpar();
      await atualizar();
    } catch (err) {
      setErro(errText(err, "A limpeza falhou."));
    } finally {
      setOcupado(null);
    }
  }

  async function acao(nome, fn, falha) {
    setOcupado(nome); setErro(null);
    try { await fn(); await atualizar(); }
    catch (err) { setErro(errText(err, falha)); }
    finally { setOcupado(null); }
  }

  if (!st || !cfg) {
    return <div style={{ padding: 20, color: "var(--color-text-secondary)" }}>{erro || "Carregando…"}</div>;
  }

  const L = st.limpeza, R = st.rebusca;
  const ultL = L.lastResult, ultR = R.lastResult;
  const prog = R.progress;

  return (
    <div style={{ display: "flex", flexDirection: "column", maxWidth: 820 }}>
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>Faxina</h1>
      <p style={{ ...sub, marginBottom: 18 }}>
        Tira do sistema o que não serve mais: cupons que não funcionam, produtos antigos e produtos que saíram de venda.
      </p>

      {erro && <div style={{ ...cardStyle, color: "var(--danger-text)", background: "var(--danger-bg)", border: "1px solid var(--danger-border)" }}>{erro}</div>}

      {/* ── Limpeza ── */}
      <div style={cardStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 12 }}>
          <div>
            <div style={{ fontWeight: 500 }}>Limpeza de cupons e produtos antigos</div>
            <div style={sub}>
              Apaga os cupons do ML vencidos ou com a palavra testada como inválida (e os produtos que só vieram pela vitrine deles),
              tira da lista do repasse os cupons com palavra inválida, e apaga os produtos que nenhum scraping viu nos últimos dias.
              Produto ligado a um cupom que ainda vale fica.
            </div>
          </div>
          <Toggle label="Limpeza automática" value={!!cfg.limpeza.enabled} disabled={salvando} onChange={v => salvar({ limpeza: { enabled: v } })} />
        </div>

        <div style={{ marginBottom: 14, maxWidth: 280 }}>
          <label style={labelStyle} htmlFor="faxina-dias">Produto antigo = sem aparecer em scraping há (dias)</label>
          <input
            id="faxina-dias" type="number" min={1} max={365} style={{ ...inputStyle, width: 120 }}
            value={cfg.limpeza.diasProdutoAntigo ?? ""}
            onChange={e => mudar("limpeza", { diasProdutoAntigo: e.target.value === "" ? "" : parseInt(e.target.value) })}
          />
        </div>

        <div style={{ marginBottom: 14 }}>
          <ScheduleField
            idPrefix="faxina-limpeza"
            mode={cfg.limpeza.scheduleMode}
            intervalMinutes={cfg.limpeza.intervalMinutes}
            times={cfg.limpeza.times}
            minInterval={30}
            onChange={p => mudar("limpeza", p)}
          />
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <button style={botaoSecundario} disabled={salvando} onClick={() => salvar()}>{salvando ? "Salvando…" : "Salvar"}</button>
          <button style={botaoPrimario(!!ocupado || L.running)} disabled={!!ocupado || L.running} onClick={abrirPrevia}>
            {ocupado === "previa" ? "Calculando…" : ocupado === "limpar" || L.running ? "Limpando…" : "Limpar agora"}
          </button>
          {salvo && <span style={sub}>{salvo}</span>}
        </div>

        <div style={{ ...sub, marginTop: 12 }}>
          Última: {quando(L.lastRun)}
          {cfg.limpeza.enabled && <> · Próxima: {quando(L.nextRunAt)}</>}
          {L.lastError && <span style={{ color: "var(--danger-text)" }}> · Erro: {L.lastError}</span>}
        </div>
        {ultL && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 10, marginTop: 10, fontSize: 12 }}>
            <Numero label={`cupons do ML (${ultL.cuponsVencidos ?? 0} vencidos, ${ultL.cuponsPalavraInvalida ?? 0} palavra inválida)`} valor={ultL.cupons} />
            <Numero label="produtos da vitrine deles" valor={ultL.produtosDaVitrine} />
            <Numero label="cupons do repasse" valor={ultL.cuponsRepasse} />
            <Numero label={`produtos com mais de ${ultL.diasProdutoAntigo} dias`} valor={ultL.produtosAntigos} />
          </div>
        )}
      </div>

      {/* ── Re-busca ── */}
      <div style={cardStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 12 }}>
          <div>
            <div style={{ fontWeight: 500 }}>Buscar os produtos de novo</div>
            <div style={sub}>
              Visita cada produto do catálogo na loja, do mais desatualizado pro mais novo: atualiza preço, foto e nome, e apaga o que saiu de venda.
              Em dúvida (CAPTCHA, erro de rede) não apaga nada. Se uma loja parecer ter mudado o site — muitos produtos "sumindo" de uma vez —, nada dela é apagado.
              Leva horas; roda em segundo plano.
            </div>
          </div>
          <Toggle label="Re-busca automática" value={!!cfg.rebusca.enabled} disabled={salvando} onChange={v => salvar({ rebusca: { enabled: v } })} />
        </div>

        <div style={{ marginBottom: 14, maxWidth: 280 }}>
          <label style={labelStyle} htmlFor="faxina-pausa">Pausa entre produtos (segundos)</label>
          <input
            id="faxina-pausa" type="number" min={0.5} max={60} step={0.5} style={{ ...inputStyle, width: 120 }}
            value={cfg.rebusca.pausaMs != null && cfg.rebusca.pausaMs !== "" ? cfg.rebusca.pausaMs / 1000 : ""}
            onChange={e => mudar("rebusca", { pausaMs: e.target.value === "" ? "" : Math.round(parseFloat(e.target.value) * 1000) })}
          />
        </div>

        <div style={{ marginBottom: 14 }}>
          <ScheduleField
            idPrefix="faxina-rebusca"
            mode={cfg.rebusca.scheduleMode}
            intervalMinutes={cfg.rebusca.intervalMinutes}
            times={cfg.rebusca.times}
            minInterval={30}
            onChange={p => mudar("rebusca", p)}
          />
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <button style={botaoSecundario} disabled={salvando} onClick={() => salvar()}>{salvando ? "Salvando…" : "Salvar"}</button>
          {!R.running ? (
            <button
              style={botaoPrimario(!!ocupado)} disabled={!!ocupado}
              onClick={() => acao("rebusca", async () => { await adminFaxinaSalvarConfig(cfg); await adminFaxinaRebuscar(); }, "Não foi possível iniciar a re-busca.")}
            >
              {ocupado === "rebusca" ? "Iniciando…" : "Buscar tudo de novo"}
            </button>
          ) : (
            <button style={botaoPerigo(R.canceling || !!ocupado)} disabled={R.canceling || !!ocupado}
              onClick={() => acao("cancelar", adminFaxinaCancelar, "Não foi possível cancelar.")}>
              {R.canceling ? "Cancelando…" : "Cancelar"}
            </button>
          )}
        </div>

        {R.running && prog && (
          <div style={{ marginTop: 12 }}>
            <Barra valor={prog.done} total={prog.total} rotulo={prog.current || "…"} direita={`${prog.done} de ${prog.total}`} />
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: 10, marginTop: 10, fontSize: 12 }}>
              <Numero label="atualizados" valor={prog.atualizados} />
              <Numero label="apagados" valor={prog.apagados} />
              <Numero label="pulados" valor={prog.pulados} />
            </div>
            <LojasParadas lojas={prog.lojasParadas} />
          </div>
        )}

        <div style={{ ...sub, marginTop: 12 }}>
          Última: {quando(R.lastRun)}
          {ultR?.cancelado && " (cancelada)"}
          {ultR?.duracaoMs != null && ` · levou ${segundos(ultR.duracaoMs)}`}
          {cfg.rebusca.enabled && <> · Próxima: {quando(R.nextRunAt)}</>}
          {R.lastError && <span style={{ color: "var(--danger-text)" }}> · Erro: {R.lastError}</span>}
        </div>
        {ultR && !R.running && (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: 10, marginTop: 10, fontSize: 12 }}>
              <Numero label={`conferidos de ${ultR.total}`} valor={ultR.conferidos} />
              <Numero label="atualizados" valor={ultR.atualizados} />
              <Numero label="apagados" valor={ultR.apagados} />
              <Numero label="pulados" valor={ultR.pulados} />
            </div>
            {ultR.porLoja && Object.keys(ultR.porLoja).length > 0 && (
              <div style={{ ...sub, marginTop: 10 }}>
                {Object.entries(ultR.porLoja).map(([loja, n]) => (
                  <div key={loja}>{loja}: {n.atualizados} atualizados, {n.apagados} apagados, {n.pulados} pulados</div>
                ))}
              </div>
            )}
            <LojasParadas lojas={ultR.lojasParadas} />
          </>
        )}
      </div>

      {previa && (
        <Modal title="Limpar agora?" onClose={() => setPrevia(null)} danger>
          <div style={{ fontSize: 13, marginBottom: 16, color: "var(--color-text-secondary)", lineHeight: 1.6 }}>
            <div><strong style={{ color: "var(--color-text-primary)" }}>{previa.cupons.cupons}</strong> cupons do ML ({previa.cupons.vencidos} vencidos, {previa.cupons.palavraInvalida} com palavra inválida)</div>
            <div><strong style={{ color: "var(--color-text-primary)" }}>{previa.cupons.produtos}</strong> produtos que só vieram pela vitrine deles{previa.cupons.produtosMantidos ? ` (${previa.cupons.produtosMantidos} ficam, por terem outra origem)` : ""}</div>
            <div><strong style={{ color: "var(--color-text-primary)" }}>{previa.cuponsRepasse}</strong> cupons com palavra inválida saem da lista do repasse</div>
            <div><strong style={{ color: "var(--color-text-primary)" }}>{previa.produtosAntigos}</strong> produtos sem aparecer em scraping há mais de {previa.diasProdutoAntigo} dias</div>
            <div style={{ marginTop: 8 }}>Não dá pra desfazer.</div>
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button onClick={() => setPrevia(null)} style={botaoSecundario}>Cancelar</button>
            <button onClick={limpar} style={{ padding: "8px 16px", borderRadius: 8, background: "#E24B4A", color: "#fff", border: "none", fontSize: 13, cursor: "pointer", fontWeight: 500 }}>Limpar</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function LojasParadas({ lojas }) {
  const lista = Object.entries(lojas || {});
  if (!lista.length) return null;
  return (
    <div style={{ marginTop: 10, fontSize: 12, padding: 10, borderRadius: 8, background: "var(--warn-bg)", border: "1px solid var(--warn-border)", color: "var(--warn-text)" }}>
      {lista.map(([loja, motivo]) => <div key={loja}><strong>{loja}</strong> parou nesta rodada: {motivo}</div>)}
    </div>
  );
}
