import { useState, useEffect, useRef } from "react";
import { initialGroups, initialNumbers, initialWhatsappGroups, makeEmptyGroup, DEFAULT_MESSAGE_TEMPLATE } from "./data/mockData";
import { allSources } from "./data/constants";

const DEFAULT_SETTINGS = {
  messageTemplate: DEFAULT_MESSAGE_TEMPLATE,
  customTemplates: [],
  notifications: { email: true, push: false, weeklyReport: true, pendingReview: true },
  sources: allSources,
  theme: "auto",
};
import { authMe, authLogout, authRefresh, loadAppState, saveAppState, loadAppOps, getToken, clearToken, getLastActivity, setLastActivity, IDLE_TIMEOUT_MS, getAffiliateStatus, billingMe } from "./data/api";
import Sidebar from "./components/Sidebar";
import GroupDashboard from "./components/GroupDashboard";
import UnsavedChangesModal from "./components/UnsavedChangesModal";
import { NavGuardContext } from "./data/navGuard";
import PageDashboard from "./pages/Dashboard";
import PageProducts from "./pages/Products";
import PageWhatsApp from "./pages/WhatsApp";
import PageSettings from "./pages/Settings";
import PageSubscription from "./pages/Subscription";
import PageAffiliateML from "./pages/AffiliateML";
import PageAffiliateAmazon from "./pages/AffiliateAmazon";
import PageAffiliateShopee from "./pages/AffiliateShopee";
import PageAdminScraper from "./pages/AdminScraper";
import PageAdminML from "./pages/AdminML";
import PageAdminAmazon from "./pages/AdminAmazon";
import PageAdminShopee from "./pages/AdminShopee";
import PageAdminUsers from "./pages/AdminUsers";
import PageAdminBackups from "./pages/AdminBackups";
import PageAdminNotifications from "./pages/AdminNotifications";
import PageTutoriais from "./pages/Tutoriais";
import Login from "./pages/Login";

const SAVE_DEBOUNCE_MS = 800;
// Onde guardamos a navegação atual (página ou campanha aberta) pra sobreviver ao F5.
const NAV_STORAGE_KEY = "nimbus:nav";
// Polling de OPS: agressivo enquanto a aba está em foco, pausa quando oculta.
// 3 s mantém UI quase live sem encher o servidor; afiliado fica em 30 s pq muda raro.
const OPS_POLL_MS = 3 * 1000;
const AFFILIATE_POLL_MS = 30 * 1000;
// Campos por grupo gerenciados pelo scheduler — atualizados por polling
const OPS_FIELDS = ["queue", "pending", "history", "sentToday", "sentWeek", "weekData", "lastSend", "avgDiscount"];

export default function App() {
  const [groups, setGroups] = useState(initialGroups);
  const [numbers, setNumbers] = useState(initialNumbers);
  const [whatsappGroups, setWhatsappGroups] = useState(initialWhatsappGroups);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [page, setPage] = useState(() => {
    try { return JSON.parse(localStorage.getItem(NAV_STORAGE_KEY) || "{}").page || "dashboard"; }
    catch { return "dashboard"; }
  });
  const [selectedGroup, setSelectedGroup] = useState(null);
  // Deep-link pra um tutorial específico — setado quando outra página chama
  // openTutorial(id). Limpado depois que a página Tutoriais consome.
  const [tutorialTarget, setTutorialTarget] = useState(null);
  const openTutorial = (id) => requestNavigation(() => { setTutorialTarget(id); setSelectedGroup(null); setPage("tutorials"); });
  const [user, setUser] = useState(null);
  const [bootstrapping, setBootstrapping] = useState(true);
  const [mobileMenu, setMobileMenu] = useState(false);
  // Guard de navegação: a tela ativa registra { dirty, save, discard } em guardRef;
  // requestNavigation intercepta trocas de tela/aba e abre o diálogo quando há
  // alterações não salvas. pendingNav guarda a navegação aguardando decisão.
  const guardRef = useRef(null);
  const [pendingNav, setPendingNav] = useState(null);
  const register = (guard) => { guardRef.current = guard; };
  const requestNavigation = (navFn) => {
    if (guardRef.current?.dirty) setPendingNav(() => navFn);
    else navFn();
  };
  const navGuard = { register, requestNavigation };
  const closeGuard = () => setPendingNav(null);
  const guardSave = async () => {
    const g = guardRef.current;
    if (g?.save) await g.save();
    if (pendingNav) pendingNav();
    setPendingNav(null);
  };
  const guardDiscard = () => {
    guardRef.current?.discard?.();
    if (pendingNav) pendingNav();
    setPendingNav(null);
  };
  // Status de afiliado por loja — controla badge "pausado" (ML) e alertas no sidebar.
  // Default true pra ML/Amazon evita "flash vermelho" antes do primeiro fetch.
  // Shopee fica sempre como "não configurado" enquanto a integração não existe.
  const [affiliateStatus, setAffiliateStatus] = useState({ ml: true, amazon: true, shopee: false });
  // Billing — { planId, effectivePlan, status, daysLeftInTrial, limits, stripeEnabled, isAdmin }
  const [billing, setBilling] = useState(null);
  const affiliateConfigured = !!affiliateStatus.ml;
  const applyAffiliateStatus = (s) => {
    setAffiliateStatus({
      ml: !!(s?.ml?.configured ?? s?.configured),
      amazon: !!s?.amazon?.configured,
      shopee: !!s?.shopee?.configured,
    });
  };

  // Controla se já carregamos o estado do servidor — só começamos a salvar depois disso
  const stateLoadedRef = useRef(false);
  const saveTimerRef = useRef(null);

  // Boot: se há token salvo, valida com o servidor e carrega o estado
  useEffect(() => {
    let cancelled = false;
    // Lê a navegação salva ANTES de qualquer setState — o efeito de persistência
    // (mais abaixo) reescreve essa chave assim que `user` é setado, então
    // precisamos capturar o groupId aqui pra restaurar a campanha aberta.
    let savedNav = {};
    try { savedNav = JSON.parse(localStorage.getItem(NAV_STORAGE_KEY) || "{}"); } catch { /* ignora */ }
    async function bootstrap() {
      if (!getToken()) { setBootstrapping(false); return; }
      // Inatividade: se a última atividade foi há mais que o timeout, a sessão
      // expirou enquanto a aba esteve fechada — cai direto no login sem validar.
      const last = getLastActivity();
      if (last && Date.now() - last > IDLE_TIMEOUT_MS) {
        clearToken();
        setBootstrapping(false);
        return;
      }
      setLastActivity(Date.now());
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
        // Reabre a campanha que estava aberta antes do F5, se ainda existir.
        if (savedNav.groupId != null) {
          const g = (state.groups || []).find(x => x.id === savedNav.groupId);
          if (g) { setSelectedGroup(g); setPage("group"); }
        }
        // Billing — não bloqueia o boot se falhar
        billingMe().then(b => !cancelled && setBilling(b)).catch(() => {});
      } catch {
        // token inválido — segue para tela de login
      } finally {
        if (!cancelled) setBootstrapping(false);
      }
    }
    bootstrap();

    // ?checkout=success/cancel — após retorno do Stripe Checkout, limpa query e refaz billingMe.
    // O webhook normalmente chega antes desse callback, mas damos 1.5s de folga.
    const qs = new URLSearchParams(window.location.search);
    const checkout = qs.get("checkout");
    if (checkout === "success" || checkout === "cancel") {
      qs.delete("checkout");
      const newSearch = qs.toString();
      window.history.replaceState({}, "", window.location.pathname + (newSearch ? `?${newSearch}` : ""));
      if (checkout === "success") {
        setTimeout(() => { billingMe().then(setBilling).catch(() => {}); }, 1500);
      }
    }

    // Se o backend devolver 401 em qualquer chamada, derruba a sessão
    const onUnauth = () => { setUser(null); stateLoadedRef.current = false; };
    window.addEventListener("nimbus:unauthorized", onUnauth);
    return () => { cancelled = true; window.removeEventListener("nimbus:unauthorized", onUnauth); };
  }, []);

  // Timeout de inatividade — desloga após IDLE_TIMEOUT_MS sem atividade do
  // usuário. Enquanto há atividade, registra o timestamp e renova o token no
  // servidor (sliding session) com throttle. Um interval checa a ociosidade.
  useEffect(() => {
    if (!user) return;
    const REFRESH_THROTTLE_MS = 10 * 60 * 1000; // renova o token no máx. a cada 10 min
    let lastRefresh = Date.now();

    const onActivity = () => {
      const now = Date.now();
      setLastActivity(now);
      if (now - lastRefresh >= REFRESH_THROTTLE_MS) {
        lastRefresh = now;
        authRefresh().catch(() => {}); // 401 já é tratado pelo http() → logout
      }
    };

    const events = ["mousemove", "mousedown", "keydown", "touchstart", "scroll"];
    const opts = { passive: true };
    events.forEach(e => window.addEventListener(e, onActivity, opts));

    const interval = setInterval(() => {
      if (Date.now() - getLastActivity() > IDLE_TIMEOUT_MS) handleLogout();
    }, 30 * 1000);

    return () => {
      events.forEach(e => window.removeEventListener(e, onActivity, opts));
      clearInterval(interval);
    };
  }, [user]);

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

  // Lembra onde o usuário está (página atual ou campanha aberta) pra restaurar no F5.
  useEffect(() => {
    if (!user) return;
    try {
      const nav = selectedGroup ? { groupId: selectedGroup.id } : { page };
      localStorage.setItem(NAV_STORAGE_KEY, JSON.stringify(nav));
    } catch { /* ignora (modo privado/quota) */ }
  }, [user, page, selectedGroup]);

  // Polling: pega dados operacionais (queue/history/métricas) que o scheduler
  // atualiza no servidor. Faz merge sem sobrescrever campos editáveis localmente.
  // Pausa quando a aba está oculta e força um pull ao voltar o foco.
  useEffect(() => {
    if (!user || !stateLoadedRef.current) return;
    let cancelled = false;
    let timer = null;
    async function pull() {
      if (cancelled || (typeof document !== "undefined" && document.hidden)) return;
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
    const start = () => { if (!timer) timer = setInterval(pull, OPS_POLL_MS); };
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
    const onVisibility = () => {
      if (document.hidden) { stop(); }
      else { pull(); start(); }
    };
    start();
    pull();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [user]);

  // Polling do status de afiliado — quando muda em Configurações, o badge
  // "pausado" some/aparece sem precisar recarregar a página.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    let timer = null;
    async function pull() {
      if (cancelled || (typeof document !== "undefined" && document.hidden)) return;
      try {
        const s = await getAffiliateStatus();
        if (!cancelled) applyAffiliateStatus(s);
      } catch {
        // silencioso
      }
    }
    const start = () => { if (!timer) timer = setInterval(pull, AFFILIATE_POLL_MS); };
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
    const onVisibility = () => {
      if (document.hidden) stop();
      else { pull(); start(); }
    };
    start();
    pull();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [user]);

  async function handleLogin(loggedUser) {
    setLastActivity(Date.now()); // inicia a janela de inatividade
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
    try { localStorage.removeItem(NAV_STORAGE_KEY); } catch { /* ignora */ }
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

  const handleSelectGroup = g => requestNavigation(() => { setSelectedGroup(groups.find(x => x.id === g.id)); setPage("group"); });
  const handleBack = () => requestNavigation(() => { setSelectedGroup(null); setPage("dashboard"); });
  const handleUpdate = (gid, updates) => {
    setGroups(gs => gs.map(g => g.id === gid ? { ...g, ...updates } : g));
    setSelectedGroup(g => g ? { ...g, ...updates } : g);
  };
  const handleDelete = (gid) => {
    setGroups(gs => gs.filter(g => g.id !== gid));
    setSelectedGroup(null);
    setPage("dashboard");
  };

  // Modelos de mensagem salvos pelo usuário — disponíveis em todas as campanhas.
  const addCustomTemplate = (name, template) => {
    const cleanName = String(name || "").trim();
    if (!cleanName || !template) return null;
    const id = `tpl_${Date.now()}`;
    setSettings(s => ({
      ...s,
      customTemplates: [...(s.customTemplates || []), { id, name: cleanName, template }],
    }));
    return id;
  };
  const deleteCustomTemplate = (id) => {
    setSettings(s => ({
      ...s,
      customTemplates: (s.customTemplates || []).filter(t => t.id !== id),
    }));
  };
  const updateCustomTemplate = (id, patch) => {
    setSettings(s => ({
      ...s,
      customTemplates: (s.customTemplates || []).map(t => {
        if (t.id !== id) return t;
        const next = { ...t };
        if (patch.name != null) {
          const cleanName = String(patch.name).trim();
          if (cleanName) next.name = cleanName;
        }
        if (patch.template != null) next.template = patch.template;
        return next;
      }),
    }));
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

  // Remove um número por completo: tira da lista e apaga os grupos WhatsApp que
  // dependiam dele (desvinculando das campanhas). Usado pelo botão "Remover".
  // Desconectar (sem remover) preserva o número pra reconexão manter os grupos.
  const removeNumberAndGroups = (numberId) => {
    const orphanGroupIds = whatsappGroups.filter(w => w.numberId === numberId).map(w => w.id);
    setWhatsappGroups(ws => ws.filter(w => w.numberId !== numberId));
    if (orphanGroupIds.length) {
      const orphanSet = new Set(orphanGroupIds);
      setGroups(gs => gs.map(g => ({ ...g, whatsappGroupIds: (g.whatsappGroupIds || []).filter(id => !orphanSet.has(id)) })));
      setSelectedGroup(g => g ? { ...g, whatsappGroupIds: (g.whatsappGroupIds || []).filter(id => !orphanSet.has(id)) } : g);
    }
    setNumbers(ns => ns.filter(n => n.id !== numberId));
  };

  // Re-vincula os grupos WhatsApp do número antigo pro novo. Usado quando um re-scan
  // (Adicionar novo número) reconecta um telefone que já existia sob outro id: os
  // grupos apontavam pro id velho e ficariam órfãos. Aqui re-apontamos pro id novo,
  // que é o que tem a sessão viva. (As campanhas referenciam o id do grupo, não o
  // numberId, então não precisam mudar.)
  const relinkNumber = (oldId, newId) => {
    if (!oldId || !newId || oldId === newId) return;
    setWhatsappGroups(ws => ws.map(w => w.numberId === oldId ? { ...w, numberId: newId } : w));
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

  const fallbackPage = <PageDashboard groups={groups} whatsappGroups={whatsappGroups} onSelectGroup={handleSelectGroup} onCreateGroup={handleCreateGroup} onUpdate={handleUpdate} affiliateConfigured={affiliateConfigured} onGoToSettings={() => setPage("settings")} />;
  const pageMap = {
    dashboard: <PageDashboard groups={groups} whatsappGroups={whatsappGroups} onSelectGroup={handleSelectGroup} onCreateGroup={handleCreateGroup} onUpdate={handleUpdate} affiliateConfigured={affiliateConfigured} onGoToSettings={() => setPage("settings")} />,
    products: user?.role === "admin" ? <PageProducts /> : fallbackPage,
    whatsapp: <PageWhatsApp
      numbers={numbers}
      setNumbers={setNumbers}
      whatsappGroups={whatsappGroups}
      onRemoveNumber={removeNumberAndGroups}
      onRelinkNumber={relinkNumber}
    />,
    settings: <PageSettings user={user} setUser={setUser} onLogout={handleLogout} settings={settings} setSettings={setSettings} onAffiliateChange={applyAffiliateStatus} />,
    subscription: <PageSubscription />,
    "mercado-livre": <PageAffiliateML onAffiliateChange={applyAffiliateStatus} onOpenTutorial={openTutorial} />,
    "amazon": <PageAffiliateAmazon onAffiliateChange={applyAffiliateStatus} onOpenTutorial={openTutorial} />,
    "shopee": <PageAffiliateShopee onAffiliateChange={applyAffiliateStatus} onOpenTutorial={openTutorial} />,
    "admin-scraper":  user?.role === "admin" ? <PageAdminScraper /> : fallbackPage,
    "admin-ml":       user?.role === "admin" ? <PageAdminML /> : fallbackPage,
    "admin-amazon":   user?.role === "admin" ? <PageAdminAmazon /> : fallbackPage,
    "admin-shopee":   user?.role === "admin" ? <PageAdminShopee /> : fallbackPage,
    "admin-users":          user?.role === "admin" ? <PageAdminUsers currentUser={user} /> : fallbackPage,
    "admin-backups":        user?.role === "admin" ? <PageAdminBackups /> : fallbackPage,
    "admin-notifications":  user?.role === "admin" ? <PageAdminNotifications numbers={numbers} /> : fallbackPage,
    "tutorials":     <PageTutoriais targetTutorialId={tutorialTarget} />,
  };

  return (
    <NavGuardContext.Provider value={navGuard}>
    <div className="app-layout" style={{ display: "flex", minHeight: "100vh" }}>
      {pendingNav && (
        <UnsavedChangesModal onSave={guardSave} onDiscard={guardDiscard} onCancel={closeGuard} />
      )}
      <Sidebar
        page={page}
        selectedGroup={selectedGroup}
        groups={groups}
        whatsappGroups={whatsappGroups}
        numbers={numbers}
        affiliateConfigured={affiliateConfigured}
        affiliateStatus={affiliateStatus}
        user={user}
        onNavigate={(id) => requestNavigation(() => { setPage(id); setSelectedGroup(null); setTutorialTarget(null); })}
        onSelectGroup={handleSelectGroup}
        onLogout={handleLogout}
        mobileOpen={mobileMenu}
        onToggleMobile={setMobileMenu}
      />
      <div className="main-content" style={{ flex: 1, padding: "20px 24px", minWidth: 0, overflowY: "auto" }}>
        {billing && !billing.isAdmin && (
          (billing.status === "past_due" || billing.status === "unpaid") ? (
            <div onClick={() => requestNavigation(() => setPage("subscription"))} style={{ cursor: "pointer", background: "#FCEBEB", border: "0.5px solid #F7C1C1", color: "#A32D2D", padding: "10px 14px", borderRadius: 8, fontSize: 13, marginBottom: 12 }}>
              Pagamento pendente — clique para regularizar e manter envios ativos.
            </div>
          ) : billing.status === "trialing" && billing.daysLeftInTrial !== null && billing.daysLeftInTrial <= 2 ? (
            <div onClick={() => requestNavigation(() => setPage("subscription"))} style={{ cursor: "pointer", background: "#FFF7E0", border: "0.5px solid #F0D58A", color: "#7A5800", padding: "10px 14px", borderRadius: 8, fontSize: 13, marginBottom: 12 }}>
              Seu trial expira em {billing.daysLeftInTrial}d. Assine para continuar usando.
            </div>
          ) : billing.effectivePlan === "free" ? (
            <div onClick={() => requestNavigation(() => setPage("subscription"))} style={{ cursor: "pointer", background: "#FFF7E0", border: "0.5px solid #F0D58A", color: "#7A5800", padding: "10px 14px", borderRadius: 8, fontSize: 13, marginBottom: 12 }}>
              Sem plano ativo — envios pausados. Escolha um plano para reativar.
            </div>
          ) : null
        )}
        {selectedGroup
          ? <GroupDashboard
              key={selectedGroup.id}
              group={selectedGroup}
              numbers={numbers}
              whatsappGroups={whatsappGroups}
              affiliateConfigured={affiliateConfigured}
              affiliateStatus={affiliateStatus}
              onBack={handleBack}
              onUpdate={handleUpdate}
              onDelete={handleDelete}
              onCreateWhatsappGroup={createWhatsappGroup}
              onDeleteWhatsappGroup={deleteWhatsappGroup}
              onUpdateWhatsappGroup={updateWhatsappGroup}
              onGoToSettings={() => requestNavigation(() => setPage("settings"))}
              onGoToAffiliate={(provider) => requestNavigation(() => setPage(provider === "shopee" ? "shopee" : "mercado-livre"))}
              customTemplates={settings.customTemplates || []}
              onAddCustomTemplate={addCustomTemplate}
              onDeleteCustomTemplate={deleteCustomTemplate}
              onUpdateCustomTemplate={updateCustomTemplate}
            />
          : pageMap[page] || pageMap["dashboard"]
        }
      </div>
    </div>
    </NavGuardContext.Provider>
  );
}
