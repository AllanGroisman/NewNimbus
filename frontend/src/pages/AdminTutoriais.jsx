import { useState, useEffect, useCallback, useMemo } from "react";
import { PRIMARY, PRIMARY_DARK } from "../data/constants";
import { tutoriaisGet, adminTutoriaisSave, errText } from "../data/api";
import { youtubeEmbedUrl, TutorialBody } from "./Tutoriais";
import Modal from "../components/ui/Modal";

// Admin › Editar Tutoriais (task 102).
//
// Edita a página de Tutoriais que todo mundo vê. Tudo é mexido EM MEMÓRIA e só
// vai pro banco no "Salvar alterações": reordenar, criar e excluir são operações
// de árvore, e salvar item por item deixaria a tela num estado meio-gravado se
// uma das chamadas falhasse. O PUT manda a árvore inteira e a ordem dos arrays
// vira a ordem que aparece pro usuário.

const cardStyle = { background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 10, padding: "20px 24px", marginBottom: 16 };
const btnPrimary = { background: PRIMARY, color: "#fff", border: "none", borderRadius: 6, padding: "8px 16px", fontSize: 13, fontWeight: 600, cursor: "pointer" };
const btnGhost = { background: "transparent", color: "var(--color-text-secondary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 6, padding: "6px 12px", fontSize: 12, cursor: "pointer" };
const btnMini = { ...btnGhost, padding: "3px 8px", fontSize: 12, lineHeight: 1.2 };
const inputStyle = { width: "100%", padding: "8px 10px", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 8, fontSize: 13, fontFamily: "inherit", background: "var(--color-background-secondary)", color: "var(--color-text-primary)", boxSizing: "border-box" };
const textareaStyle = { ...inputStyle, minHeight: 130, lineHeight: 1.5, resize: "vertical" };
const labelStyle = { display: "block", fontSize: 11, fontWeight: 600, color: "var(--color-text-secondary)", marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.3 };

// Ids temporários pra itens ainda não gravados. O backend reconhece o prefixo
// "new-" e cria em vez de atualizar; o React usa como key até o uuid chegar.
let seqNovo = 0;
function idNovo() { return `new-${Date.now()}-${seqNovo++}`; }

function mover(lista, i, delta) {
  const j = i + delta;
  if (j < 0 || j >= lista.length) return lista;
  const copia = [...lista];
  [copia[i], copia[j]] = [copia[j], copia[i]];
  return copia;
}

function Campo({ label, hint, children }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={labelStyle}>{label}</label>
      {children}
      {hint && <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

// ─── Um tutorial ───────────────────────────────────────────────────────────
function TutorialEditor({ tutorial, index, total, onChange, onMove, onDelete }) {
  const [aberto, setAberto] = useState(false);
  const [preview, setPreview] = useState(false);
  const set = (campo) => (e) => onChange({ ...tutorial, [campo]: e.target.value });

  const videoUrl = (tutorial.videoUrl || "").trim();
  const videoOk = !videoUrl || !!youtubeEmbedUrl(videoUrl);
  const pronto = !!(videoUrl || (tutorial.content || "").trim());

  return (
    <div style={{ border: "0.5px solid var(--color-border-tertiary)", borderRadius: 8, marginBottom: 8, background: "var(--color-background-secondary)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px" }}>
        <button onClick={() => setAberto(!aberto)} style={{ ...btnMini, border: "none", background: "transparent", width: 18 }} title={aberto ? "Recolher" : "Expandir"}>
          {aberto ? "▾" : "▸"}
        </button>
        <span style={{ flex: 1, fontSize: 13, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {tutorial.title || <em style={{ color: "var(--color-text-secondary)" }}>(sem título)</em>}
        </span>
        <span style={{ fontSize: 10, padding: "2px 7px", borderRadius: 5, background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", color: pronto ? PRIMARY_DARK : "var(--color-text-secondary)", fontWeight: 500, flexShrink: 0 }}>
          {pronto ? (videoUrl ? "com vídeo" : "com texto") : "Em breve"}
        </span>
        <button onClick={() => onMove(-1)} disabled={index === 0} style={{ ...btnMini, opacity: index === 0 ? 0.35 : 1 }} title="Subir">↑</button>
        <button onClick={() => onMove(1)} disabled={index === total - 1} style={{ ...btnMini, opacity: index === total - 1 ? 0.35 : 1 }} title="Descer">↓</button>
        <button onClick={onDelete} style={{ ...btnMini, color: "var(--color-danger, #c0392b)" }} title="Excluir tutorial">✕</button>
      </div>

      {aberto && (
        <div style={{ padding: "4px 12px 14px", borderTop: "0.5px solid var(--color-border-tertiary)" }}>
          <div style={{ display: "flex", gap: 12, marginTop: 12 }}>
            <div style={{ flex: 3 }}>
              <Campo label="Título">
                <input value={tutorial.title} onChange={set("title")} style={inputStyle} placeholder="Ex: Configurar afiliado da Amazon" />
              </Campo>
            </div>
            <div style={{ flex: 1 }}>
              <Campo label="Duração">
                <input value={tutorial.duration} onChange={set("duration")} style={inputStyle} placeholder="3 min" />
              </Campo>
            </div>
          </div>

          <Campo
            label="Link do vídeo"
            hint={
              videoUrl && !videoOk
                ? "Não reconheci como um link do YouTube — o tutorial vai mostrar um link “Assistir o vídeo” em vez do player."
                : "Cole a URL do YouTube (youtube.com/watch?v=… ou youtu.be/…). Deixe vazio para não mostrar vídeo."
            }
          >
            <input
              value={tutorial.videoUrl}
              onChange={set("videoUrl")}
              style={{ ...inputStyle, borderColor: videoUrl && !videoOk ? "var(--color-danger, #c0392b)" : undefined }}
              placeholder="https://www.youtube.com/watch?v=…"
            />
          </Campo>

          <Campo label="Passo a passo" hint="Texto puro — as quebras de linha são preservadas na página.">
            <textarea value={tutorial.content} onChange={set("content")} style={textareaStyle} placeholder="Escreva o passo a passo que aparece embaixo do vídeo…" />
          </Campo>

          <Campo label="Endereço (slug)" hint="Muda como outras telas linkam este tutorial. Os botões “ver tutorial” das páginas de afiliado apontam para afiliado-ml, afiliado-amazon e afiliado-shopee — renomear esses três quebra aqueles atalhos.">
            <input value={tutorial.slug} onChange={set("slug")} style={{ ...inputStyle, fontFamily: "ui-monospace, monospace", fontSize: 12 }} placeholder="gerado a partir do título" />
          </Campo>

          <button onClick={() => setPreview(!preview)} style={btnGhost}>
            {preview ? "Ocultar prévia" : "Pré-visualizar"}
          </button>
          {preview && (
            <div style={{ marginTop: 12, padding: 14, borderRadius: 8, background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)" }}>
              <TutorialBody tutorial={tutorial} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Uma seção ─────────────────────────────────────────────────────────────
function SectionEditor({ section, index, total, onChange, onMove, onDelete }) {
  const set = (campo) => (e) => onChange({ ...section, [campo]: e.target.value });
  const setTutorials = (tutorials) => onChange({ ...section, tutorials });

  return (
    <div style={cardStyle}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
        <span style={{ fontSize: 18, color: PRIMARY }}>{section.icon}</span>
        <h3 style={{ flex: 1, fontSize: 15, fontWeight: 500, margin: 0 }}>
          {section.title || <em style={{ color: "var(--color-text-secondary)" }}>(seção sem título)</em>}
        </h3>
        <button onClick={() => onMove(-1)} disabled={index === 0} style={{ ...btnMini, opacity: index === 0 ? 0.35 : 1 }} title="Subir seção">↑</button>
        <button onClick={() => onMove(1)} disabled={index === total - 1} style={{ ...btnMini, opacity: index === total - 1 ? 0.35 : 1 }} title="Descer seção">↓</button>
        <button onClick={onDelete} style={{ ...btnGhost, color: "var(--color-danger, #c0392b)" }}>Excluir seção</button>
      </div>

      <div style={{ display: "flex", gap: 12 }}>
        <div style={{ flex: 4 }}>
          <Campo label="Título da seção">
            <input value={section.title} onChange={set("title")} style={inputStyle} placeholder="Ex: Começando" />
          </Campo>
        </div>
        <div style={{ width: 90 }}>
          <Campo label="Ícone">
            <input value={section.icon} onChange={set("icon")} style={{ ...inputStyle, textAlign: "center" }} maxLength={2} placeholder="▶" />
          </Campo>
        </div>
      </div>

      <Campo label="Descrição">
        <input value={section.description} onChange={set("description")} style={inputStyle} placeholder="Uma linha explicando do que trata a seção" />
      </Campo>

      <div style={{ fontSize: 11, fontWeight: 600, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: 0.3, margin: "16px 0 8px" }}>
        Tutoriais ({section.tutorials.length})
      </div>

      {section.tutorials.map((t, i) => (
        <TutorialEditor
          key={t.id}
          tutorial={t}
          index={i}
          total={section.tutorials.length}
          onChange={(novo) => setTutorials(section.tutorials.map((x, j) => (j === i ? novo : x)))}
          onMove={(d) => setTutorials(mover(section.tutorials, i, d))}
          onDelete={() => setTutorials(section.tutorials.filter((_, j) => j !== i))}
        />
      ))}

      <button
        onClick={() => setTutorials([...section.tutorials, { id: idNovo(), slug: "", title: "", duration: "", content: "", videoUrl: "" }])}
        style={{ ...btnGhost, marginTop: 4 }}
      >
        + Novo tutorial
      </button>
    </div>
  );
}

// ─── Página ────────────────────────────────────────────────────────────────
export default function PageAdminTutoriais() {
  // `salvo` é o que está no servidor; `sections` é o que está sendo editado.
  // A comparação entre os dois é o que acende o aviso de "não salvo".
  const [salvo, setSalvo] = useState(null);
  const [sections, setSections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [okMsg, setOkMsg] = useState("");
  const [confirmar, setConfirmar] = useState(null); // índice da seção a excluir

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await tutoriaisGet();
      setSections(r.sections || []);
      setSalvo(JSON.stringify(r.sections || []));
    } catch (err) {
      setError(errText(err, "Não foi possível carregar os tutoriais."));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const dirty = useMemo(() => salvo !== null && JSON.stringify(sections) !== salvo, [sections, salvo]);

  const salvar = async () => {
    setSaving(true); setError(null); setOkMsg("");
    try {
      const r = await adminTutoriaisSave(sections);
      // Recarrega com o que voltou: é aqui que os ids temporários "new-…" viram
      // uuid de verdade e os slugs aparecem já normalizados pelo backend.
      setSections(r.sections || []);
      setSalvo(JSON.stringify(r.sections || []));
      setOkMsg("Tutoriais salvos. A página já está no ar pra todo mundo.");
    } catch (err) {
      setError(errText(err, "Não foi possível salvar os tutoriais."));
    } finally {
      setSaving(false);
    }
  };

  const descartar = () => {
    if (salvo === null) return;
    setSections(JSON.parse(salvo));
    setError(null); setOkMsg("");
  };

  const totalTutoriais = sections.reduce((n, s) => n + s.tutorials.length, 0);

  return (
    <div style={{ maxWidth: 880 }}>
      <h2 style={{ fontSize: 18, fontWeight: 500, marginBottom: 4 }}>Editar Tutoriais</h2>
      <div style={{ fontSize: 13, color: "var(--color-text-secondary)", marginBottom: 18 }}>
        Isto edita a página de Tutoriais que todos os usuários veem. As mudanças só valem depois de salvar.
      </div>

      {loading && (
        <div style={{ ...cardStyle, textAlign: "center", color: "var(--color-text-secondary)", fontSize: 13 }}>
          Carregando…
        </div>
      )}

      {!loading && (
        <>
          {error && (
            <div style={{ ...cardStyle, borderColor: "var(--color-danger, #c0392b)", fontSize: 13, padding: "14px 18px" }}>
              {error}
            </div>
          )}
          {okMsg && !dirty && (
            <div style={{ ...cardStyle, borderColor: PRIMARY, fontSize: 13, padding: "14px 18px", color: PRIMARY_DARK }}>
              {okMsg}
            </div>
          )}

          {sections.map((s, i) => (
            <SectionEditor
              key={s.id}
              section={s}
              index={i}
              total={sections.length}
              onChange={(nova) => setSections(sections.map((x, j) => (j === i ? nova : x)))}
              onMove={(d) => setSections(mover(sections, i, d))}
              onDelete={() => setConfirmar(i)}
            />
          ))}

          <button
            onClick={() => setSections([...sections, { id: idNovo(), slug: "", title: "", description: "", icon: "▶", tutorials: [] }])}
            style={{ ...btnGhost, marginBottom: 20 }}
          >
            + Nova seção
          </button>

          {/* Barra de ação fixa: com a árvore toda aberta o botão de salvar
              ficaria longe demais do que está sendo editado. */}
          <div style={{
            position: "sticky", bottom: 0, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
            padding: "12px 16px", marginTop: 8,
            background: "var(--color-background-primary)",
            border: "0.5px solid var(--color-border-tertiary)", borderRadius: 10,
          }}>
            <span style={{ flex: 1, fontSize: 12, color: "var(--color-text-secondary)" }}>
              {sections.length} seç{sections.length === 1 ? "ão" : "ões"} · {totalTutoriais} tutoria{totalTutoriais === 1 ? "l" : "is"}
              {dirty && <strong style={{ color: PRIMARY_DARK }}> · alterações não salvas</strong>}
            </span>
            {dirty && <button onClick={descartar} disabled={saving} style={btnGhost}>Descartar</button>}
            <button onClick={salvar} disabled={saving || !dirty} style={{ ...btnPrimary, opacity: saving || !dirty ? 0.5 : 1, cursor: saving || !dirty ? "default" : "pointer" }}>
              {saving ? "Salvando…" : "Salvar alterações"}
            </button>
          </div>
        </>
      )}

      {confirmar !== null && (
        <Modal title="Excluir seção" danger onClose={() => setConfirmar(null)}>
          <div style={{ fontSize: 13, lineHeight: 1.6, marginBottom: 18 }}>
            Excluir <strong>{sections[confirmar]?.title || "(sem título)"}</strong> apaga também os{" "}
            {sections[confirmar]?.tutorials.length} tutoriais dentro dela. Isso só vale depois de salvar.
          </div>
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
            <button onClick={() => setConfirmar(null)} style={btnGhost}>Cancelar</button>
            <button
              onClick={() => { setSections(sections.filter((_, j) => j !== confirmar)); setConfirmar(null); }}
              style={{ ...btnPrimary, background: "var(--color-danger, #c0392b)" }}
            >
              Excluir seção
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
