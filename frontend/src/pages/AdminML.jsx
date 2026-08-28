import { useState, useEffect, useRef } from "react";
import { PRIMARY, PRIMARY_DARK, PRIMARY_LIGHT } from "../data/constants";
import {
  adminScraperMLFilters,
  adminScraperMLFiltersSave,
  adminScraperMLSession,
  adminScraperMLSessionSave,
  adminScraperMLSessionClear,
  adminScraperMLSessionTest,
  adminScraperMLSources,
  adminScraperMLSourcesSave,
  errText,
} from "../data/api";
import StoreLockCard from "../components/ui/StoreLockCard";
import AlertBanner from "../components/ui/AlertBanner";
import Badge from "../components/ui/Badge";

export default function PageAdminML() {
  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <h2 style={{ fontSize: 18, fontWeight: 500 }}>Mercado Livre (admin)</h2>
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 4 }}>
          Filtros globais aplicados ao scraping do Mercado Livre antes de salvar no catálogo central.
        </div>
      </div>
      <StoreLockCard store="ml" storeLabel="Mercado Livre" />
      <MLSessionSection />
      <MLSourcesSection />
      <MLFiltersSection />
    </div>
  );
}

// Sessão de uma conta do Mercado Livre DO SISTEMA. É o que permite abrir páginas
// que só existem logado — hoje o Hub de Afiliados. Não tem nada a ver com o cookie
// que cada cliente cola na aba Mercado Livre dele (aquele só gera link de afiliado).
function MLSessionSection() {
  const [data, setData] = useState(null);
  const [cookie, setCookie] = useState("");
  // A tag é editada separado do cookie: ela quase nunca muda e o cookie é
  // recolado toda semana. `null` = ninguém mexeu, mostra o que veio do servidor.
  const [tag, setTag] = useState(null);
  const [msg, setMsg] = useState(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [loadError, setLoadError] = useState(null);

  const load = () => {
    adminScraperMLSession()
      .then(r => { setLoadError(null); setData(r); })
      .catch(err => setLoadError(errText(err, "Não foi possível carregar a sessão do Mercado Livre.")));
  };
  useEffect(() => { load(); }, []);

  async function save() {
    setSaving(true);
    setMsg(null);
    try {
      // Manda só o que foi editado: campo ausente é "não mexi nisso". É o que
      // permite trocar a tag sem recolar o cookie, e recolar o cookie sem perder
      // a tag.
      const r = await adminScraperMLSessionSave({
        ...(cookie.trim() ? { cookie: cookie.trim() } : {}),
        ...(tag === null ? {} : { tag: tag.trim() }),
      });
      setData(r);
      setCookie("");
      setTag(null);
      setMsg({ type: "ok", text: "Sessão salva. Clique em “Testar acesso ao Hub” pra confirmar que ela entra." });
    } catch (err) {
      setMsg({ type: "err", text: errText(err, "Não foi possível salvar a sessão.") });
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    setTesting(true);
    setMsg(null);
    try {
      const r = await adminScraperMLSessionTest();
      if (r.session) setData(r.session);
      setMsg({ type: r.ok ? "ok" : "err", text: r.reason });
    } catch (err) {
      setMsg({ type: "err", text: errText(err, "Não foi possível abrir o Hub agora.") });
      load();
    } finally {
      setTesting(false);
    }
  }

  async function clear() {
    if (!confirm("Apagar a sessão do Mercado Livre do sistema? O scraping do Hub de Afiliados para de funcionar.")) return;
    setSaving(true);
    setMsg(null);
    try {
      const r = await adminScraperMLSessionClear();
      setData(r);
      setCookie("");
      setMsg({ type: "ok", text: "Sessão apagada." });
    } catch (err) {
      setMsg({ type: "err", text: errText(err, "Não foi possível apagar a sessão.") });
    } finally {
      setSaving(false);
    }
  }

  if (loadError) return <AlertBanner tone="error" message={loadError} onRetry={load} />;

  // Dá pra salvar o cookie sozinho, a tag sozinha, ou os dois. O que não dá é
  // salvar a tag antes de existir um cookie — sem sessão não há conta.
  const temEdicao = !!cookie.trim() || (tag !== null && tag.trim() !== (data?.tag || "") && (data?.configured || !!cookie.trim()));

  const badge = !data?.configured ? { color: "gray", text: "Não configurada" }
    : data.lastCheckOk === true ? { color: "green", text: "Acessa o Hub" }
    : data.lastCheckOk === false ? { color: "amber", text: "Falhou no último teste" }
    : { color: "amber", text: "Salva, sem teste" };

  return (
    <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: 16, marginBottom: 18 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
        <div style={{ fontWeight: 500 }}>Conta do Mercado Livre do sistema</div>
        {data && <Badge color={badge.color}>{badge.text}</Badge>}
      </div>
      <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 14, lineHeight: 1.5 }}>
        O <a href="https://www.mercadolivre.com.br/afiliados/hub" target="_blank" rel="noreferrer" style={{ color: PRIMARY }}>Hub de Afiliados</a> só
        abre logado. Cole aqui o cookie de uma conta do Mercado Livre <strong>nossa</strong> — é ela que o robô usa pra
        ver essas ofertas. Não é o cookie de nenhum cliente: o que cada um cola na aba dele continua sendo usado
        só pra gerar o link de afiliado com a TAG dele.
      </div>

      <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>
        Cookie de sessão {data?.cookieLength ? <span style={{ color: PRIMARY_DARK }}>(salvo: {data.cookieLength} caracteres{data.source === "env" ? ", vindo de variável de ambiente" : ""})</span> : null}
      </label>
      <textarea
        value={cookie}
        onChange={e => setCookie(e.target.value)}
        rows={5}
        placeholder="Cole aqui o cookie copiado pela extensão Extrator Nimbus"
        style={{ width: "100%", padding: "9px 12px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 12, resize: "vertical", boxSizing: "border-box", fontFamily: "monospace" }}
      />
      <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", margin: "12px 0 4px" }}>
        TAG de afiliado da conta do sistema <span style={{ opacity: 0.7 }}>(opcional)</span>
      </label>
      <input
        value={tag === null ? (data?.tag || "") : tag}
        onChange={e => setTag(e.target.value)}
        placeholder="ex.: nomedaconta"
        style={{ width: "100%", padding: "9px 12px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 12, boxSizing: "border-box", fontFamily: "monospace" }}
      />
      <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 6, lineHeight: 1.5 }}>
        Serve só pra <strong>ler</strong>: com ela o robô consegue ver os produtos da vitrine de um cupom sem abrir
        navegador (é o único caminho que o ML não bloqueia hoje). O Hub e a coleta de cupons funcionam sem ela.
        Não tem nada a ver com a TAG de nenhum cliente — os links dos grupos continuam saindo com a tag de cada um.
      </div>

      <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 10, lineHeight: 1.5 }}>
        <strong>Como pegar:</strong> instale a extensão <a href="https://chromewebstore.google.com/detail/extrator-nimbus/jppbabekibjgclmbacibonalflchgdlh" target="_blank" rel="noreferrer" style={{ color: PRIMARY }}>Extrator Nimbus</a> no
        Chrome → entre na conta do sistema em mercadolivre.com.br → clique no ícone da extensão → cole aqui.
      </div>

      {msg && (
        <AlertBanner
          tone={msg.type === "ok" ? "success" : "error"}
          message={msg.text}
          onDismiss={() => setMsg(null)}
          style={{ marginTop: 12, marginBottom: 0 }}
        />
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
        <button onClick={save} disabled={saving || !temEdicao} style={{ padding: "7px 16px", borderRadius: 8, background: PRIMARY, color: "#fff", border: "none", fontSize: 13, cursor: (saving || !temEdicao) ? "not-allowed" : "pointer", fontWeight: 500, opacity: (saving || !temEdicao) ? 0.6 : 1 }}>
          {saving ? "Salvando..." : "Salvar"}
        </button>
        <button onClick={test} disabled={testing || !data?.configured} title={!data?.configured ? "Salve o cookie primeiro" : "Abre o Hub num navegador de verdade (~30s)"} style={{ padding: "7px 16px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 13, cursor: (testing || !data?.configured) ? "not-allowed" : "pointer", opacity: (testing || !data?.configured) ? 0.5 : 1 }}>
          {testing ? "Testando (~30s)..." : "Testar acesso ao Hub"}
        </button>
        {data?.configured && data.source !== "env" && (
          <button onClick={clear} disabled={saving} style={{ padding: "7px 16px", borderRadius: 8, border: "0.5px solid var(--danger-border)", background: "var(--danger-bg)", color: "var(--danger-text)", fontSize: 13, cursor: "pointer", marginLeft: "auto" }}>
            Apagar
          </button>
        )}
      </div>

      {data && (data.updatedAt || data.lastCheckAt) && (
        <div style={{ marginTop: 14, paddingTop: 12, borderTop: "0.5px solid var(--color-border-tertiary)", fontSize: 11, color: "var(--color-text-secondary)", lineHeight: 1.6 }}>
          {data.updatedAt && <div>Cookie atualizado em: {new Date(data.updatedAt).toLocaleString("pt-BR")}</div>}
          <div>Tag de afiliado: {data.tag ? <strong>{data.tag}</strong> : "não configurada — a vitrine dos cupons não será lida"}</div>
          {data.lastCheckAt && (
            <div style={{ color: data.lastCheckOk ? undefined : "var(--danger-text)" }}>
              {data.lastCheckOk ? "✓" : "✗"} Última verificação: {new Date(data.lastCheckAt).toLocaleString("pt-BR")}
              {data.lastCheckReason ? ` — ${data.lastCheckReason}` : ""}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// De onde saem as ofertas do Mercado Livre e qual delas enche a cota primeiro.
// Cada mudança salva na hora — são dois checkboxes e um par de opções, não vale
// um botão "Salvar" só pra isso.
function MLSourcesSection() {
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

const RECOMENDADOS = { minRating: 4.0, minSales: 50, minPrice: 20, maxPrice: 0, maxDiscount: 95, minDiscount: 0 };

function MLFiltersSection() {
  const [filters, setFilters] = useState(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);
  const [loadError, setLoadError] = useState(null);

  // Se o GET falha, o formulário NÃO é preenchido: antes ele caía nos valores
  // recomendados, o admin via números plausíveis que não eram os do servidor e
  // podia salvar por cima da configuração real.
  const load = () => {
    adminScraperMLFilters()
      .then(r => { setLoadError(null); setFilters(r.filters); })
      .catch(err => setLoadError(errText(err, "Não foi possível carregar os filtros.")));
  };
  useEffect(() => { load(); }, []);

  if (loadError) {
    return <AlertBanner tone="error" message={loadError} onRetry={load} />;
  }
  if (!filters) {
    return <div style={{ padding: 20, color: "var(--color-text-secondary)", fontSize: 13 }}>Carregando filtros...</div>;
  }

  const set = (key, value) => setFilters(f => ({ ...f, [key]: value }));

  async function save() {
    setSaving(true);
    setMsg(null);
    try {
      const r = await adminScraperMLFiltersSave(filters);
      setFilters(r.filters);
      setMsg({ type: "ok", text: "Filtros salvos! Próximo scraping vai aplicar." });
      setTimeout(() => setMsg(null), 3000);
    } catch (err) {
      setMsg({ type: "err", text: errText(err, "Não foi possível salvar os filtros.") });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: 16, marginBottom: 18 }}>
      <div style={{ fontWeight: 500, marginBottom: 4 }}>Filtros de qualidade</div>
      <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 16 }}>
        Aplicados a cada produto antes de salvar no catálogo. Valor <code>0</code> = sem filtro.
        Recomendados: rating ≥ 4.0, vendas ≥ 50, desconto máx 95%.
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 14 }}>
        <NumField label="Rating mínimo (0 a 5)"  step="0.1" max="5"
          value={filters.minRating}    onChange={v => set("minRating", v)}
          hint="Ex: 4.0 — corta produtos com avaliação baixa" />
        <NumField label="Vendas mínimas"         step="10"
          value={filters.minSales}     onChange={v => set("minSales", v)}
          hint="Ex: 50 — corta produtos sem tração" />
        <NumField label="Preço mínimo (R$)"      step="1"
          value={filters.minPrice}     onChange={v => set("minPrice", v)}
          hint="Ex: 20 — corta produtos muito baratos" />
        <NumField label="Preço máximo (R$)"      step="50"
          value={filters.maxPrice}     onChange={v => set("maxPrice", v)}
          hint="0 = sem teto. Ex: 5000" />
        <NumField label="Desconto máximo (%)"    step="5" max="100"
          value={filters.maxDiscount}  onChange={v => set("maxDiscount", v)}
          hint="Ex: 95 — corta '99% off' fake" />
        <NumField label="Desconto mínimo (%)"    step="5" max="100"
          value={filters.minDiscount}  onChange={v => set("minDiscount", v)}
          hint="Ex: 1 — só itens em promoção. 0 = qualquer um" />
      </div>

      {msg && (
        <div style={{ marginTop: 14, padding: "8px 10px", borderRadius: 8, fontSize: 12, background: msg.type === "ok" ? PRIMARY_LIGHT : "var(--danger-bg)", color: msg.type === "ok" ? PRIMARY_DARK : "var(--danger-text)" }}>
          {msg.text}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <button
          onClick={save}
          disabled={saving}
          style={{ padding: "8px 16px", borderRadius: 8, background: PRIMARY, color: "#fff", border: "none", fontSize: 13, cursor: saving ? "wait" : "pointer", fontWeight: 500, opacity: saving ? 0.6 : 1 }}
        >
          {saving ? "Salvando..." : "Salvar filtros"}
        </button>
        <button
          onClick={() => setFilters({ ...RECOMENDADOS })}
          disabled={saving}
          style={{ padding: "8px 16px", borderRadius: 8, background: "transparent", border: "0.5px solid var(--color-border-secondary)", fontSize: 13, cursor: "pointer" }}
        >
          Aplicar recomendados
        </button>
      </div>
    </div>
  );
}

function NumField({ label, hint, value, onChange, step = "1", max }) {
  // Buffer de texto local: o campo pode ficar vazio/parcial ("", "3.") enquanto o usuário digita,
  // sem que Number("") = 0 force um 0 no estado do pai. O pai só recebe números válidos.
  const fmt = (v) => (v === "" || v == null || Number.isNaN(Number(v))) ? "" : String(Math.round(Number(v) * 1e6) / 1e6);
  const [text, setText] = useState(() => fmt(value));
  const lastNum = useRef(value);
  useEffect(() => {
    // Ressincroniza só quando `value` muda por fora da digitação (reset/carregamento). A comparação
    // aproximada evita o "eco" do próprio onChange e o ruído de float (ex: comissão 0.03 * 100).
    if (Math.abs(Number(value) - Number(lastNum.current)) >= 1e-9) {
      lastNum.current = value;
      setText(fmt(value));
    }
  }, [value]);
  const handleChange = (e) => {
    const t = e.target.value;
    setText(t);
    if (t === "") return;
    const n = Number(t);
    if (!Number.isNaN(n)) { lastNum.current = n; onChange(n); }
  };
  const handleBlur = () => {
    if (text === "" || Number.isNaN(Number(text))) setText(fmt(value));
  };
  return (
    <div>
      <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>{label}</label>
      <input
        type="number"
        min={0}
        max={max}
        step={step}
        value={text}
        onChange={handleChange}
        onBlur={handleBlur}
        style={{ width: "100%", padding: "7px 10px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13, boxSizing: "border-box", fontFamily: "monospace" }}
      />
      {hint && <div style={{ fontSize: 10, color: "var(--color-text-secondary)", marginTop: 3 }}>{hint}</div>}
    </div>
  );
}
