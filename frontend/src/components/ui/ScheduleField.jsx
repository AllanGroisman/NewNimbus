import { PRIMARY, PRIMARY_DARK, PRIMARY_LIGHT } from "../../data/constants";

// Quando um scraper global roda: a cada N minutos, ou em horários fixos do dia.
// Usado pelo Admin › Scraping e pelo Admin › ScrapTester — os dois guardam
// `scheduleMode` / `intervalMinutes` / `times` na config (backend/scraping/schedule.js).
//
// Mesmo desenho do preenchimento por horários das campanhas (ProductSearchTab).

export const MAX_TIMES = 12;   // igual ao MAX_TIMES do backend

export default function ScheduleField({
  mode = "interval",
  intervalMinutes,
  times,
  minInterval = 5,
  // Mais de um na mesma tela (a agenda das três etapas de cupons) precisa de ids
  // distintos, senão o label de um aponta pro input do outro.
  idPrefix = "sched",
  onChange,
}) {
  const list = Array.isArray(times) ? times : [];

  function setTime(i, value) {
    const next = [...list];
    next[i] = value;
    onChange({ times: next });
  }

  return (
    <div>
      <label style={labelStyle}>Quando rodar</label>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        <button type="button" onClick={() => onChange({ scheduleMode: "interval" })} style={chip(mode !== "times")}>
          {mode !== "times" ? "✓ " : ""}A cada X minutos
        </button>
        <button type="button" onClick={() => onChange({ scheduleMode: "times" })} style={chip(mode === "times")}>
          {mode === "times" ? "✓ " : ""}Em horários do dia
        </button>
      </div>

      {mode !== "times" ? (
        <div style={{ maxWidth: 280 }}>
          <label style={labelStyle} htmlFor={`${idPrefix}-interval`}>Intervalo (minutos)</label>
          <input
            id={`${idPrefix}-interval`}
            type="number" min={minInterval} max={10080}
            value={intervalMinutes ?? ""}
            onChange={e => onChange({ intervalMinutes: e.target.value === "" ? "" : parseInt(e.target.value) })}
            style={inputStyle}
          />
          <div style={hintStyle}>
            {intervalMinutes === "" || intervalMinutes == null
              ? " "
              : (intervalMinutes >= 60 ? `≈ ${Math.round(intervalMinutes / 60)}h` : `${intervalMinutes}min`)}
          </div>
        </div>
      ) : (
        <div>
          <label style={labelStyle}>Horários</label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            {list.map((t, i) => (
              <span key={`${t}-${i}`} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                <input
                  type="time"
                  aria-label={`Horário ${i + 1}`}
                  value={t}
                  onChange={e => setTime(i, e.target.value)}
                  style={{ ...inputStyle, width: "auto", padding: "7px 10px" }}
                />
                <button
                  type="button"
                  onClick={() => onChange({ times: list.filter((_, j) => j !== i) })}
                  title="Remover este horário"
                  aria-label={`Remover horário ${i + 1}`}
                  style={removeBtnStyle}
                >
                  ✕
                </button>
              </span>
            ))}
            {list.length < MAX_TIMES && (
              <button type="button" onClick={() => onChange({ times: [...list, "09:00"] })} style={chip(false)}>
                + Adicionar horário
              </button>
            )}
          </div>
          <div style={hintStyle}>
            Roda uma vez em cada horário, no fuso do servidor. Se o sistema estiver fora do ar
            na hora marcada, ainda roda se voltar em até 15 minutos.
          </div>
          {list.length === 0 && (
            <div style={warnStyle}>
              Sem nenhum horário nada é agendado. Adicione um horário ou volte para "a cada X minutos".
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const labelStyle = { fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 6 };

const inputStyle = {
  width: "100%", padding: "7px 10px", borderRadius: 7,
  border: "0.5px solid var(--color-border-tertiary)",
  background: "var(--color-background-secondary)",
  color: "var(--color-text-primary)",
  fontSize: 13, fontFamily: "inherit", boxSizing: "border-box",
};

const hintStyle = { fontSize: 11, color: "var(--color-text-secondary)", marginTop: 6 };

const chip = (active) => ({
  padding: "6px 14px", borderRadius: 8,
  border: `0.5px solid ${active ? PRIMARY : "var(--color-border-tertiary)"}`,
  background: active ? PRIMARY_LIGHT : "transparent",
  color: active ? PRIMARY_DARK : "var(--color-text-secondary)",
  fontSize: 13, fontFamily: "inherit", cursor: "pointer",
  fontWeight: active ? 500 : 400,
});

const removeBtnStyle = {
  background: "transparent", border: "none", padding: "3px 4px",
  color: "var(--color-text-secondary)", fontSize: 13, fontFamily: "inherit", cursor: "pointer",
};

const warnStyle = {
  fontSize: 11, marginTop: 10, borderRadius: 8, padding: "8px 10px",
  color: "var(--warn-text)", background: "var(--warn-bg)",
  border: "0.5px solid var(--warn-border)",
};
