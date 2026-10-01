import { useState, useEffect } from "react";
import { PRIMARY, TEST_URLS } from "../data/constants";
import Badge from "../components/ui/Badge";
import { getAffiliateStatus, saveShopeeAffiliate, clearShopeeAffiliate, testShopeeAffiliate, errText } from "../data/api";
import AlertBanner from "../components/ui/AlertBanner";
import { TUTORIAL_IDS } from "./Tutoriais";

export default function PageAffiliateShopee({ onAffiliateChange, onOpenTutorial }) {
  const [affStatus, setAffStatus] = useState(null);
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [msg, setMsg] = useState(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testUrl, setTestUrl] = useState(TEST_URLS.shopee);

  const [loadError, setLoadError] = useState(null);

  // Ver AffiliateML.jsx: em erro a tela avisa em vez de parecer "nada salvo".
  const load = () => {
    getAffiliateStatus().then(s => {
      setLoadError(null);
      setAffStatus(s);
      if (s.shopee?.appId) setAppId(s.shopee.appId);
      if (onAffiliateChange) onAffiliateChange(s);
    }).catch(err => setLoadError(errText(err, "Não foi possível carregar sua configuração de afiliado.")));
  };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSave() {
    setSaving(true);
    setMsg(null);
    try {
      const s = await saveShopeeAffiliate({ appId: appId.trim(), appSecret: appSecret.trim() });
      setAffStatus(s);
      if (onAffiliateChange) onAffiliateChange(s);
      setAppSecret("");
      setMsg({ type: "ok", text: "Salvo!" });
    } catch (err) {
      setMsg({ type: "err", text: errText(err, "Não foi possível concluir. Tente novamente.") });
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    setMsg(null);
    try {
      const url = testUrl.trim();
      if (!url) {
        setMsg({ type: "err", text: "Cole uma URL de produto da Shopee pra testar." });
        setTesting(false);
        return;
      }
      if (!/shopee\.com\.br/i.test(url) && !/s\.shopee\./i.test(url)) {
        setMsg({ type: "err", text: "URL inválida — precisa ser de shopee.com.br (ou link curto s.shopee.com.br)." });
        setTesting(false);
        return;
      }
      const r = await testShopeeAffiliate(url);
      setMsg({ type: "ok", text: "Funcionou! Link gerado:", link: r.shortUrl });
      const s = await getAffiliateStatus();
      setAffStatus(s);
      if (onAffiliateChange) onAffiliateChange(s);
    } catch (err) {
      setMsg({ type: "err", text: errText(err, "Não foi possível concluir. Tente novamente.") });
    } finally {
      setTesting(false);
    }
  }

  async function handleClear() {
    setSaving(true);
    setMsg(null);
    try {
      const s = await clearShopeeAffiliate();
      setAffStatus(s);
      setAppId("");
      setAppSecret("");
      if (onAffiliateChange) onAffiliateChange(s);
      setMsg({ type: "ok", text: "Configuração apagada." });
    } catch (err) {
      setMsg({ type: "err", text: errText(err, "Não foi possível concluir. Tente novamente.") });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 6 }}>
        <h2 style={{ fontSize: 18, fontWeight: 500, margin: 0 }}>Shopee</h2>
        {onOpenTutorial && (
          <button
            className="hit"
            onClick={() => onOpenTutorial(TUTORIAL_IDS.AFILIADO_SHOPEE)}
            style={{ background: "transparent", border: "none", padding: 0, color: PRIMARY, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}
          >
            ▶ Ver tutorial
          </button>
        )}
      </div>
      <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 20 }}>
        Configure o programa de afiliados para gerar links curtos com sua tag nos envios.
      </div>

      {loadError && <AlertBanner tone="error" message={loadError} onRetry={load} />}

      <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: 16 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4, gap: 8, flexWrap: "wrap" }}>
          <div style={{ fontWeight: 500 }}>Configuração de afiliado</div>
          {affStatus?.shopee && (
            <Badge color={affStatus.shopee.configured ? "green" : "gray"}>
              {affStatus.shopee.configured ? "Configurado" : "Não configurado"}
            </Badge>
          )}
        </div>
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 14, lineHeight: 1.5 }}>
          Quando configurado, todo link da Shopee enviado vira um link curto via a API oficial de afiliados (formato
          {" "}<code style={{ background: "var(--color-background-secondary)", padding: "1px 4px", borderRadius: 4 }}>s.shopee.com.br/...</code>).
          A Shopee usa <strong>App ID</strong> + <strong>Senha</strong> — sem cookie, sem expirar.
        </div>

        <div style={{ marginBottom: 10 }}>
          <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>App ID</label>
          <input
            value={appId}
            onChange={e => setAppId(e.target.value)}
            placeholder="ex: 12345678"
            style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13, boxSizing: "border-box", fontFamily: "monospace" }}
          />
        </div>

        <div>
          <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>
            Senha
            {affStatus?.shopee?.appSecretPreview && (
              <span style={{ marginLeft: 8, color: "var(--color-text-secondary)" }}>
                (atual: <code>{affStatus.shopee.appSecretPreview}</code>)
              </span>
            )}
          </label>
          <div style={{ position: "relative" }}>
            <input
              type={showSecret ? "text" : "password"}
              value={appSecret}
              onChange={e => setAppSecret(e.target.value)}
              placeholder={affStatus?.shopee?.configured ? "Deixe vazio pra manter o atual" : "cole a senha"}
              style={{ width: "100%", padding: "8px 38px 8px 10px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13, boxSizing: "border-box", fontFamily: "monospace" }}
            />
            <button
              type="button"
              onClick={() => setShowSecret(s => !s)}
              className="hit"
              style={{ position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)", padding: "2px 8px", borderRadius: 6, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-primary)", fontSize: 10, cursor: "pointer", color: "var(--color-text-secondary)" }}
            >
              {showSecret ? "ocultar" : "mostrar"}
            </button>
          </div>
          <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 4 }}>
            Pega o App ID e a senha em <a href="https://affiliate.shopee.com.br/openapi" target="_blank" rel="noreferrer" style={{ color: PRIMARY }}>affiliate.shopee.com.br/openapi</a>.
          </div>
        </div>

        {affStatus?.shopee?.configured && (
          <div style={{ marginTop: 14, paddingTop: 12, borderTop: "0.5px solid var(--color-border-tertiary)" }}>
            <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>
              URL de produto pra testar
            </label>
            <input
              value={testUrl}
              onChange={e => setTestUrl(e.target.value)}
              placeholder="https://shopee.com.br/produto-xyz-i.123.456"
              style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 12, boxSizing: "border-box", fontFamily: "monospace" }}
            />
            <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 4 }}>
              Cole o link de um produto da Shopee. O sistema chama a API oficial pra gerar o link curto com sua tag.
            </div>
          </div>
        )}

        {msg && (
          <AlertBanner
            tone={msg.type === "ok" ? "success" : "error"}
            onDismiss={() => setMsg(null)}
            style={{ marginTop: 10, marginBottom: 0 }}
          >
            {msg.text}
            {msg.link && (
              <>
                {" "}
                <a
                  href={msg.link}
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: "inherit", textDecoration: "underline", fontFamily: "monospace", overflowWrap: "anywhere" }}
                >
                  {msg.link}
                </a>
              </>
            )}
          </AlertBanner>
        )}

        <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
          <button
            onClick={handleSave}
            disabled={saving || !appId.trim() || (!affStatus?.shopee?.configured && !appSecret.trim())}
            style={{ padding: "7px 16px", borderRadius: 8, background: PRIMARY, color: "#fff", border: "none", fontSize: 13, cursor: "pointer", fontWeight: 500, opacity: (saving || !appId.trim() || (!affStatus?.shopee?.configured && !appSecret.trim())) ? 0.6 : 1 }}
          >
            {saving ? "Salvando..." : "Salvar"}
          </button>
          <button
            onClick={handleTest}
            disabled={testing || !affStatus?.shopee?.configured || !testUrl.trim()}
            title={!affStatus?.shopee?.configured ? "Salve App ID e senha primeiro" : !testUrl.trim() ? "Cole uma URL de produto pra testar" : "Gera um link de teste"}
            style={{ padding: "7px 16px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 13, cursor: (!affStatus?.shopee?.configured || !testUrl.trim()) ? "not-allowed" : "pointer", opacity: (!affStatus?.shopee?.configured || !testUrl.trim() || testing) ? 0.5 : 1 }}
          >
            {testing ? "Testando..." : "Testar transformação"}
          </button>
          {affStatus?.shopee?.configured && (
            <button onClick={handleClear} disabled={saving} style={{ padding: "7px 16px", borderRadius: 8, border: "0.5px solid var(--danger-border)", background: "var(--danger-bg)", color: "var(--danger-text)", fontSize: 13, cursor: "pointer", marginLeft: "auto" }}>
              Apagar
            </button>
          )}
        </div>

        {affStatus?.shopee && (affStatus.shopee.lastSuccessAt || affStatus.shopee.lastFailureAt) && (
          <div style={{ marginTop: 14, paddingTop: 12, borderTop: "0.5px solid var(--color-border-tertiary)", fontSize: 11, color: "var(--color-text-secondary)", lineHeight: 1.6 }}>
            {affStatus.shopee.lastSuccessAt && <div>✓ Último sucesso: {new Date(affStatus.shopee.lastSuccessAt).toLocaleString("pt-BR")}</div>}
            {affStatus.shopee.lastFailureAt && <div style={{ color: "var(--danger-text)" }}>✗ Última falha: {new Date(affStatus.shopee.lastFailureAt).toLocaleString("pt-BR")} — {affStatus.shopee.lastFailureReason}</div>}
            {affStatus.shopee.updatedAt && <div>Atualizado em: {new Date(affStatus.shopee.updatedAt).toLocaleString("pt-BR")}</div>}
          </div>
        )}
      </div>
    </div>
  );
}
