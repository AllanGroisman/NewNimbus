import { useState, useEffect, useRef } from "react";
import { initialGroups, initialNumbers, initialWhatsappGroups, makeEmptyGroup, DEFAULT_MESSAGE_TEMPLATE } from "./data/mockData";
import { allSources } from "./data/constants";

const DEFAULT_SETTINGS = {
  messageTemplate: DEFAULT_MESSAGE_TEMPLATE,
  notifications: { email: true, push: false, weeklyReport: true, pendingReview: true },
  sources: allSources,
  theme: "auto",
};
import { authMe, authLogout, loadAppState, saveAppState, loadAppOps, getToken } from "./data/api";
import Sidebar from "./components/Sidebar";
import GroupDashboard from "./components/GroupDashboard";
import PageDashboard from "./pages/Dashboard";
import PageProducts from "./pages/Products";
import PageWhatsApp from "./pages/WhatsApp";
import PageSettings from "./pages/Settings";
import PageSubscription from "./pages/Subscription";
import Login from "./pages/Login";

const SAVE_DEBOUNCE_MS = 800;
const OPS_POLL_MS = 30 * 1000;
// Campos por grupo gerenciados pelo scheduler — atualizados por polling
const OPS_FIELDS = ["queue", "pending", "history", "sentToday", "sentWeek", "weekData", "lastSend", "avgDiscount"];

export default function App() {
  const [groups, setGroups] = useState(initialGroups);
  const [numbers, setNumbers] = useState(initialNumbers);
  const [whatsappGroups, setWhatsappGroups] = useState(initialWhatsappGroups);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [page, setPage] = useState("dashboard");
  const [selectedGroup, setSelectedGroup] = useState(null);
  const [user, setUser] = useState(null);
  const [bootstrapping, setBootstrapping] = useState(true);
  const [mobileMenu, setMobileMenu] = useState(false);

  // Controla se já carregamos o estado do servidor — só começamos a salvar depois disso
  const stateLoadedRef = useRef(false);
  const saveTimerRef = useRef(null);

  // Boot: se há token salvo, valida com o servidor e carrega o estado
  useEffect(() => {
    let cancelled = false;
    async function bootstrap() {
      if (!getToken()) { setBootstrapping(false); return; }
      try {
        const me = await authMe();
        if (cancelled) return;
        setUser(me.user);
        const state = await loadAppState();
        if (cancelled) return;
        setGroups(state.groups || []);
        setNumbers(state.numbers || []);
        setWhatsappGroups(state.whatsappGroups || []);
        setSettings({ ...DEFAULT_SETTINGS, ...(state.settings || {}) });
        stateLoadedRef.current = true;
      } catch {
        // token inválido — segue para tela de login
      } finally {
        if (!cancelled) setBootstrapping(false);
      }
    }
    bootstrap();

    // Se o backend devolver 401 em qualquer chamada, derruba a sessão
    const onUnauth = () => { setUser(null); stateLoadedRef.current = false; };
    window.addEventListener("nimbus:unauthorized", onUnauth);
    return () => { cancelled = true; window.removeEventListener("nimbus:unauthorized", onUnauth); };
  }, []);

  // Persistência com debounce — dispara sempre que algo no estado muda,
  // mas só depois do load inicial pra não sobrescrever com defaults vazios.
  useEffect(() => {
    if (!user || !stateLoadedRef.current) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveAppState({ groups, numbers, whatsappGroups, settings }).catch(err => {
        console.warn("[nimbus] falha ao salvar estado:", err.message);
      });
    }, SAVE_DEBOUNCE_MS);
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); };
  }, [user, groups, numbers, whatsappGroups, settings]);

  // Aplica o tema no <html> via data-theme — CSS responde via prefers-color-scheme/atributo
  useEffect(() => {
    const t = settings.theme || "auto";
    document.documentElement.dataset.theme = t;
  }, [settings.theme]);

  // Polling: pega dados operacionais (queue/history/métricas) que o scheduler
  // atualiza no servidor. Faz merge sem sobrescrever campos editáveis localmente.
  useEffect(() => {
    if (!user || !stateLoadedRef.current) return;
    let cancelled = false;
    async function pull() {
      try {
        const ops = await loadAppOps();
        if (cancelled) return;
        const opsById = new Map((ops.groups || []).map(g => [g.id, g]));
        const merge = (g) => {
          const o = opsById.get(g.id);
          if (!o) return g;
          const next = { ...g };
          for (const f of OPS_FIELDS) if (o[f] !== undefined) next[f] = o[f];
          return next;
        };
        setGroups(prev => prev.map(merge));
        setSelectedGroup(prev => prev ? merge(prev) : prev);
      } catch {
        // ignora — próxima rodada tenta de novo
      }
    }
    const id = setInterval(pull, OPS_POLL_MS);
    pull();
    return () => { cancelled = true; clearInterval(id); };
  }, [user]);

  async function handleLogin(loggedUser) {
    setUser(loggedUser);
    try {
      const state = await loadAppState();
      setGroups(state.groups || []);
      setNumbers(state.numbers || []);
      setWhatsappGroups(state.whatsappGroups || []);
      setSettings({ ...DEFAULT_SETTINGS, ...(state.settings || {}) });
    } catch {
      setGroups([]); setNumbers([]); setWhatsappGroups([]); setSettings(DEFAULT_SETTINGS);
    } finally {
      stateLoadedRef.current = true;
    }
  }

  function handleLogout() {
    authLogout();
    stateLoadedRef.current = false;
    setUser(null);
    setGroups([]); setNumbers([]); setWhatsappGroups([]);
    setSettings(DEFAULT_SETTINGS);
    setSelectedGroup(null);
    setPage("dashboard");
  }

  const handleCreateGroup = ({ name, categories }) => {
    const newGroup = makeEmptyGroup({ id: Date.now(), name, categories, template: settings.messageTemplate });
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

  const deleteWhatsappGroup = (wgId) => {
    setWhatsappGroups(ws => ws.filter(w => w.id !== wgId));
    setGroups(gs => gs.map(g => ({ ...g, whatsappGroupIds: (g.whatsappGroupIds || []).filter(id => id !== wgId) })));
    setSelectedGroup(g => g ? { ...g, whatsappGroupIds: (g.whatsappGroupIds || []).filter(id => id !== wgId) } : g);
  };

  const setWhatsappGroupStatus = (wgId, status) => {
    setWhatsappGroups(ws => ws.map(w => w.id === wgId ? { ...w, status } : w));
  };

  const updateWhatsappGroup = (wgId, updates) => {
    setWhatsappGroups(ws => ws.map(w => w.id === wgId ? { ...w, ...updates } : w));
  };

  if (bootstrapping) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--color-text-secondary)", fontSize: 13 }}>
        Carregando...
      </div>
    );
  }

  if (!user) {
    return <Login onLogin={handleLogin} />;
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
    settings: <PageSettings user={user} setUser={setUser} onLogout={handleLogout} settings={settings} setSettings={setSettings} />,
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
        onLogout={handleLogout}
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
