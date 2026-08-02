import { useState, useEffect } from "react";
import { PRIMARY, PRIMARY_DARK, PRIMARY_LIGHT } from "../../data/constants";
import Toggle from "./Toggle";
import { adminStoreLocks, adminStoreLockSave, errText} from "../../data/api";

// Card de trava usado nas três abas de loja do admin (ML, Amazon, Shopee).
// Trancar esconde a loja dos usuários (aba + escolha nas campanhas) mostrando a
// mensagem configurada aqui. NÃO para o scraping — o catálogo continua enchendo.
const PRESETS = [
  { label: "Em breve",       text: "Esta loja estará disponível em breve." },
  { label: "Em manutenção",  text: "Esta loja está em manutenção e volta em breve." },
];

export default function StoreLockCard({ store, storeLabel }) {
  const [lock, setLock] = useState(null);
  const [usage, setUsage] = useState(0);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    let cancelled = false;
    adminStoreLocks()
      .then(r => {
        if (cancelled) return;
        const cur = r.locks?.[store] || { locked: false, message: "" };
        setLock(cur);
        setDraft(cur.message || "");
        setUsage(r.usage?.[store] ?? 0);
      })
      .catch(err => !cancelled && setMsg({ type: "err", text: errText(err, "Não foi possível atualizar a trava da loja.") }));
    return () => { cancelled = true; };
  }, [store]);

  if (!lock) {
    return <div style={{ padding: 20, color: "var(--color-text-secondary)", fontSize: 13 }}>Carregando disponibilidade...</div>;
  }

  const flash = (m) => { setMsg(m); setTimeout(() => setMsg(null), 3000); };

  async function persist(patch) {
    setSaving(true);
    setMsg(null);
    try {
      const r = await adminStoreLockSave(store, patch);
      setLock(r.lock);
      setDraft(r.lock.message || "");
      flash({ type: "ok", text: r.lock.locked ? "Loja trancada para os clientes." : "Loja liberada para os clientes." });
    } catch (err) {
      flash({ type: "err", text: errText(err, "Não foi possível atualizar a trava da loja.") });
    } finally {
      setSaving(false);
    }
  }

  const dirty = draft.trim() !== (lock.message || "").trim();

  return (
    <div style={{ background: "var(--color-background-primary)", border: `0.5px solid ${lock.locked ? "var(--warn-border)" : "var(--color-border-tertiary)"}`, borderRadius: 12, padding: 16, marginBottom: 18 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 4 }}>
        <div>
          <div style={{ fontWeight: 500 }}>Disponibilidade para os clientes</div>
          <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 2 }}>
            Desligado = a aba {storeLabel} fica trancada e a loja some da escolha nas campanhas.
            O scraping continua rodando normalmente.
          </div>
        </div>
        <Toggle value={!lock.locked} onChange={v => persist({ locked: !v })} />
      </div>

      {lock.locked && (
        <div style={{ marginTop: 12, padding: "8px 10px", borderRadius: 8, background: "var(--warn-bg)", border: "0.5px solid var(--warn-border)", color: "var(--warn-text)", fontSize: 12 }}>
          🔒 Loja trancada. {usage > 0
            ? `${usage} campanha${usage > 1 ? "s" : ""} usa${usage > 1 ? "m" : ""} esta loja — ela é ignorada até você liberar (campanha que só tinha ela fica pausada).`
            : "Nenhuma campanha usa esta loja no momento."}
        </div>
      )}
      {!lock.locked && usage > 0 && (
        <div style={{ marginTop: 12, fontSize: 12, color: "var(--color-text-secondary)" }}>
          {usage} campanha{usage > 1 ? "s" : ""} usa{usage > 1 ? "m" : ""} esta loja hoje.
        </div>
      )}

      <div style={{ marginTop: 16 }}>
        <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 6 }}>
          Mensagem exibida ao usuário quando a loja está trancada
        </label>
        <textarea
          value={draft}
          onChange={e => setDraft(e.target.value)}
          rows={2}
          maxLength={300}
          style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13, boxSizing: "border-box", resize: "vertical", fontFamily: "inherit" }}
        />
        <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
          {PRESETS.map(p => (
            <button
              key={p.label}
              onClick={() => setDraft(p.text)}
              style={{ padding: "5px 12px", borderRadius: 7, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 12, cursor: "pointer" }}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {msg && (
        <div style={{ marginTop: 14, padding: "8px 10px", borderRadius: 8, fontSize: 12, background: msg.type === "ok" ? PRIMARY_LIGHT : "var(--danger-bg)", color: msg.type === "ok" ? PRIMARY_DARK : "var(--danger-text)" }}>
          {msg.text}
        </div>
      )}

      <div style={{ marginTop: 14 }}>
        <button
          onClick={() => persist({ message: draft })}
          disabled={saving || !dirty}
          style={{ padding: "8px 16px", borderRadius: 8, background: PRIMARY, color: "#fff", border: "none", fontSize: 13, cursor: saving || !dirty ? "not-allowed" : "pointer", fontWeight: 500, opacity: saving || !dirty ? 0.5 : 1 }}
        >
          {saving ? "Salvando..." : "Salvar mensagem"}
        </button>
      </div>
    </div>
  );
}
