import { useState, useEffect } from "react";
import { PRIMARY, PRIMARY_DARK, PRIMARY_LIGHT } from "../data/constants";
import Badge from "../components/ui/Badge";
import { getAffiliateStatus, saveAmazonAffiliate, clearAmazonAffiliate, testAmazonAffiliate } from "../data/api";

export default function PageAffiliateAmazon({ onAffiliateChange }) {
  const [affStatus, setAffStatus] = useState(null);
  const [amzTag, setAmzTag] = useState("");
  const [amzMsg, setAmzMsg] = useState(null);
  const [amzSaving, setAmzSaving] = useState(false);
  const [amzTesting, setAmzTesting] = useState(false);
  const [amzTestUrl, setAmzTestUrl] = useState("");

  useEffect(() => {
    getAffiliateStatus().then(s => {
      setAffStatus(s);
      if (s.amazon?.tag) setAmzTag(s.amazon.tag);
      if (onAffiliateChange) onAffiliateChange(s);
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSave() {
    setAmzSaving(true);
    setAmzMsg(null);
    try {
      const s = await saveAmazonAffiliate(amzTag.trim());
      setAffStatus(s);
      if (onAffiliateChange) onAffiliateChange(s);
      setAmzMsg({ type: "ok", text: "Salvo!" });
    } catch (err) {
      setAmzMsg({ type: "err", text: err.message });
    } finally {
      setAmzSaving(false);
    }
  }

  async function handleTest() {
    setAmzTesting(true);
    setAmzMsg(null);
    try {
      const url = amzTestUrl.trim();
      if (!url) {
        setAmzMsg({ type: "err", text: "Cole uma URL de produto da Amazon pra testar." });
        setAmzTesting(false);
        return;
      }
      if (!/amazon\.com/i.test(url) && !/amzn\./i.test(url)) {
        setAmzMsg({ type: "err", text: "URL inválida — precisa ser de amazon.com.br (ou link curto amzn.to)." });
        setAmzTesting(false);
        return;
      }
      const r = await testAmazonAffiliate(url);
      setAmzMsg({ type: "ok", text: "Funcionou! Link gerado:", link: r.shortUrl });
      const s = await getAffiliateStatus();
      setAffStatus(s);
      if (onAffiliateChange) onAffiliateChange(s);
    } catch (err) {
      setAmzMsg({ type: "err", text: err.message });
    } finally {
      setAmzTesting(false);
    }
  }

  async function handleClear() {
    setAmzSaving(true);
    setAmzMsg(null);
    try {
      const s = await clearAmazonAffiliate();
      setAffStatus(s);
      setAmzTag("");
      if (onAffiliateChange) onAffiliateChange(s);
      setAmzMsg({ type: "ok", text: "Configuração apagada." });
    } catch (err) {
      setAmzMsg({ type: "err", text: err.message });
    } finally {
      setAmzSaving(false);
    }
  }

  return (
    <div>
      <h2 style={{ fontSize: 18, fontWeight: 500, marginBottom: 6 }}>Amazon</h2>
      <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 20 }}>
        Configure o programa de afiliados para gerar links curtos com sua TAG nos envios.
      </div>

      <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: 16 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4, gap: 8, flexWrap: "wrap" }}>
          <div style={{ fontWeight: 500 }}>Configuração de afiliado</div>
          {affStatus?.amazon && (
            <Badge color={affStatus.amazon.configured ? "green" : "gray"}>
              {affStatus.amazon.configured ? "Configurado" : "Não configurado"}
            </Badge>
          )}
        </div>
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 14, lineHeight: 1.5 }}>
          Quando configurado, todo link da Amazon enviado vira um link curto no formato
          {" "}<code style={{ background: "var(--color-background-secondary)", padding: "1px 4px", borderRadius: 4 }}>amazon.com.br/dp/ASIN?tag=SUA-TAG</code>.
          Diferente do ML, a Amazon não precisa de cookie — só da TAG.
        </div>

        <div>
          <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>TAG de afiliado</label>
          <input
            value={amzTag}
            onChange={e => setAmzTag(e.target.value)}
            placeholder="ex: pedroguterres-20"
            style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13, boxSizing: "border-box", fontFamily: "monospace" }}
          />
          <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 4 }}>
            Pega em <a href="https://afiliados.amazon.com.br" target="_blank" rel="noreferrer" style={{ color: PRIMARY }}>afiliados.amazon.com.br</a>.
            Costuma terminar em <code>-20</code>.
          </div>
        </div>

        {affStatus?.amazon?.configured && (
          <div style={{ marginTop: 14, paddingTop: 12, borderTop: "0.5px solid var(--color-border-tertiary)" }}>
            <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>
              URL de produto pra testar
            </label>
            <input
              value={amzTestUrl}
              onChange={e => setAmzTestUrl(e.target.value)}
              placeholder="https://www.amazon.com.br/produto-xyz/dp/B0..."
              style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 12, boxSizing: "border-box", fontFamily: "monospace" }}
            />
            <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 4 }}>
              Cole o link de um produto da Amazon. O sistema extrai o ASIN e gera o link curto com sua tag.
            </div>
          </div>
        )}

        {amzMsg && (
          <div style={{ marginTop: 10, padding: "8px 10px", borderRadius: 8, fontSize: 12, background: amzMsg.type === "ok" ? PRIMARY_LIGHT : "#FCEBEB", color: amzMsg.type === "ok" ? PRIMARY_DARK : "#A32D2D", wordBreak: "break-all" }}>
            {amzMsg.text}
            {amzMsg.link && (
              <>
                {" "}
                <a
                  href={amzMsg.link}
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: PRIMARY_DARK, textDecoration: "underline", fontFamily: "monospace" }}
                >
                  {amzMsg.link}
                </a>
              </>
            )}
          </div>
        )}

        <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
          <button onClick={handleSave} disabled={amzSaving || !amzTag.trim()} style={{ padding: "7px 16px", borderRadius: 8, background: PRIMARY, color: "#fff", border: "none", fontSize: 13, cursor: "pointer", fontWeight: 500, opacity: (amzSaving || !amzTag.trim()) ? 0.6 : 1 }}>
            {amzSaving ? "Salvando..." : "Salvar"}
          </button>
          <button onClick={handleTest} disabled={amzTesting || !affStatus?.amazon?.configured || !amzTestUrl.trim()} title={!affStatus?.amazon?.configured ? "Salve a tag primeiro" : !amzTestUrl.trim() ? "Cole uma URL de produto pra testar" : "Gera um link de teste"} style={{ padding: "7px 16px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 13, cursor: (!affStatus?.amazon?.configured || !amzTestUrl.trim()) ? "not-allowed" : "pointer", opacity: (!affStatus?.amazon?.configured || !amzTestUrl.trim() || amzTesting) ? 0.5 : 1 }}>
            {amzTesting ? "Testando..." : "Testar transformação"}
          </button>
          {affStatus?.amazon?.configured && (
            <button onClick={handleClear} disabled={amzSaving} style={{ padding: "7px 16px", borderRadius: 8, border: "0.5px solid #F7C1C1", background: "#FCEBEB", color: "#A32D2D", fontSize: 13, cursor: "pointer", marginLeft: "auto" }}>
              Apagar
            </button>
          )}
        </div>

        {affStatus?.amazon && (affStatus.amazon.lastSuccessAt || affStatus.amazon.lastFailureAt) && (
          <div style={{ marginTop: 14, paddingTop: 12, borderTop: "0.5px solid var(--color-border-tertiary)", fontSize: 11, color: "var(--color-text-secondary)", lineHeight: 1.6 }}>
            {affStatus.amazon.lastSuccessAt && <div>✓ Último sucesso: {new Date(affStatus.amazon.lastSuccessAt).toLocaleString("pt-BR")}</div>}
            {affStatus.amazon.lastFailureAt && <div style={{ color: "#A32D2D" }}>✗ Última falha: {new Date(affStatus.amazon.lastFailureAt).toLocaleString("pt-BR")} — {affStatus.amazon.lastFailureReason}</div>}
            {affStatus.amazon.updatedAt && <div>Tag atualizada em: {new Date(affStatus.amazon.updatedAt).toLocaleString("pt-BR")}</div>}
          </div>
        )}
      </div>
    </div>
  );
}
