import { useState, useEffect } from "react";
import { PRIMARY, PRIMARY_DARK, PRIMARY_LIGHT, CATEGORIES, categoryLabel, categoryColor, getGroupCategories, getGroupStats } from "../data/constants";
import { fetchStatus } from "../data/api";
import Badge from "../components/ui/Badge";
import StatCard from "../components/ui/StatCard";
import MiniBar from "../components/ui/MiniBar";
import Modal from "../components/ui/Modal";

export default function PageDashboard({ groups, whatsappGroups = [], onSelectGroup, onCreateGroup }) {
  const [backendStatus, setBackendStatus] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ name: "", categories: [] });

  useEffect(() => {
    fetchStatus().then(s => setBackendStatus(s)).catch(() => setBackendStatus(null));
  }, []);

  const toggleFormCategory = (id) => setForm(f => ({
    ...f,
    categories: f.categories.includes(id) ? f.categories.filter(c => c !== id) : [...f.categories, id],
  }));

  const submit = () => {
    if (!form.name.trim() || form.categories.length === 0) return;
    onCreateGroup({ name: form.name.trim(), categories: form.categories });
    setShowCreate(false);
    setForm({ name: "", categories: [] });
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20, flexWrap: "wrap", gap: 10 }}>
        <h2 style={{ fontSize: 18, fontWeight: 500 }}>Dashboard geral</h2>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: backendStatus ? PRIMARY : "#E24B4A" }} />
            <span style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>
              {backendStatus ? `Scraper online${backendStatus.cachedProducts > 0 ? ` · ${backendStatus.cachedProducts} em cache` : ""}` : "Scraper offline"}
            </span>
          </div>
          <button onClick={() => setShowCreate(true)} style={{ padding: "7px 14px", borderRadius: 8, background: PRIMARY, color: "#fff", border: "none", fontSize: 13, cursor: "pointer", fontWeight: 500 }}>+ Nova campanha</button>
        </div>
      </div>

      {groups.length === 0 ? (
        <div style={{ textAlign: "center", padding: "60px 20px", background: "var(--color-background-secondary)", borderRadius: 14, border: "0.5px dashed var(--color-border-secondary)" }}>
          <div style={{ fontSize: 36, marginBottom: 14 }}>📣</div>
          <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 6 }}>Crie sua primeira campanha</div>
          <div style={{ fontSize: 13, color: "var(--color-text-secondary)", marginBottom: 18, maxWidth: 380, margin: "0 auto 18px" }}>
            Uma campanha agrupa categorias, filtros e grupos do WhatsApp que vão receber as ofertas. Comece criando uma campanha e depois conecte os grupos.
          </div>
          <button onClick={() => setShowCreate(true)} style={{ padding: "9px 22px", borderRadius: 10, background: PRIMARY, color: "#fff", border: "none", fontSize: 14, cursor: "pointer", fontWeight: 500 }}>+ Criar campanha</button>
        </div>
      ) : (
        <>
          <div style={{ display: "flex", gap: 10, marginBottom: 24, flexWrap: "wrap" }}>
            <StatCard label="Envios hoje" value={groups.reduce((a, g) => a + g.sentToday, 0)} color={PRIMARY_DARK} />
            <StatCard label="Envios semana" value={groups.reduce((a, g) => a + g.sentWeek, 0)} />
            <StatCard label="Campanhas ativas" value={`${groups.filter(g => getGroupStats(g, whatsappGroups).status === "connected").length}/${groups.length}`} color="#854F0B" />
            <StatCard label="Para revisar" value={groups.reduce((a, g) => a + g.pending.length, 0)} color={groups.reduce((a, g) => a + g.pending.length, 0) > 0 ? "#854F0B" : undefined} />
          </div>
          <h3 style={{ fontSize: 13, fontWeight: 500, marginBottom: 12, color: "var(--color-text-secondary)" }}>Campanhas &mdash; clique para gerenciar</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {groups.map(g => {
              const stats = getGroupStats(g, whatsappGroups);
              const statusBadge = stats.status === "connected"
                ? <Badge color="green">{stats.connected}/{stats.count} conectados</Badge>
                : stats.status === "empty"
                  ? <Badge color="gray">Sem grupos</Badge>
                  : <Badge color="red">Desconectado</Badge>;
              return (
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
                        {getGroupCategories(g).map(c => <Badge key={c} color={categoryColor(c)}>{categoryLabel(c)}</Badge>)}
                        {statusBadge}
                        <Badge color="gray">{stats.count} grupo{stats.count !== 1 ? "s" : ""} · {stats.members} membros</Badge>
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
                      <div style={{ width: 80 }}><MiniBar data={g.weekData} color={getGroupCategories(g)[0] === "gamer" ? "#378ADD" : PRIMARY} /></div>
                      <div style={{ fontSize: 18, color: "var(--color-text-secondary)" }}>&rsaquo;</div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {showCreate && (
        <Modal title="Nova campanha" onClose={() => setShowCreate(false)}>
          <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 14 }}>
            Defina o nome e as categorias de produtos que esta campanha vai monitorar. Você poderá vincular grupos do WhatsApp depois.
          </div>
          <div style={{ background: PRIMARY_LIGHT, color: "#0F6E56", padding: "8px 12px", borderRadius: 8, fontSize: 12, marginBottom: 14, lineHeight: 1.4 }}>
            💡 Já vamos preencher os defaults pra você: modelo de mensagem, filtros (desconto ≥ 25%, avaliação ≥ 4.0), todas as fontes ativas e dois horários de scraping. Tudo isso pode ser ajustado depois.
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div>
              <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Nome da campanha</label>
              <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Ex: Tech BR" style={{ width: "100%", padding: "9px 12px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13, boxSizing: "border-box" }} />
            </div>
            <div>
              <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 6 }}>Categorias (selecione uma ou mais)</label>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {Object.keys(CATEGORIES).map(id => {
                  const active = form.categories.includes(id);
                  return (
                    <div
                      key={id}
                      onClick={() => toggleFormCategory(id)}
                      style={{ padding: "6px 14px", borderRadius: 8, border: `0.5px solid ${active ? PRIMARY : "var(--color-border-tertiary)"}`, background: active ? PRIMARY_LIGHT : "transparent", color: active ? "#0F6E56" : "var(--color-text-secondary)", fontSize: 13, cursor: "pointer", fontWeight: active ? 500 : 400, userSelect: "none" }}
                    >
                      {active ? "✓ " : ""}{categoryLabel(id)}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 18 }}>
            <button onClick={() => setShowCreate(false)} style={{ padding: "8px 16px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 13, cursor: "pointer" }}>Cancelar</button>
            <button onClick={submit} disabled={!form.name.trim() || form.categories.length === 0} style={{ padding: "8px 16px", borderRadius: 8, background: PRIMARY, color: "#fff", border: "none", fontSize: 13, cursor: "pointer", fontWeight: 500, opacity: (!form.name.trim() || form.categories.length === 0) ? 0.5 : 1 }}>Criar campanha</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
