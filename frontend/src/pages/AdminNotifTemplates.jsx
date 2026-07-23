import { useState, useEffect, useRef, useCallback } from "react";
import { PRIMARY, PRIMARY_DARK } from "../data/constants";
import {
  adminNotifTemplates,
  adminNotifTemplatesSave,
  adminNotifTemplatePreview,
} from "../data/api";

const cardStyle = { background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 10, padding: "20px 24px", marginBottom: 16 };
const btnPrimary = { background: PRIMARY, color: "#fff", border: "none", borderRadius: 6, padding: "8px 16px", fontSize: 13, fontWeight: 600, cursor: "pointer" };
const textareaStyle = { width: "100%", minHeight: 130, padding: "10px 12px", border: "1px solid var(--color-border)", borderRadius: 6, fontSize: 13, lineHeight: 1.5, fontFamily: "inherit", background: "var(--color-surface)", color: "var(--color-text-primary)", boxSizing: "border-box", resize: "vertical" };
const chipStyle = { display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px", borderRadius: 12, border: "1px solid var(--color-border)", background: "var(--color-surface-alt)", color: "var(--color-text-secondary)", fontSize: 11, cursor: "pointer" };

function TemplateCard({ meta, value, onChange, onReset }) {
  const [preview, setPreview] = useState("");
  const taRef = useRef(null);
  const debounceRef = useRef(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      try {
        const r = await adminNotifTemplatePreview(meta.key, value);
        setPreview(r.text);
      } catch {
        setPreview("");
      }
    }, 400);
    return () => debounceRef.current && clearTimeout(debounceRef.current);
  }, [meta.key, value]);

  // Insere {variavel} na posição do cursor do textarea.
  const insertVar = (name) => {
    const ta = taRef.current;
    const token = `{${name}}`;
    if (!ta) { onChange(value + token); return; }
    const start = ta.selectionStart ?? value.length;
    const end = ta.selectionEnd ?? value.length;
    const next = value.slice(0, start) + token + value.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      ta.focus();
      const pos = start + token.length;
      ta.setSelectionRange(pos, pos);
    });
  };

  return (
    <div style={cardStyle}>
      <div style={{ fontSize: 15, fontWeight: 700, color: "var(--color-text-primary)", marginBottom: 12 }}>{meta.label}</div>

      <textarea
        ref={taRef}
        value={value}
        onChange={e => onChange(e.target.value)}
        style={textareaStyle}
      />

      <div style={{ marginTop: 10, marginBottom: 4, fontSize: 11, fontWeight: 600, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: 0.5 }}>
        Variáveis (clique para inserir)
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
        {meta.variables.map(v => (
          <span key={v.name} style={chipStyle} title={v.desc} onClick={() => insertVar(v.name)}>
            {"{" + v.name + "}"}
          </span>
        ))}
      </div>

      <div style={{ fontSize: 11, fontWeight: 600, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>
        Pré-visualização (dados de exemplo)
      </div>
      <div style={{ background: "#0a3d2e", color: "#e9edef", borderRadius: 8, padding: "12px 14px", fontSize: 13, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word", minHeight: 40 }}>
        {preview || <span style={{ opacity: 0.5 }}>—</span>}
      </div>

      <div style={{ marginTop: 10 }}>
        <button
          onClick={onReset}
          style={{ padding: "5px 12px", borderRadius: 6, border: "1px solid var(--color-border)", background: "transparent", color: "var(--color-text-primary)", fontSize: 12, cursor: "pointer" }}
        >
          Restaurar padrão
        </button>
      </div>
    </div>
  );
}

export default function PageAdminNotifTemplates() {
  const [meta, setMeta] = useState([]);
  const [defaults, setDefaults] = useState({});
  const [templates, setTemplates] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [savedMsg, setSavedMsg] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const r = await adminNotifTemplates();
        setMeta(r.meta || []);
        setDefaults(r.defaults || {});
        setTemplates(r.templates || {});
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const setTemplate = useCallback((key, text) => {
    setTemplates(t => ({ ...t, [key]: text }));
  }, []);

  async function save() {
    setSaving(true);
    setError(null);
    setSavedMsg(null);
    try {
      const r = await adminNotifTemplatesSave(templates);
      setTemplates(r.templates || templates);
      setSavedMsg("Salvo!");
      setTimeout(() => setSavedMsg(null), 2500);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <div style={{ padding: 40, textAlign: "center", color: "var(--color-text-secondary)" }}>Carregando...</div>;
  }

  return (
    <div style={{ padding: "28px 32px", maxWidth: 680 }}>
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 20, fontWeight: 700, color: "var(--color-text-primary)" }}>Modelos de Notificações</div>
        <div style={{ fontSize: 13, color: "var(--color-text-secondary)", marginTop: 4 }}>
          Edite o texto das notificações enviadas ao grupo do WhatsApp. Use as variáveis entre chaves
          (ex.: <code>{"{data}"}</code>) — elas são trocadas pelos valores reais no envio.
        </div>
      </div>

      {error && (
        <div style={{ background: "#FEE2E2", color: "#991B1B", borderRadius: 8, padding: "10px 14px", marginBottom: 16, fontSize: 13 }}>
          {error}
        </div>
      )}

      {meta.map(m => (
        <TemplateCard
          key={m.key}
          meta={m}
          value={templates[m.key] ?? ""}
          onChange={text => setTemplate(m.key, text)}
          onReset={() => setTemplate(m.key, defaults[m.key] ?? "")}
        />
      ))}

      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <button style={btnPrimary} onClick={save} disabled={saving}>
          {saving ? "Salvando..." : "Salvar"}
        </button>
        {savedMsg && <span style={{ fontSize: 13, color: "#15803D", fontWeight: 600 }}>{savedMsg}</span>}
      </div>
    </div>
  );
}
