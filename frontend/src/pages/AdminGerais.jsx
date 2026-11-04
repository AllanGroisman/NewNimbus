import { useState, useEffect } from "react";
import { featuresGet, adminFeaturesSave, errText } from "../data/api";
import { setFeaturesCache } from "../data/features";
import Toggle from "../components/ui/Toggle";

// Admin → Gerais: interruptores de função (backend/feature-flags.js). Serve pra
// esconder de todo mundo uma função nova que não esteja funcionando direito,
// sem deploy. Cada interruptor salva na hora.

const card = {
  background: "var(--color-background-primary)",
  border: "0.5px solid var(--color-border-tertiary)",
  borderRadius: 12,
  padding: 16,
};

// Um item por interruptor. `key` = chave em feature-flags.js.
const FEATURES = [
  {
    key: "repasseWordFilter",
    label: "Lista de palavras no repasse",
    on: "Ligado: cada campanha de repasse mostra a lista branca e a lista negra de palavras, e a captura respeita as listas.",
    off: "Desligado: as listas somem das campanhas e a captura ignora as palavras salvas. Nada é apagado — ao religar, volta como estava.",
  },
];

export default function PageAdminGerais() {
  const [flags, setFlags] = useState(null);
  const [saving, setSaving] = useState(null);
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    let alive = true;
    featuresGet()
      .then(r => { if (alive) setFlags(r.flags || {}); })
      .catch(err => { if (alive) { setFlags({}); setMsg({ type: "err", text: errText(err, "Não foi possível carregar.") }); } });
    return () => { alive = false; };
  }, []);

  const toggle = async (key, value) => {
    const anterior = flags;
    setFlags(f => ({ ...f, [key]: value }));
    setSaving(key);
    setMsg(null);
    try {
      const r = await adminFeaturesSave({ [key]: value });
      setFlags(r.flags);
      setFeaturesCache(r.flags);
      setMsg({ type: "ok", text: "Salvo. Vale pra todos os usuários." });
    } catch (err) {
      setFlags(anterior);
      setMsg({ type: "err", text: errText(err, "Não foi possível salvar.") });
    } finally {
      setSaving(null);
    }
  };

  if (flags === null) {
    return <div style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>Carregando…</div>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 640 }}>
      <div>
        <h1 style={{ fontSize: 20, marginBottom: 4 }}>Gerais</h1>
        <div style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>
          Liga e desliga funções do sistema para todos os usuários.
        </div>
      </div>

      <div style={{ ...card, display: "flex", flexDirection: "column" }}>
        {FEATURES.map((f, i) => {
          const value = flags[f.key] !== false;
          return (
            <div key={f.key} style={{
              display: "flex", alignItems: "center", gap: 12, padding: "10px 0",
              borderTop: i ? "0.5px solid var(--color-border-tertiary)" : "none",
            }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 500 }}>{f.label}</div>
                <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 2 }}>
                  {value ? f.on : f.off}
                </div>
              </div>
              <Toggle label={f.label} value={value} disabled={saving === f.key} onChange={v => toggle(f.key, v)} />
            </div>
          );
        })}
      </div>

      {msg && (
        <div role={msg.type === "err" ? "alert" : "status"} style={{ fontSize: 13, color: msg.type === "err" ? "var(--danger-text)" : "#1B7A43" }}>
          {msg.text}
        </div>
      )}
    </div>
  );
}
