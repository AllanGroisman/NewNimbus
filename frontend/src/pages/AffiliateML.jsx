import { useState, useEffect } from "react";
import { PRIMARY, PRIMARY_DARK, TEST_URLS } from "../data/constants";
import Badge from "../components/ui/Badge";
import { getAffiliateStatus, saveAffiliate, clearAffiliate, testAffiliate, getMLEtiquetas, trocarMLEtiqueta, errText } from "../data/api";
import AlertBanner from "../components/ui/AlertBanner";
import { TUTORIAL_IDS } from "./Tutoriais";

export default function PageAffiliateML({ onAffiliateChange, onOpenTutorial, isAdmin = false }) {
  const [affStatus, setAffStatus] = useState(null);
  const [affTag, setAffTag] = useState("");
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
      if (s.tag) setAffTag(s.tag);
      if (onAffiliateChange) onAffiliateChange(s);
    }).catch(err => setLoadError(errText(err, "Não foi possível carregar sua configuração de afiliado.")));
  };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
      setAffMsg({ type: "err", text: errText(err, "Não foi possível concluir. Tente novamente.") });
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
      setAffMsg({ type: "err", text: errText(err, "Não foi possível concluir. Tente novamente.") });
    } finally {
      setAffTesting(false);
    }
  }

  // A troca de etiqueta já salvou a TAG no servidor: só alinha a tela.
  function handleEtiquetaTrocada(s) {
    setAffStatus(s);
    setAffTag(s.tag || "");
    if (onAffiliateChange) onAffiliateChange(s);
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
        Configure o programa de afiliados para gerar links curtos com sua TAG nos envios.
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
          Quando configurado, todo link do Mercado Livre enviado vira link curto de afiliado (com a sua TAG).
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div>
            <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>TAG de afiliado</label>
            <input
              value={affTag}
              onChange={e => setAffTag(e.target.value)}
              placeholder="ex: ab12345678901234"
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

        {isAdmin && affStatus?.configured && (
          <EtiquetaEmUso tagAtual={affStatus.tag} onTrocada={handleEtiquetaTrocada} />
        )}

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
          <button onClick={handleSave} disabled={affSaving || (!affTag.trim() && !affCookie.trim())} style={{ padding: "7px 16px", borderRadius: 8, background: PRIMARY, color: "#fff", border: "none", fontSize: 13, cursor: "pointer", fontWeight: 500, opacity: affSaving ? 0.6 : 1 }}>
            {affSaving ? "Salvando..." : "Salvar"}
          </button>
          <button onClick={handleTest} disabled={affTesting || !affStatus?.configured || !affTestUrl.trim()} title={!affStatus?.configured ? "Salve TAG e cookie primeiro" : !affTestUrl.trim() ? "Cole uma URL de produto pra testar" : "Gera um link de teste pra validar"} style={{ padding: "7px 16px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 13, cursor: (!affStatus?.configured || !affTestUrl.trim()) ? "not-allowed" : "pointer", opacity: (!affStatus?.configured || !affTestUrl.trim() || affTesting) ? 0.5 : 1 }}>
            {affTesting ? "Testando..." : "Testar conexão"}
          </button>
          {affStatus?.configured && (
            <button onClick={handleClear} disabled={affSaving} style={{ padding: "7px 16px", borderRadius: 8, border: "0.5px solid var(--danger-border)", background: "var(--danger-bg)", color: "var(--danger-text)", fontSize: 13, cursor: "pointer", marginLeft: "auto" }}>
              Apagar
            </button>
          )}
        </div>

        {affStatus && (affStatus.lastSuccessAt || affStatus.lastFailureAt) && (
          <div style={{ marginTop: 14, paddingTop: 12, borderTop: "0.5px solid var(--color-border-tertiary)", fontSize: 11, color: "var(--color-text-secondary)", lineHeight: 1.6 }}>
            {affStatus.lastSuccessAt && <div>✓ Último sucesso: {new Date(affStatus.lastSuccessAt).toLocaleString("pt-BR")}</div>}
            {affStatus.lastFailureAt && <div style={{ color: "var(--danger-text)" }}>✗ Última falha: {new Date(affStatus.lastFailureAt).toLocaleString("pt-BR")} — {affStatus.lastFailureReason}</div>}
            {affStatus.updatedAt && <div>Cookie atualizado em: {new Date(affStatus.updatedAt).toLocaleString("pt-BR")}</div>}
          </div>
        )}
      </div>
    </div>
  );
}

// Só admin: as etiquetas da conta ML (as mesmas do "Administrador de etiquetas"
// do ML) e a troca da "em uso". A troca vale no ML e na TAG salva aqui — o
// backend só grava a TAG depois que o ML aceitou.
function EtiquetaEmUso({ tagAtual, onTrocada }) {
  const [tags, setTags] = useState(null);   // null = lista ainda não buscada
  const [escolhida, setEscolhida] = useState("");
  const [carregando, setCarregando] = useState(false);
  const [trocando, setTrocando] = useState(false);
  const [msg, setMsg] = useState(null);

  async function carregar() {
    setCarregando(true);
    setMsg(null);
    try {
      const r = await getMLEtiquetas();
      setTags(r.tags);
      const padrao = r.tags.find(t => t.tag === r.current) || r.tags.find(t => t.inUse) || r.tags[0];
      setEscolhida(padrao?.tag || "");
    } catch (err) {
      setMsg({ type: "err", text: errText(err, "Não foi possível buscar as etiquetas no Mercado Livre.") });
    } finally {
      setCarregando(false);
    }
  }

  async function trocar() {
    setTrocando(true);
    setMsg(null);
    try {
      const r = await trocarMLEtiqueta(escolhida);
      setTags(r.tags);
      onTrocada(r.status);
      setMsg({ type: "ok", text: `Etiqueta trocada — os próximos links saem com ${r.current}.` });
    } catch (err) {
      setMsg({ type: "err", text: errText(err, "Não foi possível trocar a etiqueta.") });
    } finally {
      setTrocando(false);
    }
  }

  const emUsoNoML = tags?.find(t => t.inUse)?.tag || null;
  const foraDaConta = !!(tags && tagAtual && !tags.some(t => t.tag === tagAtual));
  // Nada a fazer quando a escolhida já é a TAG daqui E a em uso no ML.
  const semMudanca = !escolhida || (escolhida === tagAtual && escolhida === emUsoNoML);

  const btnSecundario = (off) => ({ padding: "7px 16px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 13, cursor: off ? "not-allowed" : "pointer", opacity: off ? 0.5 : 1 });

  return (
    <div style={{ marginTop: 14, paddingTop: 12, borderTop: "0.5px solid var(--color-border-tertiary)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <div style={{ fontSize: 13 }}>
          Etiqueta em uso: <strong style={{ fontFamily: "monospace" }}>{tagAtual || "—"}</strong>
        </div>
        {tags === null && (
          <button onClick={carregar} disabled={carregando} style={btnSecundario(carregando)}>
            {carregando ? "Buscando no ML..." : "Trocar etiqueta"}
          </button>
        )}
      </div>

      {tags !== null && tags.length === 0 && (
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 8 }}>
          Esta conta não tem etiquetas no Mercado Livre.
        </div>
      )}

      {tags !== null && tags.length > 0 && (
        <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
          <select
            aria-label="Etiqueta"
            value={escolhida}
            onChange={e => setEscolhida(e.target.value)}
            disabled={trocando}
            style={{ flex: "1 1 180px", minWidth: 0, padding: "8px 10px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13, fontFamily: "monospace" }}
          >
            {tags.map(t => (
              <option key={t.tag} value={t.tag}>{t.tag}{t.inUse ? " (em uso no ML)" : ""}</option>
            ))}
          </select>
          <button onClick={trocar} disabled={trocando || semMudanca} style={{ padding: "7px 16px", borderRadius: 8, background: PRIMARY, color: "#fff", border: "none", fontSize: 13, fontWeight: 500, cursor: (trocando || semMudanca) ? "not-allowed" : "pointer", opacity: (trocando || semMudanca) ? 0.6 : 1 }}>
            {trocando ? "Trocando..." : "Usar esta etiqueta"}
          </button>
        </div>
      )}

      {foraDaConta && (
        <AlertBanner tone="warn" style={{ marginTop: 10, marginBottom: 0 }}
          message={`A TAG salva (${tagAtual}) não está entre as etiquetas desta conta — os links podem sair sem comissão.`} />
      )}
      {emUsoNoML && tagAtual && emUsoNoML !== tagAtual && !foraDaConta && (
        <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 6 }}>
          No Mercado Livre a etiqueta em uso é <strong>{emUsoNoML}</strong>.
        </div>
      )}

      {msg && (
        <AlertBanner tone={msg.type === "ok" ? "success" : "error"} message={msg.text} onDismiss={() => setMsg(null)} style={{ marginTop: 10, marginBottom: 0 }} />
      )}

      <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 6, lineHeight: 1.5 }}>
        A troca vale aqui e no Mercado Livre (inclusive no link gerado pelo app e pela barra do ML). Etiqueta nova se cria no{" "}
        <a href="https://www.mercadolivre.com.br/afiliados/adminlabel" target="_blank" rel="noreferrer" style={{ color: PRIMARY }}>Administrador de etiquetas</a> do ML.
      </div>
    </div>
  );
}
