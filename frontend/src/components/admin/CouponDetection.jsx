import { useState, useCallback } from "react";
import { PRIMARY, PRIMARY_DARK, PRIMARY_LIGHT } from "../../data/constants";
import WordList from "../WordList";
import {
  adminRepasseCouponConfig,
  adminRepasseCouponConfigSave,
  adminRepasseCouponTest,
  errText,
} from "../../data/api";

// Admin → Repasse: as palavras que fazem a captura reconhecer um cupom escrito
// na legenda do grupo líder ("use o cupom JBL20").
//
// Antes disso a lista era uma regex fixa no backend: incluir um jeito novo de
// escrever ("promo X10") pedia deploy. Aqui o admin edita, testa numa mensagem
// de exemplo e salva.

const cardStyle = {
  background: "var(--color-background-primary)",
  border: "0.5px solid var(--color-border-tertiary)",
  borderRadius: 12,
  padding: 16,
};

const inputStyle = {
  padding: "7px 10px",
  borderRadius: 8,
  border: "0.5px solid var(--color-border-tertiary)",
  background: "var(--color-background-secondary)",
  fontSize: 13,
  width: "100%",
};

const btnStyle = {
  padding: "6px 12px",
  borderRadius: 7,
  border: "0.5px solid var(--color-border-secondary)",
  background: "transparent",
  fontSize: 12,
  cursor: "pointer",
};

function Field({ label, hint, children }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ fontSize: 12, fontWeight: 500 }}>{label}</div>
      {hint && <div style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>{hint}</div>}
      {children}
    </div>
  );
}

export default function CouponDetection() {
  const [open, setOpen] = useState(false);
  const [config, setConfig] = useState(null);
  const [defaults, setDefaults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  const [sample, setSample] = useState("Fone JBL R$99 🔥 use o cupom JBL20 https://mercadolivre.com.br/p/MLB1");
  const [testResult, setTestResult] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await adminRepasseCouponConfig();
      setConfig(r.config);
      setDefaults(r.defaults);
      setError(null);
    } catch (err) {
      setError(errText(err, "Não foi possível carregar a detecção de cupom."));
    } finally {
      setLoading(false);
    }
  }, []);

  // Busca no clique que abre o card, não num efeito: o resto da tela recarrega
  // a cada 5s e essa config muda uma vez por mês.
  function toggle() {
    const abrindo = !open;
    setOpen(abrindo);
    if (abrindo && !config) load();
  }

  function patch(p) {
    setConfig(c => ({ ...c, ...p }));
    setSaved(false);
    setTestResult(null);
  }

  async function save() {
    setSaving(true);
    try {
      const r = await adminRepasseCouponConfigSave(config);
      // Resposta traz a config já saneada pelo servidor (minúsculas, sem
      // repetida, limites aplicados) — mostrar ela evita a tela discordar do
      // que foi realmente gravado.
      setConfig(r.config);
      setSaved(true);
      setError(null);
    } catch (err) {
      setError(errText(err, "Não foi possível salvar."));
    } finally {
      setSaving(false);
    }
  }

  async function testar() {
    try {
      const r = await adminRepasseCouponTest(sample, config);
      setTestResult({ coupon: r.coupon });
      setError(null);
    } catch (err) {
      setError(errText(err, "Não foi possível testar."));
    }
  }

  return (
    <div style={cardStyle}>
      <div onClick={toggle}
        style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
        <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>{open ? "▾" : "▸"}</span>
        <div>
          <div style={{ fontWeight: 600, fontSize: 14 }}>Detecção de cupom na legenda</div>
          <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
            Quais palavras fazem o sistema entender que o texto do grupo líder traz um cupom.
          </div>
        </div>
      </div>

      {open && (
        <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 14 }}>
          {loading && <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>Carregando…</div>}
          {error && <div style={{ color: "var(--danger-text)", fontSize: 12 }}>{error}</div>}

          {config && (
            <>
              <Field
                label="Palavras-gatilho"
                hint="Precisam vir ANTES do código pra ele ser reconhecido: “use o cupom JBL20”. Acento não importa — “codigo” e “código” valem igual.">
                <WordList words={config.triggers || []} onChange={v => patch({ triggers: v })} placeholder="ex.: promo" />
              </Field>

              <Field
                label="Palavras ignoradas"
                hint="O que vem depois do gatilho mas não é código: “use o cupom AQUI”. Uma palavra por chip, sem espaço."
              >
                <WordList words={config.ignore || []} onChange={v => patch({ ignore: v })} placeholder="ex.: descricao" />
              </Field>

              <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
                <Field label="Tamanho mínimo do código">
                  <input type="number" min={2} max={60} value={config.minLen ?? ""}
                    onChange={e => patch({ minLen: e.target.value === "" ? "" : parseInt(e.target.value) })}
                    style={{ ...inputStyle, maxWidth: 110 }} />
                </Field>
                <Field label="Tamanho máximo">
                  <input type="number" min={2} max={60} value={config.maxLen ?? ""}
                    onChange={e => patch({ maxLen: e.target.value === "" ? "" : parseInt(e.target.value) })}
                    style={{ ...inputStyle, maxWidth: 110 }} />
                </Field>
              </div>

              <Field label="Testar numa mensagem" hint="Roda com o que está no formulário, mesmo sem salvar.">
                <textarea rows={3} value={sample} onChange={e => { setSample(e.target.value); setTestResult(null); }}
                  style={{ ...inputStyle, fontFamily: "inherit", resize: "vertical" }} />
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6 }}>
                  <button type="button" onClick={testar} style={btnStyle}>Testar</button>
                  {testResult && (
                    testResult.coupon
                      ? <span style={{ fontSize: 12 }}>Detectado: <strong style={{ color: "#1B7A43" }}>{testResult.coupon}</strong></span>
                      : <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>Nenhum cupom detectado.</span>
                  )}
                </div>
              </Field>

              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <button type="button" onClick={save} disabled={saving}
                  style={{ ...btnStyle, border: `0.5px solid ${PRIMARY}`, background: PRIMARY_LIGHT, color: PRIMARY_DARK, fontWeight: 500 }}>
                  {saving ? "Salvando…" : "Salvar"}
                </button>
                <button type="button" disabled={!defaults} onClick={() => patch({ ...defaults })} style={btnStyle}>
                  Restaurar padrão
                </button>
                {saved && <span style={{ fontSize: 12, color: "#1B7A43" }}>Salvo.</span>}
                <span style={{ fontSize: 11, color: "var(--color-text-secondary)", marginLeft: "auto" }}>
                  A captura roda no worker: a mudança vale em até ~30 segundos.
                </span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
