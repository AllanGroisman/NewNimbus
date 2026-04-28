import { useState, useEffect } from "react";
import { PRIMARY, PRIMARY_DARK, categoryLabel, categoryColor } from "../data/constants";
import { fetchStatus } from "../data/api";
import Badge from "../components/ui/Badge";
import StatCard from "../components/ui/StatCard";
import MiniBar from "../components/ui/MiniBar";

export default function PageDashboard({ groups, onSelectGroup }) {
  const [backendStatus, setBackendStatus] = useState(null);

  useEffect(() => {
    fetchStatus().then(s => setBackendStatus(s)).catch(() => setBackendStatus(null));
  }, []);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <h2 style={{ fontSize: 18, fontWeight: 500 }}>Dashboard geral</h2>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: backendStatus ? PRIMARY : "#E24B4A" }} />
          <span style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>
            {backendStatus ? `Scraper online${backendStatus.cachedProducts > 0 ? ` · ${backendStatus.cachedProducts} em cache` : ""}` : "Scraper offline"}
          </span>
        </div>
      </div>
      <div style={{ display: "flex", gap: 10, marginBottom: 24, flexWrap: "wrap" }}>
        <StatCard label="Envios hoje" value={groups.reduce((a, g) => a + g.sentToday, 0)} color={PRIMARY_DARK} />
        <StatCard label="Envios semana" value={groups.reduce((a, g) => a + g.sentWeek, 0)} />
        <StatCard label="Grupos ativos" value={`${groups.filter(g => g.status === "connected").length}/${groups.length}`} color="#854F0B" />
        <StatCard label="Para revisar" value={groups.reduce((a, g) => a + g.pending.length, 0)} color={groups.reduce((a, g) => a + g.pending.length, 0) > 0 ? "#854F0B" : undefined} />
      </div>
      <h3 style={{ fontSize: 13, fontWeight: 500, marginBottom: 12, color: "var(--color-text-secondary)" }}>Grupos &mdash; clique para gerenciar</h3>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {groups.map(g => (
          <div
            key={g.id}
            onClick={() => onSelectGroup(g)}
            style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: "14px 16px", cursor: "pointer" }}
            onMouseEnter={e => e.currentTarget.style.borderColor = PRIMARY}
            onMouseLeave={e => e.currentTarget.style.borderColor = "var(--color-border-tertiary)"}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 500, marginBottom: 6 }}>{g.name}</div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <Badge color={categoryColor(g.category)}>{categoryLabel(g.category)}</Badge>
                  <Badge color={g.status === "connected" ? "green" : "red"}>{g.status === "connected" ? "Conectado" : "Desconectado"}</Badge>
                  <Badge color="gray">{g.queue.length} na fila</Badge>
                  {g.pending.length > 0 && <Badge color="amber">{g.pending.length} para revisar</Badge>}
                  <Badge color={g.scraping.auto ? "green" : "gray"}>Scraping {g.scraping.auto ? "auto" : "manual"}</Badge>
                </div>
              </div>
              <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
                <div style={{ textAlign: "center" }}>
                  <div style={{ fontSize: 18, fontWeight: 500, color: PRIMARY_DARK }}>{g.sentToday}</div>
                  <div style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>hoje</div>
                </div>
                <div style={{ width: 80 }}><MiniBar data={g.weekData} color={g.category === "gamer" ? "#378ADD" : PRIMARY} /></div>
                <div style={{ fontSize: 18, color: "var(--color-text-secondary)" }}>&rsaquo;</div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
