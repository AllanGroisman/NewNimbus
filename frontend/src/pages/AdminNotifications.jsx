import { useState, useEffect } from "react";
import { PRIMARY, PRIMARY_DARK } from "../data/constants";
import Toggle from "../components/ui/Toggle";
import {
  adminNotifConfig,
  adminNotifSave,
  adminNotifTest,
  adminNotifGroups,
  whatsNimbusStatus,
} from "../data/api";

const labelStyle = { fontSize: 12, fontWeight: 600, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 };
const cardStyle = { background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 10, padding: "20px 24px", marginBottom: 16 };
const btnPrimary = { background: PRIMARY, color: "#fff", border: "none", borderRadius: 6, padding: "8px 16px", fontSize: 13, fontWeight: 600, cursor: "pointer" };
const btnSecondary = { background: "transparent", color: PRIMARY_DARK, border: `1px solid ${PRIMARY}`, borderRadius: 6, padding: "8px 16px", fontSize: 13, fontWeight: 600, cursor: "pointer" };
const inputStyle = { width: "100%", padding: "8px 10px", border: "1px solid var(--color-border)", borderRadius: 6, fontSize: 13, background: "var(--color-surface)", color: "var(--color-text-primary)", boxSizing: "border-box" };

const EVENT_LABELS = {
  scraping:     { label: "Resumo do scraping", desc: "Envia um resumo ao final de cada execução do scraper global." },
  scrapTester:  { label: "Teste de scraping",  desc: "Envia o relatório do ScrapTester a cada rodada, dizendo quais campos dos produtos estão faltando." },
  errors:       { label: "Erros críticos",     desc: "Notifica quando ocorre um erro inesperado no sistema." },
  systemOnline: { label: "Sistema online",     desc: "Avisa quando o backend é (re)iniciado." },
};

export default function PageAdminNotifications({ onGoToWhatsNimbus }) {
  const [config, setConfig] = useState(null);
  const [whatsNimbus, setWhatsNimbus] = useState(null);
  const [groups, setGroups] = useState([]);
  const [groupSearch, setGroupSearch] = useState("");
  const [loadingGroups, setLoadingGroups] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState(null);
  const [savedMsg, setSavedMsg] = useState(null);
  const [testMsg, setTestMsg] = useState(null);

  const isConnected = whatsNimbus?.status === "connected";

  useEffect(() => {
    (async () => {
      try {
        const [cfg, wn] = await Promise.all([adminNotifConfig(), whatsNimbusStatus()]);
        setConfig(cfg);
        setWhatsNimbus(wn);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (!isConnected) return;
    (async () => {
      setLoadingGroups(true);
      try {
        const r = await adminNotifGroups();
        setGroups(Array.isArray(r) ? r : []);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoadingGroups(false);
      }
    })();
  }, [isConnected]);

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
      // O backend testa a config PERSISTIDA, não o estado local. Salva antes de
      // testar pra a mensagem ir exatamente pro grupo que está na tela.
      const r = await adminNotifSave(config);
      setConfig(r.config);
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

  if (loading || !config) {
    return <div style={{ padding: 40, textAlign: "center", color: "var(--color-text-secondary)" }}>Carregando...</div>;
  }

  const q = groupSearch.trim().toLowerCase();
  const filteredGroups = groups.filter(g => !q || (g.name || "").toLowerCase().includes(q));

  return (
    <div style={{ padding: "28px 32px", maxWidth: 640 }}>
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 20, fontWeight: 700, color: "var(--color-text-primary)" }}>Notificações WhatsApp</div>
        <div style={{ fontSize: 13, color: "var(--color-text-secondary)", marginTop: 4 }}>
          Receba logs e alertas do sistema em um grupo do WhatsApp, enviados pelo número do WhatsNimbus.
        </div>
      </div>

      {error && (
        <div style={{ background: "var(--danger-bg)", color: "var(--danger-text)", borderRadius: 8, padding: "10px 14px", marginBottom: 16, fontSize: 13 }}>
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
        <Toggle value={!!config.enabled} onChange={v => update({ enabled: v })} />
      </div>

      {/* Grupo de destino */}
      <div style={cardStyle}>
        <div style={{ fontSize: 15, fontWeight: 700, color: "var(--color-text-primary)", marginBottom: 16 }}>Grupo de destino</div>

        {!isConnected ? (
          <div style={{ fontSize: 13, color: "var(--color-text-secondary)", background: "var(--color-surface-alt)", borderRadius: 8, padding: "12px 14px" }}>
            O WhatsNimbus não está conectado.{" "}
            {onGoToWhatsNimbus ? (
              <span onClick={onGoToWhatsNimbus} style={{ color: PRIMARY_DARK, fontWeight: 600, cursor: "pointer", textDecoration: "underline" }}>
                Conecte o WhatsNimbus
              </span>
            ) : (
              <strong>Conecte o WhatsNimbus</strong>
            )}{" "}
            para escolher o grupo.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {config.groupJid && (
              <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: 8, background: "var(--color-surface-alt)", border: `1px solid ${PRIMARY}` }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "var(--color-text-primary)" }}>{config.groupName || config.groupJid}</div>
                </div>
                <button
                  onClick={() => update({ groupJid: null, groupName: null })}
                  style={{ padding: "5px 12px", borderRadius: 6, border: "1px solid var(--color-border)", background: "transparent", color: "var(--color-text-primary)", fontSize: 12, cursor: "pointer" }}
                >
                  Trocar
                </button>
              </div>
            )}

            {loadingGroups && <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>Carregando grupos…</div>}

            {!loadingGroups && !config.groupJid && groups.length > 0 && (
              <input
                autoFocus
                value={groupSearch}
                onChange={e => setGroupSearch(e.target.value)}
                placeholder="Buscar grupo pelo nome..."
                style={inputStyle}
              />
            )}

            {!loadingGroups && !config.groupJid && (
              groups.length === 0 ? (
                <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
                  Nenhum grupo encontrado. O WhatsNimbus precisa participar de algum grupo do WhatsApp primeiro.
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 260, overflowY: "auto" }}>
                  {filteredGroups.length === 0 ? (
                    <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
                      Nenhum grupo bate com "{groupSearch}".
                    </div>
                  ) : (
                    filteredGroups.map(g => (
                      <div key={g.jid} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", borderRadius: 8, border: "1px solid var(--color-border)", background: "var(--color-surface-alt)" }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 13, fontWeight: 500, color: "var(--color-text-primary)" }}>{g.name || g.jid}</div>
                          <div style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>{g.members || 0} membros</div>
                        </div>
                        <button
                          onClick={() => update({ groupJid: g.jid, groupName: g.name || null })}
                          style={{ padding: "5px 12px", borderRadius: 6, background: PRIMARY, color: "#fff", border: "none", fontSize: 12, cursor: "pointer", fontWeight: 500 }}
                        >
                          Selecionar
                        </button>
                      </div>
                    ))
                  )}
                </div>
              )
            )}
          </div>
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
              value={!!(config.events?.[key])}
              onChange={v => updateEvent(key, v)}
            />
          </div>
        ))}
        {config.events?.scraping && (
          <div style={{ marginBottom: 16 }}>
            <div style={labelStyle}>Nível de detalhe do resumo do scraping</div>
            <select
              value={config.scrapingDetail || "detailed"}
              onChange={e => update({ scrapingDetail: e.target.value })}
              style={inputStyle}
            >
              <option value="detailed">Detalhado — totais + por categoria e loja</option>
              <option value="summary">Resumo curto — só os totais</option>
            </select>
          </div>
        )}
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
          style={{ ...btnSecondary, opacity: (!config.groupJid || !isConnected) ? 0.5 : 1 }}
          onClick={runTest}
          disabled={testing || !config.groupJid || !isConnected}
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
