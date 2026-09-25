// Admin › Downloader — lista os vídeos de um perfil do YouTube/TikTok, deixa
// escolher quais baixar e, se quiser, queima um template por cima.
//
// Veio do app standalone que morava em downloader/. O que era a casca dele
// (cabeçalho com logo, botão de tema, <main> com largura máxima) saiu: o
// App.jsx do Nimbus já dá tudo isso em volta desta página.
import { useEffect, useMemo, useRef, useState } from "react";
import AlertBanner from "../components/ui/AlertBanner";
import Badge from "../components/ui/Badge";
import UrlForm from "../components/admin/downloader/UrlForm";
import { useLembrado } from "../data/useLembrado";
import VideoCard, { SkeletonCard } from "../components/admin/downloader/VideoCard";
import SelectionBar from "../components/admin/downloader/SelectionBar";
import DownloadPanel from "../components/admin/downloader/DownloadPanel";
import TemplateEditor from "../components/admin/downloader/TemplateEditor";
import { frameSize, loadImages, renderToDataUrl, usesTitle } from "../components/admin/downloader/overlay";
import { chipStyle, hintStyle } from "../components/admin/downloader/downloaderEstilos";
import {
  adminDlList, adminDlProducts, adminDlTemplates, adminDlJobCreate, adminDlJob, errText,
} from "../data/api";

// F5 não pode perder a listagem: o estado da busca fica no sessionStorage
// (some quando a aba fecha) e volta no mount.
const SAVE_KEY = "nimbus_dl_state";

function loadState() {
  try { return JSON.parse(sessionStorage.getItem(SAVE_KEY)); } catch { return null; }
}

export default function PageAdminDownloader() {
  // Dentro do componente, e não no escopo do módulo como era no app standalone.
  // Lá o módulo era avaliado a cada carga de página; aqui, dentro da SPA, ele é
  // avaliado uma vez só — um `const saved = loadState()` solto congelaria o
  // valor e sair da aba e voltar traria a listagem velha.
  const [saved] = useState(loadState);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(saved?.result || null);
  const [params, setParams] = useState(saved?.params || null);
  const [selected, setSelected] = useState(() => new Set(saved?.selected || []));
  const [jobId, setJobId] = useState(saved?.jobId || null);
  const [job, setJob] = useState(null);
  // { [videoId]: { status: "loading"|"done"|"error", items } } — TikTok e Shorts.
  const [products, setProducts] = useState(saved?.products || {});
  // O filtro e o template ficam lembrados no servidor, iguais para todos os admins
  // (data/useLembrado.js); o sessionStorage guarda só a busca desta aba.
  const [onlyWithProduct, setOnlyWithProduct] = useLembrado("admin.downloader.soComProduto", false);
  const [templates, setTemplates] = useState([]);
  const [templateId, setTemplateId] = useLembrado("admin.downloader.template", "");
  const [editor, setEditor] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const listGen = useRef(0);

  const vertical = result?.platform === "tiktok" || result?.url?.includes("/shorts");
  // Produto marcado só existe no TikTok Shop e nos Shorts (YouTube Shopping).
  const hasProducts = (data) => data.platform === "tiktok" || (data.platform === "youtube" && data.url?.includes("/shorts"));

  // Busca o produto de cada vídeo em segundo plano, 4 por vez. Uma listagem
  // nova incrementa listGen e faz as buscas da anterior pararem.
  const loadProducts = async (videos, gen) => {
    setProducts((prev) => ({ ...prev, ...Object.fromEntries(videos.map((v) => [v.id, { status: "loading", items: [] }])) }));
    const queue = [...videos];
    const worker = async () => {
      while (queue.length && listGen.current === gen) {
        const v = queue.shift();
        let entry;
        try {
          const { products: items } = await adminDlProducts(v.url);
          entry = { status: "done", items };
        } catch {
          entry = { status: "error", items: [] };
        }
        if (listGen.current === gen) setProducts((prev) => ({ ...prev, [v.id]: entry }));
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
  };

  const list = async (p) => {
    const gen = ++listGen.current;
    setLoading(true);
    setError(null);
    setResult(null);
    setParams(p);
    setProducts({});
    setSelected(new Set());
    try {
      const data = await adminDlList(p);
      if (gen !== listGen.current) return;
      if (!data.videos.length) setError("Nenhum vídeo encontrado nesse perfil.");
      setResult(data);
      if (hasProducts(data) && data.videos.length) loadProducts(data.videos, gen);
    } catch (err) {
      setError(errText(err, "Não foi possível listar os vídeos."));
    } finally {
      setLoading(false);
    }
  };

  const toggle = (id) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const startDownload = async () => {
    setError(null);
    setPreparing(true);
    try {
      const tpl = templates.find((t) => t.id === templateId);
      // Template sem camada alguma e com o vídeo em tela cheia não muda nada no
      // arquivo: pular o encode economiza minutos por lote.
      const aplica = Boolean(tpl && (tpl.layers?.length || (tpl.video?.height || 0) < frameSize(tpl)[1]));
      // O PNG é um só para o lote inteiro, a não ser que o texto use {titulo}.
      const porVideo = aplica && usesTitle(tpl);
      const images = aplica ? await loadImages(tpl) : null;
      const overlay = aplica && !porVideo ? await renderToDataUrl(tpl, { images }) : undefined;

      const videos = [];
      for (const { id, url, title, duration } of selectedShown) {
        videos.push({
          id, url, title, duration,
          overlay: porVideo ? await renderToDataUrl(tpl, { title, images }) : undefined,
        });
      }

      const { jobId } = await adminDlJobCreate({
        videos,
        // Só a geometria vai para o backend: as camadas já estão no PNG.
        template: aplica ? { format: tpl.format, video: tpl.video } : undefined,
        overlay,
      });
      setJob(null);
      setJobId(jobId);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
      setError(errText(err, "Não foi possível iniciar o download."));
    } finally {
      setPreparing(false);
    }
  };

  // Templates ficam num JSON do backend, não no navegador: sobrevivem a limpar
  // o cache e valem para qualquer aba.
  useEffect(() => {
    adminDlTemplates().then(({ templates: lista }) => {
      setTemplates(lista);
      // O template lembrado pode ter sido apagado por outro admin.
      if (templateId && !lista.some((t) => t.id === templateId)) setTemplateId("");
    }).catch(() => { /* sem templates, sem drama */ });
    // Só na montagem: é a checagem do que veio lembrado, não de cada troca.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Retoma os produtos que ficaram pela metade quando a página recarregou.
  useEffect(() => {
    if (!saved?.result || !hasProducts(saved.result)) return;
    const pending = (saved.result.videos || []).filter((v) => !["done", "error"].includes(saved.products?.[v.id]?.status));
    if (pending.length) loadProducts(pending, listGen.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    try {
      if (result) sessionStorage.setItem(SAVE_KEY, JSON.stringify({ params, result, products, selected: [...selected], jobId }));
      else sessionStorage.removeItem(SAVE_KEY);
    } catch { /* modo privado ou cota cheia */ }
  }, [params, result, products, selected, jobId]);

  // Polling do progresso, mesmo padrão das telas de colheita do Nimbus. 1,5s e
  // não 1s: o apiLimiter dá 180 req/min por usuário e o resto do painel já gasta
  // uma parte disso — com 1s, um lote longo somado à busca de produtos raspava
  // o teto e o usuário levava "Limite de requisições atingido".
  useEffect(() => {
    if (!jobId) return;
    let stop = false;
    let timer;
    let got = false;
    const tick = async () => {
      try {
        const data = await adminDlJob(jobId);
        if (stop) return;
        got = true;
        setJob(data);
        if (!data.finished) timer = setTimeout(tick, 1500);
      } catch (err) {
        if (stop) return;
        // Download restaurado que o backend já esqueceu: some sem alarde.
        if (!got) setJobId(null);
        else setError(errText(err, "O download se perdeu."));
      }
    };
    tick();
    return () => { stop = true; clearTimeout(timer); };
  }, [jobId]);

  const jobRunning = job && !job.finished;
  const videos = useMemo(() => result?.videos || [], [result]);
  const withProduct = useMemo(() => videos.filter((v) => products[v.id]?.items?.length), [videos, products]);
  const productsLoading = videos.filter((v) => products[v.id]?.status === "loading").length;
  const filtering = onlyWithProduct && hasProducts(result || {});
  const shown = filtering ? withProduct : videos;
  // Seleção escondida pelo filtro não conta nem é baixada.
  const selectedShown = shown.filter((v) => selected.has(v.id));

  // "título do vídeo — link" para os selecionados que têm produto (ou todos,
  // se nada estiver selecionado).
  const productLinks = () => {
    const base = selectedShown.length ? selectedShown : shown;
    return base.flatMap((v) => (products[v.id]?.items || []).map((p) => `${v.title.trim()} — ${p.url}`));
  };

  return (
    <>
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: 20, marginBottom: 4 }}>Downloader</h1>
        <div style={hintStyle}>
          Cole o link de um perfil do YouTube ou do TikTok, escolha os vídeos e
          baixe — com ou sem template por cima.
        </div>
      </div>

      <UrlForm loading={loading} onSubmit={list} initial={saved?.params} />

      <AlertBanner message={error} onDismiss={() => setError(null)} />

      {jobId && job && <DownloadPanel job={job} onClose={() => { setJobId(null); setJob(null); }} />}

      {editor && (
        <TemplateEditor
          templates={templates}
          // A prévia usa a miniatura de um vídeo de verdade da listagem.
          refVideo={selectedShown[0] || shown[0]}
          onClose={() => setEditor(false)}
          onSaved={(lista, id) => { setTemplates(lista); setTemplateId(id || ""); }}
        />
      )}

      {result && videos.length > 0 && (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
            <h2 style={{ fontSize: 16 }}>{result.channel || "Vídeos"}</h2>
            <Badge color={result.platform === "tiktok" ? "rose" : "red"}>
              {result.platform === "tiktok" ? "TikTok" : result.platform === "youtube" ? "YouTube" : "Outro"}
            </Badge>
            <span style={hintStyle}>{videos.length} vídeos</span>
            {hasProducts(result) && (
              <button
                type="button"
                onClick={() => setOnlyWithProduct((on) => !on)}
                style={{ ...chipStyle({ active: onlyWithProduct }), marginLeft: "auto" }}
              >
                🛍 Só com produto ({withProduct.length}{productsLoading ? `, buscando ${productsLoading}…` : ""})
              </button>
            )}
          </div>
          <SelectionBar
            total={shown.length}
            selected={selectedShown.length}
            onAll={() => setSelected(new Set(shown.map((v) => v.id)))}
            onNone={() => setSelected(new Set())}
            onDownload={startDownload}
            busy={jobRunning || preparing}
            preparing={preparing}
            productLinks={hasProducts(result) ? productLinks : null}
            templates={templates}
            templateId={templateId}
            onTemplate={setTemplateId}
            onEditTemplates={() => setEditor(true)}
          />
        </>
      )}

      {filtering && !shown.length && (
        <div style={{ ...hintStyle, textAlign: "center", padding: "40px 20px" }}>
          {productsLoading ? "Buscando produtos…" : "Nenhum vídeo com produto."}
        </div>
      )}

      {(loading || shown.length > 0) && (
        <div style={{
          display: "grid",
          gridTemplateColumns: `repeat(auto-fill, minmax(${vertical ? 170 : 220}px, 1fr))`,
          gap: 12,
        }}>
          {loading
            ? Array.from({ length: 8 }, (_, i) => <SkeletonCard key={i} />)
            : shown.map((v) => (
              <VideoCard
                key={v.id}
                video={v}
                vertical={vertical}
                selected={selected.has(v.id)}
                onToggle={() => toggle(v.id)}
                product={products[v.id]}
                platform={result.platform}
              />
            ))}
        </div>
      )}

      {!loading && !result && !error && (
        <div style={{ textAlign: "center", padding: "60px 20px", color: "var(--color-text-secondary)" }}>
          <div style={{ fontSize: 40, marginBottom: 8 }}>🎬</div>
          <div style={{ fontSize: 14 }}>Cole o link de um perfil para listar os vídeos.</div>
        </div>
      )}
    </>
  );
}
