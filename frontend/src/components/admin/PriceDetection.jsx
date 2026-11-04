import { useState, useCallback } from "react";
import { PRIMARY, PRIMARY_DARK, PRIMARY_LIGHT } from "../../data/constants";
import WordList from "../WordList";
import {
  adminRepassePriceConfig,
  adminRepassePriceConfigSave,
  adminRepassePriceTest,
  errText,
} from "../../data/api";

// Admin → Repasse: como a captura acha o PREÇO escrito na legenda do grupo líder
// ("Por: R$ 1.520", "R$ 1.520 no Pix"). Só vale para produto da Shopee: a API
// dela só dá o preço de vitrine, e o grupo líder escreve o preço com Pix + cupom.
// Mesmo formato do card de cupom (CouponDetection).

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

const brl = v => `R$ ${Number(v).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function Field({ label, hint, children }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ fontSize: 12, fontWeight: 500 }}>{label}</div>
      {hint && <div style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>{hint}</div>}
      {children}
    </div>
  );
}

export default function PriceDetection() {
  const [open, setOpen] = useState(false);
  const [config, setConfig] = useState(null);
  const [defaults, setDefaults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  const [sample, setSample] = useState("✅ Por: R$ 1.739,90\n💰 R$ 1.520 no Pix com cupom\nhttps://s.shopee.com.br/exemplo");
  const [apiPrice, setApiPrice] = useState("1739.90");
  const [testResult, setTestResult] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await adminRepassePriceConfig();
      setConfig(r.config);
      setDefaults(r.defaults);
      setError(null);
    } catch (err) {
      setError(errText(err, "Não foi possível carregar a detecção de preço."));
    } finally {
      setLoading(false);
    }
  }, []);

  // Busca no clique que abre o card (o resto da tela recarrega a cada 5s).
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
      const r = await adminRepassePriceConfigSave(config);
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
      const n = Number(String(apiPrice).replace(",", "."));
      const r = await adminRepassePriceTest(sample, config, Number.isFinite(n) && n > 0 ? n : undefined);
      setTestResult(r);
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
          <div style={{ fontWeight: 600, fontSize: 14 }}>Detecção de preço na legenda (Shopee)</div>
          <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
            Lê o preço com Pix + cupom que o grupo líder escreveu. Se for menor que o da Shopee, ele vai como “Por” e o da Shopee vira o “De”.
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
                hint="Precisam vir logo ANTES do valor: “Por: R$ 1.520”, “pix 1520”. Se aparecerem vários valores, vale o menor.">
                <WordList words={config.triggers || []} onChange={v => patch({ triggers: v })} placeholder="ex.: apenas" />
              </Field>

              <Field
                label="Não é preço"
                hint="Palavra colada no valor (2 antes ou 1 depois) que mostra que ele é outra coisa: “R$ 20 OFF”, “frete R$ 15”, “desconto de R$ 50”. Parcela (“12x de R$ 145”) já é ignorada sempre.">
                <WordList words={config.ignore || []} onChange={v => patch({ ignore: v })} placeholder="ex.: frete" />
              </Field>

              <Field
                label="Mínimo (% do preço da Shopee)"
                hint="O preço do texto só vale se for menor que o da Shopee e pelo menos esta porcentagem dele. Abaixo disso costuma ser parcela, frete ou valor do cupom.">
                <input type="number" min={1} max={99} value={config.minPct ?? ""}
                  onChange={e => patch({ minPct: e.target.value === "" ? "" : parseInt(e.target.value) })}
                  style={{ ...inputStyle, maxWidth: 110 }} />
              </Field>

              <Field label="Testar numa mensagem" hint="Roda com o que está no formulário, mesmo sem salvar.">
                <textarea rows={4} value={sample} onChange={e => { setSample(e.target.value); setTestResult(null); }}
                  style={{ ...inputStyle, fontFamily: "inherit", resize: "vertical" }} />
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 12 }}>Preço da Shopee (API):</span>
                  <input aria-label="Preço da Shopee" value={apiPrice}
                    onChange={e => { setApiPrice(e.target.value); setTestResult(null); }}
                    style={{ ...inputStyle, maxWidth: 110 }} />
                  <button type="button" onClick={testar} style={btnStyle}>Testar</button>
                </div>
                {testResult && (
                  <div style={{ fontSize: 12, marginTop: 6 }}>
                    {testResult.price == null
                      ? <span style={{ color: "var(--color-text-secondary)" }}>Nenhum preço detectado.</span>
                      : <>
                          Detectado: <strong style={{ color: "#1B7A43" }}>{brl(testResult.price)}</strong>
                          {testResult.candidates?.length > 1 && (
                            <span style={{ color: "var(--color-text-secondary)" }}> (valores achados: {testResult.candidates.map(brl).join(", ")})</span>
                          )}
                          {testResult.troca !== undefined && (
                            <div style={{ marginTop: 4 }}>
                              {testResult.troca
                                ? <>No envio: De <s>{brl(testResult.troca.originalPrice)}</s> Por <strong>{brl(testResult.troca.price)}</strong> ({testResult.troca.discount}% OFF)</>
                                : <span style={{ color: "var(--color-text-secondary)" }}>Não troca: o preço da Shopee fica (o do texto não é menor ou está abaixo do mínimo).</span>}
                            </div>
                          )}
                        </>}
                  </div>
                )}
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
