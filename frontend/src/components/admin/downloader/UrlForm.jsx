import { useState } from "react";
import Spinner from "../../ui/Spinner";
import { useLembrado, umDe } from "../../../data/useLembrado";
import { cardStyle, inputStyle, labelStyle, hintStyle, botaoPrimario, chipStyle } from "./downloaderEstilos";

const LIMITS = [
  { value: 20, label: "20" },
  { value: 50, label: "50" },
  { value: 100, label: "100" },
  { value: 0, label: "Todos" },
];

// Link de UM vídeo (vai para a lista avulsa) × link de perfil (lista os vídeos
// dele). Shopee é sempre vídeo: perfil da Shopee não dá para listar.
const VIDEO_LINK = [
  /(youtube\.com\/(shorts\/|watch\?|live\/)|youtu\.be\/)/i,
  /tiktok\.com\/(@[^/]+\/(video|photo)\/|t\/)|(vm|vt)\.tiktok\.com\//i,
  /(shopee\.com\.br|shp\.ee)\//i,
];
const isVideoLink = (url) => VIDEO_LINK.some((re) => re.test(url));

// Colar vários links de uma vez: o <input> engole a quebra de linha e gruda um
// link no outro, então separa também onde começa um "http".
const splitLinks = (raw) => raw.split(/(?=https?:\/\/)|\s+/).map((s) => s.trim()).filter(Boolean);

// `initial` volta da última busca quando a página é recarregada.
export default function UrlForm({ loading, adding, onSubmit, onAddVideos, initial, onlyWithProduct, onOnlyWithProduct }) {
  const [url, setUrl] = useState(initial?.url || "");
  // Quantos, de qual aba e em que ordem ficam lembrados no servidor, iguais para todos os admins.
  const [limit, setLimit] = useLembrado("admin.downloader.limite", 50, umDe(LIMITS.map((l) => l.value)));
  const [tab, setTab] = useLembrado("admin.downloader.aba", "videos", umDe(["videos", "shorts"]));
  const [sort, setSort] = useLembrado("admin.downloader.ordem", "recent", umDe(["recent", "views"]));
  const links = splitLinks(url);
  const video = links.length > 0 && links.every(isVideoLink);
  const isYoutube = /youtube\.com|youtu\.be/i.test(url);
  const busy = loading || adding;

  const submit = (e) => {
    e.preventDefault();
    if (!links.length || busy) return;
    if (video) {
      onAddVideos(links);
      setUrl("");
    } else {
      onSubmit({ url: url.trim(), limit, tab, sort });
    }
  };

  const label = video
    ? (adding ? "Adicionando..." : `➕ Adicionar à lista${links.length > 1 ? ` (${links.length})` : ""}`)
    : (loading ? "Listando..." : "Listar vídeos");

  return (
    <form onSubmit={submit} style={{ ...cardStyle, marginBottom: 18 }}>
      <label htmlFor="profile-url" style={labelStyle}>Link do perfil ou do vídeo (YouTube, TikTok ou Shopee)</label>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <input
          id="profile-url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://www.tiktok.com/@usuario  ·  ou o link de um vídeo"
          style={{ ...inputStyle, flex: 1, minWidth: 240 }}
          autoFocus
        />
        <button type="submit" disabled={!links.length || busy} style={botaoPrimario(!links.length || busy)}>
          {busy && <Spinner size={14} color="#fff" />}
          {label}
        </button>
      </div>

      {video ? (
        <div style={{ ...hintStyle, marginTop: 12 }}>
          Link de vídeo: ele entra numa lista avulsa. Cole outros links (de qualquer
          plataforma, até vários de uma vez) para ir juntando antes de baixar.
        </div>
      ) : (
        <div style={{ display: "flex", gap: 20, flexWrap: "wrap", marginTop: 14, alignItems: "center" }}>
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <span style={hintStyle}>Quantidade:</span>
            {LIMITS.map((l) => (
              <button key={l.value} type="button" onClick={() => setLimit(l.value)} style={chipStyle({ active: limit === l.value })}>
                {l.label}
              </button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span style={hintStyle}>Ordem:</span>
            <button type="button" onClick={() => setSort("recent")} style={chipStyle({ active: sort === "recent" })}>Recentes</button>
            <button
              type="button"
              onClick={() => setSort("views")}
              style={chipStyle({ active: sort === "views" })}
              title="Varre os 300 vídeos mais recentes e traz os mais vistos entre eles"
            >
              🔥 Mais vistos
            </button>
          </div>
          {isYoutube && (
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span style={hintStyle}>Aba:</span>
              <button type="button" onClick={() => setTab("videos")} style={chipStyle({ active: tab === "videos" })}>Vídeos</button>
              <button type="button" onClick={() => setTab("shorts")} style={chipStyle({ active: tab === "shorts" })}>Shorts</button>
            </div>
          )}
          <button
            type="button"
            onClick={() => onOnlyWithProduct((on) => !on)}
            style={chipStyle({ active: onlyWithProduct })}
            title="Mostra só os vídeos com produto do TikTok Shop / YouTube Shopping (Shorts)"
          >
            🛍 Só com produto
          </button>
        </div>
      )}
    </form>
  );
}
