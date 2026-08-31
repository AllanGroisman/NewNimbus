// De onde o robô do Mercado Livre tira as ofertas: vitrine pública, Hub de
// Afiliados, ou as duas — e qual delas enche a cota primeiro.
//
// Vive fora da página porque duas telas precisam da MESMA configuração: Admin › ML
// (onde ela sempre morou) e a aba Config Test do Cupom, que diagnostica tudo que a
// colheita de vitrines depende — e o Hub desligado é uma das causas.
import { useState, useEffect } from "react";
import { adminScraperMLSources, adminScraperMLSourcesSave, errText } from "../../data/api";
import AlertBanner from "../ui/AlertBanner";

export default function MLSourcesSection() {
  const [data, setData] = useState(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);
  const [loadError, setLoadError] = useState(null);

  const load = () => {
    adminScraperMLSources()
      .then(r => { setLoadError(null); setData(r); })
      .catch(err => setLoadError(errText(err, "Não foi possível carregar as fontes de ofertas.")));
  };
  useEffect(() => { load(); }, []);

  async function patch(p, okText) {
    setSaving(true);
    setMsg(null);
    try {
      const r = await adminScraperMLSourcesSave(p);
      setData(r);
      setMsg({ type: "ok", text: okText });
      setTimeout(() => setMsg(null), 4000);
    } catch (err) {
      setMsg({ type: "err", text: errText(err, "Não foi possível salvar.") });
      load();
    } finally {
      setSaving(false);
    }
  }

  if (loadError) return <AlertBanner tone="error" message={loadError} onRetry={load} />;
  if (!data) return <div style={{ padding: 20, color: "var(--color-text-secondary)", fontSize: 13 }}>Carregando fontes...</div>;

  const s = data.sources;
  // Desligar a última fonte deixaria o ML sem nada pra coletar — o backend recusa,
  // então a interface nem oferece.
  const soFonte = (src) => s[src] && !s[src === "hub" ? "vitrine" : "hub"];
  const hubBloqueado = !data.hubAvailable;

  const fonte = ({ src, titulo, hint, disabled, disabledHint }) => (
    <FonteCheckbox
      key={src}
      titulo={titulo}
      hint={disabled ? disabledHint : hint}
      checked={s[src] !== false}
      disabled={saving || disabled || soFonte(src)}
      apagado={!!disabled}
      lockHint={soFonte(src) ? "Deixe pelo menos uma fonte ligada" : undefined}
      onChange={checked => patch({ [src]: checked }, checked
        ? `${titulo}: as ofertas voltam a entrar no catálogo.`
        : `${titulo}: o robô para de coletar dessa fonte.`)}
    />
  );

  return (
    <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: 16, marginBottom: 18 }}>
      <div style={{ fontWeight: 500, marginBottom: 4 }}>De onde vêm as ofertas</div>
      <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 14, lineHeight: 1.5 }}>
        O robô do Mercado Livre pode olhar dois lugares. Produto que aparece nos dois entra uma vez só.
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {fonte({
          src: "vitrine",
          titulo: "Vitrine pública de ofertas",
          hint: "A página de ofertas que qualquer pessoa vê, sem login. É a coleta original do sistema.",
        })}
        {fonte({
          src: "hub",
          titulo: "Hub de Afiliados",
          hint: "Só abre com a conta do sistema configurada acima. Traz também quanto cada produto paga de comissão.",
          disabled: hubBloqueado,
          disabledHint: "Precisa da conta do Mercado Livre do sistema — cole o cookie no card acima.",
        })}
      </div>

      {s.vitrine !== false && s.hub !== false && (
        <div style={{ marginTop: 16, paddingTop: 14, borderTop: "0.5px solid var(--color-border-tertiary)" }}>
          <div style={{ fontSize: 12, marginBottom: 6 }}>Começar por:</div>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
            {[["hub", "Hub de Afiliados"], ["vitrine", "Vitrine pública"]].map(([val, label]) => (
              <label key={val} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer" }}>
                <input
                  type="radio"
                  name="ml-priority"
                  checked={s.priority === val}
                  disabled={saving}
                  onChange={() => patch({ priority: val }, `A coleta passa a começar pelo ${label.toLowerCase()}.`)}
                />
                {label}
              </label>
            ))}
          </div>
          <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 6, lineHeight: 1.5 }}>
            O limite de produtos por categoria é preenchido primeiro com as ofertas dessa fonte; o que faltar vem da outra.
            Se a primeira já encher, a segunda nem é aberta.
          </div>
        </div>
      )}

      {msg && (
        <AlertBanner
          tone={msg.type === "ok" ? "success" : "error"}
          message={msg.text}
          onDismiss={() => setMsg(null)}
          style={{ marginTop: 14, marginBottom: 0 }}
        />
      )}
    </div>
  );
}

// Uma fonte de ofertas: marcador + explicação de uma linha. `apagado` é a fonte
// indisponível (Hub sem conta do sistema); `lockHint` aparece quando é a última
// fonte ligada e por isso não pode ser desmarcada.
function FonteCheckbox({ titulo, hint, checked, disabled, apagado, lockHint, onChange }) {
  return (
    <label style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 12, cursor: disabled ? "not-allowed" : "pointer", opacity: apagado ? 0.55 : 1 }}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={e => onChange(e.target.checked)}
        title={lockHint}
        style={{ marginTop: 2 }}
      />
      <span>
        {titulo}
        <span style={{ display: "block", color: "var(--color-text-secondary)", fontSize: 11, marginTop: 2, lineHeight: 1.5 }}>
          {hint}
        </span>
      </span>
    </label>
  );
}
