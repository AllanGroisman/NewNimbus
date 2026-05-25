import { useState, useEffect } from "react";
import { PRIMARY, PRIMARY_DARK, PRIMARY_LIGHT } from "../data/constants";
import Toggle from "../components/ui/Toggle";
import {
  adminNotifConfig,
  adminNotifSave,
  adminNotifTest,
  adminNotifGroups,
} from "../data/api";

const labelStyle = { fontSize: 12, fontWeight: 600, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 };
const cardStyle = { background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 10, padding: "20px 24px", marginBottom: 16 };
const inputStyle = { width: "100%", padding: "8px 10px", border: "1px solid var(--color-border)", borderRadius: 6, fontSize: 13, background: "var(--color-surface)", color: "var(--color-text-primary)", boxSizing: "border-box" };
const btnPrimary = { background: PRIMARY, color: "#fff", border: "none", borderRadius: 6, padding: "8px 16px", fontSize: 13, fontWeight: 600, cursor: "pointer" };
const btnSecondary = { background: "transparent", color: PRIMARY_DARK, border: `1px solid ${PRIMARY}`, borderRadius: 6, padding: "8px 16px", fontSize: 13, fontWeight: 600, cursor: "pointer" };

const EVENT_LABELS = {
  scraping:     { label: "Resumo do scraping", desc: "Envia um resumo ao final de cada execução do scraper global." },
  errors:       { label: "Erros críticos",     desc: "Notifica quando ocorre um erro inesperado no sistema." },
  systemOnline: { label: "Sistema online",     desc: "Avisa quando o backend é (re)iniciado." },
};

export default function PageAdminNotifications({ numbers = [] }) {
  const [config, setConfig] = useState(null);
  const [groups, setGroups] = useState([]);
  const [loadingGroups, setLoadingGroups] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState(null);
  const [savedMsg, setSavedMsg] = useState(null);
  const [testMsg, setTestMsg] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const cfg = await adminNotifConfig();
        setConfig(cfg);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function fetchGroups() {
    if (!config?.numberId) return;
    setLoadingGroups(true);
    setError(null);
    try {
      const r = await adminNotifGroups(config.numberId);
      setGroups(Array.isArray(r) ? r : []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoadingGroups(false);
    }
  }

  async function save() {
    setSaving(true);
    setError(null);
    setSavedMsg(null);
    try {
      const r = await adminNotifSave(config);
      setConfig(r.config);
      setSavedMsg("Salvo!");
      setTimeout(() => setSavedMsg(null), 2500);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function runTest() {
    setTesting(true);
    setTestMsg(null);
    setError(null);
    try {
      await adminNotifTest();
      setTestMsg("Mensagem de teste enviada!");
      setTimeout(() => setTestMsg(null), 4000);
    } catch (err) {
      setError(err.message);
    } finally {
      setTesting(false);
    }
  }

  const update = (patch) => setConfig(c => ({ ...c, ...patch }));
  const updateEvent = (key, val) => setConfig(c => ({ ...c, events: { ...(c.events || {}), [key]: val } }));

  const selectedNumber = numbers.find(n => n.id === config?.numberId);
  const isConnected = selectedNumber?.status === "connected";

  if (loading || !config) {
    return <div style={{ padding: 40, textAlign: "center", color: "var(--color-text-secondary)" }}>Carregando...</div>;
  }

  return (
    <div style={{ padding: "28px 32px", maxWidth: 640 }}>
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 20, fontWeight: 700, color: "var(--color-text-primary)" }}>Notificações WhatsApp</div>
        <div style={{ fontSize: 13, color: "var(--color-text-secondary)", marginTop: 4 }}>
          Receba logs e alertas do sistema diretamente em um grupo do WhatsApp.
        </div>
      </div>

      {error && (
        <div style={{ background: "#FEE2E2", color: "#991B1B", borderRadius: 8, padding: "10px 14px", marginBottom: 16, fontSize: 13 }}>
          {error}
        </div>
      )}

      {/* Ativar / desativar */}
      <div style={{ ...cardStyle, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: "var(--color-text-primary)" }}>Notificações ativas</div>
          <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 2 }}>
            Liga ou desliga todos os envios sem apagar a configuração.
          </div>
        </div>
        <Toggle checked={!!config.enabled} onChange={v => update({ enabled: v })} />
      </div>

      {/* Sessão e grupo */}
      <div style={cardStyle}>
        <div style={{ fontSize: 15, fontWeight: 700, color: "var(--color-text-primary)", marginBottom: 16 }}>Grupo de destino</div>

        {numbers.length === 0 ? (
          <div style={{ fontSize: 13, color: "var(--color-text-secondary)", background: "var(--color-surface-alt)", borderRadius: 8, padding: "12px 14px" }}>
            Nenhum número WhatsApp cadastrado. Vá em <strong>WhatsApp</strong> e conecte um número primeiro.
          </div>
        ) : (
          <>
            <div style={{ marginBottom: 14 }}>
              <div style={labelStyle}>Número / sessão</div>
              <select
                value={config.numberId || ""}
                onChange={e => update({ numberId: e.target.value, groupJid: null, groupName: null })}
                style={inputStyle}
              >
                <option value="">Selecione um número...</option>
                {numbers.map(n => (
                  <option key={n.id} value={n.id}>
                    {n.label || n.id}
                    {n.phone ? ` (${n.phone})` : ""}
                    {n.status === "connected" ? " ✓" : ""}
                  </option>
                ))}
              </select>
              {config.numberId && !isConnected && (
                <div style={{ fontSize: 12, color: "#B45309", marginTop: 4 }}>
                  Esta sessão não está conectada. As notificações não serão enviadas até reconectar.
                </div>
              )}
            </div>

            <div style={{ marginBottom: 14 }}>
              <div style={labelStyle}>Grupo WhatsApp</div>
              <div style={{ display: "flex", gap: 8 }}>
                <select
                  value={config.groupJid || ""}
                  onChange={e => {
                    const g = groups.find(g => g.jid === e.target.value);
                    update({ groupJid: e.target.value || null, groupName: g?.name || null });
                  }}
                  style={{ ...inputStyle, flex: 1 }}
                  disabled={groups.length === 0}
                >
                  <option value="">
                    {groups.length === 0
                      ? config.groupJid
                        ? `${config.groupName || config.groupJid} (clique em Buscar)`
                        : "Clique em Buscar Grupos..."
                      : "Selecione um grupo..."}
                  </option>
                  {groups.map(g => (
                    <option key={g.jid} value={g.jid}>{g.name || g.jid}</option>
                  ))}
                </select>
                <button
                  style={{ ...btnSecondary, whiteSpace: "nowrap" }}
                  onClick={fetchGroups}
                  disabled={!config.numberId || loadingGroups}
                >
                  {loadingGroups ? "Buscando..." : "Buscar Grupos"}
                </button>
              </div>
              {config.groupName && (
                <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 4 }}>
                  Grupo selecionado: <strong>{config.groupName}</strong>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Eventos */}
      <div style={cardStyle}>
        <div style={{ fontSize: 15, fontWeight: 700, color: "var(--color-text-primary)", marginBottom: 16 }}>Eventos</div>
        {Object.entries(EVENT_LABELS).map(([key, { label, desc }]) => (
          <div
            key={key}
            style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingBottom: 14, marginBottom: 14, borderBottom: "1px solid var(--color-border-tertiary)" }}
          >
            <div style={{ flex: 1, paddingRight: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--color-text-primary)" }}>{label}</div>
              <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 2 }}>{desc}</div>
            </div>
            <Toggle
              checked={!!(config.events?.[key])}
              onChange={v => updateEvent(key, v)}
            />
          </div>
        ))}
        <div style={{ color: "var(--color-text-secondary)", fontSize: 12, marginTop: -4 }}>
          Os eventos só são enviados quando as notificações estão ativas e o grupo está configurado.
        </div>
      </div>

      {/* Ações */}
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <button style={btnPrimary} onClick={save} disabled={saving}>
          {saving ? "Salvando..." : "Salvar"}
        </button>
        <button
          style={{ ...btnSecondary, opacity: (!config.groupJid || !config.numberId) ? 0.5 : 1 }}
          onClick={runTest}
          disabled={testing || !config.groupJid || !config.numberId}
          title={!config.groupJid ? "Configure o grupo antes de testar" : ""}
        >
          {testing ? "Enviando..." : "Enviar Teste"}
        </button>
        {savedMsg && <span style={{ fontSize: 13, color: "#15803D", fontWeight: 600 }}>{savedMsg}</span>}
        {testMsg  && <span style={{ fontSize: 13, color: PRIMARY_DARK, fontWeight: 600 }}>{testMsg}</span>}
      </div>
    </div>
  );
}
