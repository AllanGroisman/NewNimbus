import { useState, useEffect } from "react";
import { PRIMARY, PRIMARY_DARK, PRIMARY_LIGHT } from "../data/constants";
import Badge from "../components/ui/Badge";
import { getAffiliateStatus, saveShopeeAffiliate, clearShopeeAffiliate, testShopeeAffiliate } from "../data/api";

export default function PageAffiliateShopee({ onAffiliateChange }) {
  const [affStatus, setAffStatus] = useState(null);
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [msg, setMsg] = useState(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testUrl, setTestUrl] = useState("");

  useEffect(() => {
    getAffiliateStatus().then(s => {
      setAffStatus(s);
      if (s.shopee?.appId) setAppId(s.shopee.appId);
      if (onAffiliateChange) onAffiliateChange(s);
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      setMsg({ type: "err", text: err.message });
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
      setMsg({ type: "err", text: err.message });
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
      setMsg({ type: "err", text: err.message });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <h2 style={{ fontSize: 18, fontWeight: 500, marginBottom: 6 }}>Shopee</h2>
      <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 20 }}>
        Configure o programa de afiliados para gerar links curtos com sua tag nos envios.
      </div>

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
          A Shopee usa <strong>App ID</strong> + <strong>App Secret</strong> — sem cookie, sem expirar.
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
            App Secret
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
              placeholder={affStatus?.shopee?.configured ? "Deixe vazio pra manter o atual" : "cole o App Secret"}
              style={{ width: "100%", padding: "8px 38px 8px 10px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13, boxSizing: "border-box", fontFamily: "monospace" }}
            />
            <button
              type="button"
              onClick={() => setShowSecret(s => !s)}
              style={{ position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)", padding: "2px 8px", borderRadius: 6, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-primary)", fontSize: 10, cursor: "pointer", color: "var(--color-text-secondary)" }}
            >
              {showSecret ? "ocultar" : "mostrar"}
            </button>
          </div>
          <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 4 }}>
            Pega em <a href="https://affiliate.shopee.com.br" target="_blank" rel="noreferrer" style={{ color: PRIMARY }}>affiliate.shopee.com.br</a> → painel do programa de afiliados → API Open.
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
          <div style={{ marginTop: 10, padding: "8px 10px", borderRadius: 8, fontSize: 12, background: msg.type === "ok" ? PRIMARY_LIGHT : "#FCEBEB", color: msg.type === "ok" ? PRIMARY_DARK : "#A32D2D", wordBreak: "break-all" }}>
            {msg.text}
            {msg.link && (
              <>
                {" "}
                <a
                  href={msg.link}
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: PRIMARY_DARK, textDecoration: "underline", fontFamily: "monospace" }}
                >
                  {msg.link}
                </a>
              </>
            )}
          </div>
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
            title={!affStatus?.shopee?.configured ? "Salve App ID e Secret primeiro" : !testUrl.trim() ? "Cole uma URL de produto pra testar" : "Gera um link de teste"}
            style={{ padding: "7px 16px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 13, cursor: (!affStatus?.shopee?.configured || !testUrl.trim()) ? "not-allowed" : "pointer", opacity: (!affStatus?.shopee?.configured || !testUrl.trim() || testing) ? 0.5 : 1 }}
          >
            {testing ? "Testando..." : "Testar transformação"}
          </button>
          {affStatus?.shopee?.configured && (
            <button onClick={handleClear} disabled={saving} style={{ padding: "7px 16px", borderRadius: 8, border: "0.5px solid #F7C1C1", background: "#FCEBEB", color: "#A32D2D", fontSize: 13, cursor: "pointer", marginLeft: "auto" }}>
              Apagar
            </button>
          )}
        </div>

        {affStatus?.shopee && (affStatus.shopee.lastSuccessAt || affStatus.shopee.lastFailureAt) && (
          <div style={{ marginTop: 14, paddingTop: 12, borderTop: "0.5px solid var(--color-border-tertiary)", fontSize: 11, color: "var(--color-text-secondary)", lineHeight: 1.6 }}>
            {affStatus.shopee.lastSuccessAt && <div>✓ Último sucesso: {new Date(affStatus.shopee.lastSuccessAt).toLocaleString("pt-BR")}</div>}
            {affStatus.shopee.lastFailureAt && <div style={{ color: "#A32D2D" }}>✗ Última falha: {new Date(affStatus.shopee.lastFailureAt).toLocaleString("pt-BR")} — {affStatus.shopee.lastFailureReason}</div>}
            {affStatus.shopee.updatedAt && <div>Atualizado em: {new Date(affStatus.shopee.updatedAt).toLocaleString("pt-BR")}</div>}
          </div>
        )}
      </div>
    </div>
  );
}
