import { useState, useRef, useEffect } from "react";
import { PRIMARY, PRIMARY_DARK, PRIMARY_LIGHT, allSources, CATEGORIES, categoryLabel, categoryColor, categoryIcon, formatPrice, soldText, getGroupCategories, getGroupStats, computeQueueETA, formatETA, formatTimeBR, formatDateBR, isSameDayBR } from "../data/constants";
import { createWAGroup, leaveWAGroup, revokeWAInvite, sendNextNow as apiSendNextNow, loadAppOps, listWAGroups, refillQueueNow, clearGroupQueue, saveGroupQueue, clearGroupHistory, approvePendingItem, rejectPendingItem, approveAllPending, rejectAllPending, fetchUrlMetadata, manualAddToQueue, whatsNimbusAvailable } from "../data/api";
import { DEFAULT_MESSAGE_TEMPLATE } from "../data/mockData";
import { useUnsavedGuard, useRequestNavigation } from "../data/navGuard";
import BusyOverlay from "./ui/BusyOverlay";

// Persiste a aba aberta por campanha (sobrevive ao F5). Mapa { [groupId]: tabId }
// num único item de localStorage. Validado contra VALID_TABS pra não restaurar
// uma aba que não existe mais (ex.: id renomeado/removido).
const TAB_STORAGE_KEY = "nimbus:campaignTab";
const VALID_TABS = ["overview", "manage", "whatsapp", "products", "queue", "schedule", "messages", "history"];
function readSavedTab(groupId) {
  try {
    const tabId = JSON.parse(localStorage.getItem(TAB_STORAGE_KEY) || "{}")[groupId];
    return VALID_TABS.includes(tabId) ? tabId : "overview";
  } catch { return "overview"; }
}
function writeSavedTab(groupId, tabId) {
  try {
    const map = JSON.parse(localStorage.getItem(TAB_STORAGE_KEY) || "{}");
    map[groupId] = tabId;
    localStorage.setItem(TAB_STORAGE_KEY, JSON.stringify(map));
  } catch { /* ignora (modo privado/quota) */ }
}

const TEMPLATE_VARS = [
  { token: "{produto}", desc: "Nome do produto" },
  { token: "{preco}", desc: "Preço com desconto" },
  { token: "{preco_antigo}", desc: "Preço original" },
  { token: "{desconto}", desc: "% de desconto" },
  { token: "{loja}", desc: "Nome da loja" },
  { token: "{vendas}", desc: "Nº de vendas (quando houver)" },
  { token: "{link}", desc: "Link de compra" },
];

const TEMPLATE_PREVIEW_DATA = {
  produto: "Smartphone Samsung Galaxy A55 256GB",
  preco: "R$ 1.899",
  preco_antigo: "R$ 2.499",
  desconto: "24%",
  loja: "Mercado Livre",
  vendas: "1,2 mil vendidos",
  link: "https://merc.li/abc123",
};

const renderTemplate = (tpl) => {
  if (!tpl) return "";
  return tpl.replace(/\{(\w+)\}/g, (_, k) => TEMPLATE_PREVIEW_DATA[k] ?? `{${k}}`);
};

// Renderiza a formatação que o WhatsApp aplica (*negrito*, _itálico_, ~riscado~, `mono`)
// como elementos React. Processa linha por linha pra preservar quebras.
const FORMAT_RE = /(\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~|`[^`\n]+`)/g;
function renderWhatsappFormatted(text) {
  if (!text) return null;
  const lines = text.split("\n");
  return lines.map((line, li) => {
    const parts = line.split(FORMAT_RE).filter(p => p !== undefined);
    return (
      <div key={li}>
        {parts.length === 0
          ? " "
          : parts.map((part, i) => {
              if (part.startsWith("*") && part.endsWith("*") && part.length > 2) return <strong key={i}>{part.slice(1, -1)}</strong>;
              if (part.startsWith("_") && part.endsWith("_") && part.length > 2) return <em key={i}>{part.slice(1, -1)}</em>;
              if (part.startsWith("~") && part.endsWith("~") && part.length > 2) return <del key={i}>{part.slice(1, -1)}</del>;
              if (part.startsWith("`") && part.endsWith("`") && part.length > 2) return <code key={i} style={{ padding: "0 4px", borderRadius: 3, fontFamily: "monospace" }}>{part.slice(1, -1)}</code>;
              return <span key={i}>{part || " "}</span>;
            })}
      </div>
    );
  });
}

// Modelos pré-prontos pra o usuário começar de algum lugar. O "Padrão" é
// inalterável — usuário pode editar o conteúdo no editor mas nunca sobrescreve
// o preset; ao salvar, sempre se cria um novo modelo customizado.
const MESSAGE_PRESETS = [
  {
    id: "default",
    name: "Padrão",
    desc: "Estrutura completa com emojis",
    template: `🔥 OFERTA IMPERDÍVEL!

📦 {produto}
🏪 {loja}

💰 De: {preco_antigo}
✅ Por: {preco}
🏷️ Desconto: -{desconto}

🛒 Compre aqui: {link}`,
  },
];

// Botões de formatação (estilo WhatsApp) — wraps a seleção do textarea com os marcadores.
const FORMAT_BUTTONS = [
  { token: "*", label: "B", title: "Negrito (*texto*)", style: { fontWeight: 700 } },
  { token: "_", label: "I", title: "Itálico (_texto_)", style: { fontStyle: "italic" } },
  { token: "~", label: "S", title: "Riscado (~texto~)", style: { textDecoration: "line-through" } },
  { token: "`", label: "</>", title: "Monoespaço (`texto`)", style: { fontFamily: "monospace", fontSize: 11 } },
];
import Badge from "./ui/Badge";
import StatCard from "./ui/StatCard";
import MiniBar from "./ui/MiniBar";
import Tabs from "./ui/Tabs";
import Modal from "./ui/Modal";
import Toggle from "./ui/Toggle";
import { ProductRow } from "./ui/ProductCard";

// Marca um valor "vazio" como — para o card mostrar todos os campos sempre.
const NULL_LABEL = "—";
const isEmpty = (v) => v == null || v === "" || (typeof v === "number" && isNaN(v));
const fmtBR = (v) => isEmpty(v) ? null : `R$ ${Number(v).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`;

function QueueField({ label, value, mono, link }) {
  const empty = isEmpty(value);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
      <div style={{ fontSize: 10, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 500 }}>{label}</div>
      <div style={{
        fontSize: 12,
        color: empty ? "var(--color-text-secondary)" : "var(--color-text-primary)",
        fontStyle: empty ? "italic" : "normal",
        opacity: empty ? 0.7 : 1,
        fontFamily: mono && !empty ? "monospace" : "inherit",
        wordBreak: "break-word",
        overflowWrap: "anywhere",
      }}>
        {empty
          ? NULL_LABEL
          : link
            ? <a href={value} target="_blank" rel="noreferrer" style={{ color: PRIMARY_DARK, textDecoration: "underline" }}>{value}</a>
            : String(value)
        }
      </div>
    </div>
  );
}

function QueueItemCard({ item, idx, eta, onRemove, onDragStart, onDragOver, onDragEnd, onDrop, isDragOver, isDragging }) {
  const addedAt = item.addedAt ? new Date(item.addedAt) : null;
  const addedAtStr = addedAt && !isNaN(addedAt.getTime()) ? addedAt.toLocaleString("pt-BR") : null;
  const discountStr = !isEmpty(item.discount) ? (typeof item.discount === "number" ? `${item.discount}%` : String(item.discount)) : null;
  const hasLink = !isEmpty(item.link);

  const border = isDragOver
    ? `2px dashed ${PRIMARY}`
    : (idx === 0 ? `0.5px solid ${PRIMARY}` : "0.5px solid var(--color-border-tertiary)");

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDrop={onDrop}
      style={{
        background: "var(--color-background-primary)",
        border,
        borderRadius: 12, padding: 14, display: "flex", flexDirection: "column", gap: 12,
        opacity: isDragging ? 0.4 : 1,
        cursor: "grab",
        transition: "border-color 0.15s, opacity 0.15s",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "var(--color-text-secondary)" }}>
          <span title="Arraste para reordenar" style={{ cursor: "grab", color: "var(--color-text-secondary)", fontSize: 14, lineHeight: 1, userSelect: "none" }}>⋮⋮</span>
          <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", minWidth: 22, height: 18, padding: "0 6px", borderRadius: 9, background: idx === 0 ? PRIMARY_LIGHT : "var(--color-background-secondary)", color: idx === 0 ? PRIMARY_DARK : "var(--color-text-secondary)", fontWeight: 500, fontSize: 11 }}>#{idx + 1}</span>
          <span>⏱ {idx === 0 ? "Próximo às" : "Previsto"} <strong style={{ color: idx === 0 ? PRIMARY_DARK : "var(--color-text-primary)" }}>{formatETA(eta)}</strong></span>
        </div>
        <button onClick={onRemove} style={{ padding: "5px 10px", borderRadius: 7, border: "0.5px solid #F7C1C1", background: "#FCEBEB", color: "#A32D2D", fontSize: 12, cursor: "pointer" }}>Remover</button>
      </div>

      <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
        {item.img ? (
          hasLink ? (
            <a href={item.link} target="_blank" rel="noreferrer" style={{ width: 72, height: 72, borderRadius: 10, overflow: "hidden", background: "#fff", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", border: "0.5px solid var(--color-border-tertiary)" }}>
              <img src={item.img} alt="" style={{ maxWidth: 72, maxHeight: 72, objectFit: "contain" }} />
            </a>
          ) : (
            <div style={{ width: 72, height: 72, borderRadius: 10, overflow: "hidden", background: "#fff", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", border: "0.5px solid var(--color-border-tertiary)" }}>
              <img src={item.img} alt="" style={{ maxWidth: 72, maxHeight: 72, objectFit: "contain" }} />
            </div>
          )
        ) : (
          <div style={{ width: 72, height: 72, borderRadius: 10, background: "var(--color-background-secondary)", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24, color: "var(--color-text-secondary)" }}>📦</div>
        )}
        <div style={{ flex: 1, minWidth: 0, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10 }}>
          <div style={{ gridColumn: "1 / -1", display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
            <div style={{ fontSize: 10, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 500 }}>Produto</div>
            <div style={{ fontSize: 13, fontWeight: 500, lineHeight: 1.35, wordBreak: "break-word", color: isEmpty(item.name) ? "var(--color-text-secondary)" : "var(--color-text-primary)", fontStyle: isEmpty(item.name) ? "italic" : "normal" }}>
              {isEmpty(item.name)
                ? NULL_LABEL
                : hasLink
                  ? <a href={item.link} target="_blank" rel="noreferrer" style={{ color: PRIMARY_DARK, textDecoration: "underline" }}>{item.name}</a>
                  : item.name
              }
            </div>
          </div>
          <QueueField label="Loja" value={item.store} />
          <QueueField label="Categoria" value={item.category} />
          <QueueField label="Preço" value={fmtBR(item.price)} />
          <QueueField label="Preço antigo" value={fmtBR(item.originalPrice)} />
          <QueueField label="Desconto" value={discountStr} />
          <QueueField label="Vendidos" value={soldText(item)} />
          <QueueField label="Avaliação" value={item.rating ? `★ ${item.rating}${item.reviewsCount ? ` (${item.reviewsCount})` : ""}` : null} />
          <QueueField label="Frete grátis" value={item.freeShipping ? "Sim" : null} />
          <QueueField label="Adicionado" value={addedAtStr} />
        </div>
      </div>
    </div>
  );
}

export default function GroupDashboard({ group, numbers, whatsappGroups = [], affiliateConfigured = true, affiliateStatus = null, onBack, onUpdate, onDelete, onCreateWhatsappGroup, onDeleteWhatsappGroup, onUpdateWhatsappGroup, onGoToSettings, onGoToAffiliate, onGoToWhatsapp, customTemplates = [], onAddCustomTemplate, onDeleteCustomTemplate, onUpdateCustomTemplate }) {
  const [tab, setTab] = useState(() => readSavedTab(group.id));
  // Guarda a aba atual por campanha pra restaurar no F5.
  useEffect(() => { writeSavedTab(group.id, tab); }, [group.id, tab]);
  const [sched, setSched] = useState(group.schedule);
  const [scraping, setScraping] = useState(group.scraping);
  const [queue, setQueue] = useState(group.queue);
  const [pending, setPending] = useState(group.pending);
  const [groupInfo, setGroupInfo] = useState({
    name: group.name,
    categories: getGroupCategories(group),
    whatsappGroupIds: group.whatsappGroupIds || [],
    messageTemplate: group.messageTemplate,
  });
  const [saved, setSaved] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  // Modal "Adicionar grupo": null = fechado, "choose" | "create" | "existing"
  const [addStep, setAddStep] = useState(null);
  const [addExistingNumberId, setAddExistingNumberId] = useState(null);
  const [addExistingSearch, setAddExistingSearch] = useState("");
  const [waGroupsByNumber, setWaGroupsByNumber] = useState({}); // numberId -> [{jid, name, members}]
  const [loadingWAGroups, setLoadingWAGroups] = useState(false);
  const [waGroupsError, setWaGroupsError] = useState(null);
  const [importingJid, setImportingJid] = useState(null);
  const [confirmDeleteWG, setConfirmDeleteWG] = useState(null);
  const [copiedId, setCopiedId] = useState(null);
  const [newWGForm, setNewWGForm] = useState({ name: "", numberIds: numbers[0]?.id ? [numbers[0].id] : [], participants: "", includeNimbus: false });
  const [nimbusAvail, setNimbusAvail] = useState({ connected: false, phone: null });
  const [creatingWG, setCreatingWG] = useState(false);
  const [createWGError, setCreateWGError] = useState(null);
  const [sendingNow, setSendingNow] = useState(false);
  const [sendNowMsg, setSendNowMsg] = useState(null);
  const [refilling, setRefilling] = useState(false);
  const [refillMsg, setRefillMsg] = useState(null);
  // AbortController da request de refill — permite cancelar via overlay.
  const refillAbortRef = useRef(null);
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);
  const [confirmDeleteTpl, setConfirmDeleteTpl] = useState(null);
  // Diálogo "Salvar alterações" do modelo: abre quando usuário tenta salvar
  // mudanças (presets nunca são sobrescritos, customs podem ser).
  // Estrutura: { mode: "preset" | "custom", suggestedName }
  const [saveTplDialog, setSaveTplDialog] = useState(null);
  const [saveTplName, setSaveTplName] = useState("");
  // Confirmações para botões destrutivos
  const [confirmPause, setConfirmPause] = useState(false);
  // Modal de aviso ao tentar retomar campanha com afiliado faltando.
  // null quando fechado; { needsML, needsShopee, hasManualPause } quando aberto.
  const [confirmResumeAff, setConfirmResumeAff] = useState(null);
  // Modal de aviso ao adicionar uma fonte cujo afiliado não está configurado.
  // null quando fechado; { src } (ex: "Shopee", "Mercado Livre") quando aberto.
  const [confirmAddSource, setConfirmAddSource] = useState(null);
  const [confirmClearQueue, setConfirmClearQueue] = useState(false);
  const [confirmRemoveQueueItem, setConfirmRemoveQueueItem] = useState(null);
  // Aba de modelo selecionada (presets + customs). Inicia tentando casar com o template do grupo.
  const initialActiveTplKey = (() => {
    if (group.messageTemplate) {
      const preset = MESSAGE_PRESETS.find(p => p.template === group.messageTemplate);
      if (preset) return `preset:${preset.id}`;
      const custom = customTemplates.find(t => t.template === group.messageTemplate);
      if (custom) return `custom:${custom.id}`;
    }
    return MESSAGE_PRESETS[0] ? `preset:${MESSAGE_PRESETS[0].id}` : null;
  })();
  const [activeTplKey, setActiveTplKey] = useState(initialActiveTplKey);
  const [customNameDraft, setCustomNameDraft] = useState("");
  const [confirmClearHistory, setConfirmClearHistory] = useState(false);
  const [clearingHistory, setClearingHistory] = useState(false);
  const dragIdxRef = useRef(null);
  const [dragIdx, setDragIdx] = useState(null);
  const [dragOverIdx, setDragOverIdx] = useState(null);

  // Sincroniza queue/pending quando o polling do App atualiza o grupo.
  // Usa as keys/ids dos itens como dep (não a referência do array) — assim o sync
  // só dispara quando o conteúdo realmente mudou, e não a cada poll.
  const queueKeySig = (group.queue || []).map(q => q.key ?? q.id ?? q.name).join("|");
  const pendingKeySig = (group.pending || []).map(p => p.key ?? p.id ?? p.name).join("|");
  useEffect(() => { setQueue(group.queue || []); }, [queueKeySig]);
  useEffect(() => { setPending(group.pending || []); }, [pendingKeySig]);

  // Disponibilidade do WhatsNimbus — habilita usá-lo como participante extra na
  // criação de grupo (o WhatsApp exige ao menos 1 participante além de você).
  useEffect(() => {
    let alive = true;
    whatsNimbusAvailable()
      .then(r => { if (alive) setNimbusAvail({ connected: !!r?.connected, phone: r?.phone || null }); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  async function handleClearHistory() {
    setClearingHistory(true);
    try {
      await clearGroupHistory(group.id);
      onUpdate(group.id, {
        history: [],
        sentToday: 0,
        sentWeek: 0,
        weekData: [0, 0, 0, 0, 0, 0, 0],
        lastSend: "—",
      });
      setConfirmClearHistory(false);
    } catch (err) {
      alert(`Erro: ${err.message}`);
    } finally {
      setClearingHistory(false);
    }
  }

  async function triggerRefill() {
    if (refilling) return;
    const ctrl = new AbortController();
    refillAbortRef.current = ctrl;
    setRefilling(true);
    setRefillMsg(null);
    // Buscar TAMBÉM salva a configuração atual (pesquisa + filtros + fontes/auto),
    // pra não precisar de um botão separado de "salvar filtros".
    onUpdate(group.id, { scraping });
    try {
      // Manda filtros + sources + categories atuais como override pra usar valores
      // que ainda podem não ter sido persistidos (debounce do auto-save)
      const r = await refillQueueNow(group.id, {
        filters: scraping.filters,
        sources: scraping.sources,
        categories: groupInfo.categories,
      }, { signal: ctrl.signal });
      const ops = await loadAppOps();
      const o = (ops.groups || []).find(g => g.id === group.id);
      // Com auto-aprovação OFF, os itens vão pra `pending` (Aguardando revisão),
      // não pra `queue` — então precisamos atualizar os dois.
      if (o) onUpdate(group.id, { queue: o.queue, pending: o.pending });
      const parts = [];
      if (r.added > 0) parts.push(`+${r.added} novo${r.added !== 1 ? "s" : ""}`);
      if (r.removed > 0) parts.push(`-${r.removed} duplicado${r.removed !== 1 ? "s" : ""}`);
      if (parts.length === 0) parts.push("nada novo no catálogo que passe nos filtros");
      const destino = r.target === "pending"
        ? `${r.pendingSize} aguardando revisão`
        : `fila tem ${r.queueSize} item(ns)`;
      setRefillMsg({ type: r.added > 0 ? "ok" : "warn", text: `${parts.join(", ")} · ${destino}` });
      setTimeout(() => setRefillMsg(null), 5000);
    } catch (err) {
      // AbortError quando usuário cancela: mensagem amigável, sem alarme.
      if (err.name === "AbortError") {
        setRefillMsg({ type: "warn", text: "Busca cancelada." });
        setTimeout(() => setRefillMsg(null), 3000);
      } else {
        setRefillMsg({ type: "err", text: err.message });
      }
    } finally {
      refillAbortRef.current = null;
      setRefilling(false);
    }
  }

  function cancelRefill() {
    if (refillAbortRef.current) refillAbortRef.current.abort();
  }

  async function triggerSendNow() {
    if (sendingNow || queue.length === 0) return;
    setSendingNow(true);
    setSendNowMsg(null);
    try {
      const r = await apiSendNextNow(group.id);
      // Pega ops fresco do servidor pra refletir lastSend/queue/history atualizados
      const ops = await loadAppOps();
      const o = (ops.groups || []).find(g => g.id === group.id);
      if (o) {
        onUpdate(group.id, {
          queue: o.queue,
          history: o.history,
          sentToday: o.sentToday,
          sentWeek: o.sentWeek,
          weekData: o.weekData,
          lastSend: o.lastSend,
        });
      }
      setSendNowMsg({ type: "ok", text: `Enviado para ${r.sent} grupo(s).` });
      setTimeout(() => setSendNowMsg(null), 4000);
    } catch (err) {
      setSendNowMsg({ type: "err", text: err.message });
    } finally {
      setSendingNow(false);
    }
  }
  // ── Adicionar link manualmente ──────────────────────────────────────────
  // Modal aberto = objeto com o form; null = fechado.
  const emptyManualForm = { url: "", name: "", price: "", originalPrice: "", discount: "", img: "", store: "", category: "" };
  const [manualForm, setManualForm] = useState(null);
  const [manualFetching, setManualFetching] = useState(false);
  const [manualSubmitting, setManualSubmitting] = useState(false);
  const [manualMsg, setManualMsg] = useState(null); // { type: "ok"|"err"|"warn", text }
  // Quando o backend devolve { inCooldown: true }, guardamos pra confirmar com force=true
  const [manualCooldown, setManualCooldown] = useState(null);

  const openManualAdd = () => {
    setManualForm({
      ...emptyManualForm,
      category: (groupInfo.categories || [])[0] || "",
    });
    setManualMsg(null);
    setManualCooldown(null);
  };
  const closeManualAdd = () => {
    setManualForm(null);
    setManualMsg(null);
    setManualCooldown(null);
  };
  const updateManualField = (field, value) => setManualForm(f => f ? { ...f, [field]: value } : f);

  const fetchManualMetadata = async () => {
    if (!manualForm?.url?.trim() || manualFetching) return;
    setManualFetching(true);
    setManualMsg(null);
    try {
      const data = await fetchUrlMetadata(manualForm.url.trim());
      setManualForm(f => ({
        ...f,
        url: data.link || f.url,
        name: data.name || f.name,
        img: data.img || f.img,
        price: data.price != null ? String(data.price) : f.price,
        originalPrice: data.originalPrice != null ? String(data.originalPrice) : f.originalPrice,
        discount: data.discount != null ? String(data.discount) : f.discount,
        store: data.store || f.store,
      }));
      const missing = [];
      if (!data.name) missing.push("nome");
      if (data.price == null) missing.push("preço");
      setManualMsg(missing.length
        ? { type: "warn", text: `Dados parciais. Preencha manualmente: ${missing.join(", ")}.` }
        : { type: "ok", text: "Dados carregados. Revise antes de adicionar." });
    } catch (err) {
      setManualMsg({ type: "err", text: `Falha ao buscar dados: ${err.message}. Preencha manualmente.` });
    } finally {
      setManualFetching(false);
    }
  };

  const submitManualAdd = async (force = false) => {
    if (!manualForm || manualSubmitting) return;
    if (!manualForm.url.trim()) { setManualMsg({ type: "err", text: "Informe o link do produto." }); return; }
    if (!manualForm.name.trim()) { setManualMsg({ type: "err", text: "Informe o nome do produto." }); return; }
    setManualSubmitting(true);
    setManualMsg(null);
    try {
      const payload = {
        url: manualForm.url.trim(),
        force,
        overrides: {
          name: manualForm.name.trim(),
          price: manualForm.price !== "" ? Number(manualForm.price) : null,
          originalPrice: manualForm.originalPrice !== "" ? Number(manualForm.originalPrice) : null,
          discount: manualForm.discount !== "" ? Number(manualForm.discount) : null,
          img: manualForm.img.trim() || null,
          store: manualForm.store.trim() || null,
          category: manualForm.category || null,
        },
      };
      const r = await manualAddToQueue(group.id, payload);
      if (r.inCooldown) {
        setManualCooldown(r);
        return;
      }
      // Sucesso — atualiza UI imediatamente e fecha
      const ops = await loadAppOps();
      const o = (ops.groups || []).find(g => g.id === group.id);
      if (o) onUpdate(group.id, { queue: o.queue, pending: o.pending });
      const targetLabel = r.target === "pending" ? "aguardando revisão" : "fila";
      setRefillMsg({ type: "ok", text: `Produto adicionado à ${targetLabel}.` });
      setTimeout(() => setRefillMsg(null), 4000);
      closeManualAdd();
    } catch (err) {
      setManualMsg({ type: "err", text: err.message });
    } finally {
      setManualSubmitting(false);
    }
  };

  const templateRef = useRef(null);

  const insertTemplateVar = (token) => {
    const ta = templateRef.current;
    const cur = groupInfo.messageTemplate || "";
    if (ta && typeof ta.selectionStart === "number") {
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const next = cur.slice(0, start) + token + cur.slice(end);
      setGroupInfo(g => ({ ...g, messageTemplate: next }));
      requestAnimationFrame(() => {
        ta.focus();
        const pos = start + token.length;
        ta.setSelectionRange(pos, pos);
      });
    } else {
      setGroupInfo(g => ({ ...g, messageTemplate: cur + token }));
    }
  };

  // Envolve a seleção atual do textarea com `marker` (*, _, ~, `).
  // Sem seleção: insere "markermarker" e posiciona o cursor entre os dois.
  const wrapSelectionWith = (marker) => {
    const ta = templateRef.current;
    const cur = groupInfo.messageTemplate || "";
    if (!ta || typeof ta.selectionStart !== "number") {
      setGroupInfo(g => ({ ...g, messageTemplate: cur + marker + marker }));
      return;
    }
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const selected = cur.slice(start, end);
    const next = cur.slice(0, start) + marker + selected + marker + cur.slice(end);
    setGroupInfo(g => ({ ...g, messageTemplate: next }));
    requestAnimationFrame(() => {
      ta.focus();
      const newStart = start + marker.length;
      const newEnd = newStart + selected.length;
      ta.setSelectionRange(newStart, newEnd);
    });
  };

  // Lista de abas de modelo (presets + customs). Cada aba é uma "página" estilo Chrome.
  const allTabs = [
    ...MESSAGE_PRESETS.map(p => ({ key: `preset:${p.id}`, kind: "preset", id: p.id, name: p.name, template: p.template })),
    ...customTemplates.map(t => ({ key: `custom:${t.id}`, kind: "custom", id: t.id, name: t.name, template: t.template })),
  ];
  const activeTab = allTabs.find(t => t.key === activeTplKey) || null;
  const isCustomTab = activeTab?.kind === "custom";
  // "Dirty" = editor diverge do template salvo da aba ativa, OU o nome custom foi renomeado.
  const isDirty = !!activeTab && (
    groupInfo.messageTemplate !== activeTab.template ||
    (isCustomTab && customNameDraft.trim().length > 0 && customNameDraft.trim() !== activeTab.name)
  );

  // Sincroniza o draft do nome quando troca de aba (ou quando a aba ativa é renomeada via save).
  useEffect(() => {
    setCustomNameDraft(isCustomTab ? activeTab.name : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab?.key, activeTab?.name]);

  const handleTabClick = (t) => {
    setActiveTplKey(t.key);
    setGroupInfo(g => ({ ...g, messageTemplate: t.template }));
  };

  // "+" cria um novo modelo custom usando o conteúdo atual do editor como semente
  // (assim "fork" de um preset com edições é natural).
  const handleNewTab = () => {
    const base = "Novo modelo";
    let name = base;
    let n = 1;
    while (customTemplates.some(t => t.name === name)) {
      n++;
      name = `${base} ${n}`;
    }
    const seed = (groupInfo.messageTemplate && groupInfo.messageTemplate.trim()) ? groupInfo.messageTemplate : DEFAULT_MESSAGE_TEMPLATE;
    const newId = onAddCustomTemplate?.(name, seed);
    if (newId) {
      setActiveTplKey(`custom:${newId}`);
      setGroupInfo(g => ({ ...g, messageTemplate: seed }));
      requestAnimationFrame(() => { templateRef.current?.focus(); });
    }
  };

  // "Criar a partir deste": copia o template SALVO da aba ativa (ignora edições
  // não salvas no editor) e abre uma nova aba com nome "{nome} (cópia)" único.
  const duplicateActiveTemplate = () => {
    if (!activeTab) return;
    const newName = suggestUniqueTemplateName(`${activeTab.name} (cópia)`);
    const seed = activeTab.template || DEFAULT_MESSAGE_TEMPLATE;
    const newId = onAddCustomTemplate?.(newName, seed);
    if (newId) {
      setActiveTplKey(`custom:${newId}`);
      setGroupInfo(g => ({ ...g, messageTemplate: seed }));
      requestAnimationFrame(() => { templateRef.current?.focus(); });
    }
  };

  // Sugere um nome único pra novos modelos baseados no nome atual da aba.
  const suggestUniqueTemplateName = (base) => {
    const cleanBase = String(base || "Novo modelo").trim() || "Novo modelo";
    let name = cleanBase;
    let n = 1;
    while (customTemplates.some(t => t.name === name)) {
      n++;
      name = `${cleanBase} (${n})`;
    }
    return name;
  };

  // Abre o diálogo de "Salvar alterações" — sempre pergunta se é pra criar
  // novo modelo (presets são inalteráveis; customs podem ser substituídos).
  const openSaveTplDialog = () => {
    if (!activeTab || !isDirty) return;
    if (isCustomTab) {
      setSaveTplDialog({ mode: "custom" });
      setSaveTplName(customNameDraft.trim() || activeTab.name);
    } else {
      setSaveTplDialog({ mode: "preset" });
      setSaveTplName(suggestUniqueTemplateName(`${activeTab.name} (cópia)`));
    }
  };

  const closeSaveTplDialog = () => {
    setSaveTplDialog(null);
    setSaveTplName("");
  };

  // Salva como novo modelo customizado (vale para presets E customs)
  const saveAsNewTemplate = () => {
    const cleanName = String(saveTplName || "").trim();
    if (!cleanName) return;
    const finalName = customTemplates.some(t => t.name === cleanName)
      ? suggestUniqueTemplateName(cleanName)
      : cleanName;
    const newId = onAddCustomTemplate?.(finalName, groupInfo.messageTemplate);
    if (newId) {
      setActiveTplKey(`custom:${newId}`);
      setCustomNameDraft(finalName);
    }
    closeSaveTplDialog();
  };

  // Substitui o modelo customizado atual (só disponível em aba custom)
  const replaceCurrentCustom = () => {
    if (!activeTab || !isCustomTab) return;
    const desiredName = customNameDraft.trim() || activeTab.name;
    onUpdateCustomTemplate?.(activeTab.id, {
      name: desiredName,
      template: groupInfo.messageTemplate,
    });
    closeSaveTplDialog();
  };

  // "Modelo ativo" = aquele cujo texto salvo corresponde ao template em uso
  // pela campanha. Como múltiplas abas podem ter o mesmo texto, marcamos
  // todas que casarem (caso raro, mas o indicador fica consistente).
  const isTemplateActive = (tpl) => !!group.messageTemplate && tpl === group.messageTemplate;
  const activeTabIsActive = activeTab && isTemplateActive(activeTab.template);

  // Ativa o modelo da aba atual na campanha — substitui o messageTemplate do
  // grupo e reseta o editor pra refletir o que passou a estar em uso.
  const activateActiveTab = () => {
    if (!activeTab || activeTabIsActive) return;
    onUpdate(group.id, { messageTemplate: activeTab.template });
    setGroupInfo(g => ({ ...g, messageTemplate: activeTab.template }));
  };

  // Quando deleta a aba custom ativa, pula pra primeira aba disponível.
  const onConfirmedDeleteCustom = (tplId) => {
    onDeleteCustomTemplate?.(tplId);
    if (activeTplKey === `custom:${tplId}`) {
      const fallback = MESSAGE_PRESETS[0];
      if (fallback) {
        setActiveTplKey(`preset:${fallback.id}`);
        setGroupInfo(g => ({ ...g, messageTemplate: fallback.template }));
      }
    }
  };

  const copyInvite = (wg) => {
    if (!wg?.inviteLink) return;
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(wg.inviteLink).catch(() => {});
    }
    setCopiedId(wg.id);
    setTimeout(() => setCopiedId(c => c === wg.id ? null : c), 1500);
  };

  // Calcula o próximo "#N" pra clonar um grupo. Tira sufixo "#N" prévio do nome
  // base (clonar X #2 vira X #3, não X #2 #1).
  const computeCloneName = (originalName) => {
    const base = String(originalName || "Grupo").replace(/\s*#\d+\s*$/, "").trim() || "Grupo";
    const re = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+#(\\d+)$`);
    let maxN = 1;
    let baseExists = false;
    for (const w of whatsappGroups) {
      if (w.name === base) baseExists = true;
      const m = w.name && w.name.match(re);
      if (m) maxN = Math.max(maxN, Number(m[1]));
    }
    const n = baseExists ? maxN + 1 : maxN;
    return `${base} #${n}`;
  };

  // Abre o modal de criação pré-preenchido com nome "X #N" e mesmo número.
  // Participantes ficam vazios — WhatsApp exige ao menos 1 participante além de ti.
  const cloneGroup = (wg) => {
    setNewWGForm({
      name: computeCloneName(wg.name),
      numberIds: wg.numberId ? [wg.numberId] : (numbers[0]?.id ? [numbers[0].id] : []),
      participants: "",
      includeNimbus: false,
    });
    setAddStep("create");
  };

  // Edição da descrição (estado local — guarda só no Nimbus, não no WhatsApp).
  const [editingDescId, setEditingDescId] = useState(null);
  const [descDraft, setDescDraft] = useState("");
  const startEditDesc = (wg) => { setEditingDescId(wg.id); setDescDraft(wg.description || ""); };
  const saveDesc = (wg) => {
    onUpdateWhatsappGroup?.(wg.id, { description: descDraft });
    setEditingDescId(null);
  };
  const cancelEditDesc = () => { setEditingDescId(null); setDescDraft(""); };

  const primaryCat = groupInfo.categories[0] || getGroupCategories(group)[0];
  const barColor = primaryCat === "gamer" ? "#378ADD" : PRIMARY;
  const linkedWGs = whatsappGroups.filter(w => groupInfo.whatsappGroupIds.includes(w.id));
  // Passa objeto quando disponível (ml + shopee gating), senão fallback boolean (compat).
  const stats = getGroupStats({ whatsappGroupIds: groupInfo.whatsappGroupIds, scraping: { sources: scraping.sources }, paused: group.paused }, whatsappGroups, { affiliateConfigured: affiliateStatus || affiliateConfigured });

  // Status do afiliado pode vir como bool (App.jsx) ou objeto { configured } (testes).
  const isAffOk = (key) => {
    const v = affiliateStatus?.[key];
    if (v && typeof v === "object") return !!v.configured;
    return !!v;
  };
  // Mapeia o nome exibido da loja → key do afiliado (só lojas com gating).
  const SOURCE_TO_AFF_KEY = { "Mercado Livre": "ml", "Shopee": "shopee" };

  // Aplica o toggle de uma fonte (entry point pós-confirmação ou direto).
  const applyToggleSource = (src) => {
    setScraping(s => ({
      ...s,
      sources: s.sources.includes(src) ? s.sources.filter(x => x !== src) : [...s.sources, src],
    }));
  };
  // Wrapper que intercepta: se for ADIÇÃO de fonte cujo afiliado não está
  // configurado, abre modal de confirmação primeiro (senão a campanha vai
  // pausar silenciosamente). Remoção e fontes sem gating passam direto.
  const handleToggleSource = (src) => {
    const active = scraping.sources.includes(src);
    if (!active) {
      const affKey = SOURCE_TO_AFF_KEY[src];
      if (affKey && !isAffOk(affKey)) {
        setConfirmAddSource({ src, affKey });
        return;
      }
    }
    applyToggleSource(src);
  };

  const toggleCategory = (id) => setGroupInfo(g => {
    const has = g.categories.includes(id);
    if (has) {
      if (g.categories.length === 1) return g; // mantém pelo menos uma
      return { ...g, categories: g.categories.filter(c => c !== id) };
    }
    return { ...g, categories: [...g.categories, id] };
  });

  // Vincular/desvincular grupo WA: atualiza estado local (UI imediata) E propaga
  // pro App via onUpdate — sem onUpdate, o auto-save do App nunca dispara e a
  // alteração some quando o usuário navega entre abas.
  const linkWG = (wgId) => {
    const next = [...(groupInfo.whatsappGroupIds || []), wgId];
    setGroupInfo(g => ({ ...g, whatsappGroupIds: next }));
    onUpdate(group.id, { whatsappGroupIds: next });
  };
  const unlinkWG = (wgId) => {
    const next = (groupInfo.whatsappGroupIds || []).filter(id => id !== wgId);
    setGroupInfo(g => ({ ...g, whatsappGroupIds: next }));
    onUpdate(group.id, { whatsappGroupIds: next });
  };

  const closeAddModal = () => {
    setAddStep(null);
    setAddExistingNumberId(null);
    setAddExistingSearch("");
    setWaGroupsError(null);
  };

  // Carrega os grupos do WhatsApp de UM número (lazy — só quando o usuário escolhe ele).
  const loadGroupsForNumber = async (numberId) => {
    setAddExistingNumberId(numberId);
    setAddExistingSearch("");
    setWaGroupsError(null);
    if (waGroupsByNumber[numberId]) return; // já carregado nesta sessão do modal
    setLoadingWAGroups(true);
    try {
      const list = await listWAGroups(numberId);
      setWaGroupsByNumber(m => ({ ...m, [numberId]: list }));
    } catch (err) {
      const num = numbers.find(n => n.id === numberId);
      setWaGroupsError(`${num?.label || numberId}: ${err.message || "Falha ao listar grupos"}`);
      setWaGroupsByNumber(m => ({ ...m, [numberId]: [] }));
    } finally {
      setLoadingWAGroups(false);
    }
  };

  // Importa um grupo do WhatsApp pro Nimbus e já vincula à campanha
  const importAndLink = async (numberId, waGroup) => {
    setImportingJid(waGroup.jid);
    try {
      const newId = onCreateWhatsappGroup({
        id: waGroup.jid,
        name: waGroup.name,
        numberId,
        members: waGroup.members || 0,
        inviteLink: null,
      });
      const next = [...(groupInfo.whatsappGroupIds || []), newId];
      setGroupInfo(g => ({ ...g, whatsappGroupIds: next }));
      onUpdate(group.id, { whatsappGroupIds: next });
      closeAddModal();
    } finally {
      setImportingJid(null);
    }
  };

  // Vincula à campanha um grupo já cadastrado no Nimbus
  const linkAndClose = (wgId) => {
    linkWG(wgId);
    closeAddModal();
  };

  const submitCreateWG = async () => {
    setCreateWGError(null);
    const selectedIds = newWGForm.numberIds || [];
    if (!newWGForm.name.trim() || selectedIds.length === 0) return;
    const parts = newWGForm.participants
      .split(/[\n,;]/)
      .map(p => p.trim())
      .filter(Boolean);
    const includeNimbus = !!newWGForm.includeNimbus && nimbusAvail.connected;
    if (parts.length === 0 && !includeNimbus) {
      setCreateWGError("Informe ao menos um participante (telefone com DDD) ou marque a opção do WhatsNimbus.");
      return;
    }
    setCreatingWG(true);
    const baseName = newWGForm.name.trim();
    const useSuffix = selectedIds.length > 1;
    const created = [];
    const errors = [];
    try {
      for (const numId of selectedIds) {
        const num = numbers.find(n => n.id === numId);
        const name = useSuffix && num ? `${baseName} — ${num.label}` : baseName;
        try {
          const result = await createWAGroup(numId, name, parts, includeNimbus);
          const newId = onCreateWhatsappGroup({
            id: result.jid,
            name: result.name,
            numberId: numId,
            members: result.participants.length + 1,
            inviteLink: result.inviteLink,
          });
          created.push(newId);
        } catch (err) {
          errors.push(`${num?.label || numId}: ${err.message}`);
        }
      }
      if (created.length > 0) {
        const next = [...(groupInfo.whatsappGroupIds || []), ...created];
        setGroupInfo(g => ({ ...g, whatsappGroupIds: next }));
        onUpdate(group.id, { whatsappGroupIds: next });
      }
      if (errors.length > 0) {
        setCreateWGError(`Falhou em ${errors.length} número(s):\n${errors.join("\n")}`);
        if (created.length === 0) return;
      }
      closeAddModal();
      setNewWGForm({ name: "", numberIds: numbers[0]?.id ? [numbers[0].id] : [], participants: "", includeNimbus: false });
    } finally {
      setCreatingWG(false);
    }
  };

  // Refresca o link de convite (revoga o atual e atualiza no estado)
  const refreshInvite = async (wg) => {
    try {
      const { inviteLink } = await revokeWAInvite(wg.numberId, wg.id);
      onUpdateWhatsappGroup?.(wg.id, { inviteLink });
    } catch (err) {
      alert(`Erro ao atualizar link: ${err.message}`);
    }
  };

  // Excluir grupo (sair no WhatsApp + remover do estado)
  const handleDeleteWG = async (wg) => {
    try { await leaveWAGroup(wg.numberId, wg.id); } catch (err) { console.error(err); }
    onDeleteWhatsappGroup(wg.id);
    setConfirmDeleteWG(null);
  };

  const addWindow = () => setSched(s => ({ ...s, windows: [...s.windows, { id: Date.now(), from: "10:00", to: "14:00", interval: 30 }] }));
  const removeWindow = id => setSched(s => ({ ...s, windows: s.windows.filter(w => w.id !== id) }));
  const updateWindow = (id, f, v) => setSched(s => ({ ...s, windows: s.windows.map(w => w.id === id ? { ...w, [f]: v } : w) }));

  // Calcula os horários de envio com base nas janelas configuradas
  const computeSendTimes = (count) => {
    const times = [];
    const now = new Date();
    const todayMin = (h, m) => { const d = new Date(now); d.setHours(h, m, 0, 0); return d; };
    const parseTime = (t) => { const [h, m] = t.split(":").map(Number); return { h, m }; };

    // Gerar todos os slots possíveis nas janelas
    const slots = [];
    for (const w of sched.windows) {
      const from = parseTime(w.from);
      const to = parseTime(w.to);
      let cursor = todayMin(from.h, from.m);
      const end = todayMin(to.h, to.m);
      while (cursor <= end) {
        if (cursor > now) {
          slots.push(new Date(cursor));
        }
        cursor = new Date(cursor.getTime() + w.interval * 60000);
      }
    }

    // Se não há slots restantes hoje, gerar para amanhã
    if (slots.length === 0) {
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      for (const w of sched.windows) {
        const from = parseTime(w.from);
        const to = parseTime(w.to);
        let cursor = new Date(tomorrow); cursor.setHours(from.h, from.m, 0, 0);
        const end = new Date(tomorrow); end.setHours(to.h, to.m, 0, 0);
        while (cursor <= end) {
          slots.push(new Date(cursor));
          cursor = new Date(cursor.getTime() + w.interval * 60000);
        }
      }
    }

    slots.sort((a, b) => a - b);
    for (let i = 0; i < count; i++) {
      if (i < slots.length) {
        times.push(slots[i].toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }));
      } else {
        times.push("amanhã");
      }
    }
    return times;
  };

  const refreshOps = async () => {
    try {
      const ops = await loadAppOps();
      const o = (ops.groups || []).find(g => g.id === group.id);
      if (o) onUpdate(group.id, { queue: o.queue, pending: o.pending });
    } catch {}
  };
  const approveProduct = async (pid) => {
    const p = pending.find(x => (x.id ?? x.key) === pid);
    if (!p) return;
    // optimistic
    setPending(ps => ps.filter(x => (x.id ?? x.key) !== pid));
    setQueue(q => [...q, { ...p }]);
    try {
      await approvePendingItem(group.id, p.id ?? p.key);
      await refreshOps();
    } catch (err) {
      alert(`Erro ao aprovar: ${err.message}`);
      await refreshOps();
    }
  };
  const rejectProduct = async (pid) => {
    const p = pending.find(x => (x.id ?? x.key) === pid);
    if (!p) return;
    setPending(ps => ps.filter(x => (x.id ?? x.key) !== pid));
    try {
      await rejectPendingItem(group.id, p.id ?? p.key);
      await refreshOps();
    } catch (err) {
      alert(`Erro ao rejeitar: ${err.message}`);
      await refreshOps();
    }
  };
  // Ações em massa: uma única chamada atômica no backend (não dispara N requests
  // em paralelo, que colidiam no replace-all do pending — unique [groupId, key]).
  const approveAllProducts = async () => {
    if (pending.length === 0) return;
    setQueue(q => [...q, ...pending]);
    setPending([]);
    try {
      await approveAllPending(group.id);
      await refreshOps();
    } catch (err) {
      alert(`Erro ao adicionar todos à fila: ${err.message}`);
      await refreshOps();
    }
  };
  const rejectAllProducts = async () => {
    if (pending.length === 0) return;
    setPending([]);
    try {
      await rejectAllPending(group.id);
      await refreshOps();
    } catch (err) {
      alert(`Erro ao rejeitar todos: ${err.message}`);
      await refreshOps();
    }
  };
  // Persiste a nova ordem/composição da fila na tabela de ops do servidor.
  // Sem isso o próximo poll (GET /api/state/ops, ordenado por position) reverteria
  // a mudança local em segundos — a ordem da fila NÃO é gravada pelo save geral.
  // Em falha, recarrega ops pra refletir o estado real (evita ficar "torto").
  const persistQueue = async (next) => {
    try {
      await saveGroupQueue(group.id, next);
    } catch (err) {
      console.warn("[nimbus] falha ao salvar a fila:", err.message);
      try {
        const ops = await loadAppOps();
        const o = (ops.groups || []).find(g => g.id === group.id);
        if (o) onUpdate(group.id, { queue: o.queue, pending: o.pending });
      } catch { /* ignora — próximo poll corrige */ }
    }
  };

  const removeFromQueue = qid => {
    const newQueue = queue.filter(i => (i.id ?? i.key) !== qid);
    const times = computeSendTimes(newQueue.length);
    const withTimes = newQueue.map((item, i) => ({ ...item, sendAt: times[i] }));
    setQueue(withTimes);
    onUpdate(group.id, { queue: withTimes });
    persistQueue(withTimes);
  };

  // Reordenar a fila por drag-and-drop. Persiste via saveGroupQueue pra sobreviver
  // ao próximo polling de ops (que carrega o estado fresco do servidor).
  // Usa ref pro índice de origem porque setState pode não ter propagado entre
  // dragstart e drop em alguns navegadores.
  const handleQueueDragStart = (idx) => (e) => {
    dragIdxRef.current = idx;
    setDragIdx(idx);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  };
  const handleQueueDragOver = (idx) => (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    if (dragOverIdx !== idx) setDragOverIdx(idx);
  };
  const handleQueueDragEnd = () => { dragIdxRef.current = null; setDragIdx(null); setDragOverIdx(null); };
  const handleQueueDrop = (dropIdx) => (e) => {
    e.preventDefault();
    const fromIdx = dragIdxRef.current;
    dragIdxRef.current = null;
    setDragIdx(null);
    setDragOverIdx(null);
    if (fromIdx == null || fromIdx === dropIdx) return;
    const next = [...queue];
    const [moved] = next.splice(fromIdx, 1);
    next.splice(dropIdx, 0, moved);
    setQueue(next);
    onUpdate(group.id, { queue: next });
    persistQueue(next);
  };

  const save = () => { onUpdate(group.id, { schedule: sched, scraping, queue, pending, ...groupInfo }); setSaved(true); setTimeout(() => setSaved(false), 2000); };

  // Zera todos os filtros e a pesquisa (não persiste — a próxima busca salva).
  const resetFilters = () => {
    setScraping(s => ({
      ...s,
      filters: { keywords: "", minPrice: 0, maxPrice: null, minDiscount: 0, minRating: 0, minSales: 0 },
    }));
  };

  // Dirty state por aba — usado pra (a) escurecer o botão de salvar quando
  // não há alterações, e (b) impedir cliques inúteis. JSON.stringify é
  // suficiente porque todos os objetos são produzidos por código com keys
  // em ordem estável.
  const stableJSON = (v) => JSON.stringify(v ?? null);
  // Cooldown vive no `sched` mas é editado na aba Gerenciar — separamos o dirty
  // dele do dirty das janelas pra cada aba reagir ao que ela mostra.
  const cooldownDirty = sched?.cooldownValue !== group.schedule?.cooldownValue
    || sched?.cooldownUnit !== group.schedule?.cooldownUnit;
  const windowsDirty = stableJSON(sched?.windows) !== stableJSON(group.schedule?.windows);
  const manageDirty = groupInfo.name !== group.name
    || stableJSON(groupInfo.categories) !== stableJSON(getGroupCategories(group))
    || stableJSON(scraping?.sources) !== stableJSON(group.scraping?.sources)
    || cooldownDirty;
  const scrapingDirty = stableJSON(scraping) !== stableJSON(group.scraping);
  const filtersDirty = stableJSON(scraping?.filters) !== stableJSON(group.scraping?.filters);
  const scheduleDirty = windowsDirty;
  const messageDirty = groupInfo.messageTemplate !== group.messageTemplate;

  // Alterações não salvas agregadas (todas as abas editáveis). Usado pelo guard
  // de navegação pra avisar ao trocar de aba ou sair da campanha.
  const hasUnsaved = manageDirty || scrapingDirty || filtersDirty
    || scheduleDirty || windowsDirty || cooldownDirty || messageDirty;

  // Reverte o estado local editável pros valores salvos do grupo (usado no
  // "Descartar" do guard). Não mexe em queue/pending (dados de polling).
  const revertLocal = () => {
    setSched(group.schedule);
    setScraping(group.scraping);
    setGroupInfo({
      name: group.name,
      categories: getGroupCategories(group),
      whatsappGroupIds: group.whatsappGroupIds || [],
      messageTemplate: group.messageTemplate,
    });
  };

  const requestNavigation = useRequestNavigation();
  useUnsavedGuard({ dirty: hasUnsaved, save, discard: revertLocal });

  // Estilos compartilhados pros botões de salvar — desabilitado quando não dirty.
  const saveBtnStyle = (dirty) => ({
    padding: "9px 24px", borderRadius: 8,
    background: saved ? "#3B6D11" : (dirty ? PRIMARY : "var(--color-background-secondary)"),
    color: saved ? "#fff" : (dirty ? "#fff" : "var(--color-text-secondary)"),
    border: "none", fontSize: 13,
    cursor: dirty ? "pointer" : "not-allowed",
    fontWeight: 500,
    opacity: dirty ? 1 : 0.55,
  });

  const isRepasse = scraping?.kind === "repasse";

  const groupTabs = [
    { id: "overview", label: "Visão geral" },
    { id: "manage", label: "Gerenciar" },
    { id: "whatsapp", label: `Grupos (${stats.count})` },
    { id: "products", label: isRepasse ? "Repasse" : "Busca de Produtos", dot: pending.length > 0 },
    { id: "queue", label: `Fila (${queue.length})` },
    { id: "schedule", label: "Janelas de envio" },
    { id: "messages", label: "Modelos Mensagens" },
    { id: "history", label: "Histórico" },
  ];

  return (
    <div>
      {refilling && (
        <BusyOverlay
          title="Buscando produtos no catálogo..."
          message="Aplicando filtros e gerando links de afiliado"
          onCancel={cancelRefill}
        />
      )}
      <button onClick={onBack} style={{ background: "transparent", border: "none", cursor: "pointer", fontSize: 13, color: "var(--color-text-secondary)", marginBottom: 16, display: "flex", alignItems: "center", gap: 6 }}>&larr; Voltar</button>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16, flexWrap: "wrap", gap: 10 }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 500, marginBottom: 6 }}>{groupInfo.name}</h2>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {groupInfo.categories.map(c => <Badge key={c} color={categoryColor(c)}><span style={{ marginRight: 4 }}>{categoryIcon(c)}</span>{categoryLabel(c)}</Badge>)}
            {stats.pausedManual && <Badge color="amber">Pausada</Badge>}
            {stats.pausedByAffiliateML && <Badge color="amber">Pausado · sem afiliado ML</Badge>}
            {stats.pausedByAffiliateShopee && <Badge color="amber">Pausado · sem afiliado Shopee</Badge>}
            {stats.status === "empty"
              ? <Badge color="gray">Sem grupos do WhatsApp</Badge>
              : stats.status === "disconnected"
                ? <Badge color="red">Pausada · sem WhatsApp</Badge>
                : <Badge color={stats.status === "connected" ? "green" : "amber"}>{stats.connected}/{stats.count} conectados</Badge>
            }
            {stats.count > 0 && <Badge color="gray">{stats.members} membros</Badge>}
          </div>
        </div>
        {(() => {
          // Estado efetivo: manual OU pausada pelo sistema (afiliado faltando OU
          // sem nenhum WhatsApp conectado). Botão deve refletir o estado real.
          const noWhatsapp = stats.status === "disconnected";
          const isPaused = !!group.paused || stats.pausedByAffiliate || noWhatsapp;
          const affOnly = !group.paused && stats.pausedByAffiliate;
          const waOnly = !group.paused && !stats.pausedByAffiliate && noWhatsapp;
          const affTarget = stats.pausedByAffiliateML ? "ml" : (stats.pausedByAffiliateShopee ? "shopee" : null);
          const title = group.paused
            ? "Retomar campanha"
            : affOnly
              ? `Configure o afiliado ${affTarget === "shopee" ? "Shopee" : "Mercado Livre"} para reativar`
              : waOnly
                ? "Conecte um WhatsApp para reativar (retoma sozinho)"
                : "Pausar envios desta campanha";
          const handleClick = () => {
            // Tem afiliado faltando? Abre modal explicando e pedindo confirmação
            // antes de retomar (ou redirecionar pra config).
            if (stats.pausedByAffiliate) {
              setConfirmResumeAff({
                needsML: stats.pausedByAffiliateML,
                needsShopee: stats.pausedByAffiliateShopee,
                hasManualPause: !!group.paused,
              });
              return;
            }
            // Parada por falta de WhatsApp (não é pausa manual): manda reconectar.
            // Retoma sozinho assim que um número voltar.
            if (waOnly) {
              onGoToWhatsapp?.();
              return;
            }
            if (group.paused) {
              onUpdate(group.id, { paused: false });
            } else {
              setConfirmPause(true);
            }
          };
          return (
            <button
              onClick={handleClick}
              title={title}
              style={{ padding: "8px 18px", borderRadius: 8, background: isPaused ? "#22C55E" : "#E24B4A", color: "#fff", border: "none", fontSize: 13, cursor: "pointer", fontWeight: 500, flexShrink: 0 }}
            >
              {isPaused ? "▶ Retomar" : "⏸ Pausar"}
            </button>
          );
        })()}
      </div>

      {stats.pausedManual && (
        <div style={{ background: "#FEF3C7", border: "0.5px solid #F4D08A", borderRadius: 10, padding: "10px 14px", marginBottom: 14, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: 16 }}>⏸</span>
          <span style={{ fontSize: 13, color: "#854F0B", flex: 1, minWidth: 200 }}>
            Esta campanha está <strong>pausada manualmente</strong> — não vai buscar produtos nem enviar mensagens até ser retomada.
          </span>
          <button onClick={() => onUpdate(group.id, { paused: false })} style={{ padding: "6px 12px", borderRadius: 8, background: "#22C55E", color: "#fff", border: "none", fontSize: 12, cursor: "pointer", fontWeight: 500 }}>
            ▶ Retomar
          </button>
        </div>
      )}

      {stats.pausedByAffiliateML && (
        <div style={{ background: "#FEF3C7", border: "0.5px solid #F4D08A", borderRadius: 10, padding: "10px 14px", marginBottom: 14, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: 16 }}>⚠️</span>
          <span style={{ fontSize: 13, color: "#854F0B", flex: 1, minWidth: 200 }}>
            Esta campanha está <strong>pausada</strong> — o afiliado do <strong>Mercado Livre</strong> não está configurado. Sem TAG e cookie, os links sairiam sem comissão.
          </span>
          {(onGoToAffiliate || onGoToSettings) && (
            <button onClick={() => (onGoToAffiliate ? onGoToAffiliate("ml") : onGoToSettings())} style={{ padding: "6px 12px", borderRadius: 8, background: "#854F0B", color: "#fff", border: "none", fontSize: 12, cursor: "pointer", fontWeight: 500 }}>
              Configurar Mercado Livre
            </button>
          )}
        </div>
      )}

      {stats.pausedByAffiliateShopee && (
        <div style={{ background: "#FEF3C7", border: "0.5px solid #F4D08A", borderRadius: 10, padding: "10px 14px", marginBottom: 14, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: 16 }}>⚠️</span>
          <span style={{ fontSize: 13, color: "#854F0B", flex: 1, minWidth: 200 }}>
            Esta campanha está <strong>pausada</strong> — o afiliado da <strong>Shopee</strong> não está configurado. Sem App ID e Secret, os links sairiam sem comissão.
          </span>
          {(onGoToAffiliate || onGoToSettings) && (
            <button onClick={() => (onGoToAffiliate ? onGoToAffiliate("shopee") : onGoToSettings())} style={{ padding: "6px 12px", borderRadius: 8, background: "#854F0B", color: "#fff", border: "none", fontSize: 12, cursor: "pointer", fontWeight: 500 }}>
              Configurar Shopee
            </button>
          )}
        </div>
      )}

      {stats.status === "disconnected" && (
        <div style={{ background: "#FCEBEB", border: "0.5px solid #EBB9B8", borderRadius: 10, padding: "10px 14px", marginBottom: 14, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: 16 }}>🔴</span>
          <span style={{ fontSize: 13, color: "#A32D2D", flex: 1, minWidth: 200 }}>
            Campanha <strong>parada</strong> — nenhum WhatsApp vinculado está conectado. Reconecte um número na página WhatsApp; os envios retomam sozinhos.
          </span>
        </div>
      )}

      {stats.status === "degraded" && (
        <div style={{ background: "#FEF3C7", border: "0.5px solid #F4D08A", borderRadius: 10, padding: "10px 14px", marginBottom: 14, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: 16 }}>⚠️</span>
          <span style={{ fontSize: 13, color: "#854F0B", flex: 1, minWidth: 200 }}>
            <strong>{stats.connected}/{stats.count}</strong> grupos conectados — um ou mais WhatsApp estão desconectados. A campanha segue enviando nos que estão de pé.
          </span>
        </div>
      )}

      <Tabs tabs={groupTabs} active={tab} onChange={(id) => requestNavigation(() => setTab(id))} />

      {tab === "overview" && (
        <div>
          <div style={{ display: "flex", gap: 10, marginBottom: 20, flexWrap: "wrap" }}>
            <StatCard label="Envios hoje" value={group.sentToday} color={PRIMARY_DARK} />
            <StatCard label="Envios semana" value={group.sentWeek} />
            <StatCard label="Na fila" value={queue.length} sub={pending.length > 0 ? `${pending.length} aguardando revisão` : undefined} color={pending.length > 0 ? "#854F0B" : undefined} />
            {(() => {
              const valid = !!group.lastSend && group.lastSend !== "—" && !isNaN(new Date(group.lastSend).getTime());
              const today = valid && isSameDayBR(group.lastSend);
              const value = valid ? formatTimeBR(group.lastSend) : "—";
              const sub = valid ? (today ? "hoje" : formatDateBR(group.lastSend)) : undefined;
              return <StatCard label="Último envio" value={value} sub={sub} />;
            })()}
          </div>
          <div className="grid-collapse" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 12, color: "var(--color-text-secondary)" }}>Envios esta semana</div>
              <MiniBar data={group.weekData} color={barColor} />
            </div>
            <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 10, color: "var(--color-text-secondary)" }}>Filtros do catálogo</div>
              <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 4 }}>
                Categorias: {(groupInfo.categories || []).length === 0
                  ? "—"
                  : (groupInfo.categories || []).map(c => `${categoryIcon(c)} ${categoryLabel(c)}`).join(", ")}
              </div>
              <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 4 }}>
                Lojas: {(scraping.sources || []).join(", ") || "todas"}
              </div>
              {scraping.filters?.minDiscount > 0 && (
                <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>Desconto mín: {scraping.filters.minDiscount}%</div>
              )}
            </div>
          </div>

          {/* Últimos 5 produtos enviados — derivado do histórico (mais recente primeiro) */}
          <div style={{ marginTop: 14, background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: 16 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10, gap: 8, flexWrap: "wrap" }}>
              <div style={{ fontSize: 13, fontWeight: 500, color: "var(--color-text-secondary)" }}>Últimos 5 produtos enviados</div>
              {(group.history || []).length > 5 && (
                <button onClick={() => setTab("history")} style={{ background: "transparent", border: "none", padding: 0, color: PRIMARY_DARK, fontSize: 12, cursor: "pointer", fontWeight: 500 }}>
                  Ver histórico completo →
                </button>
              )}
            </div>
            {(group.history || []).length === 0 ? (
              <div style={{ fontSize: 12, color: "var(--color-text-secondary)", padding: "16px 0", textAlign: "center", fontStyle: "italic" }}>
                Nenhum envio registrado ainda.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column" }}>
                {(group.history || [])
                  .slice()
                  .sort((a, b) => new Date(b.sentAt || 0) - new Date(a.sentAt || 0))
                  .slice(0, 5)
                  .map((h, i, arr) => {
                    const sent = h.sentAt ? new Date(h.sentAt) : null;
                    const sentValid = sent && !isNaN(sent.getTime());
                    const today = sentValid && sent.toDateString() === new Date().toDateString();
                    const dateStr = sentValid
                      ? (today ? `hoje ${sent.toTimeString().slice(0, 5)}` : sent.toLocaleDateString("pt-BR"))
                      : "—";
                    const priceStr = h.price != null ? formatPrice(Number(h.price)) : null;
                    return (
                      <div key={h.key || i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: i < arr.length - 1 ? "0.5px solid var(--color-border-tertiary)" : "none" }}>
                        <div style={{ width: 36, height: 36, borderRadius: 8, background: "var(--color-background-secondary)", flexShrink: 0, overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center" }}>
                          {h.img
                            ? <img src={h.img} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} onError={e => { e.target.style.display = "none"; }} />
                            : <span style={{ fontSize: 14, color: "var(--color-text-secondary)" }}>📦</span>}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          {h.link
                            ? <a href={h.link} target="_blank" rel="noreferrer" style={{ fontSize: 12, fontWeight: 500, color: "var(--color-text-primary)", textDecoration: "none", display: "block", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={h.name}>{h.name}</a>
                            : <div style={{ fontSize: 12, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={h.name}>{h.name}</div>}
                          <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 1 }}>
                            {dateStr}{h.store ? ` · ${h.store}` : ""}
                          </div>
                        </div>
                        {priceStr && <div style={{ fontSize: 12, fontWeight: 500, color: PRIMARY_DARK, flexShrink: 0 }}>{priceStr}</div>}
                      </div>
                    );
                  })}
              </div>
            )}
          </div>
        </div>
      )}

      {tab === "manage" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: 16 }}>
            <div style={{ fontWeight: 500, marginBottom: 4 }}>Informações da campanha</div>
            <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 14 }}>Nome e categorias</div>
            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Nome da campanha</label>
              <input value={groupInfo.name} onChange={e => setGroupInfo(g => ({ ...g, name: e.target.value }))} placeholder="Ex: Tech BR" style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13, boxSizing: "border-box" }} />
            </div>
            <div>
              <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 6 }}>Categorias <span style={{ color: "var(--color-text-tertiary, var(--color-text-secondary))" }}>(selecione uma ou mais)</span></label>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {Object.keys(CATEGORIES).map(id => {
                  const active = groupInfo.categories.includes(id);
                  return (
                    <div
                      key={id}
                      onClick={() => toggleCategory(id)}
                      style={{ padding: "6px 14px", borderRadius: 8, border: `0.5px solid ${active ? PRIMARY : "var(--color-border-tertiary)"}`, background: active ? PRIMARY_LIGHT : "transparent", color: active ? PRIMARY_DARK : "var(--color-text-secondary)", fontSize: 13, cursor: "pointer", fontWeight: active ? 500 : 400, userSelect: "none" }}
                    >
                      {active ? "✓ " : ""}<span style={{ marginRight: 4 }}>{categoryIcon(id)}</span>{categoryLabel(id)}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: 16 }}>
            <div style={{ fontWeight: 500, marginBottom: 4 }}>Fontes de busca</div>
            <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 12 }}>
              Selecione as lojas onde a campanha vai procurar ofertas.
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {allSources.map(src => {
                const active = scraping.sources.includes(src);
                return <div key={src} onClick={() => handleToggleSource(src)} style={{ padding: "6px 14px", borderRadius: 8, border: `0.5px solid ${active ? PRIMARY : "var(--color-border-tertiary)"}`, background: active ? PRIMARY_LIGHT : "transparent", color: active ? PRIMARY_DARK : "var(--color-text-secondary)", fontSize: 13, cursor: "pointer", fontWeight: active ? 500 : 400 }}>{active ? "✓ " : ""}{src}</div>;
              })}
            </div>
            {scraping.sources.length === 0 && (
              <div style={{ marginTop: 10, fontSize: 11, color: "#A32D2D" }}>Selecione ao menos uma fonte para o scraping funcionar.</div>
            )}
          </div>

          {/* Cooldown: movido da aba Janelas — é uma regra de produto, não de horário */}
          <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 4 }}>Tempo de espera para reenvio</div>
            <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 14 }}>Quanto tempo um produto aguarda antes de poder ser enviado novamente</div>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <input type="number" min={1} value={sched.cooldownValue} onChange={e => setSched(s => ({ ...s, cooldownValue: Number(e.target.value) }))} style={{ width: 80, padding: "8px 10px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 15, fontWeight: 500, textAlign: "center" }} />
              <div style={{ display: "flex", gap: 6 }}>
                {["horas", "dias", "semanas"].map(u => (
                  <button key={u} onClick={() => setSched(s => ({ ...s, cooldownUnit: u }))} style={{ padding: "7px 14px", borderRadius: 8, border: `0.5px solid ${sched.cooldownUnit === u ? PRIMARY : "var(--color-border-tertiary)"}`, background: sched.cooldownUnit === u ? PRIMARY_LIGHT : "transparent", color: sched.cooldownUnit === u ? PRIMARY_DARK : "var(--color-text-secondary)", fontSize: 13, cursor: "pointer", fontWeight: sched.cooldownUnit === u ? 500 : 400 }}>{u}</button>
                ))}
              </div>
            </div>
            <div style={{ marginTop: 10, fontSize: 12, color: "var(--color-text-secondary)" }}>Produto enviado hoje só poderá ser reenviado após {sched.cooldownValue} {sched.cooldownUnit}.</div>
          </div>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button
              onClick={save}
              disabled={!manageDirty && !saved}
              title={manageDirty ? "Salvar alterações" : "Sem alterações pra salvar"}
              style={saveBtnStyle(manageDirty)}
            >
              {saved ? "✓ Salvo!" : "Salvar alterações"}
            </button>
            <button onClick={() => setShowDelete(true)} style={{ padding: "9px 18px", borderRadius: 8, border: "0.5px solid #F7C1C1", background: "#FCEBEB", color: "#A32D2D", fontSize: 13, cursor: "pointer", fontWeight: 500, marginLeft: "auto" }}>Excluir campanha</button>
          </div>

          {showDelete && (
            <Modal title="Excluir grupo?" onClose={() => setShowDelete(false)} danger>
              <p style={{ fontSize: 13, marginBottom: 16, color: "var(--color-text-secondary)", lineHeight: 1.5 }}>
                Isso removerá permanentemente <strong style={{ color: "var(--color-text-primary)" }}>{groupInfo.name}</strong>, seus agendamentos, fila e histórico. Esta ação não pode ser desfeita.
              </p>
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button onClick={() => setShowDelete(false)} style={{ padding: "8px 16px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 13, cursor: "pointer" }}>Cancelar</button>
                <button onClick={() => { onDelete(group.id); setShowDelete(false); }} style={{ padding: "8px 16px", borderRadius: 8, background: "#E24B4A", color: "#fff", border: "none", fontSize: 13, cursor: "pointer", fontWeight: 500 }}>Sim, excluir</button>
              </div>
            </Modal>
          )}

        </div>
      )}

      {tab === "messages" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: 16 }}>
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontWeight: 500, marginBottom: 4 }}>Modelo de mensagem</div>
              <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
                Escolha um modelo na lista, edite à esquerda — a prévia atualiza enquanto você digita. Use <strong>+ Novo modelo</strong> para criar outro.
              </div>
            </div>

            {/* Lista suspensa — modelos prontos + meus modelos + ações */}
            <div style={{ display: "flex", alignItems: "flex-end", gap: 10, flexWrap: "wrap", borderBottom: "0.5px solid var(--color-border-tertiary)", paddingBottom: 14, marginBottom: 14 }}>
              <div style={{ flex: "1 1 260px", minWidth: 200 }}>
                <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Modelo</label>
                <select
                  value={activeTplKey}
                  onChange={e => {
                    const t = allTabs.find(x => x.key === e.target.value);
                    if (t) handleTabClick(t);
                  }}
                  style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", color: "var(--color-text-primary)", fontSize: 13 }}
                >
                  {allTabs.map(t => {
                    const isModelActive = isTemplateActive(t.template);
                    const dirtyMark = t.key === activeTplKey && isDirty ? "• " : "";
                    const suffix = isModelActive
                      ? " — em uso"
                      : (t.kind === "preset" ? " (modelo pronto)" : "");
                    return (
                      <option key={t.key} value={t.key}>
                        {dirtyMark}{t.name}{suffix}
                      </option>
                    );
                  })}
                </select>
              </div>
              <button
                onClick={handleNewTab}
                title="Criar novo modelo (a partir do conteúdo atual)"
                style={{
                  height: 36, padding: "0 16px", borderRadius: 8,
                  border: "0.5px solid var(--color-border-secondary)",
                  background: "transparent",
                  color: PRIMARY_DARK,
                  fontSize: 13, fontWeight: 500,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
              >+ Novo modelo</button>
              {isCustomTab && activeTab && (
                <button
                  onClick={() => setConfirmDeleteTpl(activeTab)}
                  title="Excluir este modelo"
                  style={{
                    height: 36, padding: "0 16px", borderRadius: 8,
                    border: "0.5px solid var(--color-border-secondary)",
                    background: "transparent",
                    color: "var(--color-text-secondary)",
                    fontSize: 13, fontWeight: 500,
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                  }}
                >Excluir modelo</button>
              )}
            </div>

            {/* Linha do nome do modelo (só editável em customs) + botão "Salvar alterações" */}
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12, alignItems: "flex-end" }}>
              <div style={{ flex: "1 1 240px", minWidth: 180 }}>
                <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Nome do modelo</label>
                {isCustomTab ? (
                  <input
                    value={customNameDraft}
                    onChange={e => setCustomNameDraft(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") openSaveTplDialog(); }}
                    placeholder="Ex: Eletrônicos com urgência"
                    style={{ width: "100%", height: 36, padding: "0 10px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", color: "var(--color-text-primary)", fontSize: 13, boxSizing: "border-box" }}
                  />
                ) : (
                  <div
                    title="O modelo padrão é inalterável — ao salvar suas edições você cria um novo modelo customizado"
                    style={{ width: "100%", height: 36, padding: "0 10px", borderRadius: 8, border: "0.5px dashed var(--color-border-tertiary)", background: "transparent", color: "var(--color-text-secondary)", fontSize: 13, boxSizing: "border-box", display: "flex", alignItems: "center", fontStyle: "italic" }}
                  >
                    {activeTab ? `${activeTab.name} · modelo padrão (inalterável)` : "—"}
                  </div>
                )}
              </div>
              <button
                onClick={activateActiveTab}
                disabled={!activeTab || activeTabIsActive}
                title={activeTabIsActive
                  ? "Este modelo já está em uso pela campanha"
                  : "Passar a usar este modelo nos envios desta campanha"}
                style={{
                  height: 36, padding: "0 16px", borderRadius: 8,
                  border: `0.5px solid ${activeTabIsActive ? PRIMARY : "var(--color-border-secondary)"}`,
                  background: activeTabIsActive ? PRIMARY_LIGHT : "transparent",
                  color: activeTabIsActive ? PRIMARY_DARK : "var(--color-text-primary)",
                  fontSize: 13, fontWeight: 500,
                  cursor: activeTabIsActive ? "default" : "pointer",
                  opacity: !activeTab ? 0.55 : 1,
                  display: "inline-flex", alignItems: "center", gap: 6,
                }}
              >
                {activeTabIsActive
                  ? <><span style={{ width: 8, height: 8, borderRadius: "50%", background: PRIMARY }} /> Ativo na campanha</>
                  : "Ativar este modelo"}
              </button>
              <button
                onClick={duplicateActiveTemplate}
                disabled={!activeTab}
                title="Cria um novo modelo customizado usando o conteúdo salvo deste como ponto de partida"
                style={{
                  height: 36, padding: "0 16px", borderRadius: 8,
                  border: "0.5px solid var(--color-border-secondary)",
                  background: "transparent",
                  color: "var(--color-text-primary)",
                  fontSize: 13, fontWeight: 500,
                  cursor: activeTab ? "pointer" : "not-allowed",
                  opacity: activeTab ? 1 : 0.55,
                }}
              >
                ⎘ Criar a partir deste
              </button>
              <button
                onClick={openSaveTplDialog}
                disabled={!isDirty}
                title={!isDirty
                  ? "Sem alterações pra salvar"
                  : (isCustomTab ? "Salvar alterações neste modelo (ou como novo)" : "Salvar como novo modelo a partir das edições")}
                style={{
                  height: 36, padding: "0 18px", borderRadius: 8,
                  border: "none",
                  background: isDirty ? PRIMARY : "var(--color-background-secondary)",
                  color: isDirty ? "#fff" : "var(--color-text-secondary)",
                  fontSize: 13, fontWeight: 500,
                  cursor: isDirty ? "pointer" : "not-allowed",
                  opacity: isDirty ? 1 : 0.55,
                }}
              >
                Salvar alterações
              </button>
            </div>

            {/* Toolbar: formatação + variáveis */}
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 6, alignItems: "center" }}>
              <span style={{ fontSize: 11, color: "var(--color-text-secondary)", marginRight: 4 }}>Formatar:</span>
              {FORMAT_BUTTONS.map(b => (
                <button
                  key={b.token}
                  onClick={() => wrapSelectionWith(b.token)}
                  title={b.title}
                  style={{ minWidth: 30, padding: "4px 10px", borderRadius: 6, border: "0.5px solid var(--color-border-secondary)", background: "var(--color-background-secondary)", color: "var(--color-text-primary)", fontSize: 12, cursor: "pointer", ...b.style }}
                >
                  {b.label}
                </button>
              ))}
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10, alignItems: "center" }}>
              <span style={{ fontSize: 11, color: "var(--color-text-secondary)", marginRight: 4 }}>Inserir:</span>
              {TEMPLATE_VARS.map(v => (
                <button
                  key={v.token}
                  onClick={() => insertTemplateVar(v.token)}
                  title={`Inserir ${v.desc}`}
                  style={{ padding: "4px 10px", borderRadius: 6, border: `0.5px solid ${PRIMARY}`, background: PRIMARY_LIGHT, color: PRIMARY_DARK, fontSize: 11, fontFamily: "monospace", cursor: "pointer", fontWeight: 500 }}
                >
                  {v.token}
                </button>
              ))}
            </div>

            {/* Editor + Preview lado a lado */}
            <div className="grid-collapse" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div>
                <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 4 }}>Editor</div>
                <textarea
                  ref={templateRef}
                  value={groupInfo.messageTemplate}
                  onChange={e => setGroupInfo(g => ({ ...g, messageTemplate: e.target.value }))}
                  style={{ width: "100%", padding: 10, borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13, resize: "vertical", minHeight: 260, boxSizing: "border-box", fontFamily: "inherit", lineHeight: 1.5 }}
                  placeholder={DEFAULT_MESSAGE_TEMPLATE}
                />
              </div>
              <div>
                <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 4 }}>Prévia (como aparece no WhatsApp)</div>
                <div className="wa-preview" style={{ width: "100%", minHeight: 260, padding: 12, borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", fontSize: 13, whiteSpace: "pre-wrap", lineHeight: 1.5, fontFamily: "inherit", boxSizing: "border-box" }}>
                  {groupInfo.messageTemplate
                    ? renderWhatsappFormatted(renderTemplate(groupInfo.messageTemplate))
                    : <span style={{ opacity: 0.6, fontStyle: "italic" }}>Modelo vazio. Comece a digitar à esquerda.</span>}
                </div>
                <div style={{ fontSize: 10, color: "var(--color-text-secondary)", marginTop: 6 }}>
                  Pré-visualização usa dados de exemplo. As variáveis são substituídas pelos dados reais no envio.
                </div>
              </div>
            </div>
          </div>

          {saveTplDialog && (
            <Modal title="Salvar alterações" onClose={closeSaveTplDialog}>
              <p style={{ fontSize: 13, marginBottom: 14, color: "var(--color-text-secondary)", lineHeight: 1.5 }}>
                {saveTplDialog.mode === "preset"
                  ? <>O modelo <strong style={{ color: "var(--color-text-primary)" }}>{activeTab?.name}</strong> é o padrão e não pode ser sobrescrito. Suas edições serão salvas como um <strong style={{ color: "var(--color-text-primary)" }}>novo modelo</strong>.</>
                  : <>Você editou o modelo <strong style={{ color: "var(--color-text-primary)" }}>{activeTab?.name}</strong>. Quer salvar como um novo modelo ou substituir o atual?</>}
              </p>
              <div style={{ marginBottom: 14 }}>
                <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Nome do novo modelo</label>
                <input
                  autoFocus
                  value={saveTplName}
                  onChange={e => setSaveTplName(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter") saveAsNewTemplate(); }}
                  placeholder="Ex: Padrão (minha versão)"
                  style={{ width: "100%", padding: "9px 12px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", color: "var(--color-text-primary)", fontSize: 13, boxSizing: "border-box" }}
                />
              </div>
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
                <button onClick={closeSaveTplDialog} style={{ padding: "8px 16px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 13, cursor: "pointer" }}>Cancelar</button>
                {saveTplDialog.mode === "custom" && (
                  <button
                    onClick={replaceCurrentCustom}
                    style={{ padding: "8px 16px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", color: "var(--color-text-primary)", fontSize: 13, cursor: "pointer", fontWeight: 500 }}
                  >
                    Substituir este modelo
                  </button>
                )}
                <button
                  onClick={saveAsNewTemplate}
                  disabled={!saveTplName.trim()}
                  style={{ padding: "8px 16px", borderRadius: 8, background: saveTplName.trim() ? PRIMARY : "var(--color-background-secondary)", color: saveTplName.trim() ? "#fff" : "var(--color-text-secondary)", border: "none", fontSize: 13, cursor: saveTplName.trim() ? "pointer" : "not-allowed", fontWeight: 500, opacity: saveTplName.trim() ? 1 : 0.55 }}
                >
                  Salvar como novo
                </button>
              </div>
            </Modal>
          )}

          {confirmDeleteTpl && (
            <Modal title="Excluir modelo?" onClose={() => setConfirmDeleteTpl(null)} danger>
              <p style={{ fontSize: 13, marginBottom: 16, color: "var(--color-text-secondary)", lineHeight: 1.5 }}>
                <strong style={{ color: "var(--color-text-primary)" }}>{confirmDeleteTpl.name}</strong> será removido da sua lista. Campanhas que estão usando esse modelo continuam com o texto que já tinham — só some da lista.
              </p>
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button onClick={() => setConfirmDeleteTpl(null)} style={{ padding: "8px 16px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 13, cursor: "pointer" }}>Cancelar</button>
                <button
                  onClick={() => { onConfirmedDeleteCustom(confirmDeleteTpl.id); setConfirmDeleteTpl(null); }}
                  style={{ padding: "8px 16px", borderRadius: 8, background: "#E24B4A", color: "#fff", border: "none", fontSize: 13, cursor: "pointer", fontWeight: 500 }}
                >
                  Sim, excluir
                </button>
              </div>
            </Modal>
          )}
        </div>
      )}

      {tab === "whatsapp" && (() => {
        return (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 500 }}>Grupos do WhatsApp</div>
              <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 2 }}>
                Esta campanha envia para os grupos abaixo. Cada grupo recebe a mesma fila de produtos.
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                onClick={() => setAddStep("choose")}
                disabled={numbers.length === 0}
                title={numbers.length === 0 ? "Conecte um número de WhatsApp primeiro" : "Adicionar grupo a esta campanha"}
                style={{ padding: "7px 12px", borderRadius: 8, background: numbers.length === 0 ? "var(--color-border-secondary)" : PRIMARY, color: "#fff", border: "none", fontSize: 13, cursor: numbers.length === 0 ? "not-allowed" : "pointer", fontWeight: 500 }}
              >+ Adicionar grupo</button>
            </div>
          </div>

          {linkedWGs.length === 0 ? (
            <div style={{ textAlign: "center", padding: "40px 20px", color: "var(--color-text-secondary)", fontSize: 13, background: "var(--color-background-secondary)", borderRadius: 12 }}>
              <div style={{ fontSize: 28, marginBottom: 10 }}>💬</div>
              <div style={{ fontWeight: 500, color: "var(--color-text-primary)", marginBottom: 6 }}>Nenhum grupo do WhatsApp vinculado</div>
              <div style={{ fontSize: 12, marginBottom: 14 }}>Crie um novo grupo ou vincule um existente para começar a enviar mensagens.</div>
              {numbers.length === 0
                ? <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>Conecte um número do WhatsApp na aba <strong>WhatsApp</strong> do menu para adicionar grupos.</div>
                : <button onClick={() => setAddStep("choose")} style={{ padding: "8px 18px", borderRadius: 8, background: PRIMARY, color: "#fff", border: "none", fontSize: 13, cursor: "pointer", fontWeight: 500 }}>+ Adicionar primeiro grupo</button>
              }
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {linkedWGs.map(w => {
                const number = numbers.find(n => n.id === w.numberId);
                const numberConnected = number?.status === "connected";
                const connected = w.status === "connected" && numberConnected;
                return (
                  <div key={w.id} style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: 16 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12, gap: 12, flexWrap: "wrap" }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
                          <span style={{ width: 9, height: 9, borderRadius: "50%", background: connected ? PRIMARY : "#E24B4A", flexShrink: 0 }} />
                          <span style={{ fontSize: 14, fontWeight: 500 }}>{w.name}</span>
                          <Badge color={connected ? "green" : "red"}>{connected ? "Conectado" : "Desconectado"}</Badge>
                        </div>
                        <div
                          style={{
                            display: "grid",
                            gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
                            gap: 10,
                            background: "var(--color-background-secondary)",
                            border: "0.5px solid var(--color-border-tertiary)",
                            borderRadius: 10,
                            padding: "10px 12px",
                          }}
                        >
                          <div>
                            <div style={{ fontSize: 10, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 2 }}>Membros</div>
                            <div style={{ fontSize: 13, fontWeight: 500, color: "var(--color-text-primary)" }}>{w.members ?? 0}</div>
                          </div>
                          <div>
                            <div style={{ fontSize: 10, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 2 }}>Número WhatsApp</div>
                            <div style={{ fontSize: 13, fontWeight: 500, color: "var(--color-text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={number ? `${number.label} · ${number.phone || ""}` : "número removido"}>
                              {number ? number.label : <span style={{ color: "#A32D2D", fontStyle: "italic" }}>removido</span>}
                            </div>
                            {number?.phone && <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 1 }}>{number.phone}</div>}
                          </div>
                          <div>
                            <div style={{ fontSize: 10, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 2 }}>Adicionado</div>
                            <div style={{ fontSize: 13, fontWeight: 500, color: "var(--color-text-primary)" }}>{w.createdAt || "—"}</div>
                          </div>
                          <div>
                            <div style={{ fontSize: 10, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 2 }}>Envios hoje</div>
                            <div style={{ fontSize: 13, fontWeight: 500, color: "var(--color-text-primary)" }}>{w.sentToday ?? 0}</div>
                          </div>
                          <div>
                            <div style={{ fontSize: 10, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 2 }}>Último envio</div>
                            <div style={{ fontSize: 13, fontWeight: 500, color: "var(--color-text-primary)" }}>{w.lastSend && w.lastSend !== "—" ? w.lastSend : <span style={{ color: "var(--color-text-secondary)", fontWeight: 400 }}>nenhum</span>}</div>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Descrição (nota local — não sincroniza com WhatsApp) */}
                    <div style={{ marginTop: 12, marginBottom: 12 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                        <div style={{ fontSize: 10, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 500 }}>Descrição</div>
                        {editingDescId !== w.id && (
                          <button onClick={() => startEditDesc(w)} title="Editar descrição" style={{ background: "transparent", border: "none", padding: 0, color: PRIMARY_DARK, fontSize: 11, cursor: "pointer", fontWeight: 500 }}>
                            ✎ {w.description ? "editar" : "adicionar"}
                          </button>
                        )}
                      </div>
                      {editingDescId === w.id ? (
                        <>
                          <textarea
                            autoFocus
                            value={descDraft}
                            onChange={e => setDescDraft(e.target.value)}
                            rows={2}
                            placeholder="Notas internas sobre este grupo (visível só no Nimbus)"
                            style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: `0.5px solid ${PRIMARY}`, background: "var(--color-background-secondary)", fontSize: 13, resize: "vertical", boxSizing: "border-box", fontFamily: "inherit" }}
                          />
                          <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                            <button onClick={() => saveDesc(w)} style={{ padding: "5px 12px", borderRadius: 7, background: PRIMARY, color: "#fff", border: "none", fontSize: 12, cursor: "pointer", fontWeight: 500 }}>Salvar</button>
                            <button onClick={cancelEditDesc} style={{ padding: "5px 12px", borderRadius: 7, background: "transparent", color: "var(--color-text-primary)", border: "0.5px solid var(--color-border-secondary)", fontSize: 12, cursor: "pointer" }}>Cancelar</button>
                          </div>
                        </>
                      ) : (
                        <div style={{ fontSize: 13, color: w.description ? "var(--color-text-primary)" : "var(--color-text-secondary)", fontStyle: w.description ? "normal" : "italic", whiteSpace: "pre-wrap", lineHeight: 1.4 }}>
                          {w.description || "—"}
                        </div>
                      )}
                    </div>

                    {w.inviteLink && (
                      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderRadius: 8, background: "var(--color-background-secondary)", border: "0.5px solid var(--color-border-tertiary)", marginBottom: 12 }}>
                        <span style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>🔗</span>
                        <input
                          readOnly
                          value={w.inviteLink}
                          onFocus={e => e.target.select()}
                          style={{ flex: 1, minWidth: 0, padding: 0, border: "none", background: "transparent", fontSize: 12, color: "var(--color-text-primary)", fontFamily: "monospace", outline: "none" }}
                        />
                        <button
                          onClick={() => copyInvite(w)}
                          style={{ padding: "4px 12px", borderRadius: 6, border: `0.5px solid ${copiedId === w.id ? PRIMARY : "var(--color-border-secondary)"}`, background: copiedId === w.id ? PRIMARY_LIGHT : "transparent", color: copiedId === w.id ? PRIMARY_DARK : "var(--color-text-primary)", fontSize: 12, cursor: "pointer", fontWeight: 500, flexShrink: 0 }}
                        >
                          {copiedId === w.id ? "✓ Copiado" : "Copiar"}
                        </button>
                        <a
                          href={w.inviteLink}
                          target="_blank"
                          rel="noreferrer"
                          style={{ padding: "4px 12px", borderRadius: 6, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 12, color: "var(--color-text-primary)", textDecoration: "none", flexShrink: 0 }}
                        >
                          Abrir
                        </a>
                      </div>
                    )}

                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {w.inviteLink && <button onClick={() => refreshInvite(w)} style={{ padding: "6px 12px", borderRadius: 7, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 12, cursor: "pointer" }}>Renovar link</button>}
                      <button
                        onClick={() => cloneGroup(w)}
                        disabled={numbers.length === 0}
                        title={numbers.length === 0 ? "Conecte um número de WhatsApp primeiro" : `Criar um novo grupo "${computeCloneName(w.name)}" com a mesma configuração`}
                        style={{ padding: "6px 12px", borderRadius: 7, border: "0.5px solid var(--color-border-secondary)", background: "transparent", color: "var(--color-text-primary)", fontSize: 12, cursor: numbers.length === 0 ? "not-allowed" : "pointer", opacity: numbers.length === 0 ? 0.5 : 1 }}
                      >
                        ⎘ Criar cópia
                      </button>
                      <div style={{ flex: 1 }} />
                      <button onClick={() => unlinkWG(w.id)} style={{ padding: "6px 12px", borderRadius: 7, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 12, cursor: "pointer" }}>Desvincular</button>
                      <button onClick={() => setConfirmDeleteWG(w)} style={{ padding: "6px 12px", borderRadius: 7, border: "0.5px solid #F7C1C1", background: "#FCEBEB", color: "#A32D2D", fontSize: 12, cursor: "pointer" }}>Excluir</button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {addStep === "choose" && (
            <Modal title="Adicionar grupo" onClose={closeAddModal}>
              <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 14 }}>
                Como você quer adicionar um grupo a esta campanha?
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <button
                  onClick={() => setAddStep("create")}
                  disabled={numbers.length === 0}
                  style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "14px 16px", borderRadius: 10, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", cursor: numbers.length === 0 ? "not-allowed" : "pointer", textAlign: "left", opacity: numbers.length === 0 ? 0.5 : 1 }}
                >
                  <span style={{ fontSize: 22 }}>➕</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 2 }}>Criar grupo novo</div>
                    <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
                      Cria um grupo novo no WhatsApp e já vincula a esta campanha.
                    </div>
                  </div>
                </button>
                <button
                  onClick={() => setAddStep("existing")}
                  disabled={numbers.length === 0}
                  style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "14px 16px", borderRadius: 10, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", cursor: numbers.length === 0 ? "not-allowed" : "pointer", textAlign: "left", opacity: numbers.length === 0 ? 0.5 : 1 }}
                >
                  <span style={{ fontSize: 22 }}>🔗</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 2 }}>Adicionar grupo existente</div>
                    <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
                      Escolha um número e selecione um dos grupos do WhatsApp dele.
                    </div>
                  </div>
                </button>
              </div>
              {numbers.length === 0 && (
                <div style={{ fontSize: 11, color: "#854F0B", marginTop: 12, padding: "8px 10px", background: "#FEF3C7", borderRadius: 8 }}>
                  Conecte um número de WhatsApp na aba <strong>WhatsApp</strong> antes de adicionar grupos.
                </div>
              )}
            </Modal>
          )}

          {addStep === "existing" && (() => {
            const cadastradosByJid = new Map(whatsappGroups.map(w => [w.id, w]));
            const linkedSet = new Set(groupInfo.whatsappGroupIds);
            const connectedNumbers = numbers.filter(n => n.status === "connected");
            const selectedNum = numbers.find(n => n.id === addExistingNumberId);
            const rawList = addExistingNumberId ? (waGroupsByNumber[addExistingNumberId] || []) : [];
            const q = addExistingSearch.trim().toLowerCase();
            const filtered = rawList
              .filter(g => !q || (g.name || "").toLowerCase().includes(q))
              .map(g => {
                const existing = cadastradosByJid.get(g.jid);
                return {
                  ...g,
                  alreadyInNimbus: !!existing,
                  alreadyLinked: existing ? linkedSet.has(existing.id) : false,
                  nimbusId: existing?.id || null,
                };
              });
            return (
              <Modal title="Adicionar grupo existente" onClose={closeAddModal}>
                {!addExistingNumberId ? (
                  <>
                    <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 12 }}>
                      Selecione o número de WhatsApp pra listar os grupos dele.
                    </div>
                    {connectedNumbers.length === 0 ? (
                      <div style={{ fontSize: 12, color: "#854F0B", padding: "10px 12px", background: "#FEF3C7", borderRadius: 8 }}>
                        Nenhum número conectado. Conecte um número primeiro.
                      </div>
                    ) : (
                      <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 320, overflowY: "auto" }}>
                        {connectedNumbers.map(n => (
                          <button
                            key={n.id}
                            onClick={() => loadGroupsForNumber(n.id)}
                            style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: 10, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", cursor: "pointer", textAlign: "left" }}
                          >
                            <span style={{ width: 8, height: 8, borderRadius: "50%", background: PRIMARY, flexShrink: 0 }} />
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: 13, fontWeight: 500 }}>{n.label}</div>
                              <div style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>{n.phone}</div>
                            </div>
                            <span style={{ fontSize: 11, color: PRIMARY_DARK, fontWeight: 500 }}>Listar grupos →</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, fontSize: 12, color: "var(--color-text-secondary)" }}>
                      <button onClick={() => { setAddExistingNumberId(null); setAddExistingSearch(""); setWaGroupsError(null); }} style={{ padding: "4px 10px", borderRadius: 7, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 12, cursor: "pointer" }}>← Trocar número</button>
                      <span>📱 {selectedNum?.label} <span style={{ color: "var(--color-text-secondary)" }}>· {selectedNum?.phone}</span></span>
                    </div>
                    <input
                      autoFocus
                      value={addExistingSearch}
                      onChange={e => setAddExistingSearch(e.target.value)}
                      placeholder="Buscar grupo pelo nome..."
                      style={{ width: "100%", padding: "9px 12px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13, boxSizing: "border-box", marginBottom: 10 }}
                    />
                    {loadingWAGroups ? (
                      <div style={{ fontSize: 12, color: "var(--color-text-secondary)", padding: "20px 0", textAlign: "center" }}>⟳ Carregando grupos do WhatsApp...</div>
                    ) : waGroupsError ? (
                      <div style={{ fontSize: 12, color: "#A32D2D", padding: "10px 12px", background: "#FCEBEB", borderRadius: 8 }}>{waGroupsError}</div>
                    ) : rawList.length === 0 ? (
                      <div style={{ fontSize: 12, color: "var(--color-text-secondary)", padding: "20px 0", textAlign: "center", fontStyle: "italic" }}>Nenhum grupo encontrado neste número.</div>
                    ) : filtered.length === 0 ? (
                      <div style={{ fontSize: 12, color: "var(--color-text-secondary)", padding: "20px 0", textAlign: "center", fontStyle: "italic" }}>Nenhum grupo bate com "{addExistingSearch}".</div>
                    ) : (
                      <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 360, overflowY: "auto" }}>
                        {filtered.map(g => {
                          const importing = importingJid === g.jid;
                          const onClick = g.alreadyLinked ? null
                            : g.alreadyInNimbus ? () => linkAndClose(g.nimbusId)
                            : () => importAndLink(addExistingNumberId, g);
                          const actionLabel = g.alreadyLinked ? "✓ Já nesta campanha"
                            : importing ? "⟳ Adicionando..."
                            : g.alreadyInNimbus ? "+ Vincular"
                            : "+ Adicionar";
                          return (
                            <div
                              key={g.jid}
                              onClick={onClick || undefined}
                              style={{
                                display: "flex", alignItems: "center", gap: 10,
                                padding: "10px 12px", borderRadius: 10,
                                border: "0.5px solid var(--color-border-tertiary)",
                                background: g.alreadyLinked ? "var(--color-background-primary)" : "var(--color-background-secondary)",
                                cursor: !onClick || importing ? "default" : "pointer",
                                opacity: g.alreadyLinked ? 0.5 : (importing ? 0.6 : 1),
                              }}
                            >
                              <span style={{ fontSize: 16 }}>👥</span>
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontSize: 13, fontWeight: 500 }}>{g.name || "(sem nome)"}</div>
                                <div style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>
                                  {g.members} membro{g.members !== 1 ? "s" : ""}
                                  {g.alreadyInNimbus && !g.alreadyLinked && " · já cadastrado no Nimbus"}
                                </div>
                              </div>
                              <span style={{ fontSize: 11, color: g.alreadyLinked ? "var(--color-text-secondary)" : PRIMARY_DARK, fontWeight: 500 }}>
                                {actionLabel}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </>
                )}
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
                  <button onClick={closeAddModal} style={{ padding: "8px 16px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 13, cursor: "pointer" }}>Fechar</button>
                </div>
              </Modal>
            );
          })()}

          {addStep === "create" && (
            <Modal title="Criar grupo no WhatsApp" onClose={closeAddModal}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                <button onClick={() => setAddStep("choose")} style={{ padding: "4px 10px", borderRadius: 7, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 12, cursor: "pointer" }}>← Voltar</button>
              </div>
              <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 14, lineHeight: 1.5 }}>
                Um novo grupo será criado <strong>de fato no WhatsApp</strong> e vinculado a esta campanha. O WhatsApp exige pelo menos um participante além de você.
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div>
                  <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Nome do grupo</label>
                  <input value={newWGForm.name} onChange={e => setNewWGForm(f => ({ ...f, name: e.target.value }))} placeholder={`Ex: ${group.name} — Regional`} style={{ width: "100%", padding: "9px 12px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13, boxSizing: "border-box" }} />
                </div>
                <div>
                  <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 6 }}>
                    Números que vão criar <span style={{ color: "var(--color-text-tertiary, var(--color-text-secondary))" }}>(selecione um ou mais — cria 1 grupo por número)</span>
                  </label>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 180, overflowY: "auto", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 8, padding: 8, background: "var(--color-background-secondary)" }}>
                    {numbers.map(n => {
                      const checked = (newWGForm.numberIds || []).includes(n.id);
                      const connected = n.status === "connected";
                      return (
                        <label key={n.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: 6, cursor: connected ? "pointer" : "not-allowed", opacity: connected ? 1 : 0.5, background: checked ? PRIMARY_LIGHT : "transparent" }}>
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={!connected}
                            onChange={() => setNewWGForm(f => {
                              const cur = new Set(f.numberIds || []);
                              cur.has(n.id) ? cur.delete(n.id) : cur.add(n.id);
                              return { ...f, numberIds: [...cur] };
                            })}
                            style={{ width: 15, height: 15, cursor: connected ? "pointer" : "not-allowed" }}
                          />
                          <span style={{ width: 7, height: 7, borderRadius: "50%", background: connected ? PRIMARY : "#E24B4A", flexShrink: 0 }} />
                          <span style={{ fontSize: 13, fontWeight: checked ? 500 : 400 }}>{n.label}</span>
                          <span style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>{n.phone}</span>
                          {!connected && <span style={{ fontSize: 11, color: "#A32D2D", marginLeft: "auto" }}>desconectado</span>}
                        </label>
                      );
                    })}
                  </div>
                  {(newWGForm.numberIds || []).length > 1 && (
                    <div style={{ fontSize: 11, color: PRIMARY_DARK, marginTop: 6 }}>
                      💡 Serão criados {newWGForm.numberIds.length} grupos (sufixo com o apelido de cada número).
                    </div>
                  )}
                </div>
                {nimbusAvail.connected && (
                  <label style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "10px 12px", borderRadius: 8, border: `0.5px solid ${newWGForm.includeNimbus ? PRIMARY : "var(--color-border-tertiary)"}`, background: newWGForm.includeNimbus ? PRIMARY_LIGHT : "var(--color-background-secondary)", cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={!!newWGForm.includeNimbus}
                      onChange={e => setNewWGForm(f => ({ ...f, includeNimbus: e.target.checked }))}
                      style={{ marginTop: 2, cursor: "pointer" }}
                    />
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 500 }}>Usar o WhatsNimbus como participante</div>
                      <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 2 }}>
                        O número do sistema{nimbusAvail.phone ? ` (+${nimbusAvail.phone})` : ""} entra no grupo, dispensando um número extra seu.
                      </div>
                    </div>
                  </label>
                )}
                <div>
                  <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>
                    Participantes iniciais{newWGForm.includeNimbus ? " (opcional)" : ""}
                  </label>
                  <textarea
                    value={newWGForm.participants}
                    onChange={e => setNewWGForm(f => ({ ...f, participants: e.target.value }))}
                    rows={3}
                    placeholder="+5511999998888&#10;+5521988887777"
                    style={{ width: "100%", padding: "9px 12px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13, boxSizing: "border-box", resize: "vertical", fontFamily: "inherit" }}
                  />
                  <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 4 }}>
                    Um por linha (ou separados por vírgula). Inclua o código do país (+55).
                  </div>
                </div>
                {createWGError && (
                  <div style={{ background: "#FCEBEB", color: "#A32D2D", padding: "8px 10px", borderRadius: 8, fontSize: 12 }}>{createWGError}</div>
                )}
              </div>
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 18 }}>
                <button onClick={closeAddModal} disabled={creatingWG} style={{ padding: "8px 16px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 13, cursor: "pointer" }}>Cancelar</button>
                <button onClick={submitCreateWG} disabled={!newWGForm.name.trim() || (newWGForm.numberIds || []).length === 0 || creatingWG} style={{ padding: "8px 16px", borderRadius: 8, background: PRIMARY, color: "#fff", border: "none", fontSize: 13, cursor: "pointer", fontWeight: 500, opacity: (!newWGForm.name.trim() || (newWGForm.numberIds || []).length === 0 || creatingWG) ? 0.5 : 1 }}>
                  {creatingWG ? "⟳ Criando..." : (newWGForm.numberIds || []).length > 1 ? `Criar e vincular (${newWGForm.numberIds.length})` : "Criar e vincular"}
                </button>
              </div>
            </Modal>
          )}

          {confirmDeleteWG && (
            <Modal title="Excluir grupo do WhatsApp?" onClose={() => setConfirmDeleteWG(null)} danger>
              <p style={{ fontSize: 13, marginBottom: 16, color: "var(--color-text-secondary)", lineHeight: 1.5 }}>
                <strong style={{ color: "var(--color-text-primary)" }}>{confirmDeleteWG.name}</strong> será removido permanentemente e desvinculado de todas as campanhas. Os envios pendentes para este grupo serão cancelados.
              </p>
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button onClick={() => setConfirmDeleteWG(null)} style={{ padding: "8px 16px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 13, cursor: "pointer" }}>Cancelar</button>
                <button onClick={() => handleDeleteWG(confirmDeleteWG)} style={{ padding: "8px 16px", borderRadius: 8, background: "#E24B4A", color: "#fff", border: "none", fontSize: 13, cursor: "pointer", fontWeight: 500 }}>Excluir permanentemente</button>
              </div>
            </Modal>
          )}
        </div>
        );
      })()}

      {tab === "products" && (
        <div>
          {isRepasse ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 14, marginBottom: 20 }}>
              <div style={{ background: PRIMARY_LIGHT, color: PRIMARY_DARK, padding: "10px 14px", borderRadius: 10, fontSize: 12, lineHeight: 1.5 }}>
                🔁 Esta é uma campanha de <strong>repasse</strong>. O sistema escuta o grupo líder abaixo e captura os links de produto (Mercado Livre, Shopee e Amazon) postados nele, re-afiliando com a sua TAG. A busca no catálogo fica desabilitada.
              </div>

              {/* Grupo líder */}
              <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: 16 }}>
                <div style={{ fontWeight: 500, marginBottom: 4 }}>Grupo líder</div>
                <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 12 }}>
                  O grupo de onde os links serão capturados. Só um grupo pode ser líder.
                </div>
                {scraping.repasse?.leaderJid ? (
                  <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: 8, background: "var(--color-background-secondary)", border: `0.5px solid ${PRIMARY}` }}>
                    <span style={{ fontSize: 18 }}>👑</span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 500 }}>{scraping.repasse.leaderName || scraping.repasse.leaderJid}</div>
                      <div style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>
                        {(numbers.find(n => n.id === scraping.repasse.leaderNumberId)?.label) || `Número ${scraping.repasse.leaderNumberId}`}
                      </div>
                    </div>
                    <button onClick={() => setScraping(s => ({ ...s, repasse: { leaderNumberId: null, leaderJid: null, leaderName: null } }))} style={{ padding: "5px 12px", borderRadius: 7, border: "0.5px solid var(--color-border-secondary)", background: "transparent", color: "var(--color-text-primary)", fontSize: 12, cursor: "pointer" }}>Trocar</button>
                  </div>
                ) : numbers.length === 0 ? (
                  <div style={{ fontSize: 12, color: "#854F0B", background: "#FEF3C7", border: "0.5px solid #F4D08A", padding: "10px 12px", borderRadius: 8 }}>
                    Nenhum número de WhatsApp conectado. Conecte um número na página WhatsApp para escolher o grupo líder.
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      {numbers.map(n => (
                        <button
                          key={n.id}
                          onClick={() => loadGroupsForNumber(n.id)}
                          style={{ padding: "6px 12px", borderRadius: 8, border: `0.5px solid ${addExistingNumberId === n.id ? PRIMARY : "var(--color-border-tertiary)"}`, background: addExistingNumberId === n.id ? PRIMARY_LIGHT : "transparent", color: addExistingNumberId === n.id ? PRIMARY_DARK : "var(--color-text-primary)", fontSize: 12, cursor: "pointer", fontWeight: addExistingNumberId === n.id ? 500 : 400 }}
                        >
                          {n.label || n.phone || n.id}
                        </button>
                      ))}
                    </div>
                    {loadingWAGroups && <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>Carregando grupos…</div>}
                    {waGroupsError && <div style={{ fontSize: 12, color: "#A32D2D" }}>{waGroupsError}</div>}
                    {addExistingNumberId && !loadingWAGroups && (
                      <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 260, overflowY: "auto" }}>
                        {(waGroupsByNumber[addExistingNumberId] || []).length === 0 ? (
                          <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>Nenhum grupo encontrado neste número.</div>
                        ) : (
                          (waGroupsByNumber[addExistingNumberId] || []).map(wg => (
                            <div key={wg.jid} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)" }}>
                              <div style={{ flex: 1 }}>
                                <div style={{ fontSize: 13, fontWeight: 500 }}>{wg.name}</div>
                                <div style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>{wg.members || 0} membros</div>
                              </div>
                              <button
                                onClick={() => setScraping(s => ({ ...s, repasse: { leaderNumberId: addExistingNumberId, leaderJid: wg.jid, leaderName: wg.name } }))}
                                style={{ padding: "5px 12px", borderRadius: 7, background: PRIMARY, color: "#fff", border: "none", fontSize: 12, cursor: "pointer", fontWeight: 500 }}
                              >
                                Selecionar
                              </button>
                            </div>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Aprovação automática */}
              <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: 16 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 500, marginBottom: 4 }}>Aprovação automática</div>
                    <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
                      {scraping.auto !== false
                        ? "Links capturados no grupo líder entram direto na fila de envio."
                        : "Links capturados ficam aguardando revisão. Você aprova cada um antes do envio."}
                    </div>
                  </div>
                  <Toggle value={scraping.auto !== false} onChange={v => setScraping(s => ({ ...s, auto: v }))} />
                </div>
              </div>

              {/* Ações */}
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                <button onClick={save} disabled={!scrapingDirty && !saved} title={scrapingDirty ? "Salvar configurações do repasse" : "Sem alterações pra salvar"} style={saveBtnStyle(scrapingDirty)}>
                  {saved ? "✓ Salvo!" : "Salvar configurações"}
                </button>
                <button onClick={openManualAdd} style={{ padding: "9px 18px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", color: "var(--color-text-primary)", fontSize: 13, cursor: "pointer", fontWeight: 500 }}>
                  + Adicionar link manualmente
                </button>
              </div>
            </div>
          ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 14, marginBottom: 20 }}>
            <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: 16 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 500, marginBottom: 4 }}>Auto-aprovação</div>
                  <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
                    {scraping.auto !== false
                      ? "Produtos novos do scraping entram direto na fila e são enviados automaticamente."
                      : "Produtos novos ficam aguardando revisão. Você precisa aprovar cada um antes do envio."}
                  </div>
                </div>
                <Toggle value={scraping.auto !== false} onChange={v => setScraping(s => ({ ...s, auto: v }))} />
              </div>
            </div>

            <button
              onClick={() => setShowAdvancedFilters(v => !v)}
              style={{ alignSelf: "flex-start", padding: "8px 14px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", color: "var(--color-text-primary)", fontSize: 13, cursor: "pointer", display: "flex", alignItems: "center", gap: 8 }}
            >
              <span style={{ display: "inline-block", transition: "transform 0.15s", transform: showAdvancedFilters ? "rotate(90deg)" : "rotate(0deg)" }}>▶</span>
              {showAdvancedFilters ? "Ocultar filtros avançados" : "Mostrar filtros avançados"}
              <span style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>(preço, desconto, avaliação, vendas)</span>
            </button>

            <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: 16 }}>
              <div style={{ fontWeight: 500, marginBottom: 8 }}>Pesquisa</div>
              <div style={{ position: "relative" }}>
                <span style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", fontSize: 14, color: "var(--color-text-secondary)", pointerEvents: "none" }}>🔍</span>
                <input
                  type="text"
                  value={scraping.filters.keywords}
                  onChange={e => setScraping(s => ({ ...s, filters: { ...s.filters, keywords: e.target.value } }))}
                  onKeyDown={e => { if (e.key === "Enter" && !refilling) triggerRefill(); }}
                  placeholder="Pesquisar produtos (ex: notebook, monitor, fone bluetooth)"
                  style={{ width: "100%", padding: "10px 12px 10px 36px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13, boxSizing: "border-box", fontFamily: "inherit" }}
                />
              </div>
              <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 8 }}>
                Separe vários termos por vírgula. Traz produtos cujo nome contenha <strong>pelo menos um</strong> dos termos. Vazio = todos.
              </div>
              {scraping.filters.keywords.trim() && (
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
                  {scraping.filters.keywords.split(",").map(k => k.trim()).filter(Boolean).map((kw, i) => (
                    <span key={i} style={{ padding: "3px 10px", borderRadius: 6, background: PRIMARY_LIGHT, color: PRIMARY_DARK, fontSize: 11, fontWeight: 500 }}>
                      {kw}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {showAdvancedFilters && <>
            <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: 16 }}>
              <div style={{ fontWeight: 500, marginBottom: 4 }}>Filtros de qualidade</div>
              <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 16 }}>
                Produtos que não atenderem a <strong>todos</strong> os critérios serão ignorados.
              </div>
              {(() => {
                const PRICE_MAX = 10000;
                const PRICE_STEP = 50;
                const rawMax = scraping.filters?.maxPrice;
                const maxIsUnlimited = rawMax == null || !Number.isFinite(Number(rawMax)) || Number(rawMax) >= PRICE_MAX;
                const minP = Math.max(0, Math.min(PRICE_MAX, Number(scraping.filters?.minPrice ?? 0)));
                const maxP = maxIsUnlimited ? PRICE_MAX : Math.max(minP, Math.min(PRICE_MAX, Number(rawMax)));
                const setMin = (v) => setScraping(s => ({ ...s, filters: { ...s.filters, minPrice: Math.min(v, (Number(s.filters?.maxPrice) || PRICE_MAX) - PRICE_STEP) } }));
                // Slider no máximo = sem limite (salva null pro backend ignorar o filtro)
                const setMax = (v) => setScraping(s => {
                  const adjusted = Math.max(v, (s.filters?.minPrice ?? 0) + PRICE_STEP);
                  return { ...s, filters: { ...s.filters, maxPrice: adjusted >= PRICE_MAX ? null : adjusted } };
                });
                const leftPct = (minP / PRICE_MAX) * 100;
                const rightPct = 100 - (maxP / PRICE_MAX) * 100;
                return (
                  <div style={{ marginBottom: 18 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                      <label style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>Faixa de preço</label>
                      <span style={{ fontSize: 13, fontWeight: 500 }}>
                        R$ {minP.toLocaleString("pt-BR")} — {maxP >= PRICE_MAX ? "sem limite" : `R$ ${maxP.toLocaleString("pt-BR")}`}
                      </span>
                    </div>
                    <div className="range-dual">
                      <div className="track" />
                      <div className="track-active" style={{ left: `${leftPct}%`, right: `${rightPct}%` }} />
                      <input
                        type="range" min={0} max={PRICE_MAX} step={PRICE_STEP} value={minP}
                        onChange={e => setMin(Number(e.target.value))}
                      />
                      <input
                        type="range" min={0} max={PRICE_MAX} step={PRICE_STEP} value={maxP}
                        onChange={e => setMax(Number(e.target.value))}
                      />
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--color-text-secondary)", marginTop: 2 }}>
                      <span>R$ 0</span><span>R$ {PRICE_MAX.toLocaleString("pt-BR")}+</span>
                    </div>
                  </div>
                );
              })()}

              <div className="grid-collapse" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
                {[
                  { label: "Desconto mínimo", key: "minDiscount", min: 0, max: 80, unit: "%", step: 5 },
                  { label: "Avaliação mínima", key: "minRating", min: 0, max: 5, unit: "★", step: 0.5 },
                  { label: "Vendas mínimas", key: "minSales", min: 0, max: 1000, unit: " vendas", step: 10 },
                ].map(({ label, key, min, max, unit, step, prefix }) => {
                  const value = Number(scraping.filters[key] ?? 0);
                  const isDisabled = value === 0;
                  const displayValue = isDisabled
                    ? "Sem filtro"
                    : (prefix ? `${unit} ${value.toLocaleString("pt-BR")}` : `${value}${unit}`);
                  return (
                    <div key={key}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                        <label style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>{label}</label>
                        <span style={{ fontSize: 13, fontWeight: 500, color: isDisabled ? "var(--color-text-secondary)" : undefined, fontStyle: isDisabled ? "italic" : "normal" }}>{displayValue}</span>
                      </div>
                      <input type="range" min={min} max={max} step={step} value={value} onChange={e => setScraping(s => ({ ...s, filters: { ...s.filters, [key]: Number(e.target.value) } }))} style={{ width: "100%" }} />
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--color-text-secondary)", marginTop: 2 }}>
                        <span>{min === 0 ? "Sem filtro" : (prefix ? `${unit} ${min}` : `${min}${unit}`)}</span><span>{prefix ? `${unit} ${max.toLocaleString("pt-BR")}` : `${max}${unit}`}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 10, padding: "6px 10px", background: "var(--color-background-secondary)", borderRadius: 6 }}>
                ⚠️ Filtros de Avaliação e Vendas excluem produtos sem essa info — alguns produtos da Amazon não vêm com rating extraído.
              </div>
            </div>
            </>}

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <button onClick={triggerRefill} disabled={refilling} title="Salva a configuração atual e busca produtos no catálogo com a pesquisa e os filtros definidos" style={{ padding: "9px 20px", borderRadius: 8, border: "none", background: PRIMARY, color: "#fff", fontSize: 13, cursor: refilling ? "wait" : "pointer", fontWeight: 500, opacity: refilling ? 0.6 : 1 }}>
                {refilling ? "⟳ Buscando..." : "🔍 Buscar produtos"}
              </button>
              <button onClick={resetFilters} title="Zera a pesquisa e todos os filtros" style={{ padding: "9px 18px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", color: "var(--color-text-primary)", fontSize: 13, cursor: "pointer", fontWeight: 500 }}>
                Limpar filtros
              </button>
              <button
                onClick={save}
                disabled={!scrapingDirty && !saved}
                title={scrapingDirty ? "Salvar configurações do scraping desta campanha (ex: auto-aprovação)" : "Sem alterações pra salvar"}
                style={saveBtnStyle(scrapingDirty)}
              >
                {saved ? "✓ Salvo!" : "Salvar configurações"}
              </button>
              <button onClick={openManualAdd} style={{ padding: "9px 18px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", color: "var(--color-text-primary)", fontSize: 13, cursor: "pointer", fontWeight: 500 }}>
                + Adicionar link manualmente
              </button>
              {refillMsg && (
                <span style={{ fontSize: 12, color: refillMsg.type === "err" ? "#A32D2D" : refillMsg.type === "warn" ? "#854F0B" : PRIMARY_DARK }}>
                  {refillMsg.text}
                </span>
              )}
            </div>
            <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 8 }}>
              💡 Buscar já salva a pesquisa e os filtros atuais. Os filtros são aplicados sobre o catálogo central — a fila também é reabastecida automaticamente nos horários de envio.
            </div>
          </div>
          )}

          {pending.length > 0 && (
            <div style={{ marginBottom: 20 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 500 }}>Aguardando revisão</div>
                  <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 2 }}>{isRepasse ? "Links capturados do grupo líder que precisam de aprovação" : "Produtos do scraping que precisam de aprovação"}</div>
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  <button onClick={approveAllProducts} style={{ padding: "5px 12px", borderRadius: 7, background: PRIMARY_LIGHT, color: PRIMARY_DARK, border: `0.5px solid ${PRIMARY}`, fontSize: 12, cursor: "pointer", fontWeight: 500 }}>Adicionar todos à fila</button>
                  <button onClick={rejectAllProducts} style={{ padding: "5px 12px", borderRadius: 7, background: "#FCEBEB", color: "#A32D2D", border: "0.5px solid #F7C1C1", fontSize: 12, cursor: "pointer" }}>Rejeitar todos</button>
                </div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {pending.map(p => {
                  const pid = p.id ?? p.key;
                  return (
                    <ProductRow
                      key={pid}
                      product={p}
                      actions={<>
                        <button onClick={() => approveProduct(pid)} style={{ padding: "5px 12px", borderRadius: 7, background: PRIMARY_LIGHT, color: PRIMARY_DARK, border: `0.5px solid ${PRIMARY}`, fontSize: 12, cursor: "pointer", fontWeight: 500 }}>Adicionar na fila</button>
                        <button onClick={() => rejectProduct(pid)} style={{ padding: "5px 10px", borderRadius: 7, border: "0.5px solid #F7C1C1", background: "#FCEBEB", color: "#A32D2D", fontSize: 12, cursor: "pointer" }}>Rejeitar</button>
                      </>}
                    />
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {tab === "queue" && (
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 2 }}>Fila de envio</div>
              <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
                {queue.length} produto{queue.length !== 1 ? "s" : ""} agendado{queue.length !== 1 ? "s" : ""}
                {group.lastSend && group.lastSend !== "—" && !isNaN(new Date(group.lastSend).getTime())
                  ? <> · último envio às {formatTimeBR(group.lastSend)}</>
                  : null}
              </div>
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              {queue.length > 0 && (
                <button
                  onClick={triggerSendNow}
                  disabled={sendingNow || (group.whatsappGroupIds || []).length === 0 || stats.paused}
                  title={stats.pausedManual ? "Campanha pausada — retome pra enviar" : stats.pausedByAffiliateML ? "Configure o afiliado do Mercado Livre" : stats.pausedByAffiliateShopee ? "Configure o afiliado da Shopee" : (group.whatsappGroupIds || []).length === 0 ? "Vincule um grupo de WhatsApp primeiro" : "Envia o próximo produto agora e reseta o intervalo"}
                  style={{ padding: "5px 12px", borderRadius: 7, background: PRIMARY, color: "#fff", border: "none", fontSize: 12, cursor: (sendingNow || !(group.whatsappGroupIds || []).length || stats.paused) ? "not-allowed" : "pointer", fontWeight: 500, opacity: (sendingNow || !(group.whatsappGroupIds || []).length || stats.paused) ? 0.5 : 1 }}
                >
                  {sendingNow ? "⟳ Enviando..." : "▶ Enviar próximo agora"}
                </button>
              )}
              {queue.length > 0 && (
                <button onClick={() => setConfirmClearQueue(true)} style={{ padding: "5px 12px", borderRadius: 7, background: "#FCEBEB", color: "#A32D2D", border: "0.5px solid #F7C1C1", fontSize: 12, cursor: "pointer" }}>Limpar fila</button>
              )}
            </div>
          </div>
          {sendNowMsg && (
            <div style={{ marginBottom: 10, padding: "8px 10px", borderRadius: 8, fontSize: 12, background: sendNowMsg.type === "ok" ? PRIMARY_LIGHT : "#FCEBEB", color: sendNowMsg.type === "ok" ? PRIMARY_DARK : "#A32D2D" }}>{sendNowMsg.text}</div>
          )}
          {queue.length === 0 ? (
            <div style={{ textAlign: "center", padding: "30px 20px", background: "var(--color-background-secondary)", borderRadius: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 6 }}>Fila vazia</div>
              <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 14 }}>
                A fila é reabastecida automaticamente do catálogo nos horários de envio.
                Para adicionar produtos agora — buscar do catálogo ou colar um link —
                use a aba <strong>Busca de Produtos</strong>.
              </div>
              <button onClick={() => setTab("products")} style={{ padding: "8px 18px", borderRadius: 8, background: PRIMARY, color: "#fff", border: "none", fontSize: 13, cursor: "pointer", fontWeight: 500 }}>
                Ir para Busca de Produtos
              </button>
            </div>
          ) : (() => {
            const etas = computeQueueETA(group);
            return (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {queue.length > 1 && (
                  <div style={{ fontSize: 11, color: "var(--color-text-secondary)", padding: "0 4px" }}>
                    💡 Arraste os cards para reordenar a fila.
                  </div>
                )}
                {queue.map((item, idx) => (
                  <QueueItemCard
                    key={item.key || item.id || idx}
                    item={item}
                    idx={idx}
                    eta={etas[idx]}
                    onRemove={() => setConfirmRemoveQueueItem(item)}
                    onDragStart={handleQueueDragStart(idx)}
                    onDragOver={handleQueueDragOver(idx)}
                    onDragEnd={handleQueueDragEnd}
                    onDrop={handleQueueDrop(idx)}
                    isDragOver={dragOverIdx === idx && dragIdx !== idx}
                    isDragging={dragIdx === idx}
                  />
                ))}
              </div>
            );
          })()}
        </div>
      )}

      {tab === "schedule" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, flexWrap: "wrap" }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 500 }}>Janelas de envio</div>
              <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 2 }}>
                Defina os intervalos do dia em que as mensagens podem ser enviadas. Os produtos da fila serão distribuídos automaticamente respeitando o intervalo.
              </div>
            </div>
            <button onClick={addWindow} style={{ padding: "6px 12px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 13, cursor: "pointer", flexShrink: 0 }}>+ Adicionar janela</button>
          </div>
          {sched.windows.map((w, idx) => (
            <div key={w.id} style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: "var(--color-text-secondary)" }}>Janela {idx + 1}</div>
                {sched.windows.length > 1 && <button onClick={() => removeWindow(w.id)} style={{ background: "transparent", border: "none", cursor: "pointer", fontSize: 12, color: "#A32D2D" }}>Remover</button>}
              </div>
              <div className="grid-collapse" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
                {[["Início", "from", "time"], ["Fim", "to", "time"], ["Intervalo entre produtos", "interval", "select"]].map(([label, field, type]) => (
                  <div key={field}>
                    <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>{label}</label>
                    {type === "time"
                      ? <input type="time" value={w[field]} onChange={e => updateWindow(w.id, field, e.target.value)} style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13, boxSizing: "border-box" }} />
                      : <select value={w[field]} onChange={e => updateWindow(w.id, field, Number(e.target.value))} style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13 }}>{[5, 10, 15, 20, 30, 45, 60, 90, 120].map(v => <option key={v} value={v}>{v} min</option>)}</select>
                    }
                  </div>
                ))}
              </div>
            </div>
          ))}
          <button
            onClick={save}
            disabled={!scheduleDirty && !saved}
            title={scheduleDirty ? "Salvar janelas de envio" : "Sem alterações pra salvar"}
            style={{ ...saveBtnStyle(scheduleDirty), alignSelf: "flex-start" }}
          >
            {saved ? "✓ Salvo!" : "Salvar configurações"}
          </button>
        </div>
      )}

      {tab === "history" && (
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, flexWrap: "wrap", gap: 8 }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 500 }}>Histórico de envios</div>
              <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 2 }}>
                {(group.history || []).length} envio{(group.history || []).length !== 1 ? "s" : ""} registrado{(group.history || []).length !== 1 ? "s" : ""}
              </div>
            </div>
            {(group.history || []).length > 0 && (
              <button onClick={() => setConfirmClearHistory(true)} style={{ padding: "6px 12px", borderRadius: 7, border: "0.5px solid #F7C1C1", background: "#FCEBEB", color: "#A32D2D", fontSize: 12, cursor: "pointer" }}>
                🗑 Limpar histórico
              </button>
            )}
          </div>
          {(group.history || []).length === 0
            ? <div style={{ textAlign: "center", padding: "40px 0", color: "var(--color-text-secondary)", fontSize: 13, background: "var(--color-background-secondary)", borderRadius: 12 }}>Nenhum envio registrado.</div>
            : <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, overflow: "hidden" }}>
              {group.history.map((h, i) => {
                const sent = h.sentAt ? new Date(h.sentAt) : null;
                const sentValid = sent && !isNaN(sent.getTime());
                const dateStr = sentValid ? formatDateBR(sent) : (h.time || "—");
                const timeStr = sentValid ? formatTimeBR(sent) : "";
                const priceStr = h.price != null ? formatPrice(Number(h.price)) : (typeof h.price === "string" ? h.price : "—");
                const oldPriceStr = h.originalPrice != null ? formatPrice(Number(h.originalPrice)) : null;
                const discountNum = typeof h.discount === "number" ? h.discount : (h.discount ? parseInt(String(h.discount).replace(/\D/g, ""), 10) : null);
                return (
                  <div key={h.key || i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", borderBottom: i < group.history.length - 1 ? "0.5px solid var(--color-border-tertiary)" : "none" }}>
                    <div style={{ width: 48, height: 48, borderRadius: 8, background: "var(--color-background-secondary)", flexShrink: 0, overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center" }}>
                      {h.img
                        ? <img src={h.img} alt={h.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} onError={e => { e.target.style.display = "none"; }} />
                        : <span style={{ fontSize: 18, color: "var(--color-text-secondary)" }}>📦</span>
                      }
                    </div>
                    <div style={{ minWidth: 64, fontSize: 11, color: "var(--color-text-secondary)", lineHeight: 1.3 }}>
                      <div>{dateStr}</div>
                      {timeStr && <div style={{ fontWeight: 500, color: "var(--color-text-primary)" }}>{timeStr}</div>}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      {h.link
                        ? <a href={h.link} target="_blank" rel="noreferrer" style={{ fontSize: 13, fontWeight: 500, color: "var(--color-text-primary)", textDecoration: "none", display: "block", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={h.name}>{h.name}</a>
                        : <div style={{ fontSize: 13, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={h.name}>{h.name}</div>
                      }
                      <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 2 }}>
                        {h.store || "—"}
                        {h.groupCount > 0 && <> · enviado pra {h.groupCount} grupo{h.groupCount !== 1 ? "s" : ""}</>}
                      </div>
                    </div>
                    <div style={{ textAlign: "right", flexShrink: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 500, color: PRIMARY_DARK }}>{priceStr}</div>
                      {oldPriceStr && <div style={{ fontSize: 11, color: "var(--color-text-secondary)", textDecoration: "line-through" }}>{oldPriceStr}</div>}
                      {discountNum > 0 && <Badge color="green">-{discountNum}%</Badge>}
                    </div>
                  </div>
                );
              })}
            </div>
          }
        </div>
      )}

      {confirmClearHistory && (
        <Modal title="Limpar histórico de envios?" onClose={() => setConfirmClearHistory(false)} danger>
          <p style={{ fontSize: 13, marginBottom: 12, color: "var(--color-text-secondary)", lineHeight: 1.5 }}>
            Todo o histórico desta campanha será apagado, incluindo as métricas de envios (hoje/semana).
          </p>
          <p style={{ fontSize: 13, marginBottom: 16, color: "#854F0B", lineHeight: 1.5, background: "#FEF3C7", padding: "8px 10px", borderRadius: 8 }}>
            ⚠️ Atenção: produtos que estavam em <strong>cooldown</strong> voltam a ser elegíveis pra envio imediatamente.
          </p>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button onClick={() => setConfirmClearHistory(false)} disabled={clearingHistory} style={{ padding: "8px 16px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 13, cursor: "pointer" }}>Cancelar</button>
            <button onClick={handleClearHistory} disabled={clearingHistory} style={{ padding: "8px 16px", borderRadius: 8, background: "#E24B4A", color: "#fff", border: "none", fontSize: 13, cursor: "pointer", fontWeight: 500, opacity: clearingHistory ? 0.6 : 1 }}>
              {clearingHistory ? "Limpando..." : "Limpar histórico"}
            </button>
          </div>
        </Modal>
      )}

      {confirmPause && (
        <Modal title="Pausar campanha?" onClose={() => setConfirmPause(false)} danger>
          <p style={{ fontSize: 13, marginBottom: 16, color: "var(--color-text-secondary)", lineHeight: 1.5 }}>
            Enquanto <strong style={{ color: "var(--color-text-primary)" }}>{groupInfo.name}</strong> estiver pausada, ela não vai buscar produtos novos do catálogo nem enviar mensagens para os grupos vinculados. Você pode retomar a qualquer momento.
          </p>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button onClick={() => setConfirmPause(false)} style={{ padding: "8px 16px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 13, cursor: "pointer" }}>Cancelar</button>
            <button
              onClick={() => { onUpdate(group.id, { paused: true }); setConfirmPause(false); }}
              style={{ padding: "8px 16px", borderRadius: 8, background: "#E24B4A", color: "#fff", border: "none", fontSize: 13, cursor: "pointer", fontWeight: 500 }}
            >
              Sim, pausar
            </button>
          </div>
        </Modal>
      )}

      {confirmAddSource && (() => {
        const { src } = confirmAddSource;
        const close = () => setConfirmAddSource(null);
        return (
          <Modal title="Esta fonte vai pausar a campanha" onClose={close}>
            <p style={{ fontSize: 13, marginBottom: 12, color: "var(--color-text-secondary)", lineHeight: 1.5 }}>
              O afiliado da <strong style={{ color: "var(--color-text-primary)" }}>{src}</strong> ainda não está configurado nesta conta.
            </p>
            <p style={{ fontSize: 13, marginBottom: 16, color: "var(--color-text-secondary)", lineHeight: 1.5 }}>
              Se adicionar essa fonte agora, a campanha vai ficar <strong>pausada pelo sistema</strong> até o afiliado ser configurado &mdash; senão os links sairiam sem comissão.
            </p>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
              <button
                onClick={close}
                style={{ padding: "8px 16px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 13, cursor: "pointer" }}
              >
                Cancelar
              </button>
              <button
                onClick={() => { applyToggleSource(src); close(); }}
                style={{ padding: "8px 16px", borderRadius: 8, background: "#22C55E", color: "#fff", border: "none", fontSize: 13, cursor: "pointer", fontWeight: 500 }}
                title="Adiciona a fonte; a campanha vai começar a enviar quando o afiliado for configurado."
              >
                Adicionar mesmo assim
              </button>
            </div>
          </Modal>
        );
      })()}

      {confirmResumeAff && (() => {
        const { needsML, needsShopee, hasManualPause } = confirmResumeAff;
        const missing = [];
        if (needsML) missing.push("Mercado Livre");
        if (needsShopee) missing.push("Shopee");
        const missingLabel = missing.join(" e ");
        // Pra qual config navegar quando o usuário escolhe "Configurar agora".
        // Se faltam dois, prioriza o primeiro listado (ML).
        const primaryTarget = needsML ? "ml" : "shopee";
        const close = () => setConfirmResumeAff(null);
        // Remove as fontes problemáticas da campanha — persiste no servidor na
        // hora (mudança local + onUpdate) e já limpa pausa manual se houver.
        const removeMissingSources = () => {
          const newSources = (scraping.sources || []).filter(s => !missing.includes(s));
          setScraping(s => ({ ...s, sources: newSources }));
          const patch = { scraping: { ...(group.scraping || {}), ...scraping, sources: newSources } };
          if (hasManualPause) patch.paused = false;
          onUpdate(group.id, patch);
          close();
        };
        return (
          <Modal title="Afiliado não configurado" onClose={close}>
            <p style={{ fontSize: 13, marginBottom: 12, color: "var(--color-text-secondary)", lineHeight: 1.5 }}>
              Esta campanha tem <strong style={{ color: "var(--color-text-primary)" }}>{missingLabel}</strong> como fonte, mas o afiliado correspondente ainda não está configurado.
            </p>
            <p style={{ fontSize: 13, marginBottom: 16, color: "var(--color-text-secondary)", lineHeight: 1.5 }}>
              {hasManualPause
                ? <>Mesmo retomando manualmente, a campanha vai continuar <strong>pausada pelo sistema</strong> até o afiliado ser configurado &mdash; senão os links sairiam sem comissão.</>
                : <>A campanha não vai começar a enviar até o afiliado ser configurado &mdash; senão os links sairiam sem comissão.</>
              }
            </p>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
              <button
                onClick={close}
                style={{ padding: "8px 16px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 13, cursor: "pointer" }}
              >
                Cancelar
              </button>
              <button
                onClick={removeMissingSources}
                style={{ padding: "8px 16px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", color: "var(--color-text-primary)", fontSize: 13, cursor: "pointer", fontWeight: 500 }}
                title={`Remove ${missingLabel} das fontes de busca; a campanha volta a rodar com as fontes restantes.`}
              >
                Remover {missingLabel} das fontes
              </button>
              {hasManualPause && (
                <button
                  onClick={() => { onUpdate(group.id, { paused: false }); close(); }}
                  style={{ padding: "8px 16px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", color: "var(--color-text-primary)", fontSize: 13, cursor: "pointer", fontWeight: 500 }}
                  title="Limpa a pausa manual; a campanha começa a enviar assim que o afiliado for configurado."
                >
                  Retomar mesmo assim
                </button>
              )}
              <button
                onClick={() => {
                  close();
                  // Se manual paused, já limpa a pausa antes de navegar — quando o
                  // usuário voltar configurando o afiliado, a campanha estará pronta.
                  if (hasManualPause) onUpdate(group.id, { paused: false });
                  if (onGoToAffiliate) onGoToAffiliate(primaryTarget);
                  else if (onGoToSettings) onGoToSettings();
                }}
                style={{ padding: "8px 16px", borderRadius: 8, background: "#22C55E", color: "#fff", border: "none", fontSize: 13, cursor: "pointer", fontWeight: 500 }}
              >
                Configurar {needsML ? "Mercado Livre" : "Shopee"}
              </button>
            </div>
          </Modal>
        );
      })()}

      {confirmClearQueue && (
        <Modal title="Limpar fila?" onClose={() => setConfirmClearQueue(false)} danger>
          <p style={{ fontSize: 13, marginBottom: 16, color: "var(--color-text-secondary)", lineHeight: 1.5 }}>
            Todos os <strong style={{ color: "var(--color-text-primary)" }}>{queue.length} produto{queue.length !== 1 ? "s" : ""}</strong> da fila serão removidos. Você pode reabastecer depois com o botão "Buscar do catálogo".
          </p>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button onClick={() => setConfirmClearQueue(false)} style={{ padding: "8px 16px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 13, cursor: "pointer" }}>Cancelar</button>
            <button
              onClick={async () => {
                setQueue([]);
                setConfirmClearQueue(false);
                try {
                  await clearGroupQueue(group.id);
                  onUpdate(group.id, { queue: [] });
                } catch (err) {
                  console.error("[limpar fila]", err.message);
                }
              }}
              style={{ padding: "8px 16px", borderRadius: 8, background: "#E24B4A", color: "#fff", border: "none", fontSize: 13, cursor: "pointer", fontWeight: 500 }}
            >
              Sim, limpar
            </button>
          </div>
        </Modal>
      )}

      {manualForm && (
        <Modal title="Adicionar produto manualmente" onClose={closeManualAdd}>
          <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 12, lineHeight: 1.5 }}>
            Cole a URL do produto, clique <strong>Buscar dados</strong> pra puxar nome/preço/imagem automaticamente, revise os campos e adicione à fila.
            Tudo é editável — se a busca falhar, preencha manualmente.
          </div>

          <div style={{ marginBottom: 10 }}>
            <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Link do produto</label>
            <div style={{ display: "flex", gap: 6 }}>
              <input
                autoFocus
                value={manualForm.url}
                onChange={e => updateManualField("url", e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") fetchManualMetadata(); }}
                placeholder="https://..."
                style={{ flex: 1, padding: "8px 10px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13, boxSizing: "border-box", fontFamily: "monospace" }}
              />
              <button
                onClick={fetchManualMetadata}
                disabled={!manualForm.url.trim() || manualFetching}
                title="Abre a página com Puppeteer e extrai nome/preço/imagem (5–15s)"
                style={{ padding: "8px 14px", borderRadius: 8, border: "none", background: PRIMARY, color: "#fff", fontSize: 13, cursor: (!manualForm.url.trim() || manualFetching) ? "not-allowed" : "pointer", fontWeight: 500, opacity: (!manualForm.url.trim() || manualFetching) ? 0.6 : 1, whiteSpace: "nowrap" }}
              >
                {manualFetching ? "⟳ Buscando..." : "Buscar dados"}
              </button>
            </div>
          </div>

          {manualMsg && (
            <div style={{ marginBottom: 12, padding: "8px 10px", borderRadius: 8, fontSize: 12, background: manualMsg.type === "ok" ? PRIMARY_LIGHT : manualMsg.type === "warn" ? "#FEF3C7" : "#FCEBEB", color: manualMsg.type === "ok" ? PRIMARY_DARK : manualMsg.type === "warn" ? "#854F0B" : "#A32D2D" }}>
              {manualMsg.text}
            </div>
          )}

          <div className="grid-collapse" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div style={{ gridColumn: "1 / -1" }}>
              <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Nome do produto *</label>
              <input
                value={manualForm.name}
                onChange={e => updateManualField("name", e.target.value)}
                placeholder="Ex: Smartphone Samsung Galaxy A55 256GB"
                style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13, boxSizing: "border-box" }}
              />
            </div>
            <div>
              <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Preço (R$)</label>
              <input
                type="number" min={0} step="0.01"
                value={manualForm.price}
                onChange={e => updateManualField("price", e.target.value)}
                placeholder="1899.00"
                style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13, boxSizing: "border-box" }}
              />
            </div>
            <div>
              <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Preço original (R$)</label>
              <input
                type="number" min={0} step="0.01"
                value={manualForm.originalPrice}
                onChange={e => updateManualField("originalPrice", e.target.value)}
                placeholder="2499.00"
                style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13, boxSizing: "border-box" }}
              />
            </div>
            <div>
              <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Desconto (%)</label>
              <input
                type="number" min={0} max={99}
                value={manualForm.discount}
                onChange={e => updateManualField("discount", e.target.value)}
                placeholder="24"
                style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13, boxSizing: "border-box" }}
              />
            </div>
            <div>
              <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Loja</label>
              <select
                value={manualForm.store}
                onChange={e => updateManualField("store", e.target.value)}
                style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13 }}
              >
                <option value="">— escolher —</option>
                {allSources.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div style={{ gridColumn: "1 / -1" }}>
              <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>URL da imagem</label>
              <input
                value={manualForm.img}
                onChange={e => updateManualField("img", e.target.value)}
                placeholder="https://..."
                style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 12, boxSizing: "border-box", fontFamily: "monospace" }}
              />
              {manualForm.img && (
                <div style={{ marginTop: 6, padding: 6, borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", display: "inline-block" }}>
                  <img src={manualForm.img} alt="" style={{ maxWidth: 100, maxHeight: 100, objectFit: "contain", display: "block" }} onError={e => { e.target.style.display = "none"; }} />
                </div>
              )}
            </div>
            {(groupInfo.categories || []).length > 1 && (
              <div style={{ gridColumn: "1 / -1" }}>
                <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Categoria</label>
                <select
                  value={manualForm.category}
                  onChange={e => updateManualField("category", e.target.value)}
                  style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13 }}
                >
                  {(groupInfo.categories || []).map(c => <option key={c} value={c}>{categoryLabel(c)}</option>)}
                </select>
              </div>
            )}
          </div>

          {manualCooldown && (
            <div style={{ marginTop: 14, padding: "10px 12px", borderRadius: 8, background: "#FEF3C7", border: "0.5px solid #F4D08A", fontSize: 12, color: "#854F0B", lineHeight: 1.5 }}>
              ⚠️ Este produto já foi enviado em <strong>{new Date(manualCooldown.lastSentAt).toLocaleString("pt-BR")}</strong> e ainda está dentro do tempo de espera para reenvio
              {manualCooldown.cooldownLabel ? <> ({manualCooldown.cooldownLabel})</> : null}.
              Tem certeza que quer adicionar mesmo assim?
            </div>
          )}

          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16, flexWrap: "wrap" }}>
            <button onClick={closeManualAdd} disabled={manualSubmitting} style={{ padding: "8px 16px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 13, cursor: "pointer" }}>Cancelar</button>
            {manualCooldown ? (
              <button
                onClick={() => submitManualAdd(true)}
                disabled={manualSubmitting}
                style={{ padding: "8px 16px", borderRadius: 8, background: "#E24B4A", color: "#fff", border: "none", fontSize: 13, cursor: "pointer", fontWeight: 500, opacity: manualSubmitting ? 0.6 : 1 }}
              >
                {manualSubmitting ? "⟳ Adicionando..." : "Adicionar mesmo assim"}
              </button>
            ) : (
              <button
                onClick={() => submitManualAdd(false)}
                disabled={manualSubmitting || !manualForm.url.trim() || !manualForm.name.trim()}
                style={{ padding: "8px 16px", borderRadius: 8, background: PRIMARY, color: "#fff", border: "none", fontSize: 13, cursor: "pointer", fontWeight: 500, opacity: (manualSubmitting || !manualForm.url.trim() || !manualForm.name.trim()) ? 0.6 : 1 }}
              >
                {manualSubmitting ? "⟳ Adicionando..." : "Adicionar à fila"}
              </button>
            )}
          </div>
        </Modal>
      )}

      {confirmRemoveQueueItem && (
        <Modal title="Remover produto da fila?" onClose={() => setConfirmRemoveQueueItem(null)} danger>
          <p style={{ fontSize: 13, marginBottom: 16, color: "var(--color-text-secondary)", lineHeight: 1.5 }}>
            <strong style={{ color: "var(--color-text-primary)" }}>{confirmRemoveQueueItem.name || "Este produto"}</strong> será removido da fila e não será enviado.
          </p>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button onClick={() => setConfirmRemoveQueueItem(null)} style={{ padding: "8px 16px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 13, cursor: "pointer" }}>Cancelar</button>
            <button
              onClick={() => {
                const it = confirmRemoveQueueItem;
                removeFromQueue(it.id || it.key);
                setConfirmRemoveQueueItem(null);
              }}
              style={{ padding: "8px 16px", borderRadius: 8, background: "#E24B4A", color: "#fff", border: "none", fontSize: 13, cursor: "pointer", fontWeight: 500 }}
            >
              Sim, remover
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
