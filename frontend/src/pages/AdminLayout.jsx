import { useState, useEffect, useRef } from "react";
import { PRIMARY, PRIMARY_DARK, PRIMARY_LIGHT, PALETTES, DEFAULT_PALETTE } from "../data/constants";
import { layoutGet, adminLayoutSave, errText} from "../data/api";

const card = {
  background: "var(--color-background-primary)",
  border: "0.5px solid var(--color-border-tertiary)",
  borderRadius: 12,
  padding: 16,
};

// Miniatura da paleta: uma faixa clara e uma escura, com a cor da marca em cima.
// Usa os hex crus de PALETTES de propósito — precisa mostrar a paleta que NÃO
// está ativa, então não pode depender das variáveis CSS do tema atual.
function Swatch({ swatch }) {
  const half = { flex: 1, display: "flex", alignItems: "center", gap: 6, padding: "0 8px" };
  return (
    <div style={{
      display: "flex", height: 44, borderRadius: 8, overflow: "hidden",
      border: "0.5px solid var(--color-border-tertiary)", flexShrink: 0, width: 132,
    }}>
      <div style={{ ...half, background: swatch.bgLight }}>
        <span style={{ width: 14, height: 14, borderRadius: 4, background: swatch.brand, flexShrink: 0 }} />
        <span style={{ flex: 1, height: 4, borderRadius: 2, background: swatch.text, opacity: 0.28 }} />
      </div>
      <div style={{ ...half, background: swatch.bgDark }}>
        <span style={{ width: 14, height: 14, borderRadius: 4, background: swatch.brand, flexShrink: 0 }} />
        <span style={{ flex: 1, height: 4, borderRadius: 2, background: "#fff", opacity: 0.28 }} />
      </div>
    </div>
  );
}

export default function PageAdminLayout() {
  // `applied` = o que está gravado no servidor; `sel` = o que está marcado na
  // tela. Ficam separados pra dar prévia ao vivo sem salvar: clicar pinta o
  // sistema na hora, e só "Aplicar" grava pra todo mundo.
  const [applied, setApplied] = useState(null);
  const [sel, setSel] = useState(DEFAULT_PALETTE);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await layoutGet();
        if (!alive) return;
        setApplied(r.palette);
        setSel(r.palette);
      } catch {
        if (alive) setApplied(DEFAULT_PALETTE);
      }
    })();
    return () => { alive = false; };
  }, []);

  // Prévia ao vivo enquanto a tela está aberta.
  useEffect(() => {
    document.documentElement.dataset.palette = sel;
  }, [sel]);

  // Ao sair sem aplicar, devolve a paleta que está de fato gravada. Precisa ser
  // um efeito de unmount de verdade ([] + ref): com [applied] na dependência, a
  // limpeza dispararia também ao salvar, repintando a tela com o valor ANTIGO
  // logo depois de gravar o novo.
  const appliedRef = useRef(applied);
  useEffect(() => { appliedRef.current = applied; }, [applied]);
  useEffect(() => () => {
    if (appliedRef.current) document.documentElement.dataset.palette = appliedRef.current;
  }, []);

  const dirty = applied !== null && sel !== applied;

  const apply = async () => {
    setSaving(true);
    setMsg(null);
    try {
      await adminLayoutSave(sel);
      setApplied(sel);
      setMsg({ type: "ok", text: "Paleta aplicada. Vale pra todos os usuários." });
    } catch (err) {
      setMsg({ type: "err", text: errText(err, "Não foi possível salvar.") });
      // Some o que não foi gravado: volta a tela pro estado real do servidor.
      setSel(applied);
    } finally {
      setSaving(false);
    }
  };

  if (applied === null) {
    return <div style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>Carregando…</div>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 640 }}>
      <div>
        <h1 style={{ fontSize: 20, marginBottom: 4 }}>Layout</h1>
        <div style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>
          Cores do sistema. A escolha vale para todos os usuários, em cima do tema
          claro/escuro que cada um usa.
        </div>
      </div>

      <div style={{ ...card, display: "flex", flexDirection: "column", gap: 8 }}>
        {PALETTES.map(p => {
          const active = sel === p.id;
          return (
            <button
              key={p.id}
              onClick={() => setSel(p.id)}
              aria-pressed={active}
              style={{
                display: "flex", alignItems: "center", gap: 14, textAlign: "left",
                padding: 12, borderRadius: 10, cursor: "pointer",
                border: `1px solid ${active ? PRIMARY : "var(--color-border-tertiary)"}`,
                background: active ? PRIMARY_LIGHT : "transparent",
              }}
            >
              <Swatch swatch={p.swatch} />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{
                  display: "block", fontSize: 14, fontWeight: active ? 600 : 500,
                  color: active ? PRIMARY_DARK : "var(--color-text-primary)",
                }}>
                  {p.label}
                  {p.id === applied && (
                    <span style={{ fontSize: 11, fontWeight: 500, marginLeft: 8, color: "var(--color-text-secondary)" }}>
                      em uso
                    </span>
                  )}
                </span>
                <span style={{ display: "block", fontSize: 12, color: active ? PRIMARY_DARK : "var(--color-text-secondary)", opacity: active ? 0.8 : 1 }}>
                  {p.hint}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <button
          onClick={apply}
          disabled={!dirty || saving}
          style={{
            padding: "9px 18px", borderRadius: 10, border: "none", fontSize: 13, fontWeight: 600,
            background: dirty && !saving ? PRIMARY : "var(--color-border-secondary)",
            color: "#fff", cursor: dirty && !saving ? "pointer" : "not-allowed",
          }}
        >
          {saving ? "Aplicando…" : "Aplicar para todos"}
        </button>
        {dirty && !saving && (
          <button
            onClick={() => setSel(applied)}
            style={{
              padding: "9px 14px", borderRadius: 10, fontSize: 13, cursor: "pointer",
              border: "0.5px solid var(--color-border-secondary)", background: "transparent",
              color: "var(--color-text-primary)",
            }}
          >
            Descartar
          </button>
        )}
        <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
          {dirty ? "Prévia ativa — ainda não foi salvo." : "Nenhuma alteração pendente."}
        </span>
      </div>

      {msg && (
        <div style={{
          padding: "10px 14px", borderRadius: 10, fontSize: 13,
          background: msg.type === "ok" ? "var(--success-bg)" : "var(--danger-bg)",
          border: `1px solid ${msg.type === "ok" ? "var(--success-border)" : "var(--danger-border)"}`,
          color: msg.type === "ok" ? "var(--success-text)" : "var(--danger-text)",
        }}>
          {msg.text}
        </div>
      )}
    </div>
  );
}
