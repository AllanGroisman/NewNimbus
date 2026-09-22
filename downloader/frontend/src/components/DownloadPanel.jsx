import Badge from "./ui/Badge";
import Spinner from "./ui/Spinner";
import { PRIMARY } from "../constants";
import { cardStyle, botaoPrimario, botaoSecundario, hintStyle } from "../styles";

const STATUS = {
  queued: { color: "gray", label: "Na fila" },
  downloading: { color: "amber", label: "Baixando" },
  rendering: { color: "blue", label: "Aplicando template" },
  done: { color: "green", label: "Pronto" },
  error: { color: "red", label: "Erro" },
};

// Com template cada item tem duas fases (baixar e renderizar), e cada uma vale
// metade da barra — senão o progresso volta para zero no meio do caminho.
function itemPercent(item, hasTemplate) {
  if (item.status === "done" || item.status === "error") return 100;
  if (!hasTemplate) return item.percent || 0;
  if (item.status === "rendering") return 50 + (item.percent || 0) / 2;
  return (item.percent || 0) / 2;
}

export default function DownloadPanel({ job, onClose }) {
  const done = job.items.filter((i) => i.status === "done").length;
  const errors = job.items.filter((i) => i.status === "error").length;
  const total = job.items.length;
  const overall = job.items.reduce((s, i) => s + itemPercent(i, job.hasTemplate), 0) / total;

  return (
    <div style={{ ...cardStyle, marginBottom: 18 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
        {!job.finished && <Spinner size={16} />}
        <div style={{ fontSize: 15, fontWeight: 500 }}>
          {job.finished ? "Downloads concluídos" : "Baixando vídeos"}
        </div>
        <span style={hintStyle}>
          {done}/{total} prontos{errors ? ` · ${errors} com erro` : ""}
        </span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          {done > 0 && job.hasTemplate && (
            <a href={`/api/jobs/${job.id}/zip?raw=1`} style={botaoSecundario}>⬇ .zip sem template</a>
          )}
          {done > 0 && (
            <a href={`/api/jobs/${job.id}/zip`} style={botaoPrimario(false)}>
              ⬇ Baixar tudo (.zip){!job.finished ? " — prontos" : ""}
            </a>
          )}
          {job.finished && <button type="button" onClick={onClose} style={botaoSecundario}>Fechar</button>}
        </div>
      </div>

      <ProgressBar percent={overall} />

      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 14, maxHeight: 320, overflowY: "auto" }}>
        {job.items.map((item) => {
          const st = STATUS[item.status] || STATUS.queued;
          return (
            <div key={item.id} style={{
              display: "flex", alignItems: "center", gap: 10,
              padding: "8px 10px", borderRadius: 8,
              background: "var(--color-background-secondary)",
            }}>
              <Badge color={st.color}>{st.label}</Badge>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div title={item.title} style={{ fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {item.title}
                </div>
                {(item.status === "downloading" || item.status === "rendering") && <ProgressBar percent={item.percent} thin />}
                {item.error && <div style={{ fontSize: 12, color: "var(--danger-text)" }}>{item.error}</div>}
                {item.warning && <div style={{ fontSize: 12, color: "var(--warn-text)" }}>{item.warning}</div>}
              </div>
              {(item.status === "downloading" || item.status === "rendering") && <span style={hintStyle}>{Math.round(item.percent)}%</span>}
              {item.status === "done" && (
                <>
                  {item.raw && (
                    <a href={`/api/jobs/${job.id}/file/${encodeURIComponent(item.id)}?raw=1`} style={botaoSecundario} title="Baixar sem o template">
                      Original
                    </a>
                  )}
                  <a href={`/api/jobs/${job.id}/file/${encodeURIComponent(item.id)}`} style={botaoSecundario}>Salvar</a>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ProgressBar({ percent, thin }) {
  return (
    <div style={{
      height: thin ? 4 : 8, borderRadius: 4, marginTop: thin ? 4 : 0,
      background: "var(--color-border-tertiary)", overflow: "hidden",
    }}>
      <div style={{
        height: "100%", width: `${Math.min(100, Math.max(0, percent))}%`,
        background: PRIMARY, transition: "width 0.4s",
      }} />
    </div>
  );
}
