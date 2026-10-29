import { useEffect, useMemo, useRef, useState } from "react";
import { adminDlTemplates, adminDlTemplateSave, adminDlTemplateRemove, adminDlTemplatesRestore, errText } from "../../../data/api";
import { PRIMARY } from "../../../data/constants";
import { MOBILE, useMedia } from "../../../data/useMedia";
import {
  CANVAS, FONTS, TWEET_CARD, emptyTemplate, exitEnd, frameSize, hasExit, hitTest, imageSrcs, layerBox,
  loadImages, newLayer, paintOverlay, videoPresets, videoRect,
} from "./overlay";
import {
  botaoPrimario, botaoSecundario, chipStyle, hintStyle,
  inputStyle, labelStyle, modalBackdrop, modalCard,
} from "./downloaderEstilos";

const clone = (o) => JSON.parse(JSON.stringify(o));

// A thumbnail fica num <img> atrás do canvas, nunca desenhada dentro dele: uma
// imagem de outro domínio contamina o canvas e faria o toDataURL() estourar.
// O tamanho na tela vem de quem chama (a coluna da prévia); o canvas é sempre
// do tamanho do quadro e o CSS só o escala.
// `time` (segundos) só vem durante o "Ver animação": as camadas que somem são
// desenhadas como estariam naquele instante do vídeo.
function Preview({ template, title, thumbnail, sel, time, onSel, onMove, onMoveVideo }) {
  const ref = useRef(null);
  const drag = useRef(null);
  const [images, setImages] = useState(() => new Map());
  const [W, H] = frameSize(template);
  const rect = videoRect(template);

  const srcKey = imageSrcs(template).join("|");
  useEffect(() => {
    let live = true;
    loadImages(template).then((m) => live && setImages(m));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [srcKey]);

  useEffect(() => {
    const ctx = ref.current?.getContext("2d");
    if (!ctx) return;
    paintOverlay(ctx, template, { title, images, time });
    // A moldura da seleção entra só aqui: o PNG exportado nasce noutro canvas.
    const l = template.layers?.[sel];
    if (!l || time != null) return;
    const b = layerBox(ctx, l, { title });
    ctx.save();
    ctx.strokeStyle = PRIMARY.startsWith("var") ? "#cd6f04" : PRIMARY;
    ctx.lineWidth = 4;
    ctx.setLineDash([14, 10]);
    ctx.strokeRect(b.x, b.y, b.w, b.h);
    ctx.restore();
  }, [template, title, images, sel, time]);

  const toFrame = (e) => {
    const r = ref.current.getBoundingClientRect();
    return [(e.clientX - r.left) * (W / r.width), (e.clientY - r.top) * (H / r.height)];
  };

  const down = (e) => {
    const [x, y] = toFrame(e);
    const i = hitTest(ref.current.getContext("2d"), template, x, y, { title });
    onSel(i);
    if (i >= 0) {
      drag.current = { i, dx: x - template.layers[i].x, dy: y - template.layers[i].y };
    } else if (x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h) {
      // Clique fora das camadas mas em cima do vídeo arrasta o vídeo.
      drag.current = { video: true, dx: x - rect.x, dy: y - rect.y };
    } else {
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const move = (e) => {
    if (!drag.current) return;
    const [x, y] = toFrame(e);
    const nx = Math.round(x - drag.current.dx);
    const ny = Math.round(y - drag.current.dy);
    if (drag.current.video) {
      // Preso dentro do quadro: passar da borda faria o videoRect encolher o vídeo.
      onMoveVideo(Math.min(Math.max(0, nx), W - rect.w), Math.min(Math.max(0, ny), H - rect.h));
    } else {
      onMove(drag.current.i, nx, ny);
    }
  };

  return (
    <div style={{
      position: "relative", width: "100%",
      aspectRatio: `${W} / ${H}`, background: "#000",
      borderRadius: 8, overflow: "hidden", flexShrink: 0,
    }}>
      {thumbnail && (
        <img
          src={thumbnail}
          alt=""
          referrerPolicy="no-referrer"
          style={{
            position: "absolute",
            left: `${(rect.x / W) * 100}%`, width: `${(rect.w / W) * 100}%`,
            top: `${(rect.y / H) * 100}%`, height: `${(rect.h / H) * 100}%`,
            // Igual ao ffmpeg: no "caber inteiro" a sobra sai na cor das barras.
            ...(template.video?.fit === "contain"
              ? { objectFit: "contain", background: template.video?.background || "#000000" }
              : { objectFit: "cover" }),
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

const row = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 8, marginBottom: 8 };

const ICONE = { box: "▭", text: "T", image: "🖼", tweet: "🐦" };

// Padrão do "Sumir depois de alguns segundos": tempo de ler um tweet curto e um
// sumiço suave, sem cortar seco.
const SAIDA = { at: 5, fade: 1 };

const MESES = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
const p2 = (n) => String(n).padStart(2, "0");
// Mesmo formato da linha de data do tweet: "17:00 · 01 de Julho de 2021".
const dataTweet = (d = new Date()) => `${p2(d.getHours())}:${p2(d.getMinutes())} · ${p2(d.getDate())} de ${MESES[d.getMonth()]} de ${d.getFullYear()}`;

// Os de fábrica ("Faixa no topo", "Barras + vídeo reduzido", "TwitterReact")
// são templates comuns: editar e salvar muda o padrão. "Restaurar padrões" traz de
// volta a versão original deles sem tocar nos outros.
export default function TemplateEditor({ templates, initialId, refVideo, onClose, onSaved }) {
  const [draft, setDraft] = useState(() => clone(templates.find((t) => t.id === initialId) || templates[0] || emptyTemplate()));
  const [sel, setSel] = useState(-1);
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState(null);
  const [grande, setGrande] = useState(false);
  const [tempo, setTempo] = useState(null);
  const anim = useRef(0);
  // No celular a prévia fica em cima e tudo rola junto; no resto, prévia e
  // controles rolam cada um por si, e a prévia nunca sai da tela.
  const celular = useMedia(MOBILE);

  const layer = draft.layers?.[sel] || null;
  const presets = useMemo(() => videoPresets(draft.format), [draft.format]);
  const rect = videoRect(draft);
  const [W, H] = frameSize(draft);
  const exemplo = refVideo?.title || "Título do vídeo de exemplo";
  // Largura explícita da coluna da prévia, limitada pela altura do modal para a
  // prévia caber inteira sem rolar: o que sobra tirando cabeçalho, rodapé,
  // legenda e botões (ampliada, sem cabeçalho nem legenda). Lado a lado, sobram
  // pelo menos 340px para os controles.
  const alturaUtil = grande ? "100dvh - 150px" : "92vh - 240px";
  const larguraPrevia = celular
    ? `min(100%, ${grande ? `calc((${alturaUtil}) * ${W / H})` : `${H > W ? 320 : 480}px`})`
    : `min(${grande ? "calc(100% - 340px)" : `${H > W ? 320 : 480}px`}, calc((${alturaUtil}) * ${W / H}))`;
  const temAnimacao = (draft.layers || []).some(hasExit);

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

  // A foto do tweet sai num círculo de ~170px: recortar o quadrado central e
  // reduzir para 320px aqui deixa o template leve e longe do limite de 2 MB
  // por imagem do backend, por maior que seja a foto escolhida.
  // Lida como data-URL, igual ao logo: URL blob: é barrada pelo img-src do CSP
  // do nginx, e a foto simplesmente não aparecia.
  const carregarFoto = (i, file) => {
    if (!file) return;
    const falhou = () => setErro("Não foi possível abrir essa imagem. Tente um PNG ou JPG.");
    const reader = new FileReader();
    reader.onerror = falhou;
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const lado = Math.min(img.width, img.height);
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 320;
        canvas.getContext("2d").drawImage(img, (img.width - lado) / 2, (img.height - lado) / 2, lado, lado, 0, 0, 320, 320);
        setErro(null);
        patch(i, { avatar: canvas.toDataURL("image/png") });
      };
      img.onerror = falhou;
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  };

  // Escala do tweet em torno do centro horizontal: crescer a partir do canto
  // jogaria o tweet para fora do quadro pela direita.
  const escalar = (i, scale) => {
    const l = draft.layers[i];
    const ctx = document.createElement("canvas").getContext("2d");
    const a = layerBox(ctx, l, { title: exemplo });
    const b = layerBox(ctx, { ...l, scale }, { title: exemplo });
    patch(i, { scale, x: Math.round(l.x + (a.x + a.w / 2) - (b.x + b.w / 2)) });
  };

  // Tamanho do vídeo: largura e altura na mesma proporção, mantendo o topo e o
  // centro horizontal, sem passar do quadro.
  const escalarVideo = (k) => {
    const w = Math.min(W, Math.max(2, Math.round(W * k)));
    const h = Math.min(H - rect.y, Math.max(2, Math.round(rect.h * (w / rect.w))));
    const left = Math.min(Math.max(0, Math.round(rect.x + rect.w / 2 - w / 2)), W - w);
    setVideo({ width: w, height: h, left, top: rect.y });
  };

  const trocarFormato = (format) => setDraft((d) => ({
    ...d, format, video: { ...d.video, top: 0, height: CANVAS[format][1], left: 0, width: CANVAS[format][0] },
  }));

  // Toca na prévia o que acontece no vídeo: as camadas somem no tempo certo e
  // o resultado fica 1s na tela antes de voltar ao normal.
  const animar = () => {
    cancelAnimationFrame(anim.current);
    const fim = exitEnd(draft) + 1;
    const t0 = performance.now();
    const passo = (agora) => {
      const t = (agora - t0) / 1000;
      if (t >= fim) { setTempo(null); return; }
      setTempo(t);
      anim.current = requestAnimationFrame(passo);
    };
    anim.current = requestAnimationFrame(passo);
  };
  useEffect(() => () => cancelAnimationFrame(anim.current), []);

  // Esc sai da prévia ampliada antes de qualquer outra coisa.
  useEffect(() => {
    if (!grande) return undefined;
    const onKey = (e) => { if (e.key === "Escape") setGrande(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [grande]);

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

  const restaurar = async () => {
    if (!window.confirm("Voltar os templates de fábrica à versão original? Os seus outros templates não mudam.")) return;
    setBusy(true);
    setErro(null);
    try {
      const { templates: lista } = await adminDlTemplatesRestore();
      onSaved(lista, draft.id || null);
      setDraft(clone(lista.find((t) => t.id === draft.id) || lista[0] || emptyTemplate()));
      setSel(-1);
    } catch (err) {
      setErro(errText(err, "Não foi possível restaurar os padrões."));
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
    <div style={grande ? { ...modalBackdrop, padding: 0 } : modalBackdrop} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div style={grande
        ? { ...modalCard, width: "100vw", height: "100dvh", maxHeight: "100dvh", borderRadius: 0, border: "none" }
        // Altura fixa: é ela que dá às duas colunas uma altura para rolar dentro.
        : { ...modalCard, ...(celular ? {} : { height: "92vh" }) }}>
        {/* Ampliada, o cabeçalho sai: num notebook a altura da tela é o que limita a prévia. */}
        {!grande && <div style={{
          display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", flexWrap: "wrap",
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
          <button type="button" style={botaoSecundario} onClick={restaurar} disabled={busy}
            title="Volta os templates de fábrica à versão original">
            ↺ Restaurar padrões
          </button>
          <button type="button" style={{ ...botaoSecundario, marginLeft: "auto" }} onClick={onClose}>Fechar</button>
        </div>}

        <div style={{
          display: "flex", gap: 16, padding: 16, flex: 1, minHeight: 0,
          ...(celular ? { overflowY: "auto", flexWrap: "wrap" } : { overflow: "hidden" }),
        }}>
          <div style={{
            display: "flex", flexDirection: "column", gap: 8, alignItems: "center",
            width: larguraPrevia, flexShrink: 0,
            ...(celular ? {} : { overflowY: "auto" }),
          }}>
            <Preview
              template={draft}
              title={exemplo}
              thumbnail={refVideo?.thumbnail}
              sel={sel}
              time={tempo}
              onSel={setSel}
              onMove={(i, x, y) => patch(i, { x, y })}
              onMoveVideo={(left, top) => setVideo({ left, top })}
            />
            {!grande && (
              <span style={{ ...hintStyle, textAlign: "center" }} title="O fundo da prévia é a miniatura do vídeo.">
                Arraste as camadas e o vídeo na prévia.
              </span>
            )}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
              <button type="button" style={botaoSecundario} onClick={() => setGrande((g) => !g)}
                title={grande ? "Volta ao tamanho normal (Esc)" : "Mostra a prévia do tamanho da tela"}>
                {grande ? "⤡ Reduzir" : "⤢ Ampliar"}
              </button>
              {temAnimacao && (
                <button type="button" style={{ ...botaoSecundario, minWidth: 130 }} onClick={animar}
                  title="Mostra as camadas sumindo como no vídeo">
                  {tempo != null ? `⏱ ${tempo.toFixed(1)}s do vídeo` : "▶ Ver animação"}
                </button>
              )}
            </div>
          </div>

          <div style={{
            flex: 1, display: "flex", flexDirection: "column", gap: 14,
            ...(celular ? { minWidth: "min(300px, 100%)" } : { minWidth: 0, overflowY: "auto", paddingRight: 4 }),
          }}>
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
                    style={chipStyle({
                      active: rect.y === p.video.top && rect.h === p.video.height && rect.x === p.video.left && rect.w === p.video.width,
                    })}>
                    {p.label}
                  </button>
                ))}
              </div>
              <Field label={`Tamanho do vídeo (${Math.round((rect.w / W) * 100)}%)`}>
                <input type="range" min="0.2" max="1" step="0.01" value={rect.w / W}
                  onChange={(e) => escalarVideo(Number(e.target.value))} style={{ width: "100%", marginBottom: 8 }} />
              </Field>
              <div style={row}>
                <Field label="Topo do vídeo"><Num value={draft.video?.top} onChange={(v) => setVideo({ top: v })} step={2} /></Field>
                <Field label="Esquerda do vídeo"><Num value={draft.video?.left ?? 0} onChange={(v) => setVideo({ left: v })} step={2} /></Field>
                <Field label={`Largura do vídeo (máx ${W})`}><Num value={draft.video?.width || W} onChange={(v) => setVideo({ width: v })} step={2} /></Field>
                <Field label={`Altura do vídeo (máx ${H})`}><Num value={draft.video?.height} onChange={(v) => setVideo({ height: v })} step={2} /></Field>
              </div>
              <div style={row}>
                <div>
                  <span style={labelStyle}>Posição</span>
                  <button type="button" style={{ ...botaoSecundario, width: "100%" }}
                    onClick={() => setVideo({ left: Math.round((W - rect.w) / 2) })}>
                    Centralizar
                  </button>
                </div>
                <Field label="Cor do fundo (fora do vídeo)"><Cor value={draft.video?.background} onChange={(v) => setVideo({ background: v })} /></Field>
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
                <button type="button" style={botaoSecundario} onClick={() => add("tweet")}>+ Tweet</button>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {(draft.layers || []).map((l, i) => (
                  <div key={i} style={{
                    display: "flex", alignItems: "center", gap: 6, padding: "5px 8px", borderRadius: 8,
                    background: i === sel ? "var(--color-background-secondary)" : "transparent",
                    border: `1px solid ${i === sel ? PRIMARY : "transparent"}`, cursor: "pointer", fontSize: 12,
                  }} onClick={() => setSel(i)}>
                    <span>{ICONE[l.type] || "🖼"}</span>
                    <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {l.type === "text" ? l.text || "(vazio)" : l.type === "tweet" ? l.name || "Tweet" : l.type === "box" ? "Faixa" : "Logo"}
                    </span>
                    {hasExit(l) && <span title={`Some aos ${l.exit.at}s`} style={hintStyle}>⏱ {l.exit.at}s</span>}
                    <button type="button" title="Subir" style={botaoSecundario} onClick={(e) => { e.stopPropagation(); mover(i, -1); }}>↑</button>
                    <button type="button" title="Descer" style={botaoSecundario} onClick={(e) => { e.stopPropagation(); mover(i, 1); }}>↓</button>
                    <button type="button" title="Excluir" style={botaoSecundario} onClick={(e) => { e.stopPropagation(); setLayers((ls) => ls.filter((_, k) => k !== i)); setSel(-1); }}>✕</button>
                  </div>
                ))}
                {!(draft.layers || []).length && <span style={hintStyle}>Nenhuma camada ainda.</span>}
              </div>
            </div>

            {layer && (
              <Inspector layer={layer} onPatch={(o) => patch(sel, o)} onScale={(k) => escalar(sel, k)}
                onLogo={(f) => carregarLogo(sel, f)} onFoto={(f) => carregarFoto(sel, f)} />
            )}
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
            style={{ ...inputStyle, width: "auto", minWidth: "min(200px, 100%)" }}
          />
          {erro && <span style={{ fontSize: 12, color: "var(--danger-text)" }}>{erro}</span>}
          <div style={{ marginLeft: "auto", display: "flex", gap: 8, flexWrap: "wrap" }}>
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

function Inspector({ layer, onPatch, onScale, onLogo, onFoto }) {
  const card = layer.card || {};
  const patchCard = (o) => onPatch({ card: { ...card, ...o } });
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

      {layer.type === "tweet" && (
        <>
          <Field label={`Tamanho do tweet (${Math.round((layer.scale || 1) * 100)}%)`}>
            <input type="range" min="0.3" max="2" step="0.05" value={layer.scale || 1}
              onChange={(e) => onScale(Number(e.target.value))} style={{ width: "100%", marginBottom: 8 }} />
          </Field>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
            {layer.avatar
              ? <img src={layer.avatar} alt="" style={{ width: 44, height: 44, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }} />
              : <span style={{ width: 44, height: 44, borderRadius: "50%", background: "#cfd9de", flexShrink: 0 }} />}
            <Field label="Foto do perfil">
              {/* Zerar o value deixa escolher o mesmo arquivo de novo. */}
              <input type="file" accept="image/*" style={inputStyle}
                onChange={(e) => { onFoto(e.target.files?.[0]); e.target.value = ""; }} />
            </Field>
          </div>
          <div style={row}>
            <Field label="Nome da conta">
              <input value={layer.name || ""} onChange={(e) => onPatch({ name: e.target.value })} style={inputStyle} />
            </Field>
            <Field label="@">
              <input value={layer.handle || ""} onChange={(e) => onPatch({ handle: e.target.value.replace(/^@+/, "") })} style={inputStyle} />
            </Field>
          </div>
          <Field label="Data">
            <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
              <input value={layer.date || ""} onChange={(e) => onPatch({ date: e.target.value })} style={inputStyle} />
              <button type="button" style={botaoSecundario} onClick={() => onPatch({ date: dataTweet() })}>Agora</button>
            </div>
          </Field>
          <Field label="Texto do tweet — use {titulo} para o título do vídeo">
            <textarea
              value={layer.text || ""}
              onChange={(e) => onPatch({ text: e.target.value })}
              rows={3}
              style={{ ...inputStyle, resize: "vertical", marginBottom: 8 }}
            />
          </Field>
          <div style={row}>
            <Field label="Tamanho da letra"><Num value={layer.size} onChange={(v) => onPatch({ size: v })} /></Field>
            <Field label="Largura (quebra a linha)"><Num value={layer.w} onChange={(v) => onPatch({ w: v })} /></Field>
            <Field label="Tema">
              <select value={layer.theme || "light"} onChange={(e) => onPatch({ theme: e.target.value })} style={inputStyle}>
                <option value="light">Claro — para fundo branco</option>
                <option value="dark">Escuro — para fundo preto</option>
              </select>
            </Field>
          </div>
          <label style={{ ...hintStyle, display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
            <input type="checkbox" checked={!!layer.verified} onChange={(e) => onPatch({ verified: e.target.checked })} />
            Selo azul de verificado
          </label>
          <label style={{ ...hintStyle, display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
            <input type="checkbox" checked={!!card.show}
              onChange={(e) => patchCard(e.target.checked && !layer.card ? TWEET_CARD : { show: e.target.checked })} />
            Retângulo atrás do tweet
          </label>
          {card.show && (
            <div style={row}>
              <Field label="Cor do fundo"><Cor value={card.color} onChange={(v) => patchCard({ color: v })} /></Field>
              <Field label="Cor do contorno"><Cor value={card.borderColor} onChange={(v) => patchCard({ borderColor: v })} /></Field>
              <Field label="Espessura do contorno"><Num value={card.borderWidth} onChange={(v) => patchCard({ borderWidth: v })} /></Field>
              <Field label="Cantos arredondados"><Num value={card.radius} onChange={(v) => patchCard({ radius: v })} /></Field>
              <Field label="Margem interna"><Num value={card.padding} onChange={(v) => patchCard({ padding: v })} /></Field>
            </div>
          )}
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

      <label style={{ ...hintStyle, display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
        <input type="checkbox" checked={hasExit(layer)}
          onChange={(e) => onPatch({ exit: e.target.checked ? { ...SAIDA, ...layer.exit } : null })} />
        Sumir depois de alguns segundos
      </label>
      {hasExit(layer) && (
        <div style={row}>
          <Field label="Some aos (segundos)">
            <Num value={layer.exit.at} step={0.5} onChange={(v) => onPatch({ exit: { ...layer.exit, at: Math.max(0, v) } })} />
          </Field>
          <Field label="Duração do sumiço (s)">
            <Num value={layer.exit.fade} step={0.1} onChange={(v) => onPatch({ exit: { ...layer.exit, fade: Math.max(0, v) } })} />
          </Field>
        </div>
      )}

      <Field label={`Opacidade (${Math.round((layer.opacity ?? 1) * 100)}%)`}>
        <input type="range" min="0" max="1" step="0.05" value={layer.opacity ?? 1}
          onChange={(e) => onPatch({ opacity: Number(e.target.value) })} style={{ width: "100%" }} />
      </Field>
    </div>
  );
}
