// Popup "Limpeza automática" de um número (task 13): os grupos marcados têm as
// mensagens e mídias apagadas do celular de tempos em tempos — o mesmo "Limpar
// conversa" do WhatsApp, mandado pelo servidor (whatsapp/chat-cleanup.js).
//
// A lista de grupos vem do próprio WhatsApp (todos os grupos em que o número está,
// não só os das campanhas). Grupo marcado que o número já deixou continua na lista,
// com aviso, para poder ser desmarcado. "Limpar agora" salva o que está na tela
// antes de rodar — limpa exatamente o que o usuário está vendo marcado.
import { useEffect, useMemo, useRef, useState } from "react";
import { PRIMARY } from "../../data/constants";
import { listWAGroups, saveWACleanup, runWACleanup, errText } from "../../data/api";
import Modal from "../ui/Modal";
import Spinner from "../ui/Spinner";
import { CLEANUP_INTERVALS } from "./cleanupIntervals";

const btnSec = { padding: "8px 16px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 13, cursor: "pointer", color: "var(--color-text-primary)" };
const btnPri = (off) => ({ padding: "8px 16px", borderRadius: 8, background: PRIMARY, color: "#fff", border: "none", fontSize: 13, cursor: off ? "not-allowed" : "pointer", fontWeight: 500, opacity: off ? 0.5 : 1 });
const btnDanger = (off) => ({ padding: "8px 16px", borderRadius: 8, background: "#E24B4A", color: "#fff", border: "none", fontSize: 13, cursor: off ? "not-allowed" : "pointer", fontWeight: 500, opacity: off ? 0.5 : 1 });
const campo = { width: "100%", padding: "9px 12px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13, boxSizing: "border-box", color: "var(--color-text-primary)", fontFamily: "inherit" };
const nota = { fontSize: 12, color: "var(--color-text-secondary)", lineHeight: 1.5 };

// "há 3 h", "há 2 dias" — o bastante para o usuário saber se a limpeza está rodando.
function ha(iso) {
  if (!iso) return null;
  const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (min < 1) return "agora há pouco";
  if (min < 60) return `há ${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `há ${h} h`;
  return `há ${Math.round(h / 24)} dias`;
}

// `number`: { id, label }. `config`: a configuração salva deste número, ou null.
// `onSaved(config)`: chamado com o que o servidor devolveu ao salvar ou rodar.
export default function ChatCleanupModal({ number, config, onSaved, onClose }) {
  const [enabled, setEnabled] = useState(config ? !!config.enabled : true);
  const [intervalHours, setIntervalHours] = useState(config?.intervalHours || 24);
  const [selected, setSelected] = useState(() => new Set(config?.jids || []));
  const [groups, setGroups] = useState(null); // null = carregando
  const [loadError, setLoadError] = useState(null);
  const [busca, setBusca] = useState("");
  const [passo, setPasso] = useState("editar"); // "editar" | "confirmar"
  const [ocupado, setOcupado] = useState(null); // "salvando" | "limpando"
  const [erro, setErro] = useState(null);
  const [ultimo, setUltimo] = useState(config || null);
  const vivo = useRef(true);
  useEffect(() => () => { vivo.current = false; }, []);

  useEffect(() => {
    listWAGroups(number.id)
      .then(gs => {
        if (!vivo.current) return;
        const list = (Array.isArray(gs) ? gs : []).slice().sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "pt-BR"));
        setGroups(list);
      })
      .catch(err => { if (vivo.current) { setGroups([]); setLoadError(errText(err, "Não foi possível listar os grupos do número.")); } });
  }, [number.id]);

  // Marcados que não vieram na lista: o número saiu do grupo (ou a lista falhou).
  const ausentes = useMemo(() => {
    if (!groups) return [];
    const ids = new Set(groups.map(g => g.jid));
    return [...selected].filter(j => !ids.has(j));
  }, [groups, selected]);

  const visiveis = useMemo(() => {
    const q = busca.trim().toLowerCase();
    const list = groups || [];
    return q ? list.filter(g => String(g.name || "").toLowerCase().includes(q)) : list;
  }, [groups, busca]);

  const nomeDe = (jid) => groups?.find(g => g.jid === jid)?.name || jid;
  const todosVisiveisMarcados = visiveis.length > 0 && visiveis.every(g => selected.has(g.jid));

  const toggle = (jid) => setSelected(s => {
    const n = new Set(s);
    if (n.has(jid)) n.delete(jid); else n.add(jid);
    return n;
  });
  const marcarVisiveis = () => setSelected(s => {
    const n = new Set(s);
    if (todosVisiveisMarcados) visiveis.forEach(g => n.delete(g.jid));
    else visiveis.forEach(g => n.add(g.jid));
    return n;
  });

  const salvar = async () => {
    const r = await saveWACleanup(number.id, { enabled, intervalHours, jids: [...selected] });
    onSaved?.(r);
    return r;
  };

  const onSalvar = async () => {
    setErro(null);
    setOcupado("salvando");
    try {
      await salvar();
      if (vivo.current) onClose?.();
    } catch (err) {
      if (vivo.current) setErro(errText(err, "Não foi possível salvar."));
    } finally {
      if (vivo.current) setOcupado(null);
    }
  };

  const onLimparAgora = async () => {
    setErro(null);
    setOcupado("limpando");
    try {
      await salvar();
      const r = await runWACleanup(number.id, selected.size);
      if (!vivo.current) return;
      onSaved?.(r);
      setUltimo(r);
      setPasso("editar");
    } catch (err) {
      if (vivo.current) { setErro(errText(err, "Não foi possível limpar agora.")); setPasso("editar"); }
    } finally {
      if (vivo.current) setOcupado(null);
    }
  };

  // Limpando, o popup não fecha: o resultado chegaria sem ninguém para ver.
  const fechar = () => { if (!ocupado) onClose?.(); };
  const titulo = `🧹 Limpeza automática — ${number.label || number.id}`;

  if (passo === "confirmar") {
    return (
      <Modal title="Limpar agora?" onClose={() => !ocupado && setPasso("editar")} danger>
        <p style={{ ...nota, fontSize: 13, marginBottom: 16 }}>
          As mensagens e mídias de <strong>{selected.size} grupo{selected.size !== 1 ? "s" : ""}</strong> serão apagadas do
          WhatsApp deste número (celular e aparelhos conectados). Os outros membros não são afetados. Não dá para desfazer.
        </p>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={() => setPasso("editar")} disabled={!!ocupado} style={btnSec}>Cancelar</button>
          <button onClick={onLimparAgora} disabled={!!ocupado} style={{ ...btnDanger(!!ocupado), display: "flex", alignItems: "center", gap: 6 }}>
            {ocupado === "limpando" ? <><Spinner size={12} /> Limpando...</> : "Limpar agora"}
          </button>
        </div>
      </Modal>
    );
  }

  const res = ultimo?.lastResult;
  // Chave de app state ausente (backend/whatsapp/app-state-key.js) derruba todos os
  // grupos com o mesmo erro: vira um aviso só em vez de uma linha por grupo. O
  // padrão "myAppStateKey" cobre resumos gravados antes da mensagem amigável.
  const semChave = i => /myAppStateKey|Chave de sincronização ausente/.test(i.error || "");
  const erros = (res?.items || []).filter(i => i.status === "error");
  const precisaReconectar = erros.some(semChave);
  const problemas = erros.filter(i => !semChave(i));

  return (
    <Modal title={titulo} onClose={fechar} confirmOnClickOutside>
      <p style={{ ...nota, marginBottom: 12 }}>
        Apaga as mensagens e mídias dos grupos marcados no seu celular, de tempos em tempos, para o WhatsApp não ficar pesado.
        Só afeta este número — os outros membros continuam vendo tudo. Não dá para desfazer.
      </p>

      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, marginBottom: 10, cursor: "pointer" }}>
        <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
        Limpeza automática ligada
      </label>

      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
        <span style={{ fontSize: 13 }}>Frequência:</span>
        <select value={intervalHours} onChange={e => setIntervalHours(Number(e.target.value))} disabled={!enabled}
          style={{ ...campo, width: "auto", padding: "6px 10px", opacity: enabled ? 1 : 0.6 }}>
          {CLEANUP_INTERVALS.map(i => <option key={i.hours} value={i.hours}>{i.label}</option>)}
        </select>
      </div>

      {ultimo?.lastRunAt && res && (
        <div style={{ ...nota, padding: "8px 10px", borderRadius: 8, background: "var(--color-background-secondary)", marginBottom: 12 }}>
          Última limpeza {ha(ultimo.lastRunAt)}: {res.cleared} limpo{res.cleared !== 1 ? "s" : ""}
          {res.skipped ? `, ${res.skipped} sem novidade` : ""}
          {res.errors ? <span style={{ color: "var(--danger-text)" }}>, {res.errors} com erro</span> : ""}.
          {res.skipped ? <div>Sem novidade = não chegou mensagem desde a última limpeza (ou desde que o número conectou ao sistema).</div> : null}
          {precisaReconectar && (
            <div style={{ color: "var(--danger-text)" }}>
              ✗ Faltou a chave de sincronização deste número. O sistema já pediu ao celular; se a próxima limpeza falhar de novo, reconecte o número (escaneie o QR de novo).
            </div>
          )}
          {problemas.slice(0, 5).map(p => (
            <div key={p.jid} style={{ color: "var(--danger-text)" }}>✗ {nomeDe(p.jid)}: {p.error}</div>
          ))}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
        <input value={busca} onChange={e => setBusca(e.target.value)} placeholder="Buscar grupo..." style={{ ...campo, flex: 1 }} />
        <button onClick={marcarVisiveis} disabled={!visiveis.length} style={{ ...btnSec, padding: "8px 12px", whiteSpace: "nowrap", fontSize: 12 }}>
          {todosVisiveisMarcados ? "Desmarcar todos" : "Marcar todos"}
        </button>
      </div>

      <div style={{ maxHeight: 300, overflowY: "auto", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 8, marginBottom: 6 }}>
        {groups === null ? (
          <div style={{ ...nota, padding: 16, display: "flex", alignItems: "center", gap: 8 }}><Spinner size={14} /> Carregando grupos...</div>
        ) : (
          <>
            {loadError && <div style={{ ...nota, padding: 12, color: "var(--danger-text)" }}>{loadError}</div>}
            {!loadError && !groups.length && <div style={{ ...nota, padding: 12 }}>Este número não está em nenhum grupo.</div>}
            {groups.length > 0 && !visiveis.length && <div style={{ ...nota, padding: 12 }}>Nenhum grupo com esse nome.</div>}
            {visiveis.map(g => (
              <label key={g.jid} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", borderBottom: "0.5px solid var(--color-border-tertiary)", cursor: "pointer", fontSize: 13 }}>
                <input type="checkbox" checked={selected.has(g.jid)} onChange={() => toggle(g.jid)} />
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g.name || g.jid}</span>
                {g.members ? <span style={nota}>{g.members} membros</span> : null}
              </label>
            ))}
            {ausentes.map(jid => (
              <label key={jid} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", borderBottom: "0.5px solid var(--color-border-tertiary)", cursor: "pointer", fontSize: 13 }}>
                <input type="checkbox" checked onChange={() => toggle(jid)} />
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--color-text-secondary)" }}>{jid}</span>
                <span style={{ ...nota, color: "var(--warn-text)" }}>{loadError ? "marcado" : "número não está mais no grupo"}</span>
              </label>
            ))}
          </>
        )}
      </div>
      <div style={{ ...nota, marginBottom: 14 }}>{selected.size} grupo{selected.size !== 1 ? "s" : ""} marcado{selected.size !== 1 ? "s" : ""}.</div>

      {erro && <div role="alert" style={{ fontSize: 12, color: "var(--danger-text)", marginBottom: 10 }}>{erro}</div>}

      <div style={{ display: "flex", gap: 8, justifyContent: "space-between", flexWrap: "wrap" }}>
        <button onClick={() => setPasso("confirmar")} disabled={!selected.size || !!ocupado}
          title="Apaga agora as mensagens dos grupos marcados"
          style={{ ...btnSec, color: "var(--danger-text)", borderColor: "var(--danger-border)", opacity: !selected.size || ocupado ? 0.5 : 1, cursor: !selected.size || ocupado ? "not-allowed" : "pointer" }}>
          Limpar agora
        </button>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={fechar} disabled={!!ocupado} style={btnSec}>Cancelar</button>
          <button onClick={onSalvar} disabled={!!ocupado || groups === null} style={{ ...btnPri(!!ocupado || groups === null), display: "flex", alignItems: "center", gap: 6 }}>
            {ocupado === "salvando" ? <><Spinner size={12} /> Salvando...</> : "Salvar"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
