import { PRIMARY_DARK, PRIMARY_LIGHT, sidebarItems, getGroupStats, STORE_ID_TO_PAGE, storeLockMessage, planLabel } from "../data/constants";
import Logo from "./ui/Logo";

export default function Sidebar({ page, selectedGroup, groups, whatsappGroups = [], numbers = [], affiliateConfigured = true, affiliateStatus, storeLocks = {}, user, billing, onNavigate, onSelectGroup, onLogout, mobileOpen, onToggleMobile }) {
  const nav = (id) => { onNavigate(id); onToggleMobile(false); };
  const selGroup = (g) => { onSelectGroup(g); onToggleMobile(false); };
  const isAdmin = user?.role === "admin";
  // Rótulo do plano vem do billing. Enquanto não carrega (null), não mostra nada —
  // antes era o texto fixo "Plano Pro", que mentia pra quem estava em outro plano.
  const subtitle = isAdmin ? null : planLabel(billing?.effectivePlan, billing?.plans);

  const visibleItems = sidebarItems.filter(it => !it.adminOnly);
  const adminItems = sidebarItems.filter(it => it.adminOnly);

  // Nível de alerta por aba: "red" (crítico) ou "amber" (atenção).
  // Afiliado: vermelho quando a loja não está configurada.
  // Shopee ainda não tem integração, então vai sempre acender enquanto o backend não suportar.
  // WhatsApp: vermelho quando nenhum número está conectado; amarelo quando alguns
  // (mas nem todos) estão desconectados. Usa o status ao vivo das sessões (via App).
  const connectedCount = numbers.filter(n => n.status === "connected").length;
  const whatsappLevel = numbers.length === 0 || connectedCount === 0 ? "red"
    : connectedCount < numbers.length ? "amber"
    : null;
  // Aba de loja trancada pelo admin: cadeado no lugar do alerta de afiliado —
  // não adianta pedir pro usuário configurar algo que ele não pode usar agora.
  const lockedPages = {};
  for (const [storeId, pageId] of Object.entries(STORE_ID_TO_PAGE)) {
    const msg = storeLockMessage(storeLocks, storeId);
    if (msg) lockedPages[pageId] = msg;
  }
  const alertLevel = {
    "mercado-livre": affiliateStatus && !affiliateStatus.ml ? "red" : null,
    "amazon":        affiliateStatus && !affiliateStatus.amazon ? "red" : null,
    "shopee":        affiliateStatus && !affiliateStatus.shopee ? "red" : null,
    "whatsapp":      whatsappLevel,
  };
  for (const pageId of Object.keys(lockedPages)) alertLevel[pageId] = null;

  const renderItem = (item) => {
    const isActive = page === item.id && !selectedGroup;
    const lockMsg = lockedPages[item.id] || null;
    const level = alertLevel[item.id] || null;
    const showAlert = !!level;
    const alertTitle = item.id === "whatsapp"
      ? (level === "amber" ? "Alguns números de WhatsApp desconectados" : "Nenhum WhatsApp conectado")
      : "Afiliado não configurado";
    const badgeBg = level === "amber" ? "#EF9F27" : "#E24B4A";
    const alertTextColor = level === "amber" ? "var(--warn-text)" : "var(--danger-text)";
    return (
      <button
        key={item.id}
        data-tour={`nav-${item.id}`}
        onClick={() => nav(item.id)}
        title={lockMsg || (showAlert ? alertTitle : undefined)}
        style={{
          display: "flex", alignItems: "center", gap: 10, padding: "9px 16px",
          background: isActive ? PRIMARY_LIGHT : "transparent",
          border: "none", cursor: "pointer", textAlign: "left",
          color: isActive ? PRIMARY_DARK : (showAlert ? alertTextColor : "var(--color-text-primary)"),
          fontWeight: isActive ? 600 : 500, fontSize: 13,
          opacity: lockMsg ? 0.6 : 1,
        }}
      >
        <span style={{ fontSize: 14 }}>{item.icon}</span>
        <span style={{ flex: 1 }}>{item.label}</span>
        {lockMsg && <span aria-label="Loja indisponível" style={{ fontSize: 11, flexShrink: 0 }}>🔒</span>}
        {showAlert && (
          <span
            aria-label={alertTitle}
            style={{
              width: 14, height: 14, borderRadius: "50%", background: badgeBg,
              color: "#fff", fontSize: 10, fontWeight: 700, lineHeight: "14px",
              textAlign: "center", flexShrink: 0,
            }}
          >!</span>
        )}
      </button>
    );
  };

  const sidebarContent = (
    <>
      <div style={{ padding: "0 16px 16px", borderBottom: "0.5px solid var(--color-border-tertiary)", marginBottom: 8 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <button
              onClick={() => nav("dashboard")}
              title="Ir para o início"
              aria-label="Nimbus — ir para Campanhas"
              style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 16, fontWeight: 500, color: "var(--color-brand)", background: "transparent", border: "none", padding: 0, cursor: "pointer", textAlign: "left" }}
            >
              <Logo size={22} />
              <span>Nimbus {isAdmin && <span style={{ fontSize: 9, padding: "1px 6px", borderRadius: 4, background: "var(--color-brand)", color: "var(--color-brand-contrast)", marginLeft: 4, verticalAlign: "middle" }}>ADMIN</span>}</span>
            </button>
            {subtitle && <div style={{ fontSize: 11, color: "var(--color-text-primary)", fontWeight: 500, opacity: 0.75 }}>{subtitle}</div>}
          </div>
          <button className="mobile-only" aria-label="Fechar menu" onClick={() => onToggleMobile(false)} style={{ background: "transparent", border: "none", cursor: "pointer", fontSize: 20, color: "var(--color-text-secondary)", padding: "4px" }}>✕</button>
        </div>
      </div>
      {visibleItems.map(renderItem)}
      {isAdmin && adminItems.length > 0 && (
        <div style={{ margin: "8px 10px 0", borderTop: "0.5px solid var(--color-border-tertiary)", paddingTop: 8 }}>
          <div style={{ fontSize: 11, color: "var(--color-text-primary)", padding: "4px 6px", marginBottom: 4, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 }}>Admin</div>
          {adminItems.map(renderItem)}
        </div>
      )}
      <div style={{ margin: "8px 10px 0", borderTop: "0.5px solid var(--color-border-tertiary)", paddingTop: 8 }}>
        <div style={{ fontSize: 11, color: "var(--color-text-primary)", padding: "4px 6px", marginBottom: 4, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 }}>Campanhas</div>
        {groups.length === 0 && (
          <div style={{ fontSize: 11, color: "var(--color-text-secondary)", padding: "6px 6px", fontStyle: "italic" }}>Nenhuma campanha ainda</div>
        )}
        {groups.map(g => {
          const stats = getGroupStats(g, whatsappGroups, { affiliateConfigured });
          // Verde = todos conectados, amarelo = pausado ou parcial (algum whats caído),
          // vermelho = sem whats conectado (pausada), cinza = vazio.
          const dotColor = (stats.status === "paused" || stats.status === "degraded") ? "#EF9F27"
            : stats.status === "connected" ? "#22C55E"
            : stats.status === "empty" ? "var(--color-border-secondary)"
            : "#E24B4A";
          return (
            <button
              key={g.id}
              onClick={() => selGroup(g)}
              style={{
                display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "7px 6px",
                background: selectedGroup?.id === g.id ? PRIMARY_LIGHT : "transparent",
                border: "none", cursor: "pointer", textAlign: "left", borderRadius: 8, fontSize: 12,
                color: selectedGroup?.id === g.id ? PRIMARY_DARK : "var(--color-text-primary)",
                fontWeight: selectedGroup?.id === g.id ? 600 : 500,
              }}
            >
              <span style={{ width: 7, height: 7, borderRadius: "50%", background: dotColor, flexShrink: 0 }} />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{g.name}</span>
              {stats.count > 1 && <span style={{ fontSize: 10, color: "var(--color-text-secondary)", flexShrink: 0 }}>{stats.count}</span>}
              {g.pending.length > 0 && <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#EF9F27", flexShrink: 0 }} />}
            </button>
          );
        })}
      </div>
      <div style={{ marginTop: "auto", padding: "16px 16px 0", borderTop: "0.5px solid var(--color-border-tertiary)" }}>
        <button onClick={onLogout} style={{ background: "transparent", border: "none", cursor: "pointer", fontSize: 13, color: "var(--color-text-primary)", fontWeight: 500 }}>&larr; Sair</button>
      </div>
    </>
  );

  return (
    <>
      {/* Mobile top bar */}
      <div className="mobile-only" style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "10px 16px", borderBottom: "0.5px solid var(--color-border-tertiary)",
        background: "var(--color-background-primary)", position: "sticky", top: 0, zIndex: 90,
      }}>
        <button
          onClick={() => nav("dashboard")}
          title="Ir para o início"
          aria-label="Nimbus — ir para Campanhas"
          style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 16, fontWeight: 500, color: "var(--color-brand)", background: "transparent", border: "none", padding: 0, cursor: "pointer", textAlign: "left" }}
        >
          <Logo size={20} />
          <span>Nimbus</span>
        </button>
        <button onClick={() => onToggleMobile(true)} aria-label="Abrir menu" style={{ background: "transparent", border: "none", cursor: "pointer", fontSize: 22, color: "var(--color-text-primary)", padding: "4px 8px", lineHeight: 1 }}>☰</button>
      </div>

      {/* Desktop sidebar */}
      <div className="desktop-only" style={{
        width: 200, flexShrink: 0, borderRight: "0.5px solid var(--color-border-tertiary)",
        display: "flex", flexDirection: "column", padding: "16px 0",
      }}>
        {sidebarContent}
      </div>

      {/* Mobile drawer overlay */}
      {mobileOpen && (
        <div className="mobile-only" onClick={() => onToggleMobile(false)} style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 98,
        }} />
      )}

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="mobile-only" style={{
          position: "fixed", top: 0, left: 0, bottom: 0, width: 260, zIndex: 99,
          display: "flex", flexDirection: "column", padding: "16px 0",
          background: "var(--color-background-primary)", overflowY: "auto",
          boxShadow: "2px 0 12px rgba(0,0,0,0.15)",
        }}>
          {sidebarContent}
        </div>
      )}
    </>
  );
}
