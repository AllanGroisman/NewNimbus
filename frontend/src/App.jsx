import { useState } from "react";
import { initialGroups, initialNumbers, initialWhatsappGroups, makeEmptyGroup } from "./data/mockData";
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
  const [whatsappGroups, setWhatsappGroups] = useState(initialWhatsappGroups);
  const [page, setPage] = useState("dashboard");
  const [selectedGroup, setSelectedGroup] = useState(null);
  const [loggedIn, setLoggedIn] = useState(false);
  const [mobileMenu, setMobileMenu] = useState(false);

  const handleCreateGroup = ({ name, categories }) => {
    const newGroup = makeEmptyGroup({ id: Date.now(), name, categories });
    setGroups(gs => [...gs, newGroup]);
    setSelectedGroup(newGroup);
    setPage("group");
    return newGroup.id;
  };

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

  // Registra um grupo do WhatsApp já criado no backend (Baileys).
  // Se `id` não vier, gera um id local (caso de teste/sem backend).
  // Se `linkToAppGroupId` for informado, vincula à campanha indicada.
  const createWhatsappGroup = ({ id, name, numberId, members = 0, inviteLink, linkToAppGroupId }) => {
    const wgId = id || Date.now();
    const newWG = {
      id: wgId, name, members,
      status: "connected", numberId,
      createdAt: "agora",
      inviteLink: inviteLink || null,
      sentToday: 0, lastSend: "—",
    };
    setWhatsappGroups(ws => [...ws, newWG]);
    if (linkToAppGroupId) {
      setGroups(gs => gs.map(g => g.id === linkToAppGroupId
        ? { ...g, whatsappGroupIds: [...(g.whatsappGroupIds || []), wgId] }
        : g
      ));
      setSelectedGroup(g => g && g.id === linkToAppGroupId
        ? { ...g, whatsappGroupIds: [...(g.whatsappGroupIds || []), wgId] }
        : g
      );
    }
    return wgId;
  };

  // Remove um grupo do WhatsApp por completo (e de todas as campanhas)
  const deleteWhatsappGroup = (wgId) => {
    setWhatsappGroups(ws => ws.filter(w => w.id !== wgId));
    setGroups(gs => gs.map(g => ({ ...g, whatsappGroupIds: (g.whatsappGroupIds || []).filter(id => id !== wgId) })));
    setSelectedGroup(g => g ? { ...g, whatsappGroupIds: (g.whatsappGroupIds || []).filter(id => id !== wgId) } : g);
  };

  // Atualiza o status (conectar/desconectar) de um grupo do WhatsApp
  const setWhatsappGroupStatus = (wgId, status) => {
    setWhatsappGroups(ws => ws.map(w => w.id === wgId ? { ...w, status } : w));
  };

  // Atualiza campos arbitrários de um grupo do WhatsApp
  const updateWhatsappGroup = (wgId, updates) => {
    setWhatsappGroups(ws => ws.map(w => w.id === wgId ? { ...w, ...updates } : w));
  };

  if (!loggedIn) {
    return <Login onLogin={() => setLoggedIn(true)} />;
  }

  const pageMap = {
    dashboard: <PageDashboard groups={groups} whatsappGroups={whatsappGroups} onSelectGroup={handleSelectGroup} onCreateGroup={handleCreateGroup} />,
    products: <PageProducts />,
    whatsapp: <PageWhatsApp
      numbers={numbers}
      setNumbers={setNumbers}
      groups={groups}
      whatsappGroups={whatsappGroups}
      onCreateWhatsappGroup={createWhatsappGroup}
      onDeleteWhatsappGroup={deleteWhatsappGroup}
      onSetWhatsappGroupStatus={setWhatsappGroupStatus}
      onUpdateWhatsappGroup={updateWhatsappGroup}
    />,
    settings: <PageSettings onLogout={() => setLoggedIn(false)} />,
    subscription: <PageSubscription />,
  };

  return (
    <div className="app-layout" style={{ display: "flex", minHeight: "100vh" }}>
      <Sidebar
        page={page}
        selectedGroup={selectedGroup}
        groups={groups}
        whatsappGroups={whatsappGroups}
        onNavigate={(id) => { setPage(id); setSelectedGroup(null); }}
        onSelectGroup={handleSelectGroup}
        onLogout={() => setLoggedIn(false)}
        mobileOpen={mobileMenu}
        onToggleMobile={setMobileMenu}
      />
      <div className="main-content" style={{ flex: 1, padding: "20px 24px", minWidth: 0, overflowY: "auto" }}>
        {selectedGroup
          ? <GroupDashboard
              group={selectedGroup}
              numbers={numbers}
              whatsappGroups={whatsappGroups}
              onBack={handleBack}
              onUpdate={handleUpdate}
              onDelete={handleDelete}
              onCreateWhatsappGroup={createWhatsappGroup}
              onDeleteWhatsappGroup={deleteWhatsappGroup}
              onUpdateWhatsappGroup={updateWhatsappGroup}
            />
          : pageMap[page] || pageMap["dashboard"]
        }
      </div>
    </div>
  );
}
