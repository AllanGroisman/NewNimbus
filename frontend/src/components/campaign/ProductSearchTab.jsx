import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  PRIMARY, PRIMARY_DARK, PRIMARY_LIGHT, allSources,
  CATEGORIES, categoryLabel, categoryIcon, formatPrice,
} from "../../data/constants";
import { browseCatalog, errText } from "../../data/api";
import Toggle from "../ui/Toggle";
import Modal from "../ui/Modal";
import UsageBadge from "../ui/UsageBadge";
import { ProductRow, ProductGridCard } from "../ui/ProductCard";

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

// Filtros como listas fechadas em vez de sliders: o valor fica explícito e não
// depende de acertar o pixel do arraste.
const DISCOUNT_OPTIONS = [0, 10, 20, 30, 40, 50, 60, 70];
const RATING_OPTIONS = [0, 3, 3.5, 4, 4.5];
const SALES_OPTIONS = [0, 10, 50, 100, 500, 1000];

const PAGE_SIZE = 24;
const DEBOUNCE_MS = 350;

// Preenchimento automático: quando ele acontece.
export const DEFAULT_REFILL_THRESHOLD = 5;
export const MAX_REFILL_THRESHOLD = 50;
export const MAX_REFILL_TIMES = 12;
const SECTIONS_KEY = "nimbus.searchTab.sections";
const VIEW_KEY = "nimbus.searchTab.view";

const EMPTY_FILTERS = { keywords: "", minPrice: 0, maxPrice: null, minDiscount: 0, minRating: 0, minSales: 0 };

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
  scraping, setScraping,
  // Categorias e lojas da campanha — moram no grupo, editados aqui.
  categories = [], onToggleCategory, categoryLimit,
  selectedSources = [], onToggleSource, lockMessageFor = () => null,
  refilling, triggerRefill, refillMsg,
  save, dirty, saved, saveBtnStyle,
  pending = [], queue = [], history = [], cooldownMinutes = 0, cooldownLabel,
  onAddCatalogProduct, onAddCatalogProducts,
}) {
  const filters = scraping.filters || {};
  const sortBy = SORT_OPTIONS.some(o => o.id === scraping.sortBy) ? scraping.sortBy : DEFAULT_SORT;
  const batch = Number(scraping.batchSize) > 0 ? Math.min(MAX_BATCH, Number(scraping.batchSize)) : DEFAULT_BATCH;
  const autoRefill = scraping.autoRefill !== false;
  const refillMode = scraping.refillMode === "schedule" ? "schedule" : "threshold";
  const refillThreshold = Number(scraping.refillThreshold) > 0
    ? Math.min(MAX_REFILL_THRESHOLD, Number(scraping.refillThreshold))
    : DEFAULT_REFILL_THRESHOLD;
  const refillTimes = Array.isArray(scraping.refillTimes) ? scraping.refillTimes : [];

  const [page, setPage] = useState(1);
  const [sections, setSections] = useState(loadSections);
  const [view, setView] = useState(loadView);
  // Produtos que o usuário acabou de mandar pra fila continuam visíveis mesmo
  // que a chave "Já na fila" esteja desligada — senão o card sumiria no clique.
  const [justAdded, setJustAdded] = useState(() => new Set());

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
  const [preview, setPreview] = useState({ items: [], total: 0, approximate: false });
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
  // Seleção múltipla da lista.
  const [selected, setSelected] = useState(() => new Set());
  const [bulk, setBulk] = useState(null); // { running, done, total } | { done: resumo }
  const [bulkCooldown, setBulkCooldown] = useState([]);

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

  const setFilter = (key, value) => setScraping(s => ({ ...s, filters: { ...s.filters, [key]: value } }));
  const resetFilters = () => setScraping(s => ({ ...s, filters: { ...EMPTY_FILTERS } }));

  // Assinatura dos parâmetros: muda ⇒ refaz a busca (com debounce, pra não
  // disparar uma request por tecla digitada).
  const paramsSig = JSON.stringify({
    categories, sources: usableSources, sortBy,
    q: filters.keywords || "",
    minPrice: Number(filters.minPrice) || 0,
    maxPrice: filters.maxPrice ?? null,
    minDiscount: Number(filters.minDiscount) || 0,
    minRating: Number(filters.minRating) || 0,
    minSales: Number(filters.minSales) || 0,
  });
  // Busca nova: volta pra primeira página e esquece o que era daquela busca —
  // seleção, adicionados e mensagens não valem pra outra lista.
  useEffect(() => {
    setPage(1);
    setSelected(new Set());
    setJustAdded(new Set());
    setAddMsgs(new Map());
    setBulk(null);
    setBulkCooldown([]);
  }, [paramsSig]);

  const abortRef = useRef(null);
  // A lista cresce com o "Carregar mais": a página 1 substitui, as seguintes
  // acumulam. Assim as chaves que escondem itens filtram um conjunto cada vez
  // maior, em vez de esvaziar uma página.
  const runSearch = useCallback(async () => {
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoadingPreview(true);
    setPreviewError(null);
    const p = JSON.parse(paramsSig);
    try {
      const r = await browseCatalog({ ...p, page, pageSize: PAGE_SIZE }, { signal: ctrl.signal });
      setPreview(prev => ({
        items: page > 1 ? [...prev.items, ...(r.items || [])] : (r.items || []),
        total: r.total || 0,
        approximate: !!r.approximateTotal,
      }));
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

  useEffect(() => {
    if (noSources) {
      setPreview({ items: [], total: 0, approximate: false });
      setLoadingPreview(false);
      return;
    }
    // O debounce existe pra não disparar uma request por tecla digitada; o
    // "Carregar mais" é um clique só, e esperar meio segundo por ele incomoda.
    const timer = setTimeout(runSearch, page > 1 ? 0 : DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [runSearch, noSources, page]);

  useEffect(() => () => { if (abortRef.current) abortRef.current.abort(); }, []);

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

  const markAdded = (ck) => setJustAdded(s => new Set(s).add(ck));
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
      markAdded(ck);
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

  // ── Seleção múltipla ────────────────────────────────────────────────
  const toggleSelected = (ck) => setSelected(s => {
    const next = new Set(s);
    if (next.has(ck)) next.delete(ck); else next.add(ck);
    return next;
  });

  const runBulkAdd = async (products, force = false) => {
    if (!products.length || bulk?.running) return;
    setBulk({ running: true, done: 0, total: products.length });
    setBulkCooldown([]);
    const adder = onAddCatalogProducts
      // Sem o handler de lote (uso antigo do componente), cai no de um só.
      || (async (list, f) => {
        const out = { added: 0, duplicates: 0, cooldown: [], errors: [] };
        for (const p of list) {
          const r = await onAddCatalogProduct(p, f);
          if (r?.inCooldown) out.cooldown.push(p); else out.added++;
        }
        return out;
      });
    try {
      const r = await adder(products, force, (done, total) => setBulk({ running: true, done, total }));
      // O que ficou em cooldown não entrou em lugar nenhum: continua marcado e
      // visível, à espera do "adicionar assim mesmo".
      const pendingCooldown = new Set((r.cooldown || []).map(cardKey));
      const resolved = products.filter(p => !pendingCooldown.has(cardKey(p)));
      for (const p of resolved) markAdded(cardKey(p));
      setSelected(s => {
        const next = new Set(s);
        for (const p of resolved) next.delete(cardKey(p));
        return next;
      });
      setBulkCooldown(r.cooldown || []);
      setBulk({ running: false, result: r });
    } catch (err) {
      setBulk({ running: false, error: errText(err, "Não foi possível adicionar os produtos.") });
    }
  };

  // Resumo do que está filtrando agora — cada chip tira o próprio filtro.
  const activeChips = [];
  if (String(filters.keywords || "").trim()) {
    activeChips.push({ kind: "keywords", label: `"${filters.keywords}"`, clear: () => setFilter("keywords", "") });
  }
  if (Number(filters.minPrice) > 0) {
    activeChips.push({ label: `a partir de ${formatPrice(Number(filters.minPrice))}`, clear: () => setFilter("minPrice", 0) });
  }
  if (filters.maxPrice != null && Number(filters.maxPrice) > 0) {
    activeChips.push({ label: `até ${formatPrice(Number(filters.maxPrice))}`, clear: () => setFilter("maxPrice", null) });
  }
  if (Number(filters.minDiscount) > 0) {
    activeChips.push({ label: `${filters.minDiscount}% ou mais de desconto`, clear: () => setFilter("minDiscount", 0) });
  }
  if (Number(filters.minRating) > 0) {
    activeChips.push({ label: `nota ${String(filters.minRating).replace(".", ",")}+`, clear: () => setFilter("minRating", 0) });
  }
  if (Number(filters.minSales) > 0) {
    activeChips.push({ label: `${filters.minSales}+ vendas`, clear: () => setFilter("minSales", 0) });
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

  // Duas chaves independentes escondem linhas da lista. O que acabou de ser
  // adicionado escapa das duas, pra não sumir debaixo do clique.
  let hiddenRecent = 0;
  let hiddenQueued = 0;
  const visibleItems = preview.items.filter(p => {
    if (justAdded.has(cardKey(p))) return true;
    const st = statusOf(p);
    if (!view.queued && (st === "queue" || st === "pending")) { hiddenQueued++; return false; }
    if (!view.recent && isRecent(p)) { hiddenRecent++; return false; }
    return true;
  });

  // Só entra na seleção o que dá pra adicionar: o que já está na fila ou
  // aguardando revisão não tem pra onde ir.
  const selectableItems = visibleItems.filter(p => {
    const st = statusOf(p);
    return st !== "queue" && st !== "pending";
  });
  const selectedProducts = selectableItems.filter(p => selected.has(cardKey(p)));
  const allSelected = selectableItems.length > 0 && selectedProducts.length === selectableItems.length;

  const hasMore = preview.items.length < preview.total;
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
            title="Quando preencher, quantos produtos por vez e em que ordem"
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
            ? "Ligado: o sistema faz sozinho o mesmo que o botão \"Preencher fila agora\" — busca os produtos e joga direto na fila."
            : "Desligado: a fila só recebe produtos quando você clicar em \"Preencher fila agora\" ou adicionar um produto da lista."}
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
                <div style={hintStyle}>
                  Produtos na fila. Sobrando menos que isso, o sistema busca mais — só dentro das
                  janelas de envio da campanha.
                </div>
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
                  Em cada horário o sistema preenche a fila uma vez, mesmo fora das janelas de envio.
                  Os produtos ficam guardados e saem nos horários de envio da campanha.
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

        <div className="grid-collapse" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, paddingTop: 14 }}>
          <div>
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
            <div style={hintStyle}>Quantos produtos cada preenchimento traz, de 1 a {MAX_BATCH}.</div>
          </div>
          <div>
            <label style={fieldLabelStyle} htmlFor="pr-sort">Ordem de escolha</label>
            <select
              id="pr-sort" value={sortBy}
              onChange={e => setScraping(s => ({ ...s, sortBy: e.target.value }))}
              style={inputStyle}
            >
              {SORT_OPTIONS.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
            <div style={hintStyle}>Pega de cima pra baixo da lista, nesta ordem — é a mesma ordem da lista de produtos.</div>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 12, paddingTop: 14 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 500 }}>Misturar a fila depois de preencher</div>
            <div style={hintStyle}>
              Embaralha a fila inteira a cada preenchimento, pra não sair uma sequência de ofertas parecidas na ordem em que foram achadas.
            </div>
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
              type="text"
              value={filters.keywords || ""}
              onChange={e => setFilter("keywords", e.target.value)}
              placeholder="Ex: notebook, monitor, fone bluetooth"
              style={{ ...inputStyle, paddingLeft: 36 }}
            />
          </div>
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
        <div style={hintStyle}>
          Separe vários termos por vírgula — traz produtos cujo nome tenha <strong>pelo menos um</strong> deles. Vazio = todos.
        </div>

        {sections.filters && (
        <div id="sec-filters" style={{ marginTop: 16, paddingTop: 14, borderTop: "0.5px solid var(--color-border-tertiary)" }}>
        <div className="grid-collapse" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <div>
            <label style={fieldLabelStyle} htmlFor="pr-min-price">Preço mínimo</label>
            <div style={{ position: "relative" }}>
              <span style={prefixStyle}>R$</span>
              <input
                id="pr-min-price" type="number" min={0} step={10}
                value={filters.minPrice || ""}
                onChange={e => setFilter("minPrice", num(e.target.value) ?? 0)}
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
                placeholder="Sem máximo"
                style={{ ...inputStyle, paddingLeft: 36 }}
              />
            </div>
          </div>
          <div>
            <label style={fieldLabelStyle} htmlFor="pr-min-discount">Desconto mínimo</label>
            <select
              id="pr-min-discount" value={Number(filters.minDiscount) || 0}
              onChange={e => setFilter("minDiscount", Number(e.target.value))}
              style={inputStyle}
            >
              {DISCOUNT_OPTIONS.map(v => <option key={v} value={v}>{v === 0 ? "Qualquer desconto" : `${v}% ou mais`}</option>)}
            </select>
          </div>
          <div>
            <label style={fieldLabelStyle} htmlFor="pr-min-rating">Avaliação mínima</label>
            <select
              id="pr-min-rating" value={Number(filters.minRating) || 0}
              onChange={e => setFilter("minRating", Number(e.target.value))}
              style={inputStyle}
            >
              {RATING_OPTIONS.map(v => <option key={v} value={v}>{v === 0 ? "Qualquer nota" : `★ ${String(v).replace(".", ",")} ou mais`}</option>)}
            </select>
          </div>
          <div>
            <label style={fieldLabelStyle} htmlFor="pr-min-sales">Vendas mínimas</label>
            <select
              id="pr-min-sales" value={Number(filters.minSales) || 0}
              onChange={e => setFilter("minSales", Number(e.target.value))}
              style={inputStyle}
            >
              {SALES_OPTIONS.map(v => <option key={v} value={v}>{v === 0 ? "Qualquer quantidade" : `${v.toLocaleString("pt-BR")} ou mais`}</option>)}
            </select>
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
        </div>
        )}

        {otherChips.length > 0 && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginTop: 14, paddingTop: 12, borderTop: "0.5px solid var(--color-border-tertiary)" }}>
            <span style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>Filtrando por:</span>
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
      <div data-tour="pr-results" style={{ marginBottom: 24 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap", gap: 10, marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 500 }}>Produtos encontrados</div>
            <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 2 }}>
              {noSources
                ? "Nenhuma loja ativa nesta campanha."
                : loadingPreview && preview.items.length === 0
                  ? "Carregando..."
                  : `${preview.approximate ? "~" : ""}${preview.total.toLocaleString("pt-BR")} no catálogo · o preenchimento pega os primeiros desta lista`}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>Enviados recentemente</span>
              <Toggle label="Mostrar enviados recentemente" value={view.recent} onChange={v => setViewFlag("recent", v)} />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>Já na fila</span>
              <Toggle label="Mostrar os que já estão na fila" value={view.queued} onChange={v => setViewFlag("queued", v)} />
            </div>
            <div>
              <select
                aria-label="Ordenar a lista"
                value={sortBy}
                onChange={e => setScraping(s => ({ ...s, sortBy: e.target.value }))}
                style={{ ...inputStyle, width: "auto", padding: "7px 10px" }}
              >
                {SORT_OPTIONS.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
              <div style={{ ...hintStyle, marginTop: 4, textAlign: "right" }}>
                Também é a ordem que o preenchimento usa
              </div>
            </div>
          </div>
        </div>

        {/* Preencher agora age sobre esta lista, e precisa ficar acessível com
            o painel de preenchimento fechado. */}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
          <button
            data-tour="pr-run"
            onClick={() => setAskRefill(true)}
            disabled={refilling || noSources}
            title={noSources ? "Escolha ao menos uma loja disponível" : "Salva a configuração e completa a fila agora, sem esperar o horário"}
            style={{ padding: "9px 20px", borderRadius: 8, border: "none", background: PRIMARY, color: "#fff", fontSize: 13, cursor: refilling ? "wait" : (noSources ? "not-allowed" : "pointer"), fontWeight: 500, opacity: refilling || noSources ? 0.6 : 1 }}
          >
            {refilling ? "⟳ Preenchendo..." : `Preencher fila agora (até ${batch})`}
          </button>
          <span style={{ ...hintStyle, marginTop: 0, flex: 1, minWidth: 220 }}>
            Pega os primeiros desta lista e salva as escolhas da aba. Pula o que já está na fila
            ou foi enviado há pouco.
          </span>
          {refillMsg && (
            <span style={{ fontSize: 12, color: refillMsg.type === "err" ? "var(--danger-text)" : refillMsg.type === "warn" ? "var(--warn-text)" : PRIMARY_DARK }}>
              {refillMsg.text}
            </span>
          )}
        </div>

        {previewError && (
          <div style={{ ...noteStyle("danger"), marginBottom: 10, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
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

        {(hiddenRecent > 0 || hiddenQueued > 0) && (
          <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 10 }}>
            Escondidos:
            {hiddenRecent > 0 && (
              <> {hiddenRecent} enviado{hiddenRecent !== 1 ? "s" : ""} há pouco
              {cooldownLabel ? ` (menos de ${cooldownLabel})` : ""}</>
            )}
            {hiddenRecent > 0 && hiddenQueued > 0 ? " ·" : ""}
            {hiddenQueued > 0 && <> {hiddenQueued} já na fila desta campanha</>}
            . Use as chaves acima para mostrar.
          </div>
        )}

        {/* Barra de seleção múltipla */}
        {selectableItems.length > 0 && (
          <div style={{
            display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
            marginBottom: 12, padding: "8px 12px", borderRadius: 10,
            border: `0.5px solid ${selectedProducts.length > 0 ? PRIMARY : "var(--color-border-tertiary)"}`,
            background: selectedProducts.length > 0 ? PRIMARY_LIGHT : "transparent",
          }}>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 12, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={allSelected}
                onChange={() => setSelected(s => {
                  if (allSelected) return new Set();
                  const next = new Set(s);
                  for (const p of selectableItems) next.add(cardKey(p));
                  return next;
                })}
                aria-label="Selecionar todos os produtos da lista"
                style={{ accentColor: PRIMARY, width: 15, height: 15, cursor: "pointer" }}
              />
              <span style={{ color: selectedProducts.length > 0 ? PRIMARY_DARK : "var(--color-text-secondary)", fontWeight: selectedProducts.length > 0 ? 500 : 400 }}>
                {selectedProducts.length > 0
                  ? `${selectedProducts.length} selecionado${selectedProducts.length !== 1 ? "s" : ""}`
                  : "Selecionar todos"}
              </span>
            </label>
            {selectedProducts.length > 0 && (
              <>
                <button
                  onClick={() => runBulkAdd(selectedProducts)}
                  disabled={bulk?.running}
                  style={{
                    padding: "6px 14px", borderRadius: 8, border: "none", background: PRIMARY, color: "#fff",
                    fontSize: 12, fontWeight: 500, fontFamily: "inherit",
                    cursor: bulk?.running ? "wait" : "pointer", opacity: bulk?.running ? 0.6 : 1,
                  }}
                >
                  {bulk?.running
                    ? `Adicionando ${bulk.done} de ${bulk.total}...`
                    : `Adicionar ${selectedProducts.length} à fila`}
                </button>
                <button onClick={() => setSelected(new Set())} style={linkBtnStyle}>Limpar seleção</button>
              </>
            )}
          </div>
        )}

        {/* O resumo do lote fica fora da barra de seleção: no fim de um lote
            bem-sucedido os cards viram "já na fila" e a barra some — o aviso
            do que aconteceu não pode sumir junto. */}
        {bulk && !bulk.running && (bulk.result || bulk.error) && (
          <div style={{
            ...(bulk.error ? noteStyle("danger") : {}),
            marginBottom: 12, fontSize: 12,
            color: bulk.error ? undefined : PRIMARY_DARK,
            display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
          }}>
            <span style={{ flex: 1 }}>{bulk.error || bulkResultText(bulk.result)}</span>
            <button onClick={() => setBulk(null)} style={linkBtnStyle}>Ok</button>
          </div>
        )}

        {bulkCooldown.length > 0 && (
          <div style={{ ...noteStyle("warn"), marginBottom: 12, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span style={{ flex: 1 }}>
              {bulkCooldown.length} produto{bulkCooldown.length !== 1 ? "s" : ""} foi enviado há pouco
              {cooldownLabel ? ` (espera de ${cooldownLabel})` : ""} e ficou de fora.
            </span>
            <button
              onClick={() => runBulkAdd(bulkCooldown, true)}
              disabled={bulk?.running}
              style={{ ...chipStyle({ active: true }), padding: "5px 12px", fontSize: 12 }}
            >
              Adicionar assim mesmo
            </button>
            <button onClick={() => setBulkCooldown([])} style={linkBtnStyle}>Deixar de fora</button>
          </div>
        )}

        {!noSources && !loadingPreview && !previewError && visibleItems.length === 0 && (
          <div style={{ ...cardStyle, fontSize: 13, color: "var(--color-text-secondary)" }}>
            {preview.items.length > 0 ? (
              "Todos os produtos desta busca estão escondidos pelas chaves \"Enviados recentemente\" e \"Já na fila\". Ligue uma delas para vê-los."
            ) : (
              <>
                <div>Nenhum produto do catálogo passa nesses filtros. Afrouxe algum critério ou marque mais categorias.</div>
                {hasAnyFilter && (
                  <button onClick={resetFilters} style={{ ...chipStyle({ active: false }), marginTop: 10, fontSize: 12 }}>
                    Limpar filtros
                  </button>
                )}
              </>
            )}
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 12, opacity: loadingPreview && preview.items.length > 0 ? 0.5 : 1, transition: "opacity 0.15s" }}>
          {showSkeleton && Array.from({ length: 8 }).map((_, i) => <SkeletonCard key={`sk-${i}`} />)}
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
                select={!blocked ? (
                  <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--color-text-secondary)", cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={selected.has(ck)}
                      onChange={() => toggleSelected(ck)}
                      aria-label={`Selecionar ${p.name}`}
                      style={{ accentColor: PRIMARY, width: 15, height: 15, cursor: "pointer" }}
                    />
                  </label>
                ) : null}
                badge={status ? <span style={statusChipStyle}>{
                  status === "queue" ? "Já está na fila"
                    : status === "pending" ? "Aguardando revisão"
                    : recent ? "Enviado há pouco"
                    : "Já enviado"
                }</span> : null}
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
                      title={blocked ? "Este produto já está na fila desta campanha" : "Adicionar este produto à fila da campanha"}
                      style={{
                        width: "100%", padding: "7px 10px", borderRadius: 8, border: "none",
                        background: blocked ? "var(--color-background-secondary)" : PRIMARY_LIGHT,
                        color: blocked ? "var(--color-text-secondary)" : PRIMARY_DARK,
                        fontSize: 12, fontWeight: 500,
                        cursor: blocked ? "not-allowed" : "pointer",
                        opacity: busy ? 0.6 : 1,
                      }}
                    >
                      {busy ? "Adicionando..."
                        : status === "pending" ? "Aguardando revisão"
                        : blocked ? "Já na fila"
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
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 12, marginTop: 16 }}>
            {hasMore ? (
              <button
                onClick={() => setPage(p => p + 1)}
                disabled={loadingPreview}
                style={{
                  padding: "9px 20px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)",
                  background: "transparent", color: "inherit", fontSize: 13, fontFamily: "inherit",
                  cursor: loadingPreview ? "wait" : "pointer", opacity: loadingPreview ? 0.6 : 1,
                }}
              >
                {loadingPreview ? "Carregando..." : "Carregar mais"}
              </button>
            ) : null}
            <span style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>
              {preview.items.length} de {preview.approximate ? "~" : ""}{preview.total.toLocaleString("pt-BR")} carregados
            </span>
          </div>
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

// Resumo de um "adicionar vários": só entra o que aconteceu de verdade.
function bulkResultText(r) {
  if (!r) return "";
  const parts = [];
  if (r.added) parts.push(`${r.added} adicionado${r.added !== 1 ? "s" : ""}`);
  if (r.duplicates) parts.push(`${r.duplicates} já ${r.duplicates !== 1 ? "estavam" : "estava"} na fila`);
  if (r.errors?.length) parts.push(`${r.errors.length} com erro`);
  return parts.length ? parts.join(" · ") : "Nada foi adicionado.";
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

const fieldLabelStyle = {
  fontSize: 11, color: "var(--color-text-secondary)",
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

const hintStyle = { fontSize: 11, color: "var(--color-text-secondary)", marginTop: 6 };

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
  fontSize: 11, fontWeight: 500, cursor: "pointer", fontFamily: "inherit",
};

const linkBtnStyle = {
  background: "transparent", border: "none", padding: "3px 4px",
  color: "var(--color-text-secondary)", fontSize: 11, fontFamily: "inherit",
  cursor: "pointer", textDecoration: "underline",
};

const statusChipStyle = {
  display: "inline-block", padding: "2px 8px", borderRadius: 6,
  background: "var(--color-background-secondary)", color: "var(--color-text-secondary)",
  fontSize: 10, fontWeight: 500,
};

const noteStyle = (kind) => ({
  fontSize: 11,
  color: kind === "danger" ? "var(--danger-text)" : "var(--warn-text)",
  background: kind === "danger" ? "var(--danger-bg)" : "var(--warn-bg)",
  border: `0.5px solid ${kind === "danger" ? "var(--danger-border)" : "var(--warn-border)"}`,
  borderRadius: 8, padding: "8px 10px",
});
