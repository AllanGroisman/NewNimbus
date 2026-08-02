import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { initialGroups, initialNumbers, initialWhatsappGroups, makeEmptyGroup, DEFAULT_MESSAGE_TEMPLATE } from "./data/mockData";
import { allSources, storeLockMessage, unlockedSources, navToPath, pathToNav, publicPageFor, popQueryParam, DEFAULT_PALETTE, isValidPalette } from "./data/constants";
import { DEFAULT_ONBOARDING, mergeOnboarding, TOURS } from "./data/onboarding";

const DEFAULT_SETTINGS = {
  messageTemplate: DEFAULT_MESSAGE_TEMPLATE,
  customTemplates: [],
  notifications: { email: true, push: false, weeklyReport: true, pendingReview: true },
  sources: allSources,
  theme: "auto",
  // Quais tours a pessoa já viu (tasks 38-39). Fica no settings de propósito:
  // assim segue a conta, não o navegador.
  onboarding: DEFAULT_ONBOARDING,
};
import { authMe, authLogout, authRefresh, loadAppState, saveAppState, loadAppOps, getToken, clearToken, getLastActivity, setLastActivity, IDLE_TIMEOUT_MS, getAffiliateStatus, billingMe, billingSync, billingActiveSelection, listWASessions, storeLocks as fetchStoreLocks, layoutGet, PALETTE_CACHE_KEY, errText } from "./data/api";
import Sidebar from "./components/Sidebar";
import GroupDashboard from "./components/GroupDashboard";
import UnsavedChangesModal from "./components/UnsavedChangesModal";
import LogoutConfirmModal from "./components/LogoutConfirmModal";
import PlanSwapModal from "./components/PlanSwapModal";
import StoreLockedNotice from "./components/ui/StoreLockedNotice";
import { NavGuardContext } from "./data/navGuard";
import { useNetStatus, subscribe as subscribeNetStatus } from "./data/netStatus";
import AlertBanner from "./components/ui/AlertBanner";
import { mergeGroupOps, mergeGroupsOps } from "./data/opsMerge";
import PageDashboard from "./pages/Dashboard";
import PageProducts from "./pages/Products";
import PageWhatsApp from "./pages/WhatsApp";
import PageSettings from "./pages/Settings";
import PageSubscription from "./pages/Subscription";
import PageAffiliateML from "./pages/AffiliateML";
import PageAffiliateAmazon from "./pages/AffiliateAmazon";
import PageAffiliateShopee from "./pages/AffiliateShopee";
import PageAdminScraper from "./pages/AdminScraper";
import PageAdminScrapTester from "./pages/AdminScrapTester";
import PageAdminML from "./pages/AdminML";
import PageAdminAmazon from "./pages/AdminAmazon";
import PageAdminShopee from "./pages/AdminShopee";
import PageAdminUsers from "./pages/AdminUsers";
import PageAdminBackups from "./pages/AdminBackups";
import PageAdminNotifications from "./pages/AdminNotifications";
import PageAdminNotifTemplates from "./pages/AdminNotifTemplates";
import PageAdminEmails from "./pages/AdminEmails";
import PageAdminWhatsNimbus from "./pages/AdminWhatsNimbus";
import PageAdminLayout from "./pages/AdminLayout";
import PageAdminStripe from "./pages/AdminStripe";
import PageAdminRepasse from "./pages/AdminRepasse";
import PageTutoriais from "./pages/Tutoriais";
import Login from "./pages/Login";
import PageAssinar from "./pages/Assinar";
import PageBemVindo from "./pages/BemVindo";
import ConfirmarCpf from "./pages/ConfirmarCpf";
import ConfirmarNovoEmail from "./pages/ConfirmarNovoEmail";
import TourOverlay from "./components/onboarding/TourOverlay";
import HelpButton from "./components/onboarding/HelpButton";

const SAVE_DEBOUNCE_MS = 800;
// Onde guardamos a navegação atual (página ou campanha aberta). A URL é a fonte
// principal; isto é só a memória de "onde eu estava" pra quando o usuário entra
// pela raiz (ex.: digitou só o domínio ou clicou num favorito antigo).
const NAV_STORAGE_KEY = "nimbus:nav";

// Navegação inicial: prioriza o endereço da URL; se veio pela raiz, cai na
// última posição guardada. Devolve { page, groupId }.
function readInitialNav() {
  const path = typeof window !== "undefined" ? window.location.pathname : "/";
  if (path && path !== "/") return pathToNav(path);
  try {
    const saved = JSON.parse(localStorage.getItem(NAV_STORAGE_KEY) || "{}");
    if (saved.groupId != null) return { page: "group", groupId: saved.groupId };
    return { page: saved.page || "dashboard", groupId: null };
  } catch {
    return { page: "dashboard", groupId: null };
  }
}
// Polling de OPS: agressivo enquanto a aba está em foco, pausa quando oculta.
// 3 s mantém UI quase live sem encher o servidor; afiliado fica em 30 s pq muda raro.
const OPS_POLL_MS = 3 * 1000;
const SESSION_POLL_MS = 8 * 1000;
const AFFILIATE_POLL_MS = 30 * 1000;
const STORE_LOCKS_POLL_MS = 60 * 1000;
// Teto do backoff em 429 (rate-limit): intervalo nunca passa de POLL_MS × este fator.
const MAX_BACKOFF_MULT = 8;
// Referência estável pra "nada pausado pelo plano" — evita recriar objeto a
// cada render e disparar efeitos à toa.
const EMPTY_PLAN_PAUSED = { groups: [], numbers: [] };

export default function App() {
  const [groups, setGroups] = useState(initialGroups);
  const [numbers, setNumbers] = useState(initialNumbers);
  // Pausa por plano (cancelamento/downgrade): quem está aqui continua na tela e
  // editável, mas não envia e não conta contra o limite. Quem manda é o
  // servidor — o frontend só lê e oferece a troca.
  const [planPaused, setPlanPaused] = useState(EMPTY_PLAN_PAUSED);
  // Troca pendente: { kind, target, candidates } enquanto o modal está aberto.
  const [planSwap, setPlanSwap] = useState(null);
  const [planSwapBusy, setPlanSwapBusy] = useState(false);
  const [planSwapError, setPlanSwapError] = useState(null);
  const [whatsappGroups, setWhatsappGroups] = useState(initialWhatsappGroups);
  // Status ao vivo das sessões WhatsApp por numberId ({ [numberId]: "connected" | ... }).
  // Alimentado por poll; usado pra derivar o status real das campanhas (ver liveWhatsappGroups).
  const [sessionStatus, setSessionStatus] = useState({});
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  // Navegação inicial (URL ou última posição guardada), lida uma única vez.
  const initialNavRef = useRef(null);
  if (initialNavRef.current === null) initialNavRef.current = readInitialNav();
  const [page, setPage] = useState(() => initialNavRef.current.page);
  const [selectedGroup, setSelectedGroup] = useState(null);
  // Deep-link pra um tutorial específico — setado quando outra página chama
  // openTutorial(id). Limpado depois que a página Tutoriais consome.
  const [tutorialTarget, setTutorialTarget] = useState(null);
  const openTutorial = (id) => requestNavigation(() => { setTutorialTarget(id); setSelectedGroup(null); setPage("tutorials"); });
  const [user, setUser] = useState(null);
  const [bootstrapping, setBootstrapping] = useState(true);
  // Boot que falhou por falta de conexão (≠ token inválido) — mostra a tela de
  // "sem conexão" em vez de mandar pro login com a sessão ainda válida.
  const [bootOffline, setBootOffline] = useState(false);
  // Rota pública (/assinar, /bem-vindo): o caminho de quem veio da landing e
  // ainda não tem conta. Vem da URL de entrada e só sai daqui quando a pessoa
  // entra no sistema — inclusive por cima de um token antigo no navegador, que
  // senão logaria a conta errada em cima de um pagamento recém-feito.
  const [publicPage, setPublicPage] = useState(() =>
    typeof window !== "undefined" ? publicPageFor(window.location.pathname) : null
  );
  // Token do link "confirmar novo email". Lido (e removido da URL) uma vez só,
  // antes do bootstrap: essa tela vem antes de tudo, porque confirmar derruba a
  // sessão e vale mesmo pra quem abriu o link deslogado ou em outro navegador.
  const emailChangeRef = useRef(null);
  if (emailChangeRef.current === null) {
    emailChangeRef.current = typeof window !== "undefined" ? popQueryParam("trocaemail") : "";
  }
  const [emailChangeToken, setEmailChangeToken] = useState(emailChangeRef.current || null);
  // Tour de holofote rodando agora (objeto de TOURS) ou null.
  const [activeTour, setActiveTour] = useState(null);
  const [mobileMenu, setMobileMenu] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);
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
  // Cancelar o diálogo de alterações não salvas: a tela fica onde estava. Se a
  // navegação veio do botão voltar do navegador, a URL já mudou — devolve ela
  // pro endereço da tela atual, senão a barra passa a mentir.
  const closeGuard = () => { setPendingNav(null); syncUrl("replace"); };
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
  // Travas de loja definidas pelo admin — { ml: { locked, message }, ... }.
  // Default vazio = nada trancado, pra não piscar cadeado antes do primeiro fetch.
  const [storeLocks, setStoreLocks] = useState({});
  // Billing — { planId, effectivePlan, status, daysLeftInTrial, limits, stripeEnabled, isAdmin }
  const [billing, setBilling] = useState(null);
  // Falha ao gravar o estado no servidor — { message, retryable } ou null.
  // As telas mostram "✓ Salvo!" assim que o estado local muda; sem este aviso o
  // usuário acreditaria que salvou mesmo quando o PUT falhou.
  const [saveError, setSaveError] = useState(null);
  // Último payload que falhou, pra o botão "Tentar agora" reenviar.
  const lastFailedSaveRef = useRef(null);
  // Nomes dos polls (ops/session/affiliate) atualmente em backoff por rate-limit (429).
  // Não-vazio => mostra aviso discreto: sem isso, um 429 silencioso faz a tela parar
  // de atualizar sem nenhum sinal, e só o F5 "resolve" (recarrega tudo de uma vez).
  const [degradedPolls, setDegradedPolls] = useState(() => new Set());
  const markPollDegraded = (name, degraded) => {
    setDegradedPolls(prev => {
      const has = prev.has(name);
      if (degraded === has) return prev;
      const next = new Set(prev);
      degraded ? next.add(name) : next.delete(name);
      return next;
    });
  };
  // Conexão com o servidor — alimentada pelo http() do api.js.
  const net = useNetStatus();
  // Boot que morreu por falta de conexão: assim que a sonda do netStatus achar
  // o servidor de novo, recarrega sozinho (o usuário não precisa dar F5).
  useEffect(() => {
    if (!bootOffline) return;
    return subscribeNetStatus((online) => { if (online) window.location.reload(); });
  }, [bootOffline]);

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
  // Versão (`updatedAt`) do estado como o servidor a conhece por último — usada
  // pra concorrência otimista no PUT (evita que um save atrasado sobrescreva
  // mudanças mais novas) e pra nunca ter 2 PUTs de state em voo ao mesmo tempo.
  const stateUpdatedAtRef = useRef(null);
  const savingStateRef = useRef(false);
  const pendingSaveRef = useRef(null);
  // Espelha `groups` de forma síncrona pra navFns lidas depois de um `await` (ex.
  // guardSave) não fecharem sobre um `groups` desatualizado de antes do save.
  const groupsRef = useRef(groups);
  useEffect(() => { groupsRef.current = groups; }, [groups]);

  // Boot: se há token salvo, valida com o servidor e carrega o estado
  useEffect(() => {
    let cancelled = false;
    // Navegação de entrada (URL ou última posição), capturada antes de qualquer
    // setState — o efeito de sincronização reescreve a URL assim que `user` é
    // setado, então precisamos do groupId aqui pra reabrir a campanha certa.
    const savedNav = initialNavRef.current;
    async function bootstrap() {
      // Numa rota pública não há sessão a restaurar — e em /bem-vindo restaurar
      // um token antigo abriria a conta errada por cima do pagamento novo.
      if (publicPage) { setBootstrapping(false); return; }
      // Idem na confirmação de troca de email: a sessão antiga vai ser
      // derrubada pela própria confirmação, não há o que restaurar.
      if (emailChangeRef.current) { setBootstrapping(false); return; }
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
        setPlanPaused(state.planPaused || EMPTY_PLAN_PAUSED);
        stateUpdatedAtRef.current = state.updatedAt || null;
        stateLoadedRef.current = true;
        // Reabre a campanha do endereço (ou a que estava aberta antes do F5).
        // Comparação por string: o id da URL vem sempre como texto.
        let abriuCampanha = false;
        if (savedNav.groupId != null) {
          const g = (state.groups || []).find(x => String(x.id) === String(savedNav.groupId));
          if (g) { setSelectedGroup(g); setPage("group"); abriuCampanha = true; }
          else setPage("dashboard"); // campanha do link não existe mais
        }
        // Tour de boas-vindas na primeira vez (o do painel, ou o da campanha se
        // a pessoa entrou direto por um link de campanha).
        const vistos = mergeOnboarding(state.settings?.onboarding).tours;
        maybeStartTour(abriuCampanha ? "campaign" : "main", vistos);
        // Billing — não bloqueia o boot se falhar
        billingMe().then(b => !cancelled && setBilling(b)).catch(() => {});
        // Travas de loja — idem: se falhar, nada fica trancado na UI.
        fetchStoreLocks().then(r => !cancelled && setStoreLocks(r.locks || {})).catch(() => {});
      } catch (err) {
        // Backend fora não é sessão expirada: sem essa distinção o usuário era
        // jogado na tela de login (e tomava outro erro ao tentar entrar).
        // O token fica onde está e o boot é refeito quando a conexão volta.
        if (err?.offline) { if (!cancelled) setBootOffline(true); }
        // 401: o http() já limpou o token — segue para a tela de login.
      } finally {
        if (!cancelled) setBootstrapping(false);
      }
    }
    bootstrap();

    // ?checkout=success/cancel — após retorno do Stripe Checkout, limpa query e
    // reconcilia o plano. billingSync busca a assinatura ao vivo no Stripe, então
    // o plano é corrigido na hora mesmo se o webhook não tiver chegado.
    const qs = new URLSearchParams(window.location.search);
    const checkout = qs.get("checkout");
    if (checkout === "success" || checkout === "cancel") {
      qs.delete("checkout");
      const newSearch = qs.toString();
      window.history.replaceState({}, "", window.location.pathname + (newSearch ? `?${newSearch}` : ""));
      if (checkout === "success") {
        billingSync().then(setBilling).catch(() => { billingMe().then(setBilling).catch(() => {}); });
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

  // Envia um PUT de state, nunca dois em voo ao mesmo tempo. Se o debounce
  // disparar de novo enquanto um save ainda está em andamento, a nova versão
  // fica em `pendingSaveRef` e é enviada assim que o save atual termina — em
  // vez de disparar uma 2ª fetch em paralelo (era isso que permitia um PUT
  // atrasado com dado velho "vencer" um mais novo que tinha ido antes).
  const flushSave = async (payload) => {
    savingStateRef.current = true;
    try {
      const res = await saveAppState({ ...payload, baseUpdatedAt: stateUpdatedAtRef.current });
      if (res?.updatedAt) stateUpdatedAtRef.current = res.updatedAt;
      lastFailedSaveRef.current = null;
      setSaveError(null);
    } catch (err) {
      if (err.status === 409) {
        // Servidor rejeitou por estar baseado em versão antiga (concorrência
        // otimista) — recarrega o estado real do servidor em vez de insistir
        // em sobrescrever com o que temos local, que já se sabe defasado.
        try {
          const fresh = await loadAppState();
          stateUpdatedAtRef.current = fresh.updatedAt || null;
          setGroups(fresh.groups || []);
          setNumbers(fresh.numbers || []);
          setWhatsappGroups(fresh.whatsappGroups || []);
          setSettings(s => ({ ...s, ...(fresh.settings || {}) }));
          lastFailedSaveRef.current = null;
          setSaveError(null);
        } catch { /* próxima tentativa de save cuida disso */ }
      } else if (err.status === 402) {
        // Limite do plano excedido — backend recusou o save. Insistir não
        // resolve (o limite continua estourado), então nada de "Tentar agora";
        // o caminho é pausar/remover algo ou assinar um plano maior.
        lastFailedSaveRef.current = null;
        setSaveError({
          message: errText(err, "Limite do plano excedido."),
          retryable: false,
          showPlans: err.code === "plan_limit",
        });
      } else {
        // Falha de rede/servidor: o usuário já viu "✓ Salvo!" na tela da campanha,
        // mas nada foi gravado. Guarda o payload e avisa, com opção de tentar de novo.
        console.warn("[nimbus] falha ao salvar estado:", err.message);
        lastFailedSaveRef.current = payload;
        setSaveError({
          message: "Não conseguimos salvar suas últimas alterações. Verifique sua conexão.",
          retryable: true,
        });
      }
    } finally {
      savingStateRef.current = false;
      if (pendingSaveRef.current) {
        const next = pendingSaveRef.current;
        pendingSaveRef.current = null;
        flushSave(next);
      }
    }
  };

  // "Tentar agora" do aviso de falha de gravação. Reenvia o payload que falhou
  // (ou o estado atual, se por algum motivo não temos o antigo).
  const retrySave = () => {
    const payload = lastFailedSaveRef.current || { groups, numbers, whatsappGroups, settings };
    setSaveError(null);
    if (savingStateRef.current) pendingSaveRef.current = payload;
    else flushSave(payload);
  };

  // Persistência com debounce — dispara sempre que algo no estado muda,
  // mas só depois do load inicial pra não sobrescrever com defaults vazios.
  useEffect(() => {
    if (!user || !stateLoadedRef.current) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const payload = { groups, numbers, whatsappGroups, settings };
      if (savingStateRef.current) pendingSaveRef.current = payload;
      else flushSave(payload);
    }, SAVE_DEBOUNCE_MS);
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); };
  }, [user, groups, numbers, whatsappGroups, settings]);

  // Aplica o tema no <html> via data-theme — CSS responde via prefers-color-scheme/atributo
  useEffect(() => {
    const t = settings.theme || "auto";
    document.documentElement.dataset.theme = t;
  }, [settings.theme]);

  // Paleta é global (Admin › Layout), não do usuário: buscada uma vez, sem
  // depender de login, porque a tela de login também precisa dela. O script
  // inline do index.html já pintou com o último valor conhecido; aqui só
  // corrigimos se o servidor discordar.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { palette } = await layoutGet();
        if (!alive || !isValidPalette(palette)) return;
        document.documentElement.dataset.palette = palette;
        try { localStorage.setItem(PALETTE_CACHE_KEY, palette); } catch { /* modo privado/quota */ }
      } catch {
        // Servidor fora do ar: fica no que o script inline já aplicou.
      }
    })();
    return () => { alive = false; };
  }, []);

  // Escreve a navegação atual na barra de endereços. `mode`:
  //   "push"    — entrada nova no histórico (o botão voltar desfaz)
  //   "replace" — corrige a URL sem criar entrada (1ª sincronização e cancelamento
  //               do diálogo de alterações não salvas, quando o voltar do
  //               navegador já mudou a URL mas a tela ficou onde estava)
  const syncUrl = useCallback((mode = "push") => {
    const path = navToPath({ page, groupId: selectedGroup?.id });
    const full = path + window.location.search;
    if (window.location.pathname === path && mode === "push") return;
    const state = { page, groupId: selectedGroup?.id ?? null };
    if (mode === "replace") window.history.replaceState(state, "", full);
    else window.history.pushState(state, "", full);
  }, [page, selectedGroup]);

  // Mantém URL e localStorage em dia com a tela atual. A primeira sincronização
  // depois do login é "replace" pra não deixar uma entrada morta no histórico.
  const urlSyncedRef = useRef(false);
  useEffect(() => {
    if (!user) return;
    syncUrl(urlSyncedRef.current ? "push" : "replace");
    urlSyncedRef.current = true;
    try {
      const nav = selectedGroup ? { groupId: selectedGroup.id } : { page };
      localStorage.setItem(NAV_STORAGE_KEY, JSON.stringify(nav));
    } catch { /* ignora (modo privado/quota) */ }
  }, [user, page, selectedGroup, syncUrl]);

  // Botão voltar/avançar do navegador. Passa pelo guard, então alterações não
  // salvas continuam pedindo confirmação — inclusive no voltar.
  useEffect(() => {
    if (!user) return;
    const onPop = () => {
      const nav = pathToNav(window.location.pathname);
      requestNavigation(() => {
        setTutorialTarget(null);
        if (nav.groupId != null) {
          const g = groupsRef.current.find(x => String(x.id) === String(nav.groupId));
          if (g) { setSelectedGroup(g); setPage("group"); return; }
          // Campanha apagada nesse meio tempo — cai na lista em vez de tela vazia.
          setSelectedGroup(null); setPage("dashboard"); return;
        }
        setSelectedGroup(null);
        setPage(nav.page);
      });
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [user]);

  // Polling: pega dados operacionais (queue/history/métricas) que o scheduler
  // atualiza no servidor. Faz merge sem sobrescrever campos editáveis localmente.
  // Pausa quando a aba está oculta e força um pull ao voltar o foco.
  useEffect(() => {
    if (!user || !stateLoadedRef.current) return;
    let cancelled = false;
    let timer = null;
    let backoffMult = 1; // dobra a cada 429 (até MAX_BACKOFF_MULT), reseta no 1º sucesso
    async function pull() {
      if (cancelled || (typeof document !== "undefined" && document.hidden)) return;
      try {
        const ops = await loadAppOps();
        if (cancelled) return;
        backoffMult = 1;
        markPollDegraded("ops", false);
        // Merge dos campos de ops preservando a identidade quando nada muda —
        // sem isso, cada poll (3s) trocaria a referência de `groups` e
        // dispararia um autosave à toa. Ver frontend/src/data/opsMerge.js.
        const opsList = ops.groups || [];
        setGroups(prev => mergeGroupsOps(prev, opsList));
        setSelectedGroup(prev => prev ? mergeGroupOps(prev, opsList.find(o => o.id === prev.id)) : prev);
        // Pausa por plano vem no mesmo poll — só troca a referência se mudou
        // (senão dispararia autosave a cada 3s, ver opsMerge.js).
        if (ops.planPaused) {
          setPlanPaused(prev => (
            JSON.stringify(prev) === JSON.stringify(ops.planPaused) ? prev : ops.planPaused
          ));
        }
      } catch (err) {
        // 429 (rate-limit) não é transitório do mesmo jeito que uma falha de rede —
        // insistir no intervalo cheio só mantém a janela sempre estourada. Recua
        // (dobra o intervalo, até um teto) e avisa a UI em vez de ficar em silêncio.
        if (err?.status === 429) {
          backoffMult = Math.min(backoffMult * 2, MAX_BACKOFF_MULT);
          markPollDegraded("ops", true);
        } else if (err?.offline) {
          // Servidor fora: martelar de 3 em 3s não adianta. Quem avisa o usuário
          // é o banner de conexão (netStatus), não o de rate-limit.
          backoffMult = Math.min(backoffMult * 2, MAX_BACKOFF_MULT);
        }
      }
      if (!cancelled) timer = setTimeout(pull, OPS_POLL_MS * backoffMult);
    }
    const stop = () => { if (timer) { clearTimeout(timer); timer = null; } };
    const onVisibility = () => {
      if (document.hidden) { stop(); }
      else { stop(); pull(); }
    };
    pull();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [user]);

  // Polling: status ao vivo das sessões WhatsApp. O status guardado em
  // whatsappGroups[].status (state) não é atualizado quando um número cai, então
  // sem isto a campanha continuaria "conectada" com o WhatsApp desconectado.
  // Espelha o poll da página WhatsApp (pausa com a aba oculta, força pull no foco).
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    let timer = null;
    let backoffMult = 1;
    async function pull() {
      if (cancelled || (typeof document !== "undefined" && document.hidden)) return;
      try {
        const sessions = await listWASessions();
        if (cancelled) return;
        backoffMult = 1;
        markPollDegraded("session", false);
        const map = {};
        for (const s of (sessions || [])) map[s.numberId] = s.status;
        setSessionStatus(map);
      } catch (err) {
        if (err?.status === 429) {
          backoffMult = Math.min(backoffMult * 2, MAX_BACKOFF_MULT);
          markPollDegraded("session", true);
        } else if (err?.offline) {
          backoffMult = Math.min(backoffMult * 2, MAX_BACKOFF_MULT);
        }
        // demais erros: silencioso — mantém o último status conhecido
      }
      if (!cancelled) timer = setTimeout(pull, SESSION_POLL_MS * backoffMult);
    }
    const stop = () => { if (timer) { clearTimeout(timer); timer = null; } };
    const onVisibility = () => { if (document.hidden) stop(); else { stop(); pull(); } };
    pull();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [user]);

  // Campanhas com status ao vivo: sobrepõe o status guardado pelo status real da
  // sessão do número (quando conhecido). Derivado só pra exibição — NÃO alimenta
  // saveAppState, senão gravaríamos status volátil de volta no estado.
  const liveWhatsappGroups = useMemo(
    () => whatsappGroups.map(w => ({
      ...w,
      status: sessionStatus[w.numberId] ?? w.status,
    })),
    [whatsappGroups, sessionStatus]
  );

  // Números com status ao vivo — usado pelo indicador do menu (amarelo/vermelho).
  const liveNumbers = useMemo(
    () => numbers.map(n => ({ ...n, status: sessionStatus[n.id] ?? n.status })),
    [numbers, sessionStatus]
  );

  // ─── Tour de primeiros passos (tasks 38-39) ─────────────────────────────
  // O que já foi visto mora em settings.onboarding, então vai junto no autosave
  // do estado e acompanha a conta em qualquer navegador.
  const onboarding = useMemo(() => mergeOnboarding(settings.onboarding), [settings.onboarding]);
  // Aceita um objeto (patch direto) ou uma função do onboarding atual.
  const patchOnboarding = useCallback((patch) => {
    setSettings(s => {
      const current = mergeOnboarding(s.onboarding);
      const delta = typeof patch === "function" ? patch(current) : patch;
      if (!delta) return s;
      return { ...s, onboarding: { ...current, ...delta } };
    });
  }, []);

  const startTour = (tourId) => {
    const tour = TOURS[tourId];
    if (!tour) return;
    const go = () => {
      if (tour.page) { setSelectedGroup(null); setPage(tour.page); }
      setActiveTour(tour);
    };
    // Passa pelo guard: um tour que troca de tela não pode engolir alteração
    // não salva sem perguntar.
    if (tour.page) requestNavigation(go);
    else go();
  };

  const finishTour = useCallback(() => {
    if (activeTour) patchOnboarding(prev => ({ tours: { ...prev.tours, [activeTour.id]: true } }));
    setActiveTour(null);
  }, [activeTour, patchOnboarding]);

  // Primeira vez no painel e primeira campanha aberta: o tour começa sozinho,
  // uma única vez cada. Depois disso, só pelo botão de ajuda ou por Tutoriais.
  // `seen` é passado à mão no boot, quando o settings ainda não entrou no estado.
  const maybeStartTour = (tourId, seen = onboarding.tours) => {
    if (seen?.[tourId]) return;
    setActiveTour(TOURS[tourId]);
  };

  // Polling do status de afiliado — quando muda em Configurações, o badge
  // "pausado" some/aparece sem precisar recarregar a página.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    let timer = null;
    let backoffMult = 1;
    async function pull() {
      if (cancelled || (typeof document !== "undefined" && document.hidden)) return;
      try {
        const s = await getAffiliateStatus();
        if (cancelled) return;
        backoffMult = 1;
        markPollDegraded("affiliate", false);
        applyAffiliateStatus(s);
      } catch (err) {
        if (err?.status === 429) {
          backoffMult = Math.min(backoffMult * 2, MAX_BACKOFF_MULT);
          markPollDegraded("affiliate", true);
        } else if (err?.offline) {
          backoffMult = Math.min(backoffMult * 2, MAX_BACKOFF_MULT);
        }
      }
      if (!cancelled) timer = setTimeout(pull, AFFILIATE_POLL_MS * backoffMult);
    }
    const stop = () => { if (timer) { clearTimeout(timer); timer = null; } };
    const onVisibility = () => {
      if (document.hidden) stop();
      else { stop(); pull(); }
    };
    pull();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [user]);

  // Polling das travas de loja — quando o admin destranca, o cadeado some sem F5.
  // Muda raramente, então o intervalo é folgado.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    let timer = null;
    let backoffMult = 1;
    async function pull() {
      if (cancelled || (typeof document !== "undefined" && document.hidden)) return;
      try {
        const r = await fetchStoreLocks();
        if (cancelled) return;
        backoffMult = 1;
        setStoreLocks(r.locks || {});
      } catch (err) {
        if (err?.status === 429 || err?.offline) backoffMult = Math.min(backoffMult * 2, MAX_BACKOFF_MULT);
        // demais erros: silencioso — mantém as travas conhecidas
      }
      if (!cancelled) timer = setTimeout(pull, STORE_LOCKS_POLL_MS * backoffMult);
    }
    const stop = () => { if (timer) { clearTimeout(timer); timer = null; } };
    const onVisibility = () => { if (document.hidden) stop(); else { stop(); pull(); } };
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
      setPlanPaused(state.planPaused || EMPTY_PLAN_PAUSED);
      // Quem chegou por um link de campanha e passou pelo login vai direto pra
      // ela, em vez de cair no painel e ter que procurar.
      const wanted = initialNavRef.current;
      let abriuCampanha = false;
      if (wanted?.groupId != null) {
        const g = (state.groups || []).find(x => String(x.id) === String(wanted.groupId));
        if (g) { setSelectedGroup(g); setPage("group"); abriuCampanha = true; }
      } else if (wanted?.page) {
        setPage(wanted.page);
      }
      maybeStartTour(abriuCampanha ? "campaign" : "main", mergeOnboarding(state.settings?.onboarding).tours);
    } catch {
      setGroups([]); setNumbers([]); setWhatsappGroups([]); setSettings(DEFAULT_SETTINGS);
    } finally {
      stateLoadedRef.current = true;
    }
  }

  function handleLogout() {
    authLogout();
    try { localStorage.removeItem(NAV_STORAGE_KEY); } catch { /* ignora */ }
    // Volta a barra de endereços pra raiz — deixar /campanha/123 na URL depois
    // do logout faria o próximo login tentar abrir a campanha de outra conta.
    try { window.history.replaceState({}, "", "/"); } catch { /* ignora */ }
    initialNavRef.current = { page: "dashboard", groupId: null };
    urlSyncedRef.current = false;
    stateLoadedRef.current = false;
    setActiveTour(null);
    setUser(null);
    setGroups([]); setNumbers([]); setWhatsappGroups([]);
    setSettings(DEFAULT_SETTINGS);
    setSelectedGroup(null);
    setPage("dashboard");
  }

  const handleCreateGroup = ({ name, categories, type, repasse }) => {
    const newGroup = makeEmptyGroup({ id: Date.now(), name, categories, template: settings.messageTemplate, type, repasse, sources: unlockedSources(storeLocks) });
    setGroups(gs => [...gs, newGroup]);
    setSelectedGroup(newGroup);
    setPage("group");
    maybeStartTour("campaign");
    return newGroup.id;
  };

  // Lê de `groupsRef` (não do `groups` fechado nesta closure) porque essa navFn
  // pode ficar pendurada em `pendingNav` e só executar depois de um `guardSave()`
  // assíncrono — nesse ponto `groups` já mudou (o save acabou de atualizá-lo) mas
  // essa closure ainda apontaria pro valor de antes, sobrescrevendo o resultado do save.
  const handleSelectGroup = g => requestNavigation(() => { setSelectedGroup(groupsRef.current.find(x => x.id === g.id)); setPage("group"); maybeStartTour("campaign"); });
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

  const updateWhatsappGroup = (wgId, updates) => {
    setWhatsappGroups(ws => ws.map(w => w.id === wgId ? { ...w, ...updates } : w));
  };

  // ─── Pausa por plano (cancelamento / downgrade) ────────────────────────
  // Quem passou do limite fica pausado, não apagado. Aqui o cliente troca quem
  // está ativo: se sobra vaga, ativa direto; se não, o modal pergunta qual sai.
  const isGroupPlanPaused = (id) => (planPaused.groups || []).some(x => Number(x) === Number(id));
  const isNumberPlanPaused = (id) => (planPaused.numbers || []).some(x => String(x) === String(id));
  const planPausedCount = (planPaused.groups || []).length + (planPaused.numbers || []).length;
  const numberName = (n) => n.label || n.phone || `Número ${n.id}`;

  // Listas de ativos no formato que a rota espera (o que não vem fica pausado).
  const currentSelection = () => ({
    groups: groups.filter(g => !isGroupPlanPaused(g.id)).map(g => Number(g.id)),
    numbers: numbers.filter(n => !isNumberPlanPaused(n.id)).map(n => String(n.id)),
  });

  const applyActiveSelection = async (selection) => {
    const res = await billingActiveSelection(selection);
    setPlanPaused(res.planPaused || EMPTY_PLAN_PAUSED);
    billingMe().then(b => setBilling(b)).catch(() => {});
    return res;
  };

  // kind: "groups" | "numbers"
  const activatePlanPaused = async (kind, id) => {
    const items = kind === "groups" ? groups : numbers;
    const isPaused = kind === "groups" ? isGroupPlanPaused : isNumberPlanPaused;
    const limit = kind === "groups" ? billing?.limits?.groups : billing?.limits?.numbers;
    const nameOf = (i) => (kind === "groups" ? i.name : numberName(i));
    const active = items.filter(i => !isPaused(i.id));
    const target = items.find(i => String(i.id) === String(id));
    if (!target) return;

    if (limit != null && active.length >= limit) {
      // Plano cheio — o cliente escolhe quem sai no lugar.
      setPlanSwapError(null);
      setPlanSwap({
        kind,
        id,
        target: { id, name: nameOf(target) },
        candidates: active.map(i => ({ id: i.id, name: nameOf(i) })),
      });
      return;
    }
    const selection = currentSelection();
    selection[kind] = [...selection[kind], kind === "groups" ? Number(id) : String(id)];
    try {
      await applyActiveSelection(selection);
    } catch (err) {
      setSaveError({ message: errText(err, "Não foi possível ativar. Tente novamente."), retryable: false, showPlans: err.code === "plan_limit" });
    }
  };

  const confirmPlanSwap = async (victimId) => {
    if (!planSwap) return;
    setPlanSwapBusy(true);
    setPlanSwapError(null);
    try {
      const { kind, id } = planSwap;
      const norm = (v) => (kind === "groups" ? Number(v) : String(v));
      const selection = currentSelection();
      selection[kind] = selection[kind].filter(x => norm(x) !== norm(victimId)).concat([norm(id)]);
      await applyActiveSelection(selection);
      setPlanSwap(null);
    } catch (err) {
      setPlanSwapError(errText(err, "Não conseguimos fazer a troca agora."));
    } finally {
      setPlanSwapBusy(false);
    }
  };

  // Confirmação de troca de email vem antes até das telas públicas: o link
  // pode ser aberto logado ou deslogado, e o que vale é o token da URL.
  if (emailChangeToken) {
    return (
      <ConfirmarNovoEmail
        token={emailChangeToken}
        onDone={() => {
          // Confirmar já subiu o tokenVersion no servidor: a sessão desta aba
          // não vale mais. Limpa e cai no login com o email novo.
          clearToken();
          setUser(null);
          setEmailChangeToken(null);
        }}
      />
    );
  }

  // Telas públicas vêm antes de tudo: não dependem de sessão e não podem ser
  // engolidas pelo "Carregando…" do bootstrap nem pela tela de login.
  if (publicPage === "assinar") {
    return <PageAssinar onGoToLogin={() => { window.history.replaceState({}, "", "/"); setPublicPage(null); }} />;
  }
  if (publicPage === "bem-vindo") {
    return <PageBemVindo onLogin={(u) => { window.history.replaceState({}, "", "/"); setPublicPage(null); handleLogin(u); }} />;
  }

  if (bootstrapping) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--color-text-secondary)", fontSize: 13 }}>
        Carregando...
      </div>
    );
  }

  // Não conseguimos falar com o servidor na abertura. A sessão continua válida
  // — o que faltou foi conexão, então nada de mandar pro login.
  if (bootOffline) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
        <div style={{ maxWidth: 420, textAlign: "center" }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>📡</div>
          <h1 style={{ fontSize: 18, margin: "0 0 8px", color: "var(--color-text-primary)" }}>
            Sem conexão com o Nimbus
          </h1>
          <p style={{ fontSize: 14, lineHeight: 1.5, margin: "0 0 20px", color: "var(--color-text-secondary)" }}>
            Não foi possível falar com o servidor agora. Sua conta está segura — continuamos tentando e a página volta sozinha assim que a conexão voltar.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{ padding: "9px 18px", borderRadius: 8, border: "none", cursor: "pointer", fontSize: 13, fontWeight: 500, background: "var(--color-primary)", color: "#fff" }}
          >
            Tentar de novo
          </button>
        </div>
      </div>
    );
  }

  if (!user) {
    return <Login onLogin={handleLogin} />;
  }

  // Uma conta = um CPF: contas criadas antes da regra informam o documento
  // aqui, antes de o painel abrir. Admin é isento (cpfRequired já vem false).
  if (user.cpfRequired) {
    return <ConfirmarCpf user={user} onDone={setUser} onLogout={handleLogout} />;
  }

  const fallbackPage = <PageDashboard groups={groups} whatsappGroups={liveWhatsappGroups} onSelectGroup={handleSelectGroup} onCreateGroup={handleCreateGroup} onUpdate={handleUpdate} affiliateConfigured={affiliateConfigured} onGoToSettings={() => setPage("settings")} limits={billing?.limits} planPausedIds={planPaused.groups} onActivatePlanPaused={(id) => activatePlanPaused("groups", id)} />;
  // Loja trancada pelo admin → mostra só a mensagem no lugar da página de
  // afiliado. Admin continua vendo a página normal pra poder validar antes de liberar.
  const lockedStore = (storeId) => {
    if (user?.role === "admin") return null;
    const msg = storeLockMessage(storeLocks, storeId);
    if (!msg) return null;
    const label = { ml: "Mercado Livre", amazon: "Amazon", shopee: "Shopee" }[storeId];
    return <StoreLockedNotice storeLabel={label} message={msg} />;
  };
  const pageMap = {
    dashboard: <PageDashboard groups={groups} whatsappGroups={liveWhatsappGroups} onSelectGroup={handleSelectGroup} onCreateGroup={handleCreateGroup} onUpdate={handleUpdate} affiliateConfigured={affiliateConfigured} onGoToSettings={() => setPage("settings")} limits={billing?.limits} planPausedIds={planPaused.groups} onActivatePlanPaused={(id) => activatePlanPaused("groups", id)} />,
    products: user?.role === "admin" ? <PageProducts /> : fallbackPage,
    whatsapp: <PageWhatsApp
      numbers={numbers}
      setNumbers={setNumbers}
      whatsappGroups={whatsappGroups}
      onRemoveNumber={removeNumberAndGroups}
      onRelinkNumber={relinkNumber}
      limits={billing?.limits}
      planPausedIds={planPaused.numbers}
      onActivatePlanPaused={(id) => activatePlanPaused("numbers", id)}
    />,
    settings: <PageSettings user={user} setUser={setUser} onLogout={handleLogout} settings={settings} setSettings={setSettings} numbers={numbers} onAffiliateChange={applyAffiliateStatus} />,
    subscription: <PageSubscription />,
    "mercado-livre": lockedStore("ml") || <PageAffiliateML onAffiliateChange={applyAffiliateStatus} onOpenTutorial={openTutorial} />,
    "amazon": lockedStore("amazon") || <PageAffiliateAmazon onAffiliateChange={applyAffiliateStatus} onOpenTutorial={openTutorial} />,
    "shopee": lockedStore("shopee") || <PageAffiliateShopee onAffiliateChange={applyAffiliateStatus} onOpenTutorial={openTutorial} />,
    "admin-scraper":  user?.role === "admin" ? <PageAdminScraper /> : fallbackPage,
    "admin-scrap-tester": user?.role === "admin" ? <PageAdminScrapTester /> : fallbackPage,
    "admin-ml":       user?.role === "admin" ? <PageAdminML /> : fallbackPage,
    "admin-amazon":   user?.role === "admin" ? <PageAdminAmazon /> : fallbackPage,
    "admin-shopee":   user?.role === "admin" ? <PageAdminShopee /> : fallbackPage,
    "admin-repasse":  user?.role === "admin" ? <PageAdminRepasse /> : fallbackPage,
    "admin-users":          user?.role === "admin" ? <PageAdminUsers currentUser={user} /> : fallbackPage,
    "admin-backups":        user?.role === "admin" ? <PageAdminBackups /> : fallbackPage,
    "admin-notifications":  user?.role === "admin" ? <PageAdminNotifications onGoToWhatsNimbus={() => requestNavigation(() => setPage("admin-whatsnimbus"))} /> : fallbackPage,
    "admin-notif-templates": user?.role === "admin" ? <PageAdminNotifTemplates /> : fallbackPage,
    "admin-emails": user?.role === "admin" ? <PageAdminEmails /> : fallbackPage,
    "admin-whatsnimbus":    user?.role === "admin" ? <PageAdminWhatsNimbus /> : fallbackPage,
    "admin-layout":         user?.role === "admin" ? <PageAdminLayout /> : fallbackPage,
    "admin-stripe":         user?.role === "admin" ? <PageAdminStripe /> : fallbackPage,
    "tutorials":     <PageTutoriais
      targetTutorialId={tutorialTarget}
      onboarding={onboarding}
      onStartTour={startTour}
      // O tour da campanha precisa de uma campanha aberta pra ter o que
      // iluminar — aqui só rearmamos, e ele começa sozinho na próxima que abrir.
      onArmCampaignTour={() => patchOnboarding(prev => ({ tours: { ...prev.tours, campaign: false } }))}
    />,
  };

  return (
    <NavGuardContext.Provider value={navGuard}>
    <div className="app-layout" style={{ display: "flex", minHeight: "100vh" }}>
      {pendingNav && (
        <UnsavedChangesModal onSave={guardSave} onDiscard={guardDiscard} onCancel={closeGuard} />
      )}
      {confirmLogout && (
        <LogoutConfirmModal
          onCancel={() => setConfirmLogout(false)}
          onConfirm={() => { setConfirmLogout(false); handleLogout(); }}
        />
      )}
      {activeTour && (
        <TourOverlay
          tour={activeTour}
          onNavigate={(p) => { setSelectedGroup(null); setPage(p); }}
          onFinish={finishTour}
        />
      )}
      <HelpButton
        page={page}
        hasGroupOpen={!!selectedGroup}
        onStartTour={startTour}
        onOpenTutorials={() => requestNavigation(() => { setSelectedGroup(null); setPage("tutorials"); })}
      />
      {planSwap && (
        <PlanSwapModal
          kind={planSwap.kind === "groups" ? "campanha" : "número"}
          target={planSwap.target}
          candidates={planSwap.candidates}
          busy={planSwapBusy}
          error={planSwapError}
          onCancel={() => { setPlanSwap(null); setPlanSwapError(null); }}
          onConfirm={confirmPlanSwap}
        />
      )}
      <Sidebar
        page={page}
        selectedGroup={selectedGroup}
        groups={groups}
        whatsappGroups={liveWhatsappGroups}
        numbers={liveNumbers}
        affiliateConfigured={affiliateConfigured}
        affiliateStatus={affiliateStatus}
        storeLocks={user?.role === "admin" ? {} : storeLocks}
        user={user}
        billing={billing}
        onNavigate={(id) => requestNavigation(() => { setPage(id); setSelectedGroup(null); setTutorialTarget(null); })}
        onSelectGroup={handleSelectGroup}
        onLogout={() => { setMobileMenu(false); setConfirmLogout(true); }}
        mobileOpen={mobileMenu}
        onToggleMobile={setMobileMenu}
      />
      <div className="main-content" style={{ flex: 1, padding: "20px 24px", minWidth: 0, overflowY: "auto" }}>
        {/* Sem conexão tem precedência: com o servidor fora, os outros avisos
            (falha de save, poll lento) são só sintoma da mesma causa. */}
        {!net.online && (
          <AlertBanner
            tone="warn"
            message="Sem conexão com o Nimbus. Tentando reconectar — o que estiver na tela pode estar desatualizado."
          />
        )}
        {net.online && net.recovered && (
          <AlertBanner tone="success" message="Conexão restabelecida." />
        )}
        {net.online && saveError && (
          <AlertBanner
            tone="error"
            message={saveError.message}
            onRetry={saveError.retryable ? retrySave : undefined}
            retryLabel="Tentar agora"
            actions={saveError.showPlans ? [{
              label: "Ver planos",
              onClick: () => requestNavigation(() => { setSaveError(null); setSelectedGroup(null); setPage("subscription"); }),
            }] : undefined}
          />
        )}
        {net.online && degradedPolls.size > 0 && (
          <AlertBanner
            tone="warn"
            message="Atualização automática mais lenta no momento (muitas requisições) — tentando novamente. Se algo parecer desatualizado, recarregue a página."
          />
        )}
        {/* Pausado pelo plano: nada foi apagado — só parou de enviar. O cliente
            escolhe quem volta a ficar ativo na própria lista (botão "Ativar"). */}
        {planPausedCount > 0 && (
          <div style={{ background: "var(--warn-bg)", border: "0.5px solid var(--warn-border)", color: "var(--warn-text)", padding: "10px 14px", borderRadius: 8, fontSize: 13, marginBottom: 12, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span style={{ flex: 1, minWidth: 220 }}>
              {(planPaused.groups || []).length > 0 && (
                <>Seu plano cobre {billing?.limits?.groups ?? 0} campanha{billing?.limits?.groups === 1 ? "" : "s"} ativa{billing?.limits?.groups === 1 ? "" : "s"} — {(planPaused.groups || []).length} está{(planPaused.groups || []).length === 1 ? "" : "ão"} pausada{(planPaused.groups || []).length === 1 ? "" : "s"} e não envia{(planPaused.groups || []).length === 1 ? "" : "m"}. </>
              )}
              {(planPaused.numbers || []).length > 0 && (
                <>{(planPaused.numbers || []).length} número{(planPaused.numbers || []).length === 1 ? "" : "s"} de WhatsApp pausado{(planPaused.numbers || []).length === 1 ? "" : "s"} pelo plano (segue{(planPaused.numbers || []).length === 1 ? "" : "m"} conectado{(planPaused.numbers || []).length === 1 ? "" : "s"}). </>
              )}
              Nada foi apagado — escolha o que fica ativo em <strong>Campanhas</strong> / <strong>WhatsApp</strong>, ou assine um plano maior.
            </span>
            <button onClick={() => requestNavigation(() => { setSelectedGroup(null); setPage("subscription"); })} style={{ padding: "6px 12px", borderRadius: 8, background: "var(--warn-text)", color: "var(--color-background-primary)", border: "none", fontSize: 12, cursor: "pointer", fontWeight: 500 }}>
              Ver planos
            </button>
          </div>
        )}
        {billing && !billing.isAdmin && (
          billing.inGrace ? (
            <div onClick={() => requestNavigation(() => setPage("subscription"))} style={{ cursor: "pointer", background: "var(--danger-bg)", border: "0.5px solid var(--danger-border)", color: "var(--danger-text)", padding: "10px 14px", borderRadius: 8, fontSize: 13, marginBottom: 12 }}>
              Não conseguimos cobrar seu cartão. Você continua enviando até {billing.graceEndsAt ? new Date(billing.graceEndsAt).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }) : "o fim da carência"} — clique para atualizar o pagamento.
            </div>
          ) : (billing.status === "past_due" || billing.status === "unpaid") ? (
            <div onClick={() => requestNavigation(() => setPage("subscription"))} style={{ cursor: "pointer", background: "var(--danger-bg)", border: "0.5px solid var(--danger-border)", color: "var(--danger-text)", padding: "10px 14px", borderRadius: 8, fontSize: 13, marginBottom: 12 }}>
              Pagamento pendente — clique para regularizar e manter envios ativos.
            </div>
          ) : billing.status === "trialing" && billing.daysLeftInTrial !== null && billing.daysLeftInTrial <= 2 ? (
            <div onClick={() => requestNavigation(() => setPage("subscription"))} style={{ cursor: "pointer", background: "var(--warn-bg)", border: "0.5px solid var(--warn-border)", color: "var(--warn-text)", padding: "10px 14px", borderRadius: 8, fontSize: 13, marginBottom: 12 }}>
              Seu trial expira em {billing.daysLeftInTrial}d. Assine para continuar usando.
            </div>
          ) : billing.effectivePlan === "free" ? (
            <div onClick={() => requestNavigation(() => setPage("subscription"))} style={{ cursor: "pointer", background: "var(--warn-bg)", border: "0.5px solid var(--warn-border)", color: "var(--warn-text)", padding: "10px 14px", borderRadius: 8, fontSize: 13, marginBottom: 12 }}>
              Sem plano ativo — envios pausados. Escolha um plano para reativar.
            </div>
          ) : null
        )}
        {selectedGroup
          ? <GroupDashboard
              key={selectedGroup.id}
              group={selectedGroup}
              numbers={numbers}
              whatsappGroups={liveWhatsappGroups}
              affiliateConfigured={affiliateConfigured}
              affiliateStatus={affiliateStatus}
              storeLocks={storeLocks}
              onBack={handleBack}
              onUpdate={handleUpdate}
              onDelete={handleDelete}
              onCreateWhatsappGroup={createWhatsappGroup}
              onDeleteWhatsappGroup={deleteWhatsappGroup}
              onUpdateWhatsappGroup={updateWhatsappGroup}
              onGoToSettings={() => requestNavigation(() => setPage("settings"))}
              onGoToAffiliate={(provider) => requestNavigation(() => setPage(provider === "shopee" ? "shopee" : "mercado-livre"))}
              onGoToWhatsapp={() => requestNavigation(() => setPage("whatsapp"))}
              customTemplates={settings.customTemplates || []}
              onAddCustomTemplate={addCustomTemplate}
              onDeleteCustomTemplate={deleteCustomTemplate}
              onUpdateCustomTemplate={updateCustomTemplate}
              limits={billing?.limits}
            />
          : pageMap[page] || pageMap["dashboard"]
        }
      </div>
    </div>
    </NavGuardContext.Provider>
  );
}
