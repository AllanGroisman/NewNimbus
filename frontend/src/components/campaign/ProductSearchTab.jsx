import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  PRIMARY, PRIMARY_DARK, PRIMARY_LIGHT, allSources,
  CATEGORIES, categoryLabel, categoryIcon, formatPrice,
} from "../../data/constants";
import { browseCatalog, errText } from "../../data/api";
import Toggle from "../ui/Toggle";
import Modal from "../ui/Modal";
import UsageBadge from "../ui/UsageBadge";
import Badge from "../ui/Badge";
import { ProductGridCard } from "../ui/ProductCard";
import Pagination from "../ui/Pagination";

// Ordens aceitas pelo catálogo (backend/catalog/pg.js). O mesmo valor vai pro
// `scraping.sortBy` da campanha, então a prévia e o preenchimento da fila
// enxergam os produtos exatamente na mesma ordem.
export const SORT_OPTIONS = [
  { id: "discount_desc", label: "Maior desconto" },
  { id: "price_asc", label: "Menor preço" },
  { id: "price_desc", label: "Maior preço" },
  { id: "rating_desc", label: "Melhor avaliação" },
  { id: "lastSeen_desc", label: "Mais recentes" },
];
export const DEFAULT_SORT = "discount_desc";
export const DEFAULT_BATCH = 20;
export const MAX_BATCH = 50;

// Tetos dos filtros que têm um: nota vai até 5 e desconto até 100%. Vendas não
// tem teto — o catálogo chega em dezenas de milhares.
const MAX_RATING = 5;
const MAX_DISCOUNT = 100;

const PAGE_SIZE = 24;
// Placeholders da primeira carga: metade da página, o bastante pra tela não
// nascer vazia sem fingir um total que ainda não se sabe.
const SKELETON_CARDS = 12;

// Idade máxima pra um produto ainda ser "novo" no catálogo.
const NEW_HOURS = 24;

// Aviso de que o que está na tela ainda não virou lista. Numa constante porque
// aparece em dois lugares (embaixo da busca e dentro do painel de filtros).
const PENDING_HINT = "Você mudou a busca — clique em Buscar (ou aperte Enter) pra atualizar a lista.";

// Preenchimento automático: quando ele acontece.
export const DEFAULT_REFILL_THRESHOLD = 5;
export const MAX_REFILL_THRESHOLD = 50;
export const MAX_REFILL_TIMES = 12;
const SECTIONS_KEY = "nimbus.searchTab.sections";
const VIEW_KEY = "nimbus.searchTab.view";

const EMPTY_FILTERS = { keywords: "", minPrice: 0, maxPrice: null, minDiscount: 0, minRating: 0, minSales: 0 };

// Só o que o catálogo entende dos filtros. Serve pra duas coisas ao mesmo tempo:
// é o que vai na request, e é o que se compara pra saber se o que está escrito
// na tela ainda não foi buscado (assim "" e 0 não passam por mudança).
const filterSig = (f = {}) => JSON.stringify({
  q: f.keywords || "",
  minPrice: Number(f.minPrice) || 0,
  maxPrice: f.maxPrice ?? null,
  minDiscount: Number(f.minDiscount) || 0,
  minRating: Number(f.minRating) || 0,
  minSales: Number(f.minSales) || 0,
});

// Chaves de comparação com fila/pendentes/histórico.
//
// A `key` (productKey do backend) é a única que fecha em todos os casos: o que
// está na fila e no histórico guarda o link JÁ AFILIADO, que nunca é igual ao
// link do catálogo. O link normalizado fica como reserva, pra item antigo salvo
// sem key.
function linkKey(item) {
  const l = item?.originalLink || item?.link || "";
  return String(l).trim().toLowerCase().replace(/[?#].*$/, "").replace(/\/+$/, "");
}
function itemKeys(item) {
  const out = [];
  if (item?.key) out.push(String(item.key));
  const l = linkKey(item);
  if (l) out.push(l);
  return out;
}

const num = (v) => (v === "" || v == null ? null : Number(v));

// Valor final de um filtro numérico digitado à mão: vazio e lixo viram 0
// (filtro desligado), negativo vira 0 e o que passa do teto encosta nele — um
// "50" digitado na nota zeraria a lista sem dizer por quê.
const clampFilter = (raw, max) => {
  const n = Number(raw);
  if (raw === "" || !Number.isFinite(n) || n <= 0) return 0;
  return max == null ? n : Math.min(max, n);
};

// Painéis que abrem num botão: onde buscar (lojas/categorias), os filtros (ao
// lado da busca) e os ajustes do preenchimento automático. Fechados por padrão —
// a busca e a lista de produtos são o que importa no dia a dia, e ficam no topo.
function loadSections() {
  try {
    const raw = JSON.parse(localStorage.getItem(SECTIONS_KEY) || "{}");
    return { where: raw.where === true, queue: raw.queue === true, filters: raw.filters === true };
  } catch {
    return { where: false, queue: false, filters: false };
  }
}

// Chaves da lista de produtos: o que aparece e o que fica escondido.
function loadView() {
  try {
    const raw = JSON.parse(localStorage.getItem(VIEW_KEY) || "{}");
    return { recent: raw.recent === true, queued: raw.queued !== false };
  } catch {
    return { recent: false, queued: true };
  }
}

export default function ProductSearchTab({
  groupId,
  scraping, setScraping,
  // Categorias e lojas da campanha — moram no grupo, editados aqui.
  categories = [], onToggleCategory, categoryLimit,
  selectedSources = [], onToggleSource, lockMessageFor = () => null,
  refilling, triggerRefill, refillMsg,
  save, dirty, filtersDirty, saved, saveBtnStyle,
  pending = [], queue = [], history = [], cooldownMinutes = 0,
  onAddCatalogProduct,
}) {
  // No useMemo por causa do `|| {}`: sem ele, uma campanha sem filtros criaria
  // um objeto novo por render e o `searchNow` (que depende dele) nunca pararia
  // de mudar de identidade.
  const filters = useMemo(() => scraping.filters || {}, [scraping.filters]);
  const sortBy = SORT_OPTIONS.some(o => o.id === scraping.sortBy) ? scraping.sortBy : DEFAULT_SORT;
  const batch = Number(scraping.batchSize) > 0 ? Math.min(MAX_BATCH, Number(scraping.batchSize)) : DEFAULT_BATCH;
  const autoRefill = scraping.autoRefill !== false;
  const refillMode = scraping.refillMode === "schedule" ? "schedule" : "threshold";
  const refillThreshold = Number(scraping.refillThreshold) > 0
    ? Math.min(MAX_REFILL_THRESHOLD, Number(scraping.refillThreshold))
    : DEFAULT_REFILL_THRESHOLD;
  const refillTimes = Array.isArray(scraping.refillTimes) ? scraping.refillTimes : [];

  const [page, setPage] = useState(1);
  // Os filtros que a lista atual reflete. Nascem iguais aos da campanha, pra a
  // primeira busca sair com o que estava salvo.
  const [applied, setApplied] = useState(() => ({ ...EMPTY_FILTERS, ...(scraping.filters || {}) }));
  const [sections, setSections] = useState(loadSections);
  const [view, setView] = useState(loadView);

  // "Onde buscar" e "Preenchimento" abrem no mesmo lugar, logo abaixo da faixa:
  // abrir um fecha o outro, pra a página não crescer duas vezes.
  const toggleSection = (id) => setSections(s => {
    const next = { ...s, [id]: !s[id] };
    if (id === "where" && next.where) next.queue = false;
    if (id === "queue" && next.queue) next.where = false;
    try { localStorage.setItem(SECTIONS_KEY, JSON.stringify(next)); } catch { /* modo privado */ }
    return next;
  });
  const setViewFlag = (id, v) => setView(s => {
    const next = { ...s, [id]: v };
    try { localStorage.setItem(VIEW_KEY, JSON.stringify(next)); } catch { /* modo privado */ }
    return next;
  });
  const [preview, setPreview] = useState({ items: [], total: 0 });
  const [loadingPreview, setLoadingPreview] = useState(true);
  const [previewError, setPreviewError] = useState(null);
  // Vários produtos podem estar sendo adicionados ao mesmo tempo: cada card
  // guarda o próprio "adicionando" e a própria mensagem.
  const [addingKeys, setAddingKeys] = useState(() => new Set());
  const [addMsgs, setAddMsgs] = useState(() => new Map()); // key -> { type, text }
  const [cooldownAsk, setCooldownAsk] = useState(null);    // { key, product, info }
  // Confirmação do "Preencher fila agora": o botão salva a configuração e sai
  // buscando no catálogo, então um clique sem querer custa caro.
  const [askRefill, setAskRefill] = useState(false);

  // Lojas que a busca realmente usa: as escolhidas menos as trancadas pelo admin.
  const usableSources = useMemo(
    () => selectedSources.filter(s => !lockMessageFor(s)),
    [selectedSources, lockMessageFor],
  );
  // Sem loja ativa a campanha não busca nada, e o catálogo não pode ser chamado
  // com lista vazia (lá isso significa "todas as lojas").
  const noSources = usableSources.length === 0;
  const hasLockedSelected = selectedSources.some(s => lockMessageFor(s));

  // Sem loja não há o que listar: o painel de "Onde buscar" abre sozinho, que é
  // onde está a correção.
  const whereOpen = sections.where || noSources;
  // Um painel por vez: se "Onde buscar" abriu sozinho, o de preenchimento espera.
  const queueOpen = sections.queue && !whereOpen;

  const catLimitReached = categoryLimit != null && categoryLimit < 99 && categories.length >= categoryLimit;
  // Quantas ainda cabem no plano (null = sem limite prático).
  const categoryLeft = categoryLimit != null && categoryLimit < 99
    ? Math.max(0, categoryLimit - categories.length)
    : null;
  const availableCategories = Object.keys(CATEGORIES).filter(id => !categories.includes(id));

  // Seletor de categorias: `picking` é o conjunto marcado enquanto ele está
  // aberto (null = fechado). Só no Confirmar as escolhas viram categorias da
  // campanha, então dá pra marcar várias de uma vez e desistir no meio.
  const [picking, setPicking] = useState(null);
  const togglePick = (id) => setPicking(s => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const confirmPick = () => {
    for (const id of picking) onToggleCategory(id);
    setPicking(null);
  };

  // Digitar não busca: o que está no campo (`filters`) é o que o usuário está
  // escrevendo, e `applied` é o que a lista na tela está mostrando. Só o botão
  // Buscar (ou Enter) leva um pro outro.
  const setFilter = (key, value) => setScraping(s => ({ ...s, filters: { ...s.filters, [key]: value } }));
  // Pros cliques que TIRAM filtro (chips "✕", "Tirar X", o ✕ da busca): ali o
  // usuário não está digitando, está mandando refazer a lista sem aquilo.
  const applyFilter = (key, value) => {
    setFilter(key, value);
    setApplied(a => ({ ...a, [key]: value }));
  };
  const resetFilters = () => {
    setScraping(s => ({ ...s, filters: { ...EMPTY_FILTERS } }));
    setApplied({ ...EMPTY_FILTERS });
  };

  // Assinatura dos parâmetros: muda ⇒ refaz a busca. Os filtros entram pelo
  // `applied` (o que foi buscado), não pelo que está sendo digitado; lojas,
  // categorias, ordem e as chaves de visibilidade entram direto — são um clique
  // só, e valem na hora. As chaves estão aqui porque viraram filtro de
  // servidor, não de tela.
  const paramsSig = JSON.stringify({
    groupId, categories, sources: usableSources, sortBy,
    hideQueued: !view.queued,
    hideRecent: !view.recent,
    ...JSON.parse(filterSig(applied)),
  });
  // Tem coisa escrita na tela que ainda não foi buscada.
  const pendingSearch = filterSig(filters) !== filterSig(applied);
  // Busca nova: volta pra primeira página e esquece o que era daquela busca —
  // as mensagens dos cards não valem pra outra lista.
  useEffect(() => {
    setPage(1);
    setAddMsgs(new Map());
  }, [paramsSig]);

  const abortRef = useRef(null);
  // Uma página de cada vez: a lista é substituída, nunca acumulada. O que a
  // campanha já tem na fila (ou mandou há pouco) sai no backend, então a página
  // vem cheia em vez de encolher depois de carregada.
  const runSearch = useCallback(async () => {
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoadingPreview(true);
    setPreviewError(null);
    const p = JSON.parse(paramsSig);
    try {
      const r = await browseCatalog({ ...p, page, pageSize: PAGE_SIZE }, { signal: ctrl.signal });
      setPreview({ items: r.items || [], total: r.total || 0 });
      // O total encolhe quando produtos entram na fila (o backend passa a
      // excluí-los), e a página em que o usuário está pode deixar de existir.
      const maxPage = Math.max(1, Math.ceil((r.total || 0) / PAGE_SIZE));
      if (page > maxPage) setPage(maxPage);
    } catch (err) {
      if (err.name === "AbortError") return;
      setPreviewError(errText(err, "Não foi possível carregar a prévia do catálogo."));
    } finally {
      if (abortRef.current === ctrl) {
        abortRef.current = null;
        setLoadingPreview(false);
      }
    }
  }, [paramsSig, page]);

  // Não há mais debounce: nada aqui muda por tecla digitada. O timer de 0ms
  // fica porque mudar de filtro rearma este efeito duas vezes seguidas (o sig
  // muda, e logo depois o `page` volta pra 1) — o cleanup mata a primeira antes
  // de ela virar request.
  const timerRef = useRef(null);
  useEffect(() => {
    if (noSources) {
      setPreview({ items: [], total: 0 });
      setLoadingPreview(false);
      return;
    }
    timerRef.current = setTimeout(runSearch, 0);
    return () => clearTimeout(timerRef.current);
  }, [runSearch, noSources]);

  useEffect(() => () => { if (abortRef.current) abortRef.current.abort(); }, []);

  // Buscar / Enter: é o único jeito de o que está escrito virar lista.
  const keywordsRef = useRef(null);
  const searchNow = useCallback(() => {
    if (noSources) return;
    // Nada mudou desde a última busca: aí o botão é só "atualizar a lista".
    if (!pendingSearch) {
      clearTimeout(timerRef.current);
      runSearch();
      return;
    }
    setApplied({ ...EMPTY_FILTERS, ...filters });
  }, [noSources, pendingSearch, filters, runSearch]);

  // Enter em qualquer campo do painel de filtros busca, como no campo de cima —
  // ninguém precisa voltar até o botão depois de digitar "30" no desconto.
  const onFilterKeyDown = (e) => {
    if (e.key === "Enter") { e.preventDefault(); searchNow(); }
  };

  const totalPages = Math.max(1, Math.ceil((preview.total || 0) / PAGE_SIZE));

  // Virar de página troca a lista inteira: sem isso a tela continua no meio da
  // rolagem, mostrando produtos diferentes dos que estavam ali. A página nova
  // começa no topo da tela, e não no topo da lista: os controles da busca ficam
  // acima dela, e é de lá que se muda de ideia sobre o que procurar.
  const resultsRef = useRef(null);
  const firstPageRender = useRef(true);
  useEffect(() => {
    if (firstPageRender.current) { firstPageRender.current = false; return; }
    // Quem pediu menos animação no sistema recebe o pulo direto, como no
    // scroll-to-top do App.
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const behavior = reduce ? "auto" : "smooth";
    // `?.` nos métodos: o jsdom dos testes não implementa scroll.
    window.scrollTo?.({ top: 0, left: 0, behavior });
  }, [page]);

  // Selos "já está na fila / aguardando / já enviado" nos cards da prévia.
  const statusByKey = useMemo(() => {
    const map = new Map();
    const put = (item, status) => { for (const k of itemKeys(item)) map.set(k, status); };
    for (const h of history) put(h, "sent");
    for (const p of pending) put(p, "pending");
    for (const q of queue) put(q, "queue");
    return map;
  }, [queue, pending, history]);
  const statusOf = (product) => {
    for (const k of itemKeys(product)) {
      const s = statusByKey.get(k);
      if (s) return s;
    }
    return undefined;
  };

  // Enviados dentro do tempo de espera para reenvio: o preenchimento pula esses
  // produtos, então por padrão a lista também não os mostra.
  const recentKeys = useMemo(() => {
    const set = new Set();
    if (!(cooldownMinutes > 0)) return set;
    const limit = Date.now() - cooldownMinutes * 60000;
    for (const h of history) {
      const t = new Date(h?.sentAt).getTime();
      if (Number.isFinite(t)) {
        if (t >= limit) for (const k of itemKeys(h)) set.add(k);
      }
    }
    return set;
  }, [history, cooldownMinutes]);
  const isRecent = (product) => itemKeys(product).some(k => recentKeys.has(k));

  const cardKey = (p) => p.key || p.link;

  const setAddMsg = (ck, msg) => setAddMsgs(m => {
    const next = new Map(m);
    if (msg) next.set(ck, msg); else next.delete(ck);
    return next;
  });

  const addProduct = async (product, force = false) => {
    const ck = cardKey(product);
    if (addingKeys.has(ck)) return;
    // Uma pergunta de reenvio por vez: clicar em outro card fecha a anterior.
    setCooldownAsk(a => (a && a.key !== ck ? null : a));
    setAddingKeys(s => new Set(s).add(ck));
    setAddMsg(ck, null);
    try {
      const r = await onAddCatalogProduct(product, force);
      if (r?.inCooldown) {
        setCooldownAsk({ key: ck, product, info: r });
        return;
      }
      setCooldownAsk(null);
      const alvo = r?.target === "pending" ? "aguardando revisão" : "fila";
      setAddMsg(ck, { type: "ok", text: `Foi pra ${alvo}.` });
      setTimeout(() => setAddMsg(ck, null), 4000);
    } catch (err) {
      setAddMsg(ck, { type: "err", text: errText(err, "Não foi possível adicionar.") });
    } finally {
      setAddingKeys(s => {
        const next = new Set(s);
        next.delete(ck);
        return next;
      });
    }
  };

  // Resumo do que está filtrando agora — cada chip tira o próprio filtro, e
  // tirar vale na hora (`applyFilter`): é um clique, não é digitar.
  const activeChips = [];
  if (String(filters.keywords || "").trim()) {
    activeChips.push({ kind: "keywords", label: `"${filters.keywords}"`, clear: () => applyFilter("keywords", "") });
  }
  if (Number(filters.minPrice) > 0) {
    activeChips.push({ label: `a partir de ${formatPrice(Number(filters.minPrice))}`, clear: () => applyFilter("minPrice", 0) });
  }
  if (filters.maxPrice != null && Number(filters.maxPrice) > 0) {
    activeChips.push({ label: `até ${formatPrice(Number(filters.maxPrice))}`, clear: () => applyFilter("maxPrice", null) });
  }
  if (Number(filters.minDiscount) > 0) {
    activeChips.push({ label: `${filters.minDiscount}% ou mais de desconto`, clear: () => applyFilter("minDiscount", 0) });
  }
  if (Number(filters.minRating) > 0) {
    activeChips.push({ label: `nota ${String(filters.minRating).replace(".", ",")}+`, clear: () => applyFilter("minRating", 0) });
  }
  if (Number(filters.minSales) > 0) {
    activeChips.push({ label: `${filters.minSales}+ vendas`, clear: () => applyFilter("minSales", 0) });
  }

  // A palavra-chave já aparece no campo de busca — o resumo abaixo dele mostra
  // só o que está escondido dentro do botão "Filtros".
  const otherChips = activeChips.filter(c => c.kind !== "keywords");
  const hasAnyFilter = activeChips.length > 0;
  const priceInverted = Number(filters.minPrice) > 0 && Number(filters.maxPrice) > 0
    && Number(filters.minPrice) > Number(filters.maxPrice);

  // Resumo do preenchimento, mostrado embaixo do título do bloco.
  const timesSummary = refillTimes.length ? refillTimes.join(", ") : "nenhum horário escolhido";
  const queueSummary = !autoRefill
    ? "Automático desligado — só entra o que você mandar"
    : refillMode === "schedule"
      ? `Automático às ${timesSummary} · ${batch} por vez`
      : `Automático quando faltarem ${refillThreshold} na fila · ${batch} por vez`;

  // Resumo do "Onde buscar", pra o painel fechado ainda dizer onde a campanha
  // está procurando.
  const whereSummary = [
    usableSources.length ? usableSources.join(", ") : "nenhuma loja ativa",
    `${categories.length} ${categories.length === 1 ? "categoria" : "categorias"}`,
  ].join(" · ");

  // As chaves "Já na fila" e "Enviados recentemente" agora são filtro de
  // servidor (vão no paramsSig), então a página chega pronta. O que ainda pode
  // aparecer com elas desligadas é o que o usuário acabou de adicionar nesta
  // sessão — a lista só é rebuscada quando ele troca de página ou de filtro.
  const visibleItems = preview.items;

  const showSkeleton = loadingPreview && preview.items.length === 0 && !noSources;

  return (
    <div>
      {/* ── 1. Faixa de contexto: o que a campanha busca e como preenche a
             fila. Compacta de propósito — resumo de uma linha e um botão que
             abre o painel inteiro logo abaixo, sem empurrar a lista pra longe. */}
      <div className="grid-collapse" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: whereOpen || queueOpen ? 0 : 14 }}>
        <div data-tour="pr-where" style={stripCardStyle(whereOpen)}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 500, fontSize: 13, marginBottom: 2 }}>🏪 Onde buscar</div>
            <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>{whereSummary}</div>
          </div>
          <button
            type="button"
            onClick={() => toggleSection("where")}
            aria-expanded={whereOpen}
            aria-controls="sec-where"
            aria-label="Escolher lojas e categorias"
            title="As lojas e as categorias de produto que esta campanha vasculha"
            style={{ ...chipStyle({ active: false }), padding: "7px 12px", whiteSpace: "nowrap", display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            Alterar <span style={caretStyle(whereOpen)}>▼</span>
          </button>
        </div>

        <div data-tour="pr-queue" style={stripCardStyle(queueOpen)}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 500, fontSize: 13, marginBottom: 2 }}>🔄 Preenchimento automático</div>
            <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>{queueSummary}</div>
          </div>
          <button
            type="button"
            onClick={() => toggleSection("queue")}
            aria-expanded={queueOpen}
            aria-controls="sec-queue"
            title="Quando preencher e quantos produtos por vez"
            style={{ ...chipStyle({ active: false }), padding: "7px 12px", whiteSpace: "nowrap", display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            Configurar <span style={caretStyle(queueOpen)}>▼</span>
          </button>
          {/* A chave fica na faixa: ligar e desligar é um clique, não precisa
              abrir painel nenhum. */}
          <span data-tour="pr-auto" style={{ display: "inline-flex" }}>
            <Toggle label="Preencher a fila automaticamente" value={autoRefill} onChange={v => setScraping(s => ({ ...s, autoRefill: v }))} />
          </span>
        </div>
      </div>

      {/* ── 2. Painéis da faixa: abrem aqui, em largura inteira, um por vez —
             chips de loja e campos do preenchimento não cabem em meia coluna.
             O painel nasce colado no card que o abriu (canto reto no encontro,
             borda destacada), então o título não precisa se repetir aqui. */}
      {whereOpen && (
        <div className="nimbus-panel">
        <div id="sec-where" className="sec-panel join-left" style={panelStyle}>
        <label style={fieldLabelStyle}>Lojas</label>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
          {allSources.map(src => {
            const active = selectedSources.includes(src);
            const lockMsg = lockMessageFor(src);
            return (
              <button
                key={src}
                onClick={() => onToggleSource(src)}
                title={lockMsg || undefined}
                style={chipStyle({ active, disabled: !!lockMsg })}
              >
                {lockMsg ? "🔒 " : (active ? "✓ " : "")}{src}
              </button>
            );
          })}
        </div>
        {hasLockedSelected && (
          <div style={{ ...noteStyle("warn"), marginTop: -8, marginBottom: 16 }}>
            Uma das lojas desta campanha está indisponível no momento — ela é ignorada e a campanha segue buscando nas outras.
          </div>
        )}
        {selectedSources.length === 0 && (
          <div style={{ ...noteStyle("danger"), marginTop: -8, marginBottom: 16 }}>
            Selecione ao menos uma loja para a campanha buscar produtos.
          </div>
        )}

        <label style={{ ...fieldLabelStyle, display: "flex", alignItems: "center", gap: 8 }}>
          Categorias
          <UsageBadge current={categories.length} limit={categoryLimit} label="categorias" />
        </label>
        {/* Só as categorias ligadas ficam à mostra — as outras entram pelo
            botão Adicionar, pra a lista não virar um paredão de 20 chips. */}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          {categories.map(id => {
            const last = categories.length === 1;
            return (
              <span key={id} style={{ ...chipStyle({ active: true }), display: "inline-flex", alignItems: "center", gap: 6, cursor: "default" }}>
                <span>{categoryIcon(id)}</span>{categoryLabel(id)}
                <button
                  onClick={() => { if (!last) onToggleCategory(id); }}
                  disabled={last}
                  aria-label={`Tirar ${categoryLabel(id)}`}
                  title={last ? "A campanha precisa de pelo menos uma categoria" : "Tirar esta categoria"}
                  style={{
                    background: "transparent", border: "none", padding: 0, margin: 0,
                    color: "inherit", fontSize: 12, fontFamily: "inherit",
                    cursor: last ? "not-allowed" : "pointer", opacity: last ? 0.4 : 0.7,
                  }}
                >
                  ✕
                </button>
              </span>
            );
          })}
          {!picking && (
            <button
              onClick={() => setPicking(new Set())}
              disabled={catLimitReached || availableCategories.length === 0}
              title={catLimitReached
                ? `Seu plano permite ${categoryLimit} categorias por campanha. Tire uma para trocar.`
                : "Escolher mais categorias"}
              style={chipStyle({ active: false, disabled: catLimitReached || availableCategories.length === 0 })}
            >
              + Adicionar categoria
            </button>
          )}
        </div>

        {picking && (
          <div style={{ marginTop: 12, padding: 12, borderRadius: 10, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)" }}>
            <div style={{ fontSize: 12, marginBottom: 8 }}>
              Marque as categorias que quer adicionar
              {categoryLeft != null && <> — cabem mais {categoryLeft} no seu plano</>}.
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {availableCategories.map(id => {
                const chosen = picking.has(id);
                const noRoom = !chosen && categoryLeft != null && picking.size >= categoryLeft;
                return (
                  <button
                    key={id}
                    onClick={() => { if (!noRoom) togglePick(id); }}
                    disabled={noRoom}
                    title={noRoom ? `Seu plano permite ${categoryLimit} categorias por campanha.` : undefined}
                    style={chipStyle({ active: chosen, disabled: noRoom })}
                  >
                    {chosen ? "✓ " : ""}<span style={{ marginRight: 4 }}>{categoryIcon(id)}</span>{categoryLabel(id)}
                  </button>
                );
              })}
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <button
                onClick={confirmPick}
                disabled={picking.size === 0}
                style={{
                  padding: "7px 16px", borderRadius: 8, border: "none",
                  background: picking.size === 0 ? "var(--color-background-primary)" : PRIMARY,
                  color: picking.size === 0 ? "var(--color-text-secondary)" : "#fff",
                  fontSize: 12, fontWeight: 500, fontFamily: "inherit",
                  cursor: picking.size === 0 ? "not-allowed" : "pointer",
                }}
              >
                Confirmar{picking.size > 0 ? ` (${picking.size})` : ""}
              </button>
              <button
                onClick={() => setPicking(null)}
                style={{ padding: "7px 14px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", color: "inherit", fontSize: 12, fontFamily: "inherit", cursor: "pointer" }}
              >
                Cancelar
              </button>
            </div>
            {categoryLeft === 0 && (
              <div style={{ ...noteStyle("warn"), marginTop: 10 }}>
                Você chegou no limite de {categoryLimit} {categoryLimit === 1 ? "categoria" : "categorias"} do seu plano.
                Tire uma para trocar, ou suba de plano para buscar em mais categorias.
              </div>
            )}
          </div>
        )}

        {!picking && catLimitReached && (
          <div style={{ ...noteStyle("warn"), marginTop: 10 }}>
            Você chegou no limite de {categoryLimit} {categoryLimit === 1 ? "categoria" : "categorias"} do seu plano.
            Tire uma para trocar, ou suba de plano para buscar em mais categorias.
          </div>
        )}
        </div>
        </div>
      )}

      {queueOpen && (
        <div className="nimbus-panel">
        <div id="sec-queue" className="sec-panel join-right" style={panelStyle}>
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 4 }}>
          {autoRefill
            ? "O sistema preenche a fila sozinho."
            : "Desligado: só o botão \"Preencher fila agora\" e o que você adicionar da lista."}
        </div>
        {autoRefill && (
          <div style={{ padding: "14px 0", borderBottom: "0.5px solid var(--color-border-tertiary)" }}>
            <label style={fieldLabelStyle}>Quando preencher</label>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
              <button
                onClick={() => setScraping(s => ({ ...s, refillMode: "threshold" }))}
                style={chipStyle({ active: refillMode === "threshold" })}
              >
                {refillMode === "threshold" ? "✓ " : ""}Quando a fila estiver acabando
              </button>
              <button
                onClick={() => setScraping(s => ({ ...s, refillMode: "schedule" }))}
                style={chipStyle({ active: refillMode === "schedule" })}
              >
                {refillMode === "schedule" ? "✓ " : ""}Em horários do dia
              </button>
            </div>

            {refillMode === "threshold" ? (
              <div style={{ maxWidth: 280 }}>
                <label style={fieldLabelStyle} htmlFor="pr-threshold">Preencher quando faltarem menos de</label>
                <input
                  id="pr-threshold" type="number" min={1} max={MAX_REFILL_THRESHOLD} value={refillThreshold}
                  onChange={e => {
                    const raw = e.target.value;
                    if (raw === "") return setScraping(s => ({ ...s, refillThreshold: "" }));
                    setScraping(s => ({ ...s, refillThreshold: Math.min(MAX_REFILL_THRESHOLD, Math.max(1, Number(raw))) }));
                  }}
                  onBlur={e => { if (e.target.value === "") setScraping(s => ({ ...s, refillThreshold: DEFAULT_REFILL_THRESHOLD })); }}
                  style={inputStyle}
                />
                <div style={hintStyle}>Produtos na fila. Só dentro das janelas de envio.</div>
              </div>
            ) : (
              <div>
                <label style={fieldLabelStyle}>Horários do preenchimento</label>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  {refillTimes.map((t, i) => (
                    <span key={`${t}-${i}`} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                      <input
                        type="time"
                        aria-label={`Horário ${i + 1}`}
                        value={t}
                        onChange={e => setScraping(s => {
                          const list = [...(s.refillTimes || [])];
                          list[i] = e.target.value;
                          return { ...s, refillTimes: list };
                        })}
                        style={{ ...inputStyle, width: "auto", padding: "7px 10px" }}
                      />
                      <button
                        onClick={() => setScraping(s => ({ ...s, refillTimes: (s.refillTimes || []).filter((_, j) => j !== i) }))}
                        title="Remover este horário"
                        aria-label={`Remover horário ${i + 1}`}
                        style={{ ...linkBtnStyle, textDecoration: "none", fontSize: 13 }}
                      >
                        ✕
                      </button>
                    </span>
                  ))}
                  {refillTimes.length < MAX_REFILL_TIMES && (
                    <button
                      onClick={() => setScraping(s => ({ ...s, refillTimes: [...(s.refillTimes || []), "09:00"] }))}
                      style={chipStyle({ active: false })}
                    >
                      + Adicionar horário
                    </button>
                  )}
                </div>
                <div style={hintStyle}>
                  Uma vez em cada horário, mesmo fora das janelas de envio.
                </div>
                {refillTimes.length === 0 && (
                  <div style={{ ...noteStyle("warn"), marginTop: 10 }}>
                    Sem nenhum horário, o preenchimento automático não vai acontecer. Adicione um horário
                    ou volte para "quando a fila estiver acabando".
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* A ordem não fica aqui: é o mesmo `scraping.sortBy` do seletor que
            está em cima da lista de produtos, onde dá pra ver o efeito. */}
        <div style={{ maxWidth: 280, paddingTop: 14 }}>
          <label style={fieldLabelStyle} htmlFor="pr-batch">Produtos por vez</label>
          <input
            id="pr-batch" type="number" min={1} max={MAX_BATCH} value={batch}
            onChange={e => {
              const raw = e.target.value;
              if (raw === "") return setScraping(s => ({ ...s, batchSize: "" }));
              setScraping(s => ({ ...s, batchSize: Math.min(MAX_BATCH, Math.max(1, Number(raw))) }));
            }}
            onBlur={e => { if (e.target.value === "") setScraping(s => ({ ...s, batchSize: DEFAULT_BATCH })); }}
            style={inputStyle}
          />
          <div style={hintStyle}>De 1 a {MAX_BATCH}.</div>
        </div>

        {/* Cupom do ML: vale só para o preenchimento AUTOMÁTICO da fila. A lista
            de produtos aqui de baixo continua mostrando tudo — o cupom é uma
            preferência de quem entra na fila sozinho, não um filtro de busca. */}
        <div style={{ paddingTop: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 500 }}>Produtos com cupom do Mercado Livre</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
            {[
              ["off", "Tanto faz"],
              ["prefer", "Preferir com cupom"],
              ["only", "Só com cupom"],
            ].map(([id, label]) => (
              <button
                key={id}
                onClick={() => setScraping(s => ({ ...s, couponBoost: id }))}
                style={chipStyle({ active: (scraping.couponBoost || "off") === id })}
              >
                {label}
              </button>
            ))}
          </div>
          <div style={hintStyle}>
            Vale no preenchimento automático da fila. Os cupons vêm de Admin › Cupom › Cupons do ML;
            com “só com cupom”, a fila pode vir vazia se nenhum produto da campanha estiver num cupom.
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 12, paddingTop: 14 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 500 }}>Misturar a fila depois de preencher</div>
            <div style={hintStyle}>Pra não sair uma sequência de ofertas parecidas.</div>
          </div>
          <Toggle
            label="Misturar a fila depois de preencher"
            value={scraping.shuffleAfterRefill === true}
            onChange={v => setScraping(s => ({ ...s, shuffleAfterRefill: v }))}
          />
        </div>
        </div>
        </div>
      )}

      {/* ── 3. Busca por palavras-chave (+ filtros no botão ao lado) ──── */}
      <div data-tour="pr-search" style={{ ...cardStyle, marginBottom: 14 }}>
        <label style={fieldLabelStyle} htmlFor="pr-keywords">Busca por palavras-chave</label>
        <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
          <div style={{ position: "relative", flex: 1 }}>
            <span style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", fontSize: 14, color: "var(--color-text-secondary)", pointerEvents: "none" }}>🔍</span>
            <input
              id="pr-keywords"
              ref={keywordsRef}
              type="text"
              value={filters.keywords || ""}
              onChange={e => setFilter("keywords", e.target.value)}
              // Enter busca. Esc limpa o campo (só o campo — a lista continua
              // como está até o próximo Buscar), como em qualquer busca.
              onKeyDown={e => {
                if (e.key === "Enter") { e.preventDefault(); searchNow(); }
                if (e.key === "Escape") setFilter("keywords", "");
              }}
              placeholder="Ex: notebook, monitor, fone bluetooth"
              style={{ ...inputStyle, paddingLeft: 36, paddingRight: filters.keywords ? 34 : 11 }}
            />
            {filters.keywords && (
              <button
                type="button"
                // Limpar a busca é um clique de "quero a lista sem isso": vale na
                // hora, sem passar pelo Buscar.
                onClick={() => { applyFilter("keywords", ""); keywordsRef.current?.focus(); }}
                aria-label="Limpar a busca"
                title="Limpar a busca"
                style={{
                  position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)",
                  background: "transparent", border: "none", padding: 4, lineHeight: 1,
                  color: "var(--color-text-secondary)", fontSize: 13, fontFamily: "inherit", cursor: "pointer",
                }}
              >
                ✕
              </button>
            )}
          </div>
          {/* A lista só muda aqui: digitar não busca mais nada sozinho, então
              o botão precisa ser o mais visível do bloco. */}
          <button
            type="button"
            onClick={searchNow}
            disabled={noSources}
            title={noSources
              ? "Escolha ao menos uma loja disponível"
              : "Buscar no catálogo com o que está escrito e com os filtros escolhidos"}
            style={{
              padding: "9px 18px", borderRadius: 8, border: "none",
              background: PRIMARY, color: "#fff",
              fontSize: 13, fontWeight: 500, fontFamily: "inherit",
              whiteSpace: "nowrap",
              cursor: noSources ? "not-allowed" : "pointer",
              opacity: noSources ? 0.6 : 1,
            }}
          >
            Buscar
          </button>
          <button
            data-tour="pr-filters"
            type="button"
            onClick={() => toggleSection("filters")}
            aria-expanded={sections.filters}
            aria-controls="sec-filters"
            title="Preço, desconto, avaliação e vendas"
            style={{
              ...chipStyle({ active: otherChips.length > 0 }),
              padding: "9px 14px", whiteSpace: "nowrap", display: "inline-flex", alignItems: "center", gap: 6,
            }}
          >
            <span>Filtros</span>
            {otherChips.length > 0 && (
              <span style={{ ...statusChipStyle, background: PRIMARY_LIGHT, color: PRIMARY_DARK }}>{otherChips.length}</span>
            )}
            <span style={{ fontSize: 10 }}>{sections.filters ? "▲" : "▼"}</span>
          </button>
        </div>
        <div style={pendingSearch ? { ...hintStyle, color: "var(--warn-text)" } : hintStyle}>
          {pendingSearch
            ? PENDING_HINT
            : "Vários termos separados por vírgula. Vazio = todos."}
        </div>

        {sections.filters && (
        <div id="sec-filters" style={{ marginTop: 16, paddingTop: 14, borderTop: "0.5px solid var(--color-border-tertiary)" }}>
        {/* Quem está mexendo aqui dentro não vê a dica lá de cima. */}
        {pendingSearch && (
          <div style={{ ...noteStyle("warn"), marginBottom: 14 }}>{PENDING_HINT}</div>
        )}
        <div className="grid-collapse" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <div>
            <label style={fieldLabelStyle} htmlFor="pr-min-price">Preço mínimo</label>
            <div style={{ position: "relative" }}>
              <span style={prefixStyle}>R$</span>
              <input
                id="pr-min-price" type="number" min={0} step={10}
                value={filters.minPrice || ""}
                onChange={e => setFilter("minPrice", num(e.target.value) ?? 0)}
                onKeyDown={onFilterKeyDown}
                placeholder="Sem mínimo"
                style={{ ...inputStyle, paddingLeft: 36 }}
              />
            </div>
          </div>
          <div>
            <label style={fieldLabelStyle} htmlFor="pr-max-price">Preço máximo</label>
            <div style={{ position: "relative" }}>
              <span style={prefixStyle}>R$</span>
              <input
                id="pr-max-price" type="number" min={0} step={10}
                value={filters.maxPrice ?? ""}
                onChange={e => setFilter("maxPrice", num(e.target.value))}
                onKeyDown={onFilterKeyDown}
                placeholder="Sem máximo"
                style={{ ...inputStyle, paddingLeft: 36 }}
              />
            </div>
          </div>
          <div>
            <label style={fieldLabelStyle} htmlFor="pr-min-discount">Desconto mínimo</label>
            <div style={{ position: "relative" }}>
              <span style={prefixStyle}>%</span>
              <input
                id="pr-min-discount" type="number" min={0} max={MAX_DISCOUNT} step={5}
                value={filters.minDiscount || ""}
                onChange={e => setFilter("minDiscount", num(e.target.value) ?? 0)}
                // O teto só entra ao sair do campo: prender enquanto digita
                // trocaria o "1" de "100" por "100" na frente dos olhos.
                onBlur={e => setFilter("minDiscount", clampFilter(e.target.value, MAX_DISCOUNT))}
                onKeyDown={onFilterKeyDown}
                placeholder="Sem mínimo"
                style={{ ...inputStyle, paddingLeft: 36 }}
              />
            </div>
          </div>
          <div>
            <label style={fieldLabelStyle} htmlFor="pr-min-rating">Avaliação mínima</label>
            <div style={{ position: "relative" }}>
              <span style={prefixStyle}>★</span>
              <input
                id="pr-min-rating" type="number" min={0} max={MAX_RATING} step={0.5}
                value={filters.minRating || ""}
                onChange={e => setFilter("minRating", num(e.target.value) ?? 0)}
                onBlur={e => setFilter("minRating", clampFilter(e.target.value, MAX_RATING))}
                onKeyDown={onFilterKeyDown}
                placeholder="Qualquer nota"
                style={{ ...inputStyle, paddingLeft: 36 }}
              />
            </div>
          </div>
          <div>
            <label style={fieldLabelStyle} htmlFor="pr-min-sales">Vendas mínimas</label>
            <input
              id="pr-min-sales" type="number" min={0} step={10}
              value={filters.minSales || ""}
              onChange={e => setFilter("minSales", num(e.target.value) ?? 0)}
              onBlur={e => setFilter("minSales", clampFilter(e.target.value, null))}
              onKeyDown={onFilterKeyDown}
              placeholder="Sem mínimo"
              style={inputStyle}
            />
          </div>
        </div>

        {priceInverted && (
          <div style={{ ...noteStyle("warn"), marginTop: 12 }}>
            O preço mínimo está maior que o máximo — desse jeito nenhum produto passa.
          </div>
        )}

        {(Number(filters.minRating) > 0 || Number(filters.minSales) > 0) && (
          <div style={{ ...noteStyle("warn"), marginTop: 12 }}>
            Avaliação e vendas excluem produtos sem essa informação — parte dos produtos da Amazon não traz nota.
          </div>
        )}

        {/* Salvar sem sair daqui: os filtros ficam no topo da aba e a barra de
            salvar mora lá no rodapé, depois da lista inteira. É o mesmo `save`
            (grava as escolhas da aba toda), só que aceso pelos filtros. */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 16, paddingTop: 12, borderTop: "0.5px solid var(--color-border-tertiary)" }}>
          <span style={{ flex: 1, fontSize: 12, color: "var(--color-text-secondary)" }}>
            {saved
              ? "Filtros salvos."
              : filtersDirty
                ? "Filtros alterados e ainda não salvos."
                : "A campanha usa estes filtros pra preencher a fila."}
          </span>
          <button
            onClick={save}
            disabled={!filtersDirty}
            title={filtersDirty ? "Salvar as escolhas desta aba" : "Sem alterações pra salvar"}
            style={{ ...saveBtnStyle(filtersDirty), padding: "7px 16px", fontSize: 12 }}
          >
            {saved ? "✓ Salvo!" : "Salvar filtros"}
          </button>
        </div>
        </div>
        )}

        {otherChips.length > 0 && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginTop: 14, paddingTop: 12, borderTop: "0.5px solid var(--color-border-tertiary)" }}>
            <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>Filtrando por:</span>
            {otherChips.map((c, i) => (
              <button key={i} onClick={c.clear} title="Remover este filtro" style={activeChipStyle}>
                {c.label} <span style={{ opacity: 0.6, marginLeft: 2 }}>✕</span>
              </button>
            ))}
            <button onClick={resetFilters} style={{ ...linkBtnStyle, marginLeft: 4 }}>Limpar filtros</button>
          </div>
        )}
      </div>

      {/* ── 4. Prévia do catálogo ─────────────────────────────────────── */}
      <div ref={resultsRef} data-tour="pr-results" style={{ marginBottom: 24 }}>
        {/* Cabeçalho + controles num card igual aos outros da tela (mesmo
            `cardStyle`). Já foi uma barra grudada no topo: ficava sem cantos
            arredondados no meio da rolagem e destoava de tudo em volta. */}
        <div style={{ ...cardStyle, marginBottom: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap", gap: 10, marginBottom: 14 }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 500 }}>Produtos encontrados</div>
            <div aria-live="polite" style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 2 }}>
              {noSources
                ? "Nenhuma loja ativa nesta campanha."
                : loadingPreview && preview.items.length === 0
                  ? "Carregando..."
                  : countText(preview, page, totalPages, loadingPreview)}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>Mostrar enviados recentemente</span>
              <Toggle label="Mostrar enviados recentemente" value={view.recent} onChange={v => setViewFlag("recent", v)} />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>Mostrar já na fila</span>
              <Toggle label="Mostrar os que já estão na fila" value={view.queued} onChange={v => setViewFlag("queued", v)} />
            </div>
          </div>
        </div>

        {/* Preencher agora age sobre esta lista, e precisa ficar acessível com
            o painel de preenchimento fechado. A ordem vem logo antes dele: é o
            `scraping.sortBy` da campanha, então é a mesma ordem que o
            preenchimento pega — encostada no botão, isso se vê sem legenda. */}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <label style={{ fontSize: 12, color: "var(--color-text-secondary)" }} htmlFor="pr-sort">Ordenar Por</label>
          <select
            id="pr-sort"
            value={sortBy}
            onChange={e => setScraping(s => ({ ...s, sortBy: e.target.value }))}
            title="Também é a ordem que o preenchimento usa"
            style={{ ...inputStyle, width: "auto", padding: "8px 10px" }}
          >
            {SORT_OPTIONS.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
          <button
            data-tour="pr-run"
            onClick={() => setAskRefill(true)}
            disabled={refilling || noSources}
            title={noSources ? "Escolha ao menos uma loja disponível" : "Salva a configuração e completa a fila agora, sem esperar o horário"}
            style={{ padding: "9px 20px", borderRadius: 8, border: "none", background: PRIMARY, color: "#fff", fontSize: 13, cursor: refilling ? "wait" : (noSources ? "not-allowed" : "pointer"), fontWeight: 500, opacity: refilling || noSources ? 0.6 : 1 }}
          >
            {refilling ? "⟳ Preenchendo..." : `Preencher fila agora (até ${batch})`}
          </button>
          {/* O que o botão faz está no pop-up de confirmação, que é onde a
              informação chega na hora de decidir. */}
          {refillMsg && (
            <span style={{ fontSize: 12, color: refillMsg.type === "err" ? "var(--danger-text)" : refillMsg.type === "warn" ? "var(--warn-text)" : PRIMARY_DARK }}>
              {refillMsg.text}
            </span>
          )}
        </div>
        </div>

        {previewError && (
          <div role="alert" style={{ ...noteStyle("danger"), marginBottom: 10, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span style={{ flex: 1 }}>{previewError}</span>
            <button onClick={runSearch} style={{ ...chipStyle({ active: false }), padding: "5px 12px", fontSize: 12 }}>
              Tentar de novo
            </button>
          </div>
        )}

        {noSources && (
          <div style={{ ...cardStyle, fontSize: 13, color: "var(--color-text-secondary)" }}>
            Escolha ao menos uma loja disponível em "Onde buscar" para ver os produtos.
          </div>
        )}

        {/* Sem itens agora quer dizer sem itens mesmo: as chaves de visibilidade
            já foram aplicadas no backend, não sobra nada escondido na tela. */}
        {!noSources && !loadingPreview && !previewError && visibleItems.length === 0 && (
          <div style={{ ...cardStyle, fontSize: 13, color: "var(--color-text-secondary)" }}>
            {/* Numa string só: quebrar em {expressões} espalharia o texto por
                vários nós e o findByText dos testes deixaria de achar a frase. */}
            <div>{emptyListText(view)}</div>
            {hasAnyFilter && (
              // Tirar um filtro de cada vez, sem ter que abrir o painel e
              // adivinhar qual deles está apertado demais.
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginTop: 10 }}>
                {activeChips.map((c, i) => (
                  <button key={i} onClick={c.clear} style={{ ...chipStyle({ active: false }), fontSize: 12 }}>
                    Tirar {c.label}
                  </button>
                ))}
                {activeChips.length > 1 && (
                  <button onClick={resetFilters} style={{ ...linkBtnStyle, marginLeft: 4 }}>Limpar todos os filtros</button>
                )}
              </div>
            )}
          </div>
        )}

        <div style={{
          display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 12,
          transition: "opacity 0.15s",
          // Enquanto a próxima página não chega, a atual fica apagada e sem
          // clique: adicionar um card que está de saída confunde.
          ...(loadingPreview && preview.items.length > 0 ? { opacity: 0.6, pointerEvents: "none" } : null),
        }}>
          {showSkeleton && Array.from({ length: SKELETON_CARDS }).map((_, i) => <SkeletonCard key={`sk-${i}`} />)}
          {visibleItems.map((p, i) => {
            const ck = cardKey(p);
            const status = statusOf(p);
            const recent = isRecent(p);
            // Já enviado não bloqueia: passado o tempo de espera ele volta a ser
            // elegível, e dentro do tempo o backend pede confirmação.
            const blocked = status === "queue" || status === "pending";
            const busy = addingKeys.has(ck);
            const asking = cooldownAsk?.key === ck;
            const msg = addMsgs.get(ck);
            return (
              <ProductGridCard
                key={p.key || `${p.link}-${i}`}
                product={p}
                // Com as três lojas ligadas, saber de onde veio a oferta muda a
                // escolha; e a ordem padrão é por desconto, então ele merece
                // mais que um selo no rodapé.
                showStore
                emphasizeDiscount
                // "Na fila" e "aguardando revisão" já estão escritos no botão
                // logo abaixo — o selo em cima só repetia. Fica o que o botão
                // não diz: que este produto já foi ao ar antes, e que ele é
                // novidade no catálogo.
                badge={
                  <>
                    {isNew(p) && <Badge color="blue">Novo</Badge>}
                    {status === "sent" && (
                      <Badge color={recent ? "amber" : "gray"}>{recent ? "Enviado há pouco" : "Já enviado"}</Badge>
                    )}
                  </>
                }
                footer={
                  // A confirmação de reenvio nasce no próprio card: o usuário
                  // clicou aqui embaixo na lista, um aviso no topo da página
                  // passaria despercebido.
                  asking ? (
                    <div style={{ ...noteStyle("warn"), padding: "8px 9px" }}>
                      <div style={{ marginBottom: 7 }}>
                        Já enviado há pouco
                        {cooldownAsk.info?.cooldownLabel ? ` (espera de ${cooldownAsk.info.cooldownLabel})` : ""}.
                        {" "}Adicionar mesmo assim?
                      </div>
                      <div style={{ display: "flex", gap: 6 }}>
                        <button
                          onClick={() => addProduct(p, true)}
                          disabled={busy}
                          style={{ flex: 1, padding: "6px 8px", borderRadius: 7, background: PRIMARY, color: "#fff", border: "none", fontSize: 11, cursor: busy ? "wait" : "pointer", fontWeight: 500 }}
                        >
                          {busy ? "Adicionando..." : "Adicionar assim mesmo"}
                        </button>
                        <button
                          onClick={() => setCooldownAsk(null)}
                          style={{ padding: "6px 10px", borderRadius: 7, background: "transparent", color: "inherit", border: "0.5px solid var(--color-border-secondary)", fontSize: 11, cursor: "pointer" }}
                        >
                          Não
                        </button>
                      </div>
                    </div>
                  ) : msg ? (
                    // A confirmação ocupa o lugar do botão pelos segundos em que
                    // fica na tela; quando ela sai, o botão volta já mostrando o
                    // novo estado ("Já na fila").
                    <div
                      style={{
                        padding: "7px 10px", borderRadius: 8, textAlign: "center",
                        fontSize: 12, fontWeight: 500,
                        background: msg.type === "err" ? "var(--danger-bg)" : PRIMARY_LIGHT,
                        color: msg.type === "err" ? "var(--danger-text)" : PRIMARY_DARK,
                      }}
                    >
                      {msg.text}
                    </div>
                  ) : (
                    <button
                      onClick={() => addProduct(p)}
                      disabled={blocked || busy}
                      title={status === "pending"
                        ? "Este produto está aguardando sua revisão na aba Fila"
                        : blocked ? "Este produto já está na fila desta campanha"
                        : "Adicionar este produto à fila da campanha"}
                      // Bloqueado não é botão apagado, é estado: fundo neutro e
                      // um sinalzinho, em vez do bloco cinza chapado — nem
                      // convida ao clique, nem some no fundo do card.
                      style={{
                        width: "100%", padding: "7px 10px", borderRadius: 8,
                        display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 5,
                        border: blocked ? "0.5px solid var(--color-border-tertiary)" : "0.5px solid transparent",
                        background: blocked ? "var(--color-background-secondary)" : PRIMARY_LIGHT,
                        color: blocked ? "var(--color-text-secondary)" : PRIMARY_DARK,
                        fontSize: 12, fontWeight: 500, fontFamily: "inherit",
                        cursor: blocked ? "default" : "pointer",
                        opacity: busy ? 0.6 : 1,
                      }}
                    >
                      {busy ? "Adicionando..."
                        : status === "pending" ? <><span aria-hidden="true">⏳</span>Aguardando revisão</>
                        : blocked ? <><span aria-hidden="true">✓</span>Já na fila</>
                        : status === "sent" ? "Adicionar de novo"
                        : "Adicionar à fila"}
                    </button>
                  )
                }
              />
            );
          })}
        </div>

        {!noSources && !previewError && preview.items.length > 0 && (
          <Pagination page={page} totalPages={totalPages} onChange={setPage} disabled={loadingPreview} />
        )}
      </div>

      {/* A revisão dos pendentes vive na aba Fila (uma tela só pros dois tipos
             de campanha) — aqui ficou só o link pra lá. */}
      {pending.length > 0 && (
        <div style={{ marginBottom: 20, padding: "10px 14px", borderRadius: 10, background: "var(--color-background-secondary)", fontSize: 12, color: "var(--color-text-secondary)" }}>
          {pending.length} produto{pending.length !== 1 ? "s" : ""} aguardando revisão — aprove ou rejeite na aba <strong>Fila</strong>.
        </div>
      )}

      {/* ── Barra fixa de salvar: as configurações desta aba ficam
             espalhadas pela rolagem, então o aviso acompanha a tela. ──── */}
      {(dirty || saved) && (
        <div style={{
          position: "sticky", bottom: 0, zIndex: 5,
          display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
          padding: "10px 14px", marginTop: 8,
          borderRadius: 12, border: `0.5px solid ${saved ? PRIMARY : "var(--warn-border)"}`,
          background: saved ? PRIMARY_LIGHT : "var(--warn-bg)",
          boxShadow: "0 -2px 12px rgba(0,0,0,0.08)",
        }}>
          <span style={{ flex: 1, fontSize: 12, color: saved ? PRIMARY_DARK : "var(--warn-text)" }}>
            {saved ? "Configurações salvas." : "Você tem alterações não salvas nesta aba."}
          </span>
          <button
            onClick={save}
            disabled={!dirty && !saved}
            title={dirty ? "Salvar as configurações desta aba" : "Sem alterações pra salvar"}
            style={saveBtnStyle(dirty)}
          >
            {saved ? "✓ Salvo!" : "Salvar configurações"}
          </button>
        </div>
      )}

      {/* Confirmação do "Preencher fila agora": diz quantos produtos vão entrar
          e de onde saem, antes de sair buscando no catálogo. */}
      {askRefill && (
        <Modal title="Preencher a fila agora?" onClose={() => setAskRefill(false)}>
          <div style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 10 }}>
            Vamos pegar os <strong>{batch} primeiros produtos</strong> desta lista, na ordem em que
            estão na tela, e mandar pra fila.
          </div>
          <div style={{ fontSize: 12, color: "var(--color-text-secondary)", lineHeight: 1.5, marginBottom: 18 }}>
            O que já está na fila ou foi enviado há pouco é pulado, então pode entrar menos que {batch}.
            As escolhas desta aba também são salvas.
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button onClick={() => setAskRefill(false)} style={chipStyle({ active: false })}>
              Cancelar
            </button>
            <button
              onClick={() => { setAskRefill(false); triggerRefill(); }}
              style={{ padding: "6px 14px", borderRadius: 8, border: "none", background: PRIMARY, color: "#fff", fontSize: 13, fontFamily: "inherit", fontWeight: 500, cursor: "pointer" }}
            >
              Preencher agora
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// Linha embaixo de "Produtos encontrados": quantos vieram, de quantos, e em que
// página. O "N no catálogo" fica no meio da frase de propósito — é o número que
// o usuário procura, e os testes o encontram por ele.
function countText(preview, page, totalPages, loading) {
  const total = preview.total || 0;
  const parts = [`${preview.items.length} de ${total.toLocaleString("pt-BR")} no catálogo`];
  if (totalPages > 1) parts.push(`página ${page} de ${totalPages}`);
  if (loading) parts.push("buscando...");
  return parts.join(" · ");
}

// Produto que entrou no catálogo nas últimas horas. `firstSeenAt` vem do
// catálogo (backend/catalog/pg.js → fromRow).
function isNew(product) {
  const t = new Date(product?.firstSeenAt).getTime();
  return Number.isFinite(t) && Date.now() - t < NEW_HOURS * 3600 * 1000;
}

// Lista vazia. As chaves de visibilidade agora cortam no backend, então elas
// entram na sugestão do que afrouxar quando estão desligadas.
function emptyListText(view) {
  const base = "Nenhum produto do catálogo passa nesses filtros. Afrouxe algum critério, marque mais categorias";
  return (!view.queued || !view.recent)
    ? `${base}, ou ligue as chaves acima pra ver os que já estão na fila.`
    : `${base}.`;
}

// Placeholder cinza do mesmo tamanho do card, pra primeira carga não ser um
// buraco branco.
function SkeletonCard() {
  return (
    <div
      aria-hidden="true"
      style={{
        background: "var(--color-background-primary)",
        border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12,
        padding: 14, display: "flex", flexDirection: "column", gap: 8, minHeight: 250,
      }}
    >
      <div style={{ ...skelBar, height: 120, borderRadius: 8 }} />
      <div style={{ ...skelBar, width: "90%" }} />
      <div style={{ ...skelBar, width: "60%" }} />
      <div style={{ ...skelBar, width: "40%", marginTop: "auto" }} />
    </div>
  );
}

const skelBar = {
  height: 12, borderRadius: 6,
  background: "var(--color-background-secondary)",
  animation: "nimbus-skeleton 1.2s ease-in-out infinite",
};

const cardStyle = {
  background: "var(--color-background-primary)",
  border: "0.5px solid var(--color-border-tertiary)",
  borderRadius: 12,
  padding: 16,
};

// Card da faixa. Com o painel aberto embaixo ele perde o arredondado e a borda
// de baixo pra emendar no painel, e ganha a borda destacada que contorna os
// dois. Tudo em propriedades longas (nada de `border`/`borderRadius`): misturar
// as duas formas faz o React avisar quando a longa some no fechamento.
const stripCardStyle = (open) => ({
  background: "var(--color-background-primary)",
  borderWidth: "0.5px",
  borderStyle: "solid",
  borderColor: open ? PRIMARY : "var(--color-border-tertiary)",
  borderBottomColor: open ? "transparent" : "var(--color-border-tertiary)",
  borderTopLeftRadius: 12,
  borderTopRightRadius: 12,
  borderBottomLeftRadius: open ? 0 : 12,
  borderBottomRightRadius: open ? 0 : 12,
  padding: 16,
  display: "flex",
  alignItems: "center",
  gap: 10,
});

// O painel em si. Sem borderRadius aqui de propósito: os cantos vêm da classe
// .sec-panel (index.css), que trata o mobile — estilo inline venceria a classe.
const panelStyle = {
  background: "var(--color-background-primary)",
  border: `0.5px solid ${PRIMARY}`,
  padding: 16,
  marginBottom: 14,
};

// Setinha do botão que abre o painel: gira em vez de trocar de glifo.
const caretStyle = (open) => ({
  fontSize: 10, display: "inline-block",
  transition: "transform 0.2s",
  transform: open ? "rotate(180deg)" : "none",
});

// 12px é o menor tamanho que ainda se lê bem em cinza secundário — os rótulos,
// as dicas e os avisos desta aba viviam em 11px.
const fieldLabelStyle = {
  fontSize: 12, color: "var(--color-text-secondary)",
  display: "block", marginBottom: 6,
};

const inputStyle = {
  width: "100%", padding: "9px 11px", borderRadius: 8,
  border: "0.5px solid var(--color-border-tertiary)",
  background: "var(--color-background-secondary)",
  color: "var(--color-text-primary)",
  fontSize: 13, fontFamily: "inherit", boxSizing: "border-box",
};

const prefixStyle = {
  position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)",
  fontSize: 12, color: "var(--color-text-secondary)", pointerEvents: "none",
};

const hintStyle = { fontSize: 12, color: "var(--color-text-secondary)", marginTop: 6 };

const chipStyle = ({ active, disabled }) => ({
  padding: "6px 14px", borderRadius: 8,
  border: `0.5px solid ${active && !disabled ? PRIMARY : "var(--color-border-tertiary)"}`,
  background: disabled ? "var(--color-background-secondary)" : (active ? PRIMARY_LIGHT : "transparent"),
  color: disabled ? "var(--color-text-secondary)" : (active ? PRIMARY_DARK : "var(--color-text-secondary)"),
  fontSize: 13, fontFamily: "inherit",
  cursor: disabled ? "not-allowed" : "pointer",
  fontWeight: active && !disabled ? 500 : 400,
  opacity: disabled ? 0.7 : 1,
});

const activeChipStyle = {
  padding: "3px 10px", borderRadius: 6, border: `0.5px solid ${PRIMARY}`,
  background: PRIMARY_LIGHT, color: PRIMARY_DARK,
  fontSize: 12, fontWeight: 500, cursor: "pointer", fontFamily: "inherit",
};

const linkBtnStyle = {
  background: "transparent", border: "none", padding: "3px 4px",
  color: "var(--color-text-secondary)", fontSize: 12, fontFamily: "inherit",
  cursor: "pointer", textDecoration: "underline",
};

const statusChipStyle = {
  display: "inline-block", padding: "2px 8px", borderRadius: 6,
  background: "var(--color-background-secondary)", color: "var(--color-text-secondary)",
  fontSize: 10, fontWeight: 500,
};

const noteStyle = (kind) => ({
  fontSize: 12,
  color: kind === "danger" ? "var(--danger-text)" : "var(--warn-text)",
  background: kind === "danger" ? "var(--danger-bg)" : "var(--warn-bg)",
  border: `0.5px solid ${kind === "danger" ? "var(--danger-border)" : "var(--warn-border)"}`,
  borderRadius: 8, padding: "8px 10px",
});
