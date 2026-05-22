import { PRIMARY, PRIMARY_DARK, PRIMARY_LIGHT, sidebarItems, getGroupStats } from "../data/constants";

export default function Sidebar({ page, selectedGroup, groups, whatsappGroups = [], numbers = [], affiliateConfigured = true, affiliateStatus, user, onNavigate, onSelectGroup, onLogout, mobileOpen, onToggleMobile }) {
  const nav = (id) => { onNavigate(id); onToggleMobile(false); };
  const selGroup = (g) => { onSelectGroup(g); onToggleMobile(false); };
  const isAdmin = user?.role === "admin";

  const visibleItems = sidebarItems.filter(it => !it.adminOnly);
  const adminItems = sidebarItems.filter(it => it.adminOnly);

  // Alerta de afiliado por aba — vermelho quando a loja não está configurada.
  // Shopee ainda não tem integração, então vai sempre acender enquanto o backend não suportar.
  // WhatsApp acende quando nenhum número está conectado.
  const noWhatsappConnected = numbers.length === 0 || !numbers.some(n => n.status === "connected");
  const affiliateAlert = {
    "mercado-livre": affiliateStatus ? !affiliateStatus.ml : false,
    "amazon":        affiliateStatus ? !affiliateStatus.amazon : false,
    "shopee":        affiliateStatus ? !affiliateStatus.shopee : false,
    "whatsapp":      noWhatsappConnected,
  };

  const renderItem = (item) => {
    const isActive = page === item.id && !selectedGroup;
    const showAlert = !!affiliateAlert[item.id];
    const alertTitle = item.id === "whatsapp" ? "Nenhum WhatsApp conectado" : "Afiliado não configurado";
    return (
      <button
        key={item.id}
        onClick={() => nav(item.id)}
        title={showAlert ? alertTitle : undefined}
        style={{
          display: "flex", alignItems: "center", gap: 10, padding: "9px 16px",
          background: isActive ? PRIMARY_LIGHT : "transparent",
          border: "none", cursor: "pointer", textAlign: "left",
          color: isActive ? PRIMARY_DARK : (showAlert ? "#A32D2D" : "var(--color-text-primary)"),
          fontWeight: isActive ? 600 : 500, fontSize: 13,
        }}
      >
        <span style={{ fontSize: 14 }}>{item.icon}</span>
        <span style={{ flex: 1 }}>{item.label}</span>
        {showAlert && (
          <span
            aria-label={alertTitle}
            style={{
              width: 14, height: 14, borderRadius: "50%", background: "#E24B4A",
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
            <div style={{ fontSize: 16, fontWeight: 500, color: "var(--color-brand)" }}>Nimbus {isAdmin && <span style={{ fontSize: 9, padding: "1px 6px", borderRadius: 4, background: "var(--color-brand)", color: "var(--color-brand-contrast)", marginLeft: 4, verticalAlign: "middle" }}>ADMIN</span>}</div>
            <div style={{ fontSize: 11, color: "var(--color-text-primary)", fontWeight: 500, opacity: 0.75 }}>{isAdmin ? "Painel administrativo" : "Plano Pro"}</div>
          </div>
          <button className="mobile-only" onClick={() => onToggleMobile(false)} style={{ background: "transparent", border: "none", cursor: "pointer", fontSize: 20, color: "var(--color-text-secondary)", padding: "4px" }}>✕</button>
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
          // Verde = funcionando, amarelo = pausado, vermelho = desconectado, cinza = vazio.
          const dotColor = stats.status === "paused" ? "#EF9F27"
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
        <div style={{ fontSize: 16, fontWeight: 500, color: "var(--color-brand)" }}>Nimbus</div>
        <button onClick={() => onToggleMobile(true)} style={{ background: "transparent", border: "none", cursor: "pointer", fontSize: 22, color: "var(--color-text-primary)", padding: "4px 8px", lineHeight: 1 }}>☰</button>
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
