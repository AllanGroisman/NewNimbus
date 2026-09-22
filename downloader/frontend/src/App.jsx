import { useEffect, useMemo, useRef, useState } from "react";
import Logo from "./components/ui/Logo";
import AlertBanner from "./components/ui/AlertBanner";
import Badge from "./components/ui/Badge";
import UrlForm from "./components/UrlForm";
import VideoCard, { SkeletonCard } from "./components/VideoCard";
import SelectionBar from "./components/SelectionBar";
import DownloadPanel from "./components/DownloadPanel";
import { botaoSecundario, hintStyle } from "./styles";

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", ...opts.headers },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
  return data;
}

function useTheme() {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme || "system");
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") delete root.dataset.theme;
    else root.dataset.theme = theme;
    try { localStorage.setItem("nimbus_dl_theme", theme); } catch { /* modo privado */ }
  }, [theme]);
  return [theme, setTheme];
}

const THEME_NEXT = { system: "light", light: "dark", dark: "system" };
const THEME_LABEL = { system: "🖥 Sistema", light: "☀ Claro", dark: "🌙 Escuro" };

export default function App() {
  const [theme, setTheme] = useTheme();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [jobId, setJobId] = useState(null);
  const [job, setJob] = useState(null);
  // { [videoId]: { status: "loading"|"done"|"error", items } } — só TikTok.
  const [products, setProducts] = useState({});
  const listGen = useRef(0);

  const vertical = result?.platform === "tiktok" || result?.url?.includes("/shorts");

  // Busca o produto de cada vídeo em segundo plano, 4 por vez. Uma listagem
  // nova incrementa listGen e faz as buscas da anterior pararem.
  const loadProducts = async (videos, gen) => {
    setProducts(Object.fromEntries(videos.map((v) => [v.id, { status: "loading", items: [] }])));
    const queue = [...videos];
    const worker = async () => {
      while (queue.length && listGen.current === gen) {
        const v = queue.shift();
        let entry;
        try {
          const { products: items } = await api("/tiktok/products", { method: "POST", body: JSON.stringify({ url: v.url }) });
          entry = { status: "done", items };
        } catch {
          entry = { status: "error", items: [] };
        }
        if (listGen.current === gen) setProducts((prev) => ({ ...prev, [v.id]: entry }));
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
  };

  const list = async (params) => {
    const gen = ++listGen.current;
    setLoading(true);
    setError(null);
    setResult(null);
    setProducts({});
    setSelected(new Set());
    try {
      const data = await api("/list", { method: "POST", body: JSON.stringify(params) });
      if (gen !== listGen.current) return;
      if (!data.videos.length) setError("Nenhum vídeo encontrado nesse perfil.");
      setResult(data);
      if (data.platform === "tiktok" && data.videos.length) loadProducts(data.videos, gen);
    } catch (err) {
      setError(err.message);
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
    const videos = result.videos
      .filter((v) => selected.has(v.id))
      .map(({ id, url, title }) => ({ id, url, title }));
    try {
      setError(null);
      const { jobId } = await api("/jobs", { method: "POST", body: JSON.stringify({ videos }) });
      setJob(null);
      setJobId(jobId);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
      setError(err.message);
    }
  };

  // Polling do progresso, mesmo padrão das telas de colheita do Nimbus.
  useEffect(() => {
    if (!jobId) return;
    let stop = false;
    let timer;
    const tick = async () => {
      try {
        const data = await api(`/jobs/${jobId}`);
        if (stop) return;
        setJob(data);
        if (!data.finished) timer = setTimeout(tick, 1000);
      } catch (err) {
        if (!stop) setError(err.message);
      }
    };
    tick();
    return () => { stop = true; clearTimeout(timer); };
  }, [jobId]);

  const jobRunning = job && !job.finished;
  const videos = useMemo(() => result?.videos || [], [result]);

  // "título do vídeo — link" para os selecionados que têm produto (ou todos,
  // se nada estiver selecionado).
  const productLinks = () => {
    const base = selected.size ? videos.filter((v) => selected.has(v.id)) : videos;
    return base.flatMap((v) => (products[v.id]?.items || []).map((p) => `${v.title.trim()} — ${p.url}`));
  };

  return (
    <div style={{ minHeight: "100vh", background: "var(--color-background-secondary)" }}>
      <header style={{
        display: "flex", alignItems: "center", gap: 10,
        padding: "12px 24px",
        background: "var(--color-background-primary)",
        borderBottom: "0.5px solid var(--color-border-tertiary)",
      }}>
        <Logo size={28} />
        <div style={{ fontSize: 16, fontWeight: 600 }}>Nimbus <span style={{ color: "var(--color-brand)" }}>Downloader</span></div>
        <button
          type="button"
          onClick={() => setTheme(THEME_NEXT[theme])}
          style={{ ...botaoSecundario, marginLeft: "auto" }}
          title="Trocar tema"
        >
          {THEME_LABEL[theme]}
        </button>
      </header>

      <main className="main-content" style={{ maxWidth: 1200, margin: "0 auto", padding: "24px" }}>
        <UrlForm loading={loading} onSubmit={list} />

        <AlertBanner message={error} onDismiss={() => setError(null)} />

        {jobId && job && <DownloadPanel job={job} onClose={() => { setJobId(null); setJob(null); }} />}

        {result && videos.length > 0 && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
              <h2 style={{ fontSize: 16 }}>{result.channel || "Vídeos"}</h2>
              <Badge color={result.platform === "tiktok" ? "rose" : "red"}>
                {result.platform === "tiktok" ? "TikTok" : result.platform === "youtube" ? "YouTube" : "Outro"}
              </Badge>
              <span style={hintStyle}>{videos.length} vídeos</span>
            </div>
            <SelectionBar
              total={videos.length}
              selected={selected.size}
              onAll={() => setSelected(new Set(videos.map((v) => v.id)))}
              onNone={() => setSelected(new Set())}
              onDownload={startDownload}
              busy={jobRunning}
              productLinks={result.platform === "tiktok" ? productLinks : null}
            />
          </>
        )}

        {(loading || videos.length > 0) && (
          <div style={{
            display: "grid",
            gridTemplateColumns: `repeat(auto-fill, minmax(${vertical ? 170 : 220}px, 1fr))`,
            gap: 12,
          }}>
            {loading
              ? Array.from({ length: 8 }, (_, i) => <SkeletonCard key={i} />)
              : videos.map((v) => (
                <VideoCard
                  key={v.id}
                  video={v}
                  vertical={vertical}
                  selected={selected.has(v.id)}
                  onToggle={() => toggle(v.id)}
                  product={products[v.id]}
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
      </main>
    </div>
  );
}
