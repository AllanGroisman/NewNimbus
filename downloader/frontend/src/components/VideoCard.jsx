import Badge from "./ui/Badge";
import { PRIMARY } from "../constants";
import { duration, views, date } from "../format";
import { cardStyle, skelBar } from "../styles";

// Card de vídeo com seleção. Mesmo esqueleto do ProductGridCard do Nimbus:
// imagem no topo, título em 2 linhas, selos embaixo.
export default function VideoCard({ video, vertical, selected, onToggle, product }) {
  const d = duration(video.duration);
  const v = views(video.views);
  const dt = date(video.uploadDate);
  const items = product?.items || [];

  return (
    <div
      role="checkbox"
      aria-checked={selected}
      tabIndex={0}
      onClick={onToggle}
      onKeyDown={(e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); onToggle(); } }}
      style={{
        ...cardStyle,
        padding: 0,
        overflow: "hidden",
        cursor: "pointer",
        border: `${selected ? 2 : 0.5}px solid ${selected ? PRIMARY : "var(--color-border-tertiary)"}`,
        margin: selected ? 0 : 1.5,
        display: "flex", flexDirection: "column",
      }}
    >
      <div style={{
        position: "relative",
        aspectRatio: vertical ? "9 / 16" : "16 / 9",
        background: "var(--color-background-tertiary)",
      }}>
        {video.thumbnail && (
          <img
            src={video.thumbnail}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
          />
        )}
        <span style={{
          position: "absolute", top: 8, left: 8,
          width: 22, height: 22, borderRadius: 6,
          background: selected ? PRIMARY : "rgba(0,0,0,0.45)",
          border: "2px solid #fff",
          color: "#fff", fontSize: 13, fontWeight: 700,
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          {selected ? "✓" : ""}
        </span>
        {items.length > 0 && (
          <span style={{ position: "absolute", top: 8, right: 8 }}>
            <Badge color="orange">🛍 TikTok Shop</Badge>
          </span>
        )}
        {d && (
          <span style={{
            position: "absolute", bottom: 6, right: 6,
            background: "rgba(0,0,0,0.75)", color: "#fff",
            fontSize: 11, fontWeight: 500, padding: "1px 6px", borderRadius: 4,
          }}>
            {d}
          </span>
        )}
      </div>
      <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 8, flex: 1 }}>
        <div title={video.title} style={{
          fontSize: 13, fontWeight: 500, lineHeight: 1.35,
          display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden",
        }}>
          {video.title}
        </div>
        {(v || dt) && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: "auto" }}>
            {v && <Badge color="gray">{v}</Badge>}
            {dt && <Badge color="blue">{dt}</Badge>}
          </div>
        )}
        {product?.status === "loading" && <div style={{ ...skelBar, height: 28, borderRadius: 8 }} />}
        {product?.status === "error" && (
          <div><Badge color="gray">produto indisponível</Badge></div>
        )}
        {items.map((p) => <ProductLink key={p.id} product={p} />)}
      </div>
    </div>
  );
}

// Link do produto anunciado. stopPropagation: clicar aqui não marca o card.
function ProductLink({ product }) {
  return (
    <a
      href={product.url}
      target="_blank"
      rel="noreferrer"
      title={product.title}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: 6, borderRadius: 8, textDecoration: "none",
        border: "0.5px solid var(--color-border-tertiary)",
        background: "var(--color-background-secondary)",
        color: "var(--color-text-primary)",
      }}
    >
      {product.image && (
        <img src={product.image} alt="" loading="lazy" referrerPolicy="no-referrer"
          style={{ width: 28, height: 28, borderRadius: 6, objectFit: "cover", flexShrink: 0 }} />
      )}
      <span style={{ flex: 1, minWidth: 0, fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {product.title}
      </span>
      <span style={{ fontSize: 12, fontWeight: 500, color: PRIMARY, whiteSpace: "nowrap" }}>Ver produto ↗</span>
    </a>
  );
}

export function SkeletonCard({ vertical }) {
  return (
    <div style={{ ...cardStyle, padding: 0, overflow: "hidden" }}>
      <div style={{ aspectRatio: vertical ? "9 / 16" : "16 / 9", ...skelBar, height: "auto", borderRadius: 0 }} />
      <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ ...skelBar, width: "90%" }} />
        <div style={{ ...skelBar, width: "60%" }} />
      </div>
    </div>
  );
}
