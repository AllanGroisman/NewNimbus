import { useEffect, useMemo, useRef, useState } from "react";
import { adminDlTemplates, adminDlTemplateSave, adminDlTemplateRemove, errText } from "../../../data/api";
import { PRIMARY } from "../../../data/constants";
import {
  CANVAS, FONTS, emptyTemplate, frameSize, hitTest, layerBox,
  loadImages, newLayer, paintOverlay, videoPresets, videoRect,
} from "./overlay";
import {
  botaoPrimario, botaoSecundario, chipStyle, hintStyle,
  inputStyle, labelStyle, modalBackdrop, modalCard,
} from "./downloaderEstilos";

const clone = (o) => JSON.parse(JSON.stringify(o));

// A thumbnail fica num <img> atrás do canvas, nunca desenhada dentro dele: uma
// imagem de outro domínio contamina o canvas e faria o toDataURL() estourar.
function Preview({ template, title, thumbnail, sel, onSel, onMove }) {
  const ref = useRef(null);
  const drag = useRef(null);
  const [images, setImages] = useState(() => new Map());
  const [W, H] = frameSize(template);
  const rect = videoRect(template);

  const srcKey = (template.layers || []).filter((l) => l.type === "image").map((l) => l.src).join("|");
  useEffect(() => {
    let live = true;
    loadImages(template).then((m) => live && setImages(m));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [srcKey]);

  useEffect(() => {
    const ctx = ref.current?.getContext("2d");
    if (!ctx) return;
    paintOverlay(ctx, template, { title, images });
    // A moldura da seleção entra só aqui: o PNG exportado nasce noutro canvas.
    const l = template.layers?.[sel];
    if (!l) return;
    const b = layerBox(ctx, l, { title });
    ctx.save();
    ctx.strokeStyle = PRIMARY.startsWith("var") ? "#cd6f04" : PRIMARY;
    ctx.lineWidth = 4;
    ctx.setLineDash([14, 10]);
    ctx.strokeRect(b.x, b.y, b.w, b.h);
    ctx.restore();
  }, [template, title, images, sel]);

  const toFrame = (e) => {
    const r = ref.current.getBoundingClientRect();
    return [(e.clientX - r.left) * (W / r.width), (e.clientY - r.top) * (H / r.height)];
  };

  const down = (e) => {
    const [x, y] = toFrame(e);
    const i = hitTest(ref.current.getContext("2d"), template, x, y, { title });
    onSel(i);
    if (i < 0) return;
    drag.current = { i, dx: x - template.layers[i].x, dy: y - template.layers[i].y };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const move = (e) => {
    if (!drag.current) return;
    const [x, y] = toFrame(e);
    onMove(drag.current.i, Math.round(x - drag.current.dx), Math.round(y - drag.current.dy));
  };

  return (
    <div style={{
      position: "relative", width: "100%", maxWidth: H > W ? 290 : 460,
      aspectRatio: `${W} / ${H}`, background: "#000",
      borderRadius: 8, overflow: "hidden", flexShrink: 0,
    }}>
      {thumbnail && (
        <img
          src={thumbnail}
          alt=""
          referrerPolicy="no-referrer"
          style={{
            position: "absolute", left: 0, width: "100%",
            top: `${(rect.y / H) * 100}%`, height: `${(rect.h / H) * 100}%`,
            objectFit: "cover",
          }}
        />
      )}
      <canvas
        ref={ref}
        width={W}
        height={H}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={() => { drag.current = null; }}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", cursor: "grab", touchAction: "none" }}
      />
    </div>
  );
}

const Field = ({ label, children }) => (
  <label style={{ display: "block" }}>
    <span style={labelStyle}>{label}</span>
    {children}
  </label>
);

const Num = ({ value, onChange, step = 1 }) => (
  <input type="number" step={step} value={value ?? 0} style={inputStyle}
    onChange={(e) => onChange(Number(e.target.value))} />
);

const Cor = ({ value, onChange }) => (
  <input type="color" value={value || "#000000"} style={{ ...inputStyle, padding: 2, height: 34 }}
    onChange={(e) => onChange(e.target.value)} />
);

const row = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 };

export default function TemplateEditor({ templates, refVideo, onClose, onSaved }) {
  const [draft, setDraft] = useState(() => clone(templates[0] || emptyTemplate()));
  const [sel, setSel] = useState(-1);
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState(null);

  const layer = draft.layers?.[sel] || null;
  const presets = useMemo(() => videoPresets(draft.format), [draft.format]);
  const rect = videoRect(draft);
  const [, H] = frameSize(draft);

  const setLayers = (fn) => setDraft((d) => ({ ...d, layers: fn(d.layers || []) }));
  const patch = (i, obj) => setLayers((ls) => ls.map((l, k) => (k === i ? { ...l, ...obj } : l)));
  const setVideo = (obj) => setDraft((d) => ({ ...d, video: { ...d.video, ...obj } }));

  const add = (type) => {
    setLayers((ls) => [...ls, newLayer(type, draft)]);
    setSel((draft.layers || []).length);
  };

  const mover = (i, dir) => {
    const j = i + dir;
    if (j < 0 || j >= draft.layers.length) return;
    setLayers((ls) => { const n = [...ls]; [n[i], n[j]] = [n[j], n[i]]; return n; });
    setSel(j);
  };

  const carregarLogo = (i, file) => {
    if (!file) return;
    const reader = new FileReader();
    // data-URL: o logo viaja dentro do próprio template, sem pasta de uploads.
    reader.onload = () => patch(i, { src: reader.result });
    reader.readAsDataURL(file);
  };

  const trocarFormato = (format) => setDraft((d) => ({
    ...d, format, video: { ...d.video, top: 0, height: CANVAS[format][1] },
  }));

  const salvar = async () => {
    setBusy(true);
    setErro(null);
    try {
      const id = draft.id || crypto.randomUUID();
      await adminDlTemplateSave(id, draft);
      const { templates: lista } = await adminDlTemplates();
      onSaved(lista, id);
      setDraft(clone(lista.find((t) => t.id === id) || draft));
    } catch (err) {
      setErro(errText(err, "Não foi possível salvar o template."));
    } finally {
      setBusy(false);
    }
  };

  const excluir = async () => {
    if (!draft.id) return;
    setBusy(true);
    try {
      await adminDlTemplateRemove(draft.id);
      const { templates: lista } = await adminDlTemplates();
      onSaved(lista, null);
      setDraft(clone(lista[0] || emptyTemplate()));
      setSel(-1);
    } catch (err) {
      setErro(errText(err, "Não foi possível excluir o template."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={modalBackdrop} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div style={modalCard}>
        <div style={{
          display: "flex", alignItems: "center", gap: 10, padding: "12px 16px",
          borderBottom: "0.5px solid var(--color-border-tertiary)",
        }}>
          <div style={{ fontSize: 15, fontWeight: 600 }}>🎨 Templates</div>
          <select
            value={draft.id || ""}
            onChange={(e) => {
              setDraft(clone(templates.find((t) => t.id === e.target.value) || emptyTemplate()));
              setSel(-1);
            }}
            style={{ ...inputStyle, width: "auto", minWidth: 180 }}
          >
            {!draft.id && <option value="">{draft.name}</option>}
            {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <button type="button" style={botaoSecundario} onClick={() => { setDraft(emptyTemplate(draft.format)); setSel(-1); }}>
            + Novo
          </button>
          <button type="button" style={botaoSecundario} onClick={() => setDraft((d) => ({ ...clone(d), id: undefined, name: `${d.name} (cópia)` }))}>
            Duplicar
          </button>
          <button type="button" style={{ ...botaoSecundario, marginLeft: "auto" }} onClick={onClose}>Fechar</button>
        </div>

        <div style={{ display: "flex", gap: 16, padding: 16, overflowY: "auto", flexWrap: "wrap" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "center" }}>
            <Preview
              template={draft}
              title={refVideo?.title || "Título do vídeo de exemplo"}
              thumbnail={refVideo?.thumbnail}
              sel={sel}
              onSel={setSel}
              onMove={(i, x, y) => patch(i, { x, y })}
            />
            <span style={{ ...hintStyle, textAlign: "center" }}>
              Arraste as camadas na prévia.<br />O fundo é a miniatura do vídeo.
            </span>
          </div>

          <div style={{ flex: 1, minWidth: 300, display: "flex", flexDirection: "column", gap: 14 }}>
            <div>
              <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 8, flexWrap: "wrap" }}>
                <span style={hintStyle}>Formato:</span>
                <button type="button" style={chipStyle({ active: draft.format !== "horizontal" })} onClick={() => trocarFormato("vertical")}>Vertical 9:16</button>
                <button type="button" style={chipStyle({ active: draft.format === "horizontal" })} onClick={() => trocarFormato("horizontal")}>Horizontal 16:9</button>
              </div>
              <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
                <span style={hintStyle}>Vídeo:</span>
                {presets.map((p) => (
                  <button key={p.label} type="button" onClick={() => setVideo(p.video)}
                    style={chipStyle({ active: rect.y === p.video.top && rect.h === p.video.height })}>
                    {p.label}
                  </button>
                ))}
              </div>
              <div style={row}>
                <Field label="Topo do vídeo"><Num value={draft.video?.top} onChange={(v) => setVideo({ top: v })} step={2} /></Field>
                <Field label={`Altura do vídeo (máx ${H})`}><Num value={draft.video?.height} onChange={(v) => setVideo({ height: v })} step={2} /></Field>
                <Field label="Cor das barras"><Cor value={draft.video?.background} onChange={(v) => setVideo({ background: v })} /></Field>
                <Field label="Encaixe">
                  <select value={draft.video?.fit || "cover"} onChange={(e) => setVideo({ fit: e.target.value })} style={inputStyle}>
                    <option value="cover">Preencher (corta as sobras)</option>
                    <option value="contain">Caber inteiro (deixa sobra)</option>
                  </select>
                </Field>
              </div>
            </div>

            <div>
              <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 8, flexWrap: "wrap" }}>
                <span style={hintStyle}>Camadas:</span>
                <button type="button" style={botaoSecundario} onClick={() => add("box")}>+ Faixa</button>
                <button type="button" style={botaoSecundario} onClick={() => add("text")}>+ Texto</button>
                <button type="button" style={botaoSecundario} onClick={() => add("image")}>+ Logo</button>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {(draft.layers || []).map((l, i) => (
                  <div key={i} style={{
                    display: "flex", alignItems: "center", gap: 6, padding: "5px 8px", borderRadius: 8,
                    background: i === sel ? "var(--color-background-secondary)" : "transparent",
                    border: `1px solid ${i === sel ? PRIMARY : "transparent"}`, cursor: "pointer", fontSize: 12,
                  }} onClick={() => setSel(i)}>
                    <span>{l.type === "box" ? "▭" : l.type === "text" ? "T" : "🖼"}</span>
                    <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {l.type === "text" ? l.text || "(vazio)" : l.type === "box" ? "Faixa" : "Logo"}
                    </span>
                    <button type="button" title="Subir" style={botaoSecundario} onClick={(e) => { e.stopPropagation(); mover(i, -1); }}>↑</button>
                    <button type="button" title="Descer" style={botaoSecundario} onClick={(e) => { e.stopPropagation(); mover(i, 1); }}>↓</button>
                    <button type="button" title="Excluir" style={botaoSecundario} onClick={(e) => { e.stopPropagation(); setLayers((ls) => ls.filter((_, k) => k !== i)); setSel(-1); }}>✕</button>
                  </div>
                ))}
                {!(draft.layers || []).length && <span style={hintStyle}>Nenhuma camada ainda.</span>}
              </div>
            </div>

            {layer && <Inspector layer={layer} onPatch={(o) => patch(sel, o)} onLogo={(f) => carregarLogo(sel, f)} />}
          </div>
        </div>

        <div style={{
          display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", flexWrap: "wrap",
          borderTop: "0.5px solid var(--color-border-tertiary)",
        }}>
          <input
            value={draft.name || ""}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            placeholder="Nome do template"
            style={{ ...inputStyle, width: "auto", minWidth: 200 }}
          />
          {erro && <span style={{ fontSize: 12, color: "var(--danger-text)" }}>{erro}</span>}
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            {draft.id && <button type="button" style={botaoSecundario} onClick={excluir} disabled={busy}>Excluir</button>}
            <button type="button" style={botaoPrimario(busy)} onClick={salvar} disabled={busy}>
              {busy ? "Salvando…" : "Salvar template"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Inspector({ layer, onPatch, onLogo }) {
  return (
    <div style={{ borderTop: "0.5px solid var(--color-border-tertiary)", paddingTop: 12 }}>
      <div style={row}>
        <Field label="X"><Num value={layer.x} onChange={(v) => onPatch({ x: v })} /></Field>
        <Field label="Y"><Num value={layer.y} onChange={(v) => onPatch({ y: v })} /></Field>
      </div>

      {layer.type === "text" && (
        <>
          <Field label="Texto — use {titulo} para o título do vídeo">
            <textarea
              value={layer.text || ""}
              onChange={(e) => onPatch({ text: e.target.value })}
              rows={2}
              style={{ ...inputStyle, resize: "vertical", marginBottom: 8 }}
            />
          </Field>
          <div style={row}>
            <Field label="Fonte">
              <select value={layer.font} onChange={(e) => onPatch({ font: e.target.value })} style={inputStyle}>
                {FONTS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
              </select>
            </Field>
            <Field label="Tamanho"><Num value={layer.size} onChange={(v) => onPatch({ size: v })} /></Field>
            <Field label="Cor"><Cor value={layer.color} onChange={(v) => onPatch({ color: v })} /></Field>
            <Field label="Largura (quebra a linha)"><Num value={layer.w} onChange={(v) => onPatch({ w: v })} /></Field>
            <Field label="Alinhamento">
              <select value={layer.align || "left"} onChange={(e) => onPatch({ align: e.target.value })} style={inputStyle}>
                <option value="left">Esquerda</option>
                <option value="center">Centro</option>
                <option value="right">Direita</option>
              </select>
            </Field>
            <Field label="Contorno"><Num value={layer.stroke?.width} onChange={(v) => onPatch({ stroke: { ...layer.stroke, width: v } })} /></Field>
            <Field label="Cor do contorno"><Cor value={layer.stroke?.color} onChange={(v) => onPatch({ stroke: { ...layer.stroke, color: v } })} /></Field>
            <Field label="Sombra (borrão)"><Num value={layer.shadow?.blur} onChange={(v) => onPatch({ shadow: { ...layer.shadow, blur: v } })} /></Field>
          </div>
          <label style={{ ...hintStyle, display: "flex", alignItems: "center", gap: 6 }}>
            <input type="checkbox" checked={!!layer.uppercase} onChange={(e) => onPatch({ uppercase: e.target.checked })} />
            TUDO EM MAIÚSCULAS
          </label>
        </>
      )}

      {layer.type === "box" && (
        <div style={row}>
          <Field label="Largura"><Num value={layer.w} onChange={(v) => onPatch({ w: v })} /></Field>
          <Field label="Altura"><Num value={layer.h} onChange={(v) => onPatch({ h: v })} /></Field>
          <Field label="Cor"><Cor value={layer.color} onChange={(v) => onPatch({ color: v })} /></Field>
          <Field label="Cantos arredondados"><Num value={layer.radius} onChange={(v) => onPatch({ radius: v })} /></Field>
        </div>
      )}

      {layer.type === "image" && (
        <>
          <Field label="Arquivo do logo (PNG com fundo transparente fica melhor)">
            <input type="file" accept="image/png,image/jpeg,image/webp" style={{ ...inputStyle, marginBottom: 8 }}
              onChange={(e) => onLogo(e.target.files?.[0])} />
          </Field>
          <div style={row}>
            <Field label="Largura"><Num value={layer.w} onChange={(v) => onPatch({ w: v })} /></Field>
            <Field label="Altura"><Num value={layer.h} onChange={(v) => onPatch({ h: v })} /></Field>
          </div>
        </>
      )}

      <Field label={`Opacidade (${Math.round((layer.opacity ?? 1) * 100)}%)`}>
        <input type="range" min="0" max="1" step="0.05" value={layer.opacity ?? 1}
          onChange={(e) => onPatch({ opacity: Number(e.target.value) })} style={{ width: "100%" }} />
      </Field>
    </div>
  );
}
