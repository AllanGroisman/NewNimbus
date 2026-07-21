import { useState, useEffect } from "react";
import { PRIMARY, PRIMARY_DARK, PRIMARY_LIGHT, CATEGORIES, categoryLabel, categoryColor, categoryIcon, getGroupCategories, getGroupStats, formatTimeBR, formatDateTimeBR, isSameDayBR } from "../data/constants";
import Badge from "../components/ui/Badge";
import UsageBadge from "../components/ui/UsageBadge";
import Modal from "../components/ui/Modal";

// Calcula status da janela: ativa agora (até quando) ou próxima (em quanto tempo).
function getWindowStatus(group, now = new Date()) {
  const windows = (group?.schedule?.windows || []).slice().sort((a, b) => (a.from || "").localeCompare(b.from || ""));
  if (!windows.length) return { kind: "none", text: "Nenhuma janela configurada" };
  const hhmm = (s) => { const [h, m] = String(s || "0:0").split(":").map(Number); return (h || 0) * 60 + (m || 0); };
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const fmtMins = (m) => {
    if (m <= 0) return "agora";
    const h = Math.floor(m / 60);
    const min = m % 60;
    if (h > 0 && min > 0) return `${h}h${String(min).padStart(2, "0")}`;
    if (h > 0) return `${h}h`;
    return `${min}min`;
  };
  for (const w of windows) {
    const from = hhmm(w.from), to = hhmm(w.to);
    if (nowMin >= from && nowMin < to) {
      return { kind: "current", text: `Ativa até ${w.to}`, sub: `${fmtMins(to - nowMin)} restantes` };
    }
  }
  for (const w of windows) {
    if (nowMin < hhmm(w.from)) {
      return { kind: "next", text: `Próxima: ${w.from}`, sub: `em ${fmtMins(hhmm(w.from) - nowMin)}` };
    }
  }
  const first = windows[0];
  const wait = (24 * 60 - nowMin) + hhmm(first.from);
  return { kind: "next", text: `Amanhã ${first.from}`, sub: `em ${fmtMins(wait)}` };
}

export default function PageDashboard({ groups, whatsappGroups = [], onSelectGroup, onCreateGroup, onUpdate, affiliateConfigured = true, onGoToSettings, limits }) {
  const [showCreate, setShowCreate] = useState(false);
  // type: null = tela de escolha; "scraping" | "repasse" = formulário do tipo.
  const [form, setForm] = useState({ name: "", categories: [], type: null, autoApprove: false });
  // Guarda o grupo aguardando confirmação de pause — retomar é seguro e não pede confirmação.
  const [pendingPause, setPendingPause] = useState(null);
  // Re-renderiza por minuto pra manter "próxima janela" / "tempo restante" em dia.
  const [, setNowTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setNowTick(t => t + 1), 60 * 1000);
    return () => clearInterval(id);
  }, []);

  const toggleFormCategory = (id) => setForm(f => ({
    ...f,
    categories: f.categories.includes(id) ? f.categories.filter(c => c !== id) : [...f.categories, id],
  }));

  const closeCreate = () => {
    setShowCreate(false);
    setForm({ name: "", categories: [], type: null, autoApprove: false });
  };

  const submit = () => {
    if (form.type === "repasse") {
      if (!form.name.trim()) return;
      onCreateGroup({ name: form.name.trim(), categories: [], type: "repasse", repasse: { autoApprove: form.autoApprove } });
    } else {
      if (!form.name.trim() || form.categories.length === 0) return;
      onCreateGroup({ name: form.name.trim(), categories: form.categories, type: "scraping" });
    }
    closeCreate();
  };

  const togglePause = (g) => {
    if (!onUpdate) return;
    if (g.paused) onUpdate(g.id, { paused: false });
    else setPendingPause(g);
  };
  const confirmPauseNow = () => {
    if (!pendingPause) return;
    onUpdate(pendingPause.id, { paused: true });
    setPendingPause(null);
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20, flexWrap: "wrap", gap: 10 }}>
        <h2 style={{ fontSize: 18, fontWeight: 500, display: "flex", alignItems: "center", gap: 8 }}>
          Campanhas
          <UsageBadge current={groups.length} limit={limits?.groups} label="campanhas criadas" />
        </h2>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button onClick={() => setShowCreate(true)} style={{ padding: "7px 14px", borderRadius: 8, background: PRIMARY, color: "#fff", border: "none", fontSize: 13, cursor: "pointer", fontWeight: 500 }}>+ Nova campanha</button>
        </div>
      </div>

      {!affiliateConfigured && groups.length > 0 && (
        <div style={{ background: "#FEF3C7", border: "0.5px solid #F4D08A", borderRadius: 10, padding: "10px 14px", marginBottom: 16, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: 16 }}>⚠️</span>
          <span style={{ fontSize: 13, color: "#854F0B", flex: 1, minWidth: 200 }}>
            Campanhas do Mercado Livre estão <strong>pausadas</strong> — configure a TAG e o cookie de afiliado para retomar os envios.
          </span>
          {onGoToSettings && (
            <button onClick={onGoToSettings} style={{ padding: "6px 12px", borderRadius: 8, background: "#854F0B", color: "#fff", border: "none", fontSize: 12, cursor: "pointer", fontWeight: 500 }}>
              Configurar afiliado
            </button>
          )}
        </div>
      )}

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
          <h3 style={{ fontSize: 13, fontWeight: 500, marginBottom: 12, color: "var(--color-text-secondary)" }}>Campanhas &mdash; clique para gerenciar</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {groups.map(g => {
              const stats = getGroupStats(g, whatsappGroups, { affiliateConfigured });
              const cats = getGroupCategories(g);
              const sources = (g.scraping?.sources || []);
              const win = getWindowStatus(g);
              // Estado efetivo: manual OU afiliado faltando OU sem WhatsApp conectado —
              // botão reflete todos. (degraded/parcial ainda envia, então não pausa.)
              const isPaused = !!g.paused || stats.pausedByAffiliate || stats.status === "disconnected";
              const isLive = !stats.paused && stats.status === "connected";
              const missingAff = stats.pausedByAffiliateML && stats.pausedByAffiliateShopee
                ? "ML e Shopee"
                : stats.pausedByAffiliateML
                  ? "ML"
                  : stats.pausedByAffiliateShopee
                    ? "Shopee"
                    : null;
              const statusBadge = stats.pausedManual
                ? <Badge color="amber">Campanha pausada</Badge>
                : stats.pausedByAffiliate
                  ? <Badge color="amber">Pausado · sem afiliado {missingAff}</Badge>
                  : stats.status === "connected"
                    ? <Badge color="green">Ativa</Badge>
                    : stats.status === "degraded"
                      ? <Badge color="amber">Parcial · algum WhatsApp caiu</Badge>
                      : stats.status === "empty"
                        ? <Badge color="gray">Sem grupos</Badge>
                        : <Badge color="red">Pausada · sem WhatsApp</Badge>;
              return (
                <div
                  key={g.id}
                  onClick={() => onSelectGroup(g)}
                  style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: "14px 16px", cursor: "pointer" }}
                  onMouseEnter={e => e.currentTarget.style.borderColor = PRIMARY}
                  onMouseLeave={e => e.currentTarget.style.borderColor = "var(--color-border-tertiary)"}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, gap: 10, flexWrap: "wrap" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", minWidth: 0, flex: 1 }}>
                      {isLive && <span className="live-dot" title="Campanha funcionando" />}
                      <span style={{ fontSize: 15, fontWeight: 500 }}>{g.name}</span>
                      {statusBadge}
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        // Pausa por afiliado faltando OU sem WhatsApp: clicar abre a
                        // campanha pra ver o alerta — pausar/retomar manual aqui não
                        // resolve sozinho.
                        if (stats.pausedByAffiliate && !g.paused) { onSelectGroup(g); return; }
                        if (stats.status === "disconnected" && !g.paused && !stats.pausedByAffiliate) { onSelectGroup(g); return; }
                        togglePause(g);
                      }}
                      title={
                        g.paused ? "Reativar campanha"
                          : stats.pausedByAffiliate ? `Configure o afiliado ${missingAff} para reativar`
                          : stats.status === "disconnected" ? "Conecte um WhatsApp para reativar (retoma sozinho)"
                          : "Pausar campanha"
                      }
                      style={{
                        padding: "6px 14px", borderRadius: 8,
                        border: `0.5px solid ${isPaused ? "#22C55E" : "#E24B4A"}`,
                        background: isPaused ? "#22C55E" : "#E24B4A",
                        color: "#fff",
                        fontSize: 12, cursor: "pointer", fontWeight: 500,
                      }}
                    >
                      {isPaused ? "▶ Ativar" : "⏸ Pausar"}
                    </button>
                  </div>

                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
                      gap: 10,
                      background: "var(--color-background-secondary)",
                      border: "0.5px solid var(--color-border-tertiary)",
                      borderRadius: 10,
                      padding: "10px 12px",
                    }}
                  >
                    <div>
                      <div style={{ fontSize: 10, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>Categorias</div>
                      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                        {cats.length === 0
                          ? <span style={{ fontSize: 12, color: "var(--color-text-secondary)", fontStyle: "italic" }}>nenhuma</span>
                          : cats.map(c => <Badge key={c} color={categoryColor(c)}><span style={{ marginRight: 4 }}>{categoryIcon(c)}</span>{categoryLabel(c)}</Badge>)}
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: 10, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>Grupos</div>
                      <div style={{ fontSize: 13, fontWeight: 500, color: "var(--color-text-primary)" }}>
                        {limits?.whatsappGroupsPerCampaign == null
                          ? stats.count
                          : limits.whatsappGroupsPerCampaign >= 99
                            ? `${stats.count} (ilimitado)`
                            : `${stats.count}/${limits.whatsappGroupsPerCampaign}`}
                      </div>
                      <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 1 }}>{stats.members} membro{stats.members !== 1 ? "s" : ""}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 10, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>Fila</div>
                      <div style={{ fontSize: 13, fontWeight: 500, color: "var(--color-text-primary)" }}>{g.queue.length}</div>
                      {g.pending.length > 0 && <div style={{ fontSize: 11, color: "#854F0B", marginTop: 1 }}>+{g.pending.length} p/ revisar</div>}
                    </div>
                    <div>
                      <div style={{ fontSize: 10, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>Lojas</div>
                      <div style={{ fontSize: 12, color: "var(--color-text-primary)", lineHeight: 1.35 }} title={sources.join(", ")}>
                        {sources.length === 0
                          ? <span style={{ color: "var(--color-text-secondary)", fontStyle: "italic" }}>nenhuma</span>
                          : sources.join(", ")}
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: 10, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>Último envio</div>
                      <div style={{ fontSize: 13, fontWeight: 500, color: "var(--color-text-primary)" }}>
                        {g.lastSend && g.lastSend !== "—"
                          ? (isSameDayBR(g.lastSend) ? `hoje, ${formatTimeBR(g.lastSend)}` : formatDateTimeBR(g.lastSend))
                          : <span style={{ color: "var(--color-text-secondary)", fontWeight: 400 }}>nenhum</span>}
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: 10, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>
                        {win.kind === "current" ? "Janela atual" : "Próxima janela"}
                      </div>
                      <div style={{ fontSize: 13, fontWeight: 500, color: win.kind === "current" ? PRIMARY_DARK : "var(--color-text-primary)" }}>
                        {win.text}
                      </div>
                      {win.sub && <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 1 }}>{win.sub}</div>}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {pendingPause && (
        <Modal title="Pausar campanha?" onClose={() => setPendingPause(null)} danger>
          <p style={{ fontSize: 13, marginBottom: 16, color: "var(--color-text-secondary)", lineHeight: 1.5 }}>
            Enquanto <strong style={{ color: "var(--color-text-primary)" }}>{pendingPause.name}</strong> estiver pausada, ela não vai buscar produtos novos do catálogo nem enviar mensagens para os grupos vinculados. Você pode retomar a qualquer momento.
          </p>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button onClick={() => setPendingPause(null)} style={{ padding: "8px 16px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 13, cursor: "pointer" }}>Cancelar</button>
            <button
              onClick={confirmPauseNow}
              style={{ padding: "8px 16px", borderRadius: 8, background: "#E24B4A", color: "#fff", border: "none", fontSize: 13, cursor: "pointer", fontWeight: 500 }}
            >
              Sim, pausar
            </button>
          </div>
        </Modal>
      )}

      {showCreate && (
        <Modal title="Nova campanha" onClose={closeCreate}>
          {form.type === null ? (
            // Passo 1: escolher o tipo de campanha.
            <>
              <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 14 }}>
                Escolha como esta campanha vai encontrar os produtos que serão enviados.
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div
                  onClick={() => setForm(f => ({ ...f, type: "scraping" }))}
                  style={{ padding: "14px 16px", borderRadius: 10, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", cursor: "pointer" }}
                >
                  <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>🔎 Original</div>
                  <div style={{ fontSize: 12, color: "var(--color-text-secondary)", lineHeight: 1.4 }}>
                    O sistema busca ofertas automaticamente no Mercado Livre, Shopee e Amazon conforme as categorias e filtros que você definir.
                  </div>
                </div>
                <div
                  onClick={() => setForm(f => ({ ...f, type: "repasse" }))}
                  style={{ padding: "14px 16px", borderRadius: 10, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", cursor: "pointer" }}
                >
                  <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>🔁 Repasse</div>
                  <div style={{ fontSize: 12, color: "var(--color-text-secondary)", lineHeight: 1.4 }}>
                    Em vez de buscar produtos, o sistema escuta um <strong>grupo líder</strong> e captura os links de produto postados nele, re-afiliando com a sua TAG. Os grupos vinculados replicam as ofertas do líder.
                  </div>
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 18 }}>
                <button onClick={closeCreate} style={{ padding: "8px 16px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 13, cursor: "pointer" }}>Cancelar</button>
              </div>
            </>
          ) : form.type === "repasse" ? (
            // Passo 2b: campanha de repasse.
            <>
              <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 14 }}>
                Dê um nome à campanha. Você vai escolher o <strong>grupo líder</strong> e os grupos que recebem as ofertas depois, dentro da campanha.
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div>
                  <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Nome da campanha</label>
                  <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Ex: Repasse Ofertas Tech" style={{ width: "100%", padding: "9px 12px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13, boxSizing: "border-box" }} />
                </div>
                <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
                  <input type="checkbox" checked={form.autoApprove} onChange={e => setForm(f => ({ ...f, autoApprove: e.target.checked }))} />
                  <span style={{ fontSize: 13 }}>
                    Aprovação automática
                    <span style={{ display: "block", fontSize: 11, color: "var(--color-text-secondary)" }}>
                      {form.autoApprove ? "Links capturados vão direto pra fila de envio." : "Links capturados vão para revisão antes de enviar."}
                    </span>
                  </span>
                </label>
              </div>
              <div style={{ display: "flex", gap: 8, justifyContent: "space-between", marginTop: 18 }}>
                <button onClick={() => setForm(f => ({ ...f, type: null }))} style={{ padding: "8px 16px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 13, cursor: "pointer" }}>← Voltar</button>
                <button onClick={submit} disabled={!form.name.trim()} style={{ padding: "8px 16px", borderRadius: 8, background: PRIMARY, color: "#fff", border: "none", fontSize: 13, cursor: "pointer", fontWeight: 500, opacity: !form.name.trim() ? 0.5 : 1 }}>Criar campanha</button>
              </div>
            </>
          ) : (
            // Passo 2a: campanha original (scraping).
            <>
              <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 14 }}>
                Defina o nome e as categorias de produtos que esta campanha vai monitorar. Você poderá vincular grupos do WhatsApp depois.
              </div>
              <div style={{ background: PRIMARY_LIGHT, color: PRIMARY_DARK, padding: "8px 12px", borderRadius: 8, fontSize: 12, marginBottom: 14, lineHeight: 1.4 }}>
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
                          style={{ padding: "6px 14px", borderRadius: 8, border: `0.5px solid ${active ? PRIMARY : "var(--color-border-tertiary)"}`, background: active ? PRIMARY_LIGHT : "transparent", color: active ? PRIMARY_DARK : "var(--color-text-secondary)", fontSize: 13, cursor: "pointer", fontWeight: active ? 500 : 400, userSelect: "none" }}
                        >
                          {active ? "✓ " : ""}<span style={{ marginRight: 4 }}>{categoryIcon(id)}</span>{categoryLabel(id)}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, justifyContent: "space-between", marginTop: 18 }}>
                <button onClick={() => setForm(f => ({ ...f, type: null }))} style={{ padding: "8px 16px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 13, cursor: "pointer" }}>← Voltar</button>
                <button onClick={submit} disabled={!form.name.trim() || form.categories.length === 0} style={{ padding: "8px 16px", borderRadius: 8, background: PRIMARY, color: "#fff", border: "none", fontSize: 13, cursor: "pointer", fontWeight: 500, opacity: (!form.name.trim() || form.categories.length === 0) ? 0.5 : 1 }}>Criar campanha</button>
              </div>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}
