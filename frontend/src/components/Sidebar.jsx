import { PRIMARY, PRIMARY_DARK, PRIMARY_LIGHT, sidebarItems } from "../data/constants";

export default function Sidebar({ page, selectedGroup, groups, onNavigate, onSelectGroup, onLogout, mobileOpen, onToggleMobile }) {
  const nav = (id) => { onNavigate(id); onToggleMobile(false); };
  const selGroup = (g) => { onSelectGroup(g); onToggleMobile(false); };

  const sidebarContent = (
    <>
      <div style={{ padding: "0 16px 16px", borderBottom: "0.5px solid var(--color-border-tertiary)", marginBottom: 8 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 500, color: PRIMARY_DARK }}>Nimbus</div>
            <div style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>Plano Pro</div>
          </div>
          <button className="mobile-only" onClick={() => onToggleMobile(false)} style={{ background: "transparent", border: "none", cursor: "pointer", fontSize: 20, color: "var(--color-text-secondary)", padding: "4px" }}>✕</button>
        </div>
      </div>
      {sidebarItems.map(item => (
        <button
          key={item.id}
          onClick={() => nav(item.id)}
          style={{
            display: "flex", alignItems: "center", gap: 10, padding: "9px 16px",
            background: page === item.id && !selectedGroup ? PRIMARY_LIGHT : "transparent",
            border: "none", cursor: "pointer", textAlign: "left",
            color: page === item.id && !selectedGroup ? PRIMARY_DARK : "var(--color-text-secondary)",
            fontWeight: page === item.id && !selectedGroup ? 500 : 400, fontSize: 13,
          }}
        >
          <span style={{ fontSize: 14 }}>{item.icon}</span>{item.label}
        </button>
      ))}
      <div style={{ margin: "8px 10px 0", borderTop: "0.5px solid var(--color-border-tertiary)", paddingTop: 8 }}>
        <div style={{ fontSize: 11, color: "var(--color-text-secondary)", padding: "4px 6px", marginBottom: 4 }}>Grupos</div>
        {groups.map(g => (
          <button
            key={g.id}
            onClick={() => selGroup(g)}
            style={{
              display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "7px 6px",
              background: selectedGroup?.id === g.id ? PRIMARY_LIGHT : "transparent",
              border: "none", cursor: "pointer", textAlign: "left", borderRadius: 8, fontSize: 12,
              color: selectedGroup?.id === g.id ? PRIMARY_DARK : "var(--color-text-secondary)",
              fontWeight: selectedGroup?.id === g.id ? 500 : 400,
            }}
          >
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: g.status === "connected" ? PRIMARY : "#E24B4A", flexShrink: 0 }} />
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{g.name}</span>
            {g.pending.length > 0 && <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#EF9F27", flexShrink: 0 }} />}
          </button>
        ))}
      </div>
      <div style={{ marginTop: "auto", padding: "16px 16px 0", borderTop: "0.5px solid var(--color-border-tertiary)" }}>
        <button onClick={onLogout} style={{ background: "transparent", border: "none", cursor: "pointer", fontSize: 13, color: "var(--color-text-secondary)" }}>&larr; Sair</button>
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
        <div style={{ fontSize: 16, fontWeight: 500, color: PRIMARY_DARK }}>Nimbus</div>
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
