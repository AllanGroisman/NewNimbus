import { useState } from "react";
import { initialGroups, initialNumbers } from "./data/mockData";
import Sidebar from "./components/Sidebar";
import GroupDashboard from "./components/GroupDashboard";
import PageDashboard from "./pages/Dashboard";
import PageProducts from "./pages/Products";
import PageWhatsApp from "./pages/WhatsApp";
import PageSettings from "./pages/Settings";
import PageSubscription from "./pages/Subscription";
import Login from "./pages/Login";

export default function App() {
  const [groups, setGroups] = useState(initialGroups);
  const [numbers, setNumbers] = useState(initialNumbers);
  const [page, setPage] = useState("dashboard");
  const [selectedGroup, setSelectedGroup] = useState(null);
  const [loggedIn, setLoggedIn] = useState(false);
  const [mobileMenu, setMobileMenu] = useState(false);

  const handleSelectGroup = g => { setSelectedGroup(groups.find(x => x.id === g.id)); setPage("group"); };
  const handleBack = () => { setSelectedGroup(null); setPage("dashboard"); };
  const handleUpdate = (gid, updates) => {
    setGroups(gs => gs.map(g => g.id === gid ? { ...g, ...updates } : g));
    setSelectedGroup(g => g ? { ...g, ...updates } : g);
  };
  const handleDelete = (gid) => {
    setGroups(gs => gs.filter(g => g.id !== gid));
    setSelectedGroup(null);
    setPage("dashboard");
  };

  if (!loggedIn) {
    return <Login onLogin={() => setLoggedIn(true)} />;
  }

  const pageMap = {
    dashboard: <PageDashboard groups={groups} onSelectGroup={handleSelectGroup} />,
    products: <PageProducts />,
    whatsapp: <PageWhatsApp numbers={numbers} setNumbers={setNumbers} groups={groups} />,
    settings: <PageSettings onLogout={() => setLoggedIn(false)} />,
    subscription: <PageSubscription />,
  };

  return (
    <div className="app-layout" style={{ display: "flex", minHeight: "100vh" }}>
      <Sidebar
        page={page}
        selectedGroup={selectedGroup}
        groups={groups}
        onNavigate={(id) => { setPage(id); setSelectedGroup(null); }}
        onSelectGroup={handleSelectGroup}
        onLogout={() => setLoggedIn(false)}
        mobileOpen={mobileMenu}
        onToggleMobile={setMobileMenu}
      />
      <div className="main-content" style={{ flex: 1, padding: "20px 24px", minWidth: 0, overflowY: "auto" }}>
        {selectedGroup
          ? <GroupDashboard group={selectedGroup} numbers={numbers} onBack={handleBack} onUpdate={handleUpdate} onDelete={handleDelete} />
          : pageMap[page] || pageMap["dashboard"]
        }
      </div>
    </div>
  );
}
