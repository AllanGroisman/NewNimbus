import { useState, useEffect } from "react";
import { PRIMARY, PRIMARY_DARK, PRIMARY_LIGHT, TEST_URLS } from "../data/constants";
import Badge from "../components/ui/Badge";
import { getAffiliateStatus, saveAffiliate, clearAffiliate, testAffiliate } from "../data/api";

export default function PageAffiliateML({ onAffiliateChange }) {
  const [affStatus, setAffStatus] = useState(null);
  const [affTag, setAffTag] = useState("");
  const [affCookie, setAffCookie] = useState("");
  const [affMsg, setAffMsg] = useState(null);
  const [affSaving, setAffSaving] = useState(false);
  const [affTesting, setAffTesting] = useState(false);
  const [affTestUrl, setAffTestUrl] = useState(TEST_URLS.ml);

  useEffect(() => {
    getAffiliateStatus().then(s => {
      setAffStatus(s);
      if (s.tag) setAffTag(s.tag);
      if (onAffiliateChange) onAffiliateChange(s);
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSave() {
    setAffSaving(true);
    setAffMsg(null);
    try {
      const payload = {};
      if (affTag.trim()) payload.tag = affTag.trim();
      if (affCookie.trim()) payload.cookie = affCookie.trim();
      const s = await saveAffiliate(payload);
      setAffStatus(s);
      setAffCookie("");
      if (onAffiliateChange) onAffiliateChange(s);
      setAffMsg({ type: "ok", text: "Salvo!" });
    } catch (err) {
      setAffMsg({ type: "err", text: err.message });
    } finally {
      setAffSaving(false);
    }
  }

  async function handleTest() {
    setAffTesting(true);
    setAffMsg(null);
    try {
      const url = affTestUrl.trim();
      if (!url) {
        setAffMsg({ type: "err", text: "Cole uma URL de produto do Mercado Livre pra testar." });
        setAffTesting(false);
        return;
      }
      if (!/^https?:\/\/.+mercadolivre\.com/i.test(url) && !/^https?:\/\/(merc\.li|mlb\.li)/i.test(url)) {
        setAffMsg({ type: "err", text: "URL inválida — precisa ser de mercadolivre.com ou um link curto do ML." });
        setAffTesting(false);
        return;
      }
      const r = await testAffiliate(url);
      setAffMsg({ type: "ok", text: "Funcionou! Link gerado:", link: r.shortUrl });
      const s = await getAffiliateStatus();
      setAffStatus(s);
    } catch (err) {
      setAffMsg({ type: "err", text: err.message });
    } finally {
      setAffTesting(false);
    }
  }

  async function handleClear() {
    setAffSaving(true);
    setAffMsg(null);
    try {
      const s = await clearAffiliate();
      setAffStatus(s);
      setAffTag(""); setAffCookie("");
      if (onAffiliateChange) onAffiliateChange(s);
      setAffMsg({ type: "ok", text: "Configuração apagada." });
    } catch (err) {
      setAffMsg({ type: "err", text: err.message });
    } finally {
      setAffSaving(false);
    }
  }

  return (
    <div>
      <h2 style={{ fontSize: 18, fontWeight: 500, marginBottom: 6 }}>Mercado Livre</h2>
      <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 20 }}>
        Configure o programa de afiliados para gerar links curtos com sua TAG nos envios.
      </div>

      <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: 16 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4, gap: 8, flexWrap: "wrap" }}>
          <div style={{ fontWeight: 500 }}>Configuração de afiliado</div>
          {affStatus && (
            <Badge color={affStatus.healthy ? "green" : (affStatus.configured ? "amber" : "gray")}>
              {!affStatus.configured ? "Não configurado" : affStatus.healthy ? "OK" : "Possível erro"}
            </Badge>
          )}
        </div>
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 14, lineHeight: 1.5 }}>
          Quando configurado, todo link do Mercado Livre enviado vira link curto de afiliado (com a sua TAG).
          O <strong>cookie expira</strong> de tempos em tempos — quando os envios pararem de gerar comissão, atualize aqui.
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div>
            <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>TAG de afiliado</label>
            <input
              value={affTag}
              onChange={e => setAffTag(e.target.value)}
              placeholder="ex: pb20260221170529"
              style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13, boxSizing: "border-box", fontFamily: "monospace" }}
            />
            <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 4 }}>
              Pega em <a href="https://www.mercadolivre.com.br/afiliados" target="_blank" rel="noreferrer" style={{ color: PRIMARY }}>mercadolivre.com.br/afiliados</a>.
            </div>
          </div>

          <div>
            <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>
              Cookie de sessão {affStatus?.cookieLength ? <span style={{ color: PRIMARY_DARK }}>(salvo: {affStatus.cookieLength} caracteres)</span> : null}
            </label>
            <textarea
              value={affCookie}
              onChange={e => setAffCookie(e.target.value)}
              rows={5}
              placeholder="Cole aqui o conteúdo de document.cookie do mercadolivre.com.br/afiliados"
              style={{ width: "100%", padding: "9px 12px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 12, resize: "vertical", boxSizing: "border-box", fontFamily: "monospace" }}
            />
            <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 6, lineHeight: 1.5 }}>
              <strong>Como pegar:</strong> entre logado em mercadolivre.com.br/afiliados → abra o DevTools (F12) →
              Console → digite <code style={{ background: "var(--color-background-secondary)", padding: "1px 4px", borderRadius: 4 }}>document.cookie</code>
              → copie a saída inteira e cole aqui.
              <br/>O cookie nunca sai do servidor e não é commitado.
            </div>
          </div>
        </div>

        {affStatus?.configured && (
          <div style={{ marginTop: 14, paddingTop: 12, borderTop: "0.5px solid var(--color-border-tertiary)" }}>
            <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>
              URL de produto pra testar
            </label>
            <input
              value={affTestUrl}
              onChange={e => setAffTestUrl(e.target.value)}
              placeholder="https://www.mercadolivre.com.br/algum-produto/p/MLB..."
              style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 12, boxSizing: "border-box", fontFamily: "monospace" }}
            />
            <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 4 }}>
              Cole o link de qualquer produto do Mercado Livre. A home não funciona — só páginas de produto/oferta geram link curto.
            </div>
          </div>
        )}

        {affMsg && (
          <div style={{ marginTop: 10, padding: "8px 10px", borderRadius: 8, fontSize: 12, background: affMsg.type === "ok" ? PRIMARY_LIGHT : "#FCEBEB", color: affMsg.type === "ok" ? PRIMARY_DARK : "#A32D2D", wordBreak: "break-all" }}>
            {affMsg.text}
            {affMsg.link && (
              <>
                {" "}
                <a
                  href={affMsg.link}
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: PRIMARY_DARK, textDecoration: "underline", fontFamily: "monospace" }}
                >
                  {affMsg.link}
                </a>
              </>
            )}
          </div>
        )}

        <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
          <button onClick={handleSave} disabled={affSaving || (!affTag.trim() && !affCookie.trim())} style={{ padding: "7px 16px", borderRadius: 8, background: PRIMARY, color: "#fff", border: "none", fontSize: 13, cursor: "pointer", fontWeight: 500, opacity: affSaving ? 0.6 : 1 }}>
            {affSaving ? "Salvando..." : "Salvar"}
          </button>
          <button onClick={handleTest} disabled={affTesting || !affStatus?.configured || !affTestUrl.trim()} title={!affStatus?.configured ? "Salve TAG e cookie primeiro" : !affTestUrl.trim() ? "Cole uma URL de produto pra testar" : "Gera um link de teste pra validar"} style={{ padding: "7px 16px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 13, cursor: (!affStatus?.configured || !affTestUrl.trim()) ? "not-allowed" : "pointer", opacity: (!affStatus?.configured || !affTestUrl.trim() || affTesting) ? 0.5 : 1 }}>
            {affTesting ? "Testando..." : "Testar conexão"}
          </button>
          {affStatus?.configured && (
            <button onClick={handleClear} disabled={affSaving} style={{ padding: "7px 16px", borderRadius: 8, border: "0.5px solid #F7C1C1", background: "#FCEBEB", color: "#A32D2D", fontSize: 13, cursor: "pointer", marginLeft: "auto" }}>
              Apagar
            </button>
          )}
        </div>

        {affStatus && (affStatus.lastSuccessAt || affStatus.lastFailureAt) && (
          <div style={{ marginTop: 14, paddingTop: 12, borderTop: "0.5px solid var(--color-border-tertiary)", fontSize: 11, color: "var(--color-text-secondary)", lineHeight: 1.6 }}>
            {affStatus.lastSuccessAt && <div>✓ Último sucesso: {new Date(affStatus.lastSuccessAt).toLocaleString("pt-BR")}</div>}
            {affStatus.lastFailureAt && <div style={{ color: "#A32D2D" }}>✗ Última falha: {new Date(affStatus.lastFailureAt).toLocaleString("pt-BR")} — {affStatus.lastFailureReason}</div>}
            {affStatus.updatedAt && <div>Cookie atualizado em: {new Date(affStatus.updatedAt).toLocaleString("pt-BR")}</div>}
          </div>
        )}
      </div>
    </div>
  );
}
