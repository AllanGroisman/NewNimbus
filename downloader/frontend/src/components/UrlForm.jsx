import { useState } from "react";
import Spinner from "./ui/Spinner";
import { cardStyle, inputStyle, labelStyle, hintStyle, botaoPrimario, chipStyle } from "../styles";

const LIMITS = [
  { value: 20, label: "20" },
  { value: 50, label: "50" },
  { value: 100, label: "100" },
  { value: 0, label: "Todos" },
];

// `initial` volta da última busca quando a página é recarregada.
export default function UrlForm({ loading, onSubmit, initial }) {
  const [url, setUrl] = useState(initial?.url || "");
  const [limit, setLimit] = useState(initial?.limit ?? 50);
  const [tab, setTab] = useState(initial?.tab || "videos");
  const isYoutube = /youtube\.com|youtu\.be/i.test(url);

  const submit = (e) => {
    e.preventDefault();
    if (url.trim() && !loading) onSubmit({ url: url.trim(), limit, tab });
  };

  return (
    <form onSubmit={submit} style={{ ...cardStyle, marginBottom: 18 }}>
      <label htmlFor="profile-url" style={labelStyle}>Perfil do YouTube ou TikTok</label>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <input
          id="profile-url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://www.youtube.com/@canal ou https://www.tiktok.com/@usuario"
          style={{ ...inputStyle, flex: 1, minWidth: 260 }}
          autoFocus
        />
        <button type="submit" disabled={!url.trim() || loading} style={botaoPrimario(!url.trim() || loading)}>
          {loading && <Spinner size={14} color="#fff" />}
          {loading ? "Listando..." : "Listar vídeos"}
        </button>
      </div>

      <div style={{ display: "flex", gap: 20, flexWrap: "wrap", marginTop: 14, alignItems: "center" }}>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <span style={hintStyle}>Quantidade:</span>
          {LIMITS.map((l) => (
            <button key={l.value} type="button" onClick={() => setLimit(l.value)} style={chipStyle({ active: limit === l.value })}>
              {l.label}
            </button>
          ))}
        </div>
        {isYoutube && (
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span style={hintStyle}>Aba:</span>
            <button type="button" onClick={() => setTab("videos")} style={chipStyle({ active: tab === "videos" })}>Vídeos</button>
            <button type="button" onClick={() => setTab("shorts")} style={chipStyle({ active: tab === "shorts" })}>Shorts</button>
          </div>
        )}
      </div>
    </form>
  );
}
