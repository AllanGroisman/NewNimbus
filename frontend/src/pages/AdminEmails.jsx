// Admin › E-mails — edita o texto dos 17 e-mails que o sistema manda.
//
// O visual do e-mail NÃO é editável aqui: cores, largura e botão vêm do layout
// único do backend. O que se edita é o conteúdo — assunto, título, saudação,
// parágrafos, rótulo do botão e rodapé. A pré-visualização é renderizada pelo
// backend (mesmo código do envio) e mostrada num iframe pra o CSS do e-mail não
// encostar no do painel.

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { PRIMARY, PRIMARY_DARK, PRIMARY_LIGHT } from "../data/constants";
import { useUnsavedGuard } from "../data/navGuard";
import Toggle from "../components/ui/Toggle";
import {
  adminEmailTemplates,
  adminEmailTemplatesSave,
  adminEmailPreview,
  adminEmailTest,
  errText,
} from "../data/api";

// Tokens de cor do index.css. Atenção: --color-surface / --color-border NÃO
// existem — quando usados, o navegador descarta a declaração inteira e o campo
// fica sem borda e sem fundo (foi o que deixava esta tela apagada). Os nomes
// certos são --color-background-* e --color-border-*, como em Settings.jsx.
const cardStyle = { background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: 16 };
const btnPrimary = { background: PRIMARY, color: "#fff", border: "none", borderRadius: 8, padding: "8px 16px", fontSize: 13, fontWeight: 500, cursor: "pointer" };
const btnGhost = { padding: "7px 14px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", color: "var(--color-text-primary)", fontSize: 12, cursor: "pointer" };
const inputStyle = { width: "100%", padding: "8px 10px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", color: "var(--color-text-primary)", fontSize: 13, fontFamily: "inherit", boxSizing: "border-box", outline: "none" };
const textareaStyle = { ...inputStyle, minHeight: 76, lineHeight: 1.5, resize: "vertical" };
const chipStyle = { display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 9px", borderRadius: 12, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-tertiary)", color: "var(--color-text-secondary)", fontSize: 11, cursor: "pointer" };
const labelStyle = { fontSize: 11, fontWeight: 600, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6, display: "block" };
const hintStyle = { fontSize: 11, color: "var(--color-text-secondary)", marginTop: 5, lineHeight: 1.45 };
const codeStyle = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12, padding: "1px 5px", borderRadius: 4, background: "rgba(127,127,127,0.18)" };

const CAMPOS = ["subject", "title", "greeting", "paragraphs", "ctaLabel", "footnote", "tone"];

// Bloco só com os campos editáveis — é o que vai pro backend e o que a
// comparação de "tem alteração não salva" usa.
function limpar(block) {
  const out = {};
  for (const f of CAMPOS) out[f] = f === "paragraphs" ? [...(block.paragraphs || [])] : (block[f] ?? "");
  out.enabled = block.enabled !== false;
  return out;
}

function igual(a, b) {
  return JSON.stringify(limpar(a || {})) === JSON.stringify(limpar(b || {}));
}

// Fora do componente de propósito: definido dentro, o React remontaria o input
// a cada tecla e o cursor pularia pro fim.
// `focusRef` guarda o último campo focado — é onde os chips inserem a variável.
function Campo({ label, hint, multi, valor, onChange, focusRef, style }) {
  const ref = useRef(null);
  const [ativo, setAtivo] = useState(false);
  const Tag = multi ? "textarea" : "input";
  const registrar = () => { focusRef.current = { el: ref.current, get: () => valor, set: onChange }; };
  const base = multi ? textareaStyle : inputStyle;
  return (
    <div style={{ marginBottom: 16, ...style }}>
      {label && <label style={labelStyle}>{label}</label>}
      <Tag
        ref={ref}
        value={valor ?? ""}
        onFocus={() => { registrar(); setAtivo(true); }}
        onBlur={() => setAtivo(false)}
        onChange={e => { registrar(); onChange(e.target.value); }}
        // A borda acesa marca o campo em edição — é nele que o chip de variável
        // insere, então precisa ficar óbvio qual é.
        style={{
          ...base,
          border: ativo ? `1px solid ${PRIMARY}` : base.border,
          background: ativo ? "var(--color-background-primary)" : base.background,
        }}
      />
      {hint && <div style={hintStyle}>{hint}</div>}
    </div>
  );
}

export default function PageAdminEmails() {
  const [meta, setMeta] = useState([]);
  const [groups, setGroups] = useState([]);
  const [defaults, setDefaults] = useState({});
  const [saved, setSaved] = useState({});     // o que está no servidor
  const [drafts, setDrafts] = useState({});   // o que está na tela
  const [sel, setSel] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [aviso, setAviso] = useState(null);
  const [preview, setPreview] = useState(null);
  const [testando, setTestando] = useState(false);

  // Último campo que teve foco — é nele que os chips inserem a variável.
  const focus = useRef(null);

  useEffect(() => {
    (async () => {
      try {
        const r = await adminEmailTemplates();
        setMeta(r.meta || []);
        setGroups(r.groups || []);
        setDefaults(r.defaults || {});
        setSaved(r.templates || {});
        setDrafts(r.templates || {});
        setSel((r.meta || [])[0]?.key || null);
      } catch (err) {
        setError(errText(err, "Não foi possível concluir a ação. Tente novamente."));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const specs = useMemo(() => Object.fromEntries(meta.map(m => [m.key, m])), [meta]);
  const spec = sel ? specs[sel] : null;
  const draft = sel ? drafts[sel] : null;

  const alterados = useMemo(
    () => meta.map(m => m.key).filter(k => !igual(drafts[k], saved[k])),
    [meta, drafts, saved],
  );
  const dirty = alterados.length > 0;

  const setCampo = useCallback((campo, valor) => {
    setDrafts(d => ({ ...d, [sel]: { ...d[sel], [campo]: valor } }));
  }, [sel]);

  // Pré-visualização: o backend renderiza com os valores de exemplo do catálogo.
  useEffect(() => {
    if (!sel || !draft) return;
    const t = setTimeout(async () => {
      try {
        setPreview(await adminEmailPreview(sel, limpar(draft)));
      } catch {
        setPreview(null);
      }
    }, 400);
    return () => clearTimeout(t);
  }, [sel, draft]);

  async function save() {
    setSaving(true);
    setError(null);
    setAviso(null);
    try {
      const r = await adminEmailTemplatesSave(drafts);
      setSaved(r.templates || drafts);
      setDrafts(r.templates || drafts);
      setAviso("Salvo!");
      setTimeout(() => setAviso(null), 2500);
    } catch (err) {
      setError(errText(err, "Não foi possível concluir a ação. Tente novamente."));
      throw err;
    } finally {
      setSaving(false);
    }
  }

  const descartar = useCallback(() => setDrafts(saved), [saved]);
  useUnsavedGuard({ dirty, save, discard: descartar });

  async function enviarTeste() {
    setTestando(true);
    setError(null);
    setAviso(null);
    try {
      const r = await adminEmailTest(sel, limpar(draft));
      setAviso(`Teste enviado para ${r.to}.`);
      setTimeout(() => setAviso(null), 4000);
    } catch (err) {
      setError(errText(err, "Não foi possível concluir a ação. Tente novamente."));
    } finally {
      setTestando(false);
    }
  }

  // Insere {variavel} na posição do cursor do último campo focado.
  function inserirVar(nome) {
    const f = focus.current;
    const token = `{${nome}}`;
    if (!f || !f.el) return;
    const atual = String(f.get() ?? "");
    const start = f.el.selectionStart ?? atual.length;
    const end = f.el.selectionEnd ?? atual.length;
    f.set(atual.slice(0, start) + token + atual.slice(end));
    requestAnimationFrame(() => {
      f.el.focus();
      const pos = start + token.length;
      f.el.setSelectionRange(pos, pos);
    });
  }

  if (loading) {
    return <div style={{ padding: 40, textAlign: "center", color: "var(--color-text-secondary)" }}>Carregando...</div>;
  }

  return (
    <div className="unpad-mobile" style={{ padding: "28px 32px" }}>
      <div style={{ marginBottom: 18 }}>
        <div style={{ fontSize: 20, fontWeight: 600, color: "var(--color-text-primary)" }}>E-mails do sistema</div>
        <div style={{ fontSize: 13, color: "var(--color-text-secondary)", marginTop: 4 }}>
          Todo e-mail que o Nimbus manda está aqui. O visual é o mesmo em todos e não muda por aqui —
          o que se edita é o texto.
        </div>
      </div>

      <div style={{
        display: "flex", gap: 18, flexWrap: "wrap", alignItems: "center",
        background: "var(--info-bg)", border: "0.5px solid var(--info-border)", color: "var(--info-text)",
        borderRadius: 10, padding: "10px 14px", marginBottom: 16, fontSize: 12.5,
      }}>
        <span>Variável: <code style={codeStyle}>{"{nome}"}</code> vira o valor real no envio.</span>
        <span>Negrito: <code style={codeStyle}>*assim*</code>.</span>
        <span>Quebra de linha vira parágrafo novo dentro do mesmo bloco.</span>
      </div>

      {error && (
        <div style={{
          background: "var(--danger-bg)", border: "0.5px solid var(--danger-border)", color: "var(--danger-text)",
          borderRadius: 10, padding: "10px 14px", marginBottom: 16, fontSize: 13,
        }}>
          {error}
        </div>
      )}

      <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
        {/* Lista */}
        <div className="full-mobile" style={{ ...cardStyle, width: 268, flexShrink: 0, padding: "12px 10px", maxHeight: "72vh", overflowY: "auto" }}>
          {groups.map(g => (
            <div key={g.id} style={{ marginBottom: 12 }}>
              <div style={{ ...labelStyle, padding: "0 8px", marginBottom: 4 }}>{g.label}</div>
              {meta.filter(m => m.group === g.id).map(m => {
                const aberto = m.key === sel;
                const desligado = drafts[m.key]?.enabled === false;
                return (
                  <div
                    key={m.key}
                    onClick={() => setSel(m.key)}
                    style={{
                      padding: "7px 9px", borderRadius: 8, fontSize: 13, cursor: "pointer",
                      display: "flex", alignItems: "center", gap: 6, lineHeight: 1.35,
                      background: aberto ? PRIMARY_LIGHT : "transparent",
                      color: aberto ? PRIMARY_DARK : "var(--color-text-secondary)",
                      fontWeight: aberto ? 500 : 400,
                    }}
                  >
                    <span style={{ flex: 1, textDecoration: desligado ? "line-through" : "none", opacity: desligado ? 0.7 : 1 }}>
                      {m.label}
                    </span>
                    {alterados.includes(m.key) && (
                      <span title="alterado, ainda não salvo" style={{ width: 6, height: 6, borderRadius: "50%", background: PRIMARY, flexShrink: 0 }} />
                    )}
                    {desligado && <span title="desligado — não está sendo enviado" style={{ fontSize: 11 }}>⏸</span>}
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        {/* Editor */}
        {spec && draft && (
          <div style={{ ...cardStyle, flex: "1 1 400px", minWidth: "min(360px, 100%)" }}>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 15, fontWeight: 600, color: "var(--color-text-primary)" }}>{spec.label}</div>
                <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 3, lineHeight: 1.45 }}>
                  {spec.description}
                </div>
              </div>
              {spec.canDisable && (
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                  <span style={{ fontSize: 12, color: draft.enabled === false ? "var(--color-text-secondary)" : "var(--color-text-primary)" }}>
                    {draft.enabled === false ? "Desligado" : "Ligado"}
                  </span>
                  <Toggle value={draft.enabled !== false} onChange={v => setCampo("enabled", v)} />
                </div>
              )}
            </div>
            {!spec.canDisable && (
              <div style={{ ...hintStyle, marginTop: 8 }}>
                Este e-mail não pode ser desligado — sem ele ninguém consegue ativar a conta nem recuperar a senha.
              </div>
            )}
            {draft.enabled === false && (
              <div style={{
                marginTop: 10, fontSize: 12, color: "var(--warn-text)", background: "var(--warn-bg)",
                border: "0.5px solid var(--warn-border)", borderRadius: 8, padding: "8px 10px", lineHeight: 1.45,
              }}>
                Desligado: o texto continua guardado, mas este aviso não está sendo enviado a ninguém.
              </div>
            )}

            <div style={{ height: 1, background: "var(--color-border-tertiary)", margin: "16px 0" }} />

            <Campo focusRef={focus} label="Assunto" valor={draft.subject} onChange={v => setCampo("subject", v)} />
            <Campo focusRef={focus} label="Título (dentro do e-mail)" valor={draft.title} onChange={v => setCampo("title", v)} />
            <Campo
              focusRef={focus}
              label="Saudação"
              hint='Vira "Olá, Ana!". Deixe vazio para o e-mail não ter saudação.'
              valor={draft.greeting}
              onChange={v => setCampo("greeting", v)}
            />

            <label style={labelStyle}>Parágrafos</label>
            {(draft.paragraphs || []).map((p, i) => (
              <div key={i} style={{ marginBottom: 10 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                  <span style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>Parágrafo {i + 1}</span>
                  <button
                    style={{
                      border: "none", background: "transparent", color: "var(--color-text-secondary)",
                      fontSize: 15, lineHeight: 1, cursor: "pointer", padding: "2px 4px",
                    }}
                    title="Remover parágrafo"
                    onClick={() => setCampo("paragraphs", draft.paragraphs.filter((_, j) => j !== i))}
                  >
                    ×
                  </button>
                </div>
                <Campo
                  focusRef={focus}
                  multi
                  style={{ marginBottom: 0 }}
                  valor={p}
                  onChange={v => setCampo("paragraphs", draft.paragraphs.map((x, j) => (j === i ? v : x)))}
                />
              </div>
            ))}
            <button
              style={{ ...btnGhost, marginBottom: 18, padding: "6px 12px" }}
              onClick={() => setCampo("paragraphs", [...(draft.paragraphs || []), ""])}
            >
              + parágrafo
            </button>

            <Campo
              focusRef={focus}
              label="Texto do botão"
              hint={
                spec.ctaUrl
                  ? `O botão sempre leva para ${spec.ctaUrl} — o endereço não muda por aqui. Deixe vazio para o e-mail não ter botão.`
                  : "O botão leva para o link com token, gerado na hora do envio. Deixe vazio para o e-mail não ter botão."
              }
              valor={draft.ctaLabel}
              onChange={v => setCampo("ctaLabel", v)}
            />
            <Campo
              focusRef={focus}
              label="Rodapé"
              hint="Letra miúda no fim do e-mail."
              multi
              valor={draft.footnote}
              onChange={v => setCampo("footnote", v)}
            />

            <label style={labelStyle}>Tom</label>
            <div style={{ display: "flex", gap: 8, marginBottom: 18 }}>
              {[["normal", "Normal", "#2563EB"], ["warn", "Aviso", "#B45309"]].map(([v, rotulo, cor]) => {
                const escolhido = (draft.tone === "warn" ? "warn" : "normal") === v;
                return (
                  <button
                    key={v}
                    onClick={() => setCampo("tone", v)}
                    style={{
                      display: "flex", alignItems: "center", gap: 7, padding: "7px 14px", borderRadius: 8,
                      border: `${escolhido ? 1 : 0.5}px solid ${escolhido ? PRIMARY : "var(--color-border-tertiary)"}`,
                      background: escolhido ? PRIMARY_LIGHT : "transparent",
                      color: escolhido ? PRIMARY_DARK : "var(--color-text-secondary)",
                      fontSize: 12.5, cursor: "pointer", fontWeight: escolhido ? 500 : 400,
                    }}
                  >
                    <span style={{ width: 10, height: 10, borderRadius: "50%", background: cor, flexShrink: 0 }} />
                    {rotulo}
                  </button>
                );
              })}
            </div>

            <label style={labelStyle}>Variáveis — clique para inserir no campo em edição</label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 18 }}>
              {spec.variables.map(v => (
                <span
                  key={v.name}
                  style={chipStyle}
                  title={v.condicional
                    ? `${v.desc} — o parágrafo que usar esta variável some quando ela vier vazia`
                    : v.desc}
                  onMouseDown={e => e.preventDefault()}
                  onClick={() => inserirVar(v.name)}
                >
                  {"{" + v.name + "}"}{v.condicional ? " ⓘ" : ""}
                </span>
              ))}
            </div>

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                style={btnGhost}
                onClick={() => setDrafts(d => ({ ...d, [sel]: { ...defaults[sel], enabled: d[sel].enabled } }))}
              >
                Restaurar padrão
              </button>
              <button style={btnGhost} onClick={enviarTeste} disabled={testando}>
                {testando ? "Enviando..." : "Enviar teste pra mim"}
              </button>
            </div>
          </div>
        )}

        {/* Pré-visualização */}
        <div className="static-mobile" style={{ ...cardStyle, flex: "1 1 380px", minWidth: "min(340px, 100%)", position: "sticky", top: 20, padding: 0, overflow: "hidden" }}>
          <div style={{ padding: "12px 14px", borderBottom: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)" }}>
            <div style={{ ...labelStyle, marginBottom: 5 }}>Como o cliente vê (dados de exemplo)</div>
            <div style={{ fontSize: 13, color: "var(--color-text-primary)", wordBreak: "break-word", lineHeight: 1.4 }}>
              <span style={{ color: "var(--color-text-secondary)" }}>Assunto: </span>
              <strong style={{ fontWeight: 600 }}>{preview?.subject || "—"}</strong>
            </div>
          </div>
          {/* Fundo branco fixo: é assim que o e-mail chega na caixa de entrada,
              independente do tema do painel. */}
          <iframe
            title="Pré-visualização do e-mail"
            sandbox=""
            srcDoc={preview?.html || ""}
            style={{ width: "100%", height: 440, border: "none", background: "#fff", display: "block" }}
          />
        </div>
      </div>

      {/* Barra de ação — colada no rodapé pra o Salvar ficar sempre à mão numa
          tela que rola bastante. */}
      <div style={{
        position: "sticky", bottom: 0, marginTop: 16, padding: "12px 0",
        background: "var(--color-background-secondary)",
        borderTop: "0.5px solid var(--color-border-tertiary)",
        display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap",
      }}>
        <button
          style={{ ...btnPrimary, opacity: saving || !dirty ? 0.5 : 1, cursor: saving || !dirty ? "default" : "pointer" }}
          onClick={() => save().catch(() => {})}
          disabled={saving || !dirty}
        >
          {saving ? "Salvando..." : "Salvar"}
        </button>
        {dirty && <button style={btnGhost} onClick={descartar}>Descartar alterações</button>}
        {dirty && (
          <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
            {alterados.length} e-mail{alterados.length > 1 ? "s" : ""} com alteração não salva
          </span>
        )}
        {aviso && (
          <span style={{ fontSize: 13, color: "var(--success-text)", fontWeight: 500 }}>{aviso}</span>
        )}
      </div>
    </div>
  );
}
