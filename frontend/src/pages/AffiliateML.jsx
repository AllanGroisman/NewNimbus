import { useState, useEffect } from "react";
import { PRIMARY, PRIMARY_DARK, TEST_URLS } from "../data/constants";
import Badge from "../components/ui/Badge";
import { getAffiliateStatus, saveAffiliate, clearAffiliate, testAffiliate, atualizarMLEtiquetas, errText } from "../data/api";
import AlertBanner from "../components/ui/AlertBanner";
import { TUTORIAL_IDS } from "./Tutoriais";

export default function PageAffiliateML({ onAffiliateChange, onOpenTutorial }) {
  const [affStatus, setAffStatus] = useState(null);
  const [affCookie, setAffCookie] = useState("");
  const [affMsg, setAffMsg] = useState(null);
  const [affSaving, setAffSaving] = useState(false);
  const [affTesting, setAffTesting] = useState(false);
  const [affTestUrl, setAffTestUrl] = useState(TEST_URLS.ml);

  const [loadError, setLoadError] = useState(null);

  // Se este GET falha, `affStatus` fica null e a tela não sabe dizer se a
  // integração está configurada — antes isso passava em silêncio e o usuário
  // via a página como se nada estivesse salvo.
  const load = () => {
    getAffiliateStatus().then(s => {
      setLoadError(null);
      setAffStatus(s);
      if (onAffiliateChange) onAffiliateChange(s);
    }).catch(err => setLoadError(errText(err, "Não foi possível carregar sua configuração de afiliado.")));
  };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const aplica = (s) => {
    setAffStatus(s);
    if (onAffiliateChange) onAffiliateChange(s);
  };
  const quantas = (s) => {
    const n = s?.tags?.length || 0;
    return n === 1 ? "1 etiqueta encontrada" : `${n} etiquetas encontradas`;
  };

  // Salvar já testa: o backend só grava o cookie se o ML listar as etiquetas com ele.
  async function handleSave() {
    setAffSaving(true);
    setAffMsg(null);
    try {
      const s = await saveAffiliate({ cookie: affCookie.trim() });
      aplica(s);
      setAffCookie("");
      setAffMsg({ type: "ok", text: `Cookie salvo — ${quantas(s)}.` });
    } catch (err) {
      setAffMsg({ type: "err", text: errText(err, "Não foi possível concluir. Tente novamente.") });
    } finally {
      setAffSaving(false);
    }
  }

  // Testar = rebuscar as etiquetas com o cookie salvo (é o que diz se ele vale) e,
  // com uma URL de produto preenchida, gerar um link de verdade.
  async function handleTest() {
    setAffMsg(null);
    const url = affTestUrl.trim();
    if (url && !/^https?:\/\/.+mercadolivre\.com/i.test(url) && !/^https?:\/\/(merc\.li|mlb\.li)/i.test(url)) {
      setAffMsg({ type: "err", text: "URL inválida — precisa ser de mercadolivre.com ou um link curto do ML." });
      return;
    }
    setAffTesting(true);
    try {
      const s = await atualizarMLEtiquetas();
      aplica(s);
      if (!url) {
        setAffMsg({ type: "ok", text: `Conexão OK — ${quantas(s)}.` });
        return;
      }
      const r = await testAffiliate(url);
      setAffMsg({ type: "ok", text: `Funcionou! ${quantas(s)}. Link gerado:`, link: r.shortUrl });
      setAffStatus(await getAffiliateStatus());
    } catch (err) {
      setAffMsg({ type: "err", text: errText(err, "Não foi possível concluir. Tente novamente.") });
    } finally {
      setAffTesting(false);
    }
  }

  async function handleClear() {
    setAffSaving(true);
    setAffMsg(null);
    try {
      const s = await clearAffiliate();
      aplica(s);
      setAffCookie("");
      setAffMsg({ type: "ok", text: "Configuração apagada." });
    } catch (err) {
      setAffMsg({ type: "err", text: errText(err, "Não foi possível concluir. Tente novamente.") });
    } finally {
      setAffSaving(false);
    }
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 6 }}>
        <h2 style={{ fontSize: 18, fontWeight: 500, margin: 0 }}>Mercado Livre</h2>
        {onOpenTutorial && (
          <button
            className="hit"
            onClick={() => onOpenTutorial(TUTORIAL_IDS.AFILIADO_ML)}
            style={{ background: "transparent", border: "none", padding: 0, color: PRIMARY, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}
          >
            ▶ Ver tutorial
          </button>
        )}
      </div>
      <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 20 }}>
        Cole o cookie da sua conta de afiliado: as etiquetas da conta vêm sozinhas, e cada campanha escolhe com qual delas os links saem.
      </div>

      {loadError && <AlertBanner tone="error" message={loadError} onRetry={load} />}

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
          Quando configurado, todo link do Mercado Livre enviado vira link curto de afiliado, com a etiqueta escolhida na campanha.
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div>
            <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>
              Cookie de sessão {affStatus?.cookieLength ? <span style={{ color: PRIMARY_DARK }}>(salvo: {affStatus.cookieLength} caracteres)</span> : null}
            </label>
            <textarea
              value={affCookie}
              onChange={e => setAffCookie(e.target.value)}
              rows={5}
              placeholder="Cole aqui o cookie copiado pela extensão Extrator Nimbus"
              style={{ width: "100%", padding: "9px 12px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 12, resize: "vertical", boxSizing: "border-box", fontFamily: "monospace" }}
            />
            <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 6, lineHeight: 1.5 }}>
              <strong>Como pegar:</strong> instale a extensão <a href="https://chromewebstore.google.com/detail/extrator-nimbus/jppbabekibjgclmbacibonalflchgdlh" target="_blank" rel="noreferrer" style={{ color: PRIMARY }}>Extrator Nimbus</a> no
              Chrome → entre logado em mercadolivre.com.br/afiliados → clique no ícone da extensão → ela copia o cookie
              pra você → cole aqui.
            </div>
          </div>
        </div>

        {affStatus?.configured && <EtiquetasDaConta status={affStatus} />}

        {affStatus?.configured && (
          <div style={{ marginTop: 14, paddingTop: 12, borderTop: "0.5px solid var(--color-border-tertiary)" }}>
            <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>
              URL de produto pra testar <span style={{ opacity: 0.7 }}>(opcional)</span>
            </label>
            <input
              value={affTestUrl}
              onChange={e => setAffTestUrl(e.target.value)}
              placeholder="https://www.mercadolivre.com.br/algum-produto/p/MLB..."
              style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 12, boxSizing: "border-box", fontFamily: "monospace" }}
            />
            <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 4 }}>
              Com um link de produto aqui, o teste também gera um link curto de verdade (com a etiqueta padrão). A home não funciona — só páginas de produto/oferta.
            </div>
          </div>
        )}

        {affMsg && (
          <AlertBanner
            tone={affMsg.type === "ok" ? "success" : "error"}
            onDismiss={() => setAffMsg(null)}
            style={{ marginTop: 10, marginBottom: 0 }}
          >
            {affMsg.text}
            {affMsg.link && (
              <>
                {" "}
                <a
                  href={affMsg.link}
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: "inherit", textDecoration: "underline", fontFamily: "monospace", overflowWrap: "anywhere" }}
                >
                  {affMsg.link}
                </a>
              </>
            )}
          </AlertBanner>
        )}

        <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
          <button onClick={handleSave} disabled={affSaving || !affCookie.trim()} title={!affCookie.trim() ? "Cole o cookie primeiro" : "Salva o cookie e busca as etiquetas da conta"} style={{ padding: "7px 16px", borderRadius: 8, background: PRIMARY, color: "#fff", border: "none", fontSize: 13, cursor: (affSaving || !affCookie.trim()) ? "not-allowed" : "pointer", fontWeight: 500, opacity: (affSaving || !affCookie.trim()) ? 0.6 : 1 }}>
            {affSaving ? "Testando cookie..." : "Salvar e testar"}
          </button>
          <button onClick={handleTest} disabled={affTesting || !affStatus?.configured} title={!affStatus?.configured ? "Salve o cookie primeiro" : "Rebusca as etiquetas da conta e, com uma URL de produto, gera um link de teste"} style={{ padding: "7px 16px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 13, cursor: !affStatus?.configured ? "not-allowed" : "pointer", opacity: (!affStatus?.configured || affTesting) ? 0.5 : 1 }}>
            {affTesting ? "Testando..." : "Testar conexão"}
          </button>
          {affStatus?.configured && (
            <button onClick={handleClear} disabled={affSaving} style={{ padding: "7px 16px", borderRadius: 8, border: "0.5px solid var(--danger-border)", background: "var(--danger-bg)", color: "var(--danger-text)", fontSize: 13, cursor: "pointer", marginLeft: "auto" }}>
              Apagar
            </button>
          )}
        </div>

        {affStatus && (affStatus.lastSuccessAt || affStatus.lastFailureAt || affStatus.tagsFetchedAt) && (
          <div style={{ marginTop: 14, paddingTop: 12, borderTop: "0.5px solid var(--color-border-tertiary)", fontSize: 11, color: "var(--color-text-secondary)", lineHeight: 1.6 }}>
            {affStatus.lastSuccessAt && <div>✓ Último sucesso: {new Date(affStatus.lastSuccessAt).toLocaleString("pt-BR")}</div>}
            {affStatus.lastFailureAt && <div style={{ color: "var(--danger-text)" }}>✗ Última falha: {new Date(affStatus.lastFailureAt).toLocaleString("pt-BR")} — {affStatus.lastFailureReason}</div>}
            {affStatus.updatedAt && <div>Cookie atualizado em: {new Date(affStatus.updatedAt).toLocaleString("pt-BR")}</div>}
            {affStatus.tagsFetchedAt && <div>Etiquetas buscadas em: {new Date(affStatus.tagsFetchedAt).toLocaleString("pt-BR")}</div>}
          </div>
        )}
      </div>
    </div>
  );
}

// As etiquetas da conta, como vieram do ML na última busca. Só leitura: quem
// escolhe é cada campanha (aba Gerenciar); a padrão é a "em uso" no ML.
function EtiquetasDaConta({ status }) {
  const tags = Array.isArray(status.tags) ? status.tags : [];
  return (
    <div style={{ marginTop: 14, paddingTop: 12, borderTop: "0.5px solid var(--color-border-tertiary)" }}>
      <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8 }}>Etiquetas da conta</div>
      {tags.length === 0 ? (
        <AlertBanner tone="warn" style={{ marginBottom: 0 }}
          message="Clique em Testar conexão para carregar as etiquetas da conta — é delas que cada campanha escolhe a sua." />
      ) : (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {tags.map(t => (
            <span key={t.tag} style={{ padding: "4px 10px", borderRadius: 8, fontSize: 12, fontFamily: "monospace", border: `0.5px solid ${t.tag === status.tag ? PRIMARY : "var(--color-border-tertiary)"}`, color: t.tag === status.tag ? PRIMARY_DARK : "var(--color-text-primary)" }}>
              {t.tag}{t.tag === status.tag ? " · padrão" : ""}
            </span>
          ))}
        </div>
      )}
      <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 8, lineHeight: 1.5 }}>
        Cada campanha escolhe a sua etiqueta na aba <strong>Gerenciar</strong>; quem não escolher usa a padrão (a que está em uso no Mercado Livre).
        Etiqueta nova se cria no{" "}
        <a href="https://www.mercadolivre.com.br/afiliados/adminlabel" target="_blank" rel="noreferrer" style={{ color: PRIMARY }}>Administrador de etiquetas</a> do ML — depois clique em Testar conexão para ela aparecer aqui.
      </div>
    </div>
  );
}
