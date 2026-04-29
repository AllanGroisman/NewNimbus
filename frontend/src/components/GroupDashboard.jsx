import { useState, useRef } from "react";
import { PRIMARY, PRIMARY_DARK, PRIMARY_LIGHT, allSources, CATEGORIES, categoryLabel, categoryColor, formatPrice, getGroupCategories, getGroupStats } from "../data/constants";
import { fetchOfertas, createWAGroup, leaveWAGroup, getWAInvite, revokeWAInvite, broadcastWA, sendWAText } from "../data/api";
import { DEFAULT_MESSAGE_TEMPLATE } from "../data/mockData";

const TEMPLATE_VARS = [
  { token: "{produto}", desc: "Nome do produto" },
  { token: "{preco}", desc: "Preço com desconto" },
  { token: "{preco_antigo}", desc: "Preço original" },
  { token: "{desconto}", desc: "% de desconto" },
  { token: "{loja}", desc: "Nome da loja" },
  { token: "{link}", desc: "Link de compra" },
];

const TEMPLATE_PREVIEW_DATA = {
  produto: "Smartphone Samsung Galaxy A55 256GB",
  preco: "R$ 1.899",
  preco_antigo: "R$ 2.499",
  desconto: "24%",
  loja: "Mercado Livre",
  link: "https://merc.li/abc123",
};

const renderTemplate = (tpl) => {
  if (!tpl) return "";
  return tpl.replace(/\{(\w+)\}/g, (_, k) => TEMPLATE_PREVIEW_DATA[k] ?? `{${k}}`);
};
import Badge from "./ui/Badge";
import StatCard from "./ui/StatCard";
import MiniBar from "./ui/MiniBar";
import Toggle from "./ui/Toggle";
import Tabs from "./ui/Tabs";
import Modal from "./ui/Modal";
import { ProductRow } from "./ui/ProductCard";

export default function GroupDashboard({ group, numbers, whatsappGroups = [], onBack, onUpdate, onDelete, onCreateWhatsappGroup, onDeleteWhatsappGroup, onUpdateWhatsappGroup }) {
  const [tab, setTab] = useState("overview");
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
  const [scrapingRunning, setScrapingRunning] = useState(false);
  const [newTime, setNewTime] = useState("08:00");
  const [showDelete, setShowDelete] = useState(false);
  const [showLinkModal, setShowLinkModal] = useState(false);
  const [showCreateWGModal, setShowCreateWGModal] = useState(false);
  const [confirmDeleteWG, setConfirmDeleteWG] = useState(null);
  const [copiedId, setCopiedId] = useState(null);
  const [newWGForm, setNewWGForm] = useState({ name: "", numberId: numbers[0]?.id, participants: "" });
  const [creatingWG, setCreatingWG] = useState(false);
  const [createWGError, setCreateWGError] = useState(null);
  const [showPreview, setShowPreview] = useState(false);
  const [sendStatus, setSendStatus] = useState({}); // wgId -> "sending" | "sent" | "error:..."
  const [broadcasting, setBroadcasting] = useState(false);
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

  const copyInvite = (wg) => {
    if (!wg?.inviteLink) return;
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(wg.inviteLink).catch(() => {});
    }
    setCopiedId(wg.id);
    setTimeout(() => setCopiedId(c => c === wg.id ? null : c), 1500);
  };

  const primaryCat = groupInfo.categories[0] || getGroupCategories(group)[0];
  const barColor = primaryCat === "gamer" ? "#378ADD" : PRIMARY;
  const linkedWGs = whatsappGroups.filter(w => groupInfo.whatsappGroupIds.includes(w.id));
  const availableWGs = whatsappGroups.filter(w => !groupInfo.whatsappGroupIds.includes(w.id));
  const stats = getGroupStats({ whatsappGroupIds: groupInfo.whatsappGroupIds }, whatsappGroups);

  const toggleCategory = (id) => setGroupInfo(g => {
    const has = g.categories.includes(id);
    if (has) {
      if (g.categories.length === 1) return g; // mantém pelo menos uma
      return { ...g, categories: g.categories.filter(c => c !== id) };
    }
    return { ...g, categories: [...g.categories, id] };
  });

  const linkWG = (wgId) => setGroupInfo(g => ({ ...g, whatsappGroupIds: [...g.whatsappGroupIds, wgId] }));
  const unlinkWG = (wgId) => setGroupInfo(g => ({ ...g, whatsappGroupIds: g.whatsappGroupIds.filter(id => id !== wgId) }));

  const submitCreateWG = async () => {
    setCreateWGError(null);
    if (!newWGForm.name.trim() || !newWGForm.numberId) return;
    const parts = newWGForm.participants
      .split(/[\n,;]/)
      .map(p => p.trim())
      .filter(Boolean);
    if (parts.length === 0) {
      setCreateWGError("Informe ao menos um participante (telefone com DDD).");
      return;
    }
    setCreatingWG(true);
    try {
      const result = await createWAGroup(newWGForm.numberId, newWGForm.name.trim(), parts);
      const newId = onCreateWhatsappGroup({
        id: result.jid,
        name: result.name,
        numberId: newWGForm.numberId,
        members: result.participants.length + 1,
        inviteLink: result.inviteLink,
      });
      setGroupInfo(g => ({ ...g, whatsappGroupIds: [...g.whatsappGroupIds, newId] }));
      setShowCreateWGModal(false);
      setNewWGForm({ name: "", numberId: numbers[0]?.id, participants: "" });
    } catch (err) {
      setCreateWGError(err.message);
    } finally {
      setCreatingWG(false);
    }
  };

  // Renderiza o template substituindo variáveis pelos campos de um produto
  const renderForProduct = (tpl, p) => {
    if (!tpl) return "";
    const map = {
      produto: p.name || "",
      preco: p.price || "",
      preco_antigo: p.originalPrice || "",
      desconto: p.discount || "",
      loja: p.store || "",
      link: p.link || "",
    };
    return tpl.replace(/\{(\w+)\}/g, (_, k) => map[k] ?? `{${k}}`);
  };

  // Envia o próximo produto da fila para um único grupo (botão "Enviar agora" do card)
  const sendNowToGroup = async (wg) => {
    if (queue.length === 0) return;
    const product = queue[0];
    const text = renderForProduct(groupInfo.messageTemplate || DEFAULT_MESSAGE_TEMPLATE, product);
    setSendStatus(s => ({ ...s, [wg.id]: "sending" }));
    try {
      await sendWAText(wg.numberId, wg.id, text);
      setSendStatus(s => ({ ...s, [wg.id]: "sent" }));
      setTimeout(() => setSendStatus(s => { const c = { ...s }; delete c[wg.id]; return c; }), 2500);
    } catch (err) {
      setSendStatus(s => ({ ...s, [wg.id]: `error:${err.message}` }));
    }
  };

  // Envia o próximo produto da fila para todos os grupos vinculados
  const broadcastNow = async () => {
    if (queue.length === 0 || linkedWGs.length === 0) return;
    const product = queue[0];
    const text = renderForProduct(groupInfo.messageTemplate || DEFAULT_MESSAGE_TEMPLATE, product);
    setBroadcasting(true);
    try {
      // Agrupa por numberId e dispara um broadcast por número
      const byNumber = linkedWGs.reduce((acc, w) => {
        (acc[w.numberId] = acc[w.numberId] || []).push(w.id);
        return acc;
      }, {});
      for (const [numberId, jids] of Object.entries(byNumber)) {
        await broadcastWA(numberId, jids, text);
      }
      // Remove o produto da fila após envio
      setQueue(q => q.slice(1));
    } catch (err) {
      console.error(err);
      alert(`Erro ao enviar: ${err.message}`);
    } finally {
      setBroadcasting(false);
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

  const approveProduct = pid => {
    const p = pending.find(x => x.id === pid);
    if (!p) return;
    setQueue(q => {
      const newQueue = [...q, { ...p }];
      const times = computeSendTimes(newQueue.length);
      return newQueue.map((item, i) => ({ ...item, sendAt: times[i] }));
    });
    setPending(ps => ps.filter(x => x.id !== pid));
  };
  const rejectProduct = pid => setPending(ps => ps.filter(x => x.id !== pid));
  const removeFromQueue = qid => setQueue(q => {
    const newQueue = q.filter(i => i.id !== qid);
    const times = computeSendTimes(newQueue.length);
    return newQueue.map((item, i) => ({ ...item, sendAt: times[i] }));
  });

  const runScraping = async () => {
    setScrapingRunning(true);
    try {
      const { minDiscount, maxPrice, minRating, minSales, keywords } = scraping.filters;
      const cats = groupInfo.categories.length > 0 ? groupInfo.categories : [primaryCat];
      const results = await Promise.all(cats.map(cat => fetchOfertas({ category: cat, minDiscount, maxPrice, limit: 50, refresh: true })));
      const seen = new Set();
      const merged = [];
      for (const r of results) {
        for (const p of r.products) {
          const key = p.link || p.name;
          if (seen.has(key)) continue;
          seen.add(key);
          merged.push(p);
        }
      }

      // Aplicar filtros client-side que o backend não suporta
      let filtered = merged;
      if (minRating > 0) {
        filtered = filtered.filter(p => p.rating && p.rating >= minRating);
      }
      if (minSales > 0) {
        filtered = filtered.filter(p => {
          if (!p.sold) return false;
          const m = p.sold.match(/[\d.]+/);
          return m ? parseInt(m[0].replace(/\./g, "")) >= minSales : false;
        });
      }
      if (keywords && keywords.trim()) {
        const kws = keywords.split(",").map(k => k.trim().toLowerCase()).filter(Boolean);
        if (kws.length > 0) {
          filtered = filtered.filter(p => {
            const name = p.name.toLowerCase();
            return kws.some(kw => name.includes(kw));
          });
        }
      }

      const sliced = filtered.slice(0, 20);
      const times = computeSendTimes(sliced.length);
      const newProducts = sliced.map((p, i) => ({
        id: Date.now() + Math.random(),
        name: p.name,
        price: p.price,
        originalPrice: p.originalPrice,
        discount: p.discount,
        store: p.store,
        img: p.img,
        rating: p.rating,
        freeShipping: p.freeShipping,
        sold: p.sold,
        link: p.link,
        sendAt: times[i],
      }));
      if (scraping.mode === "auto") {
        setQueue(newProducts);
        setPending([]);
      } else {
        setPending(newProducts);
        setQueue([]);
      }
    } catch (err) {
      console.error("Erro no scraping:", err);
    } finally {
      setScrapingRunning(false);
    }
  };

  const save = () => { onUpdate(group.id, { schedule: sched, scraping, queue, pending, ...groupInfo }); setSaved(true); setTimeout(() => setSaved(false), 2000); };

  const groupTabs = [
    { id: "overview", label: "Visão geral" },
    { id: "manage", label: "Gerenciar" },
    { id: "whatsapp", label: `WhatsApp (${stats.count})` },
    { id: "scraping", label: "Scraping" },
    { id: "queue", label: `Fila (${queue.length})`, dot: pending.length > 0 },
    { id: "schedule", label: "Horários" },
    { id: "history", label: "Histórico" },
  ];

  return (
    <div>
      <button onClick={onBack} style={{ background: "transparent", border: "none", cursor: "pointer", fontSize: 13, color: "var(--color-text-secondary)", marginBottom: 16, display: "flex", alignItems: "center", gap: 6 }}>&larr; Voltar</button>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16, flexWrap: "wrap", gap: 10 }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 500, marginBottom: 6 }}>{groupInfo.name}</h2>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {groupInfo.categories.map(c => <Badge key={c} color={categoryColor(c)}>{categoryLabel(c)}</Badge>)}
            {stats.status === "empty"
              ? <Badge color="gray">Sem grupos do WhatsApp</Badge>
              : <Badge color={stats.status === "connected" ? "green" : "red"}>{stats.connected}/{stats.count} conectados</Badge>
            }
            {stats.count > 0 && <Badge color="gray">{stats.members} membros</Badge>}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={runScraping} disabled={scrapingRunning} style={{ padding: "7px 14px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 13, cursor: "pointer", opacity: scrapingRunning ? 0.6 : 1 }}>
            {scrapingRunning ? "⟳ Buscando..." : "⟳ Buscar agora"}
          </button>
          <button disabled={stats.count === 0} style={{ padding: "7px 14px", borderRadius: 8, background: stats.count === 0 ? "var(--color-border-secondary)" : PRIMARY, color: "#fff", border: "none", fontSize: 13, cursor: stats.count === 0 ? "not-allowed" : "pointer", fontWeight: 500 }}>
            Enviar agora{stats.count > 1 ? ` (${stats.count})` : ""}
          </button>
        </div>
      </div>

      <Tabs tabs={groupTabs} active={tab} onChange={setTab} />

      {tab === "overview" && (
        <div>
          <div style={{ display: "flex", gap: 10, marginBottom: 20, flexWrap: "wrap" }}>
            <StatCard label="Envios hoje" value={group.sentToday} color={PRIMARY_DARK} />
            <StatCard label="Envios semana" value={group.sentWeek} />
            <StatCard label="Na fila" value={queue.length} sub={pending.length > 0 ? `${pending.length} aguardando revisão` : undefined} color={pending.length > 0 ? "#854F0B" : undefined} />
            <StatCard label="Último envio" value={group.lastSend} />
          </div>
          <div className="grid-collapse" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 12, color: "var(--color-text-secondary)" }}>Envios esta semana</div>
              <MiniBar data={group.weekData} color={barColor} />
            </div>
            <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 10, color: "var(--color-text-secondary)" }}>Scraping</div>
              <div style={{ fontSize: 13, marginBottom: 6 }}>{scraping.auto ? `Auto — ${scraping.times.join(", ")}` : "Manual"}</div>
              <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 4 }}>Modo: {scraping.mode === "auto" ? "Entrada automática" : scraping.mode === "manual" ? "Revisão manual" : "Auto com revisão"}</div>
              <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>Fontes: {scraping.sources.join(", ")}</div>
            </div>
          </div>
        </div>
      )}

      {tab === "manage" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: 16 }}>
            <div style={{ fontWeight: 500, marginBottom: 4 }}>Informações do grupo</div>
            <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 14 }}>Nome, categoria e dados principais</div>
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
                      {active ? "✓ " : ""}{categoryLabel(id)}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>


          <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10, gap: 10, flexWrap: "wrap" }}>
              <div>
                <div style={{ fontWeight: 500, marginBottom: 4 }}>Modelo de mensagem</div>
                <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
                  Como cada produto será enviado nos grupos. Clique numa variável para inseri-la onde o cursor estiver.
                </div>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <button onClick={() => setShowPreview(p => !p)} style={{ padding: "5px 12px", borderRadius: 7, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 12, cursor: "pointer" }}>{showPreview ? "Editar" : "👁 Preview"}</button>
                <button onClick={() => setGroupInfo(g => ({ ...g, messageTemplate: DEFAULT_MESSAGE_TEMPLATE }))} style={{ padding: "5px 12px", borderRadius: 7, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 12, cursor: "pointer" }}>Restaurar padrão</button>
              </div>
            </div>

            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
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

            {showPreview ? (
              <div style={{ width: "100%", minHeight: 160, padding: 12, borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "#E1F5EE", fontSize: 13, whiteSpace: "pre-wrap", lineHeight: 1.5, fontFamily: "inherit" }}>
                {renderTemplate(groupInfo.messageTemplate) || <span style={{ color: "var(--color-text-secondary)" }}>Modelo vazio.</span>}
                <div style={{ fontSize: 10, color: "var(--color-text-secondary)", marginTop: 10, paddingTop: 8, borderTop: "0.5px solid rgba(0,0,0,0.06)" }}>
                  Pré-visualização com dados de exemplo
                </div>
              </div>
            ) : (
              <textarea
                ref={templateRef}
                value={groupInfo.messageTemplate}
                onChange={e => setGroupInfo(g => ({ ...g, messageTemplate: e.target.value }))}
                style={{ width: "100%", padding: 10, borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13, resize: "vertical", minHeight: 160, boxSizing: "border-box", fontFamily: "inherit", lineHeight: 1.5 }}
                placeholder={DEFAULT_MESSAGE_TEMPLATE}
              />
            )}
          </div>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button onClick={save} style={{ padding: "9px 24px", borderRadius: 8, background: saved ? "#3B6D11" : PRIMARY, color: "#fff", border: "none", fontSize: 13, cursor: "pointer", fontWeight: 500 }}>{saved ? "✓ Salvo!" : "Salvar alterações"}</button>
            <button style={{ padding: "9px 18px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 13, cursor: "pointer" }}>Pausar grupo</button>
            <button onClick={() => setShowDelete(true)} style={{ padding: "9px 18px", borderRadius: 8, border: "0.5px solid #F7C1C1", background: "#FCEBEB", color: "#A32D2D", fontSize: 13, cursor: "pointer", fontWeight: 500 }}>Excluir grupo</button>
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

      {tab === "whatsapp" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", gap: 10, marginBottom: 4, flexWrap: "wrap" }}>
            <StatCard label="Grupos vinculados" value={stats.count} color={PRIMARY_DARK} />
            <StatCard label="Total de membros" value={stats.members} />
            <StatCard label="Conectados" value={`${stats.connected}/${stats.count}`} color={stats.status === "connected" ? undefined : "#854F0B"} />
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 500 }}>Grupos do WhatsApp</div>
              <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 2 }}>
                Esta campanha envia para os grupos abaixo. Cada grupo recebe a mesma fila de produtos.
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {linkedWGs.length > 0 && queue.length > 0 && (
                <button onClick={broadcastNow} disabled={broadcasting} style={{ padding: "7px 12px", borderRadius: 8, background: broadcasting ? "var(--color-border-secondary)" : "#1D9E75", color: "#fff", border: "none", fontSize: 13, cursor: broadcasting ? "not-allowed" : "pointer", fontWeight: 500 }}>
                  {broadcasting ? "⟳ Enviando..." : `📤 Enviar a todos (${linkedWGs.length})`}
                </button>
              )}
              <button onClick={() => setShowLinkModal(true)} disabled={availableWGs.length === 0} style={{ padding: "7px 12px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 13, cursor: availableWGs.length === 0 ? "not-allowed" : "pointer", opacity: availableWGs.length === 0 ? 0.5 : 1 }}>+ Vincular existente</button>
              <button onClick={() => setShowCreateWGModal(true)} disabled={numbers.length === 0} title={numbers.length === 0 ? "Conecte um número primeiro" : ""} style={{ padding: "7px 12px", borderRadius: 8, background: numbers.length === 0 ? "var(--color-border-secondary)" : PRIMARY, color: "#fff", border: "none", fontSize: 13, cursor: numbers.length === 0 ? "not-allowed" : "pointer", fontWeight: 500 }}>+ Criar grupo</button>
            </div>
          </div>

          {linkedWGs.length === 0 ? (
            <div style={{ textAlign: "center", padding: "40px 20px", color: "var(--color-text-secondary)", fontSize: 13, background: "var(--color-background-secondary)", borderRadius: 12 }}>
              <div style={{ fontSize: 28, marginBottom: 10 }}>💬</div>
              <div style={{ fontWeight: 500, color: "var(--color-text-primary)", marginBottom: 6 }}>Nenhum grupo do WhatsApp vinculado</div>
              <div style={{ fontSize: 12, marginBottom: 14 }}>Crie um novo grupo ou vincule um existente para começar a enviar mensagens.</div>
              {numbers.length === 0
                ? <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>Conecte um número do WhatsApp na aba <strong>WhatsApp</strong> do menu para criar grupos.</div>
                : <button onClick={() => setShowCreateWGModal(true)} style={{ padding: "8px 18px", borderRadius: 8, background: PRIMARY, color: "#fff", border: "none", fontSize: 13, cursor: "pointer", fontWeight: 500 }}>+ Criar primeiro grupo</button>
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
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
                          <span style={{ width: 9, height: 9, borderRadius: "50%", background: connected ? PRIMARY : "#E24B4A", flexShrink: 0 }} />
                          <span style={{ fontSize: 14, fontWeight: 500 }}>{w.name}</span>
                          <Badge color={connected ? "green" : "red"}>{connected ? "Conectado" : "Desconectado"}</Badge>
                        </div>
                        <div style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "flex", gap: 12, flexWrap: "wrap" }}>
                          <span>👥 {w.members} membros</span>
                          <span>📱 via {number ? number.label : "número removido"}</span>
                          <span>🗓 Criado {w.createdAt}</span>
                          {w.sentToday !== undefined && <span>📨 {w.sentToday} envios hoje</span>}
                          {w.lastSend && <span>⏱ Último: {w.lastSend}</span>}
                        </div>
                      </div>
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
                      <button
                        onClick={() => sendNowToGroup(w)}
                        disabled={queue.length === 0 || sendStatus[w.id] === "sending" || !connected}
                        title={queue.length === 0 ? "Fila vazia" : !connected ? "Grupo desconectado" : `Envia o próximo da fila: ${queue[0]?.name}`}
                        style={{
                          padding: "6px 12px", borderRadius: 7,
                          background: sendStatus[w.id]?.startsWith("error") ? "#FCEBEB" : sendStatus[w.id] === "sent" ? "#EAF3DE" : PRIMARY_LIGHT,
                          color: sendStatus[w.id]?.startsWith("error") ? "#A32D2D" : sendStatus[w.id] === "sent" ? "#3B6D11" : PRIMARY_DARK,
                          border: `0.5px solid ${sendStatus[w.id]?.startsWith("error") ? "#F7C1C1" : sendStatus[w.id] === "sent" ? "#3B6D11" : PRIMARY}`,
                          fontSize: 12, cursor: queue.length === 0 || !connected ? "not-allowed" : "pointer",
                          fontWeight: 500, opacity: queue.length === 0 || !connected ? 0.5 : 1
                        }}
                      >
                        {sendStatus[w.id] === "sending" ? "⟳ Enviando..." : sendStatus[w.id] === "sent" ? "✓ Enviado" : sendStatus[w.id]?.startsWith("error") ? "✗ Erro" : "Enviar agora"}
                      </button>
                      {w.inviteLink && <button onClick={() => refreshInvite(w)} style={{ padding: "6px 12px", borderRadius: 7, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 12, cursor: "pointer" }}>Renovar link</button>}
                      <div style={{ flex: 1 }} />
                      <button onClick={() => unlinkWG(w.id)} style={{ padding: "6px 12px", borderRadius: 7, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 12, cursor: "pointer" }}>Desvincular</button>
                      <button onClick={() => setConfirmDeleteWG(w)} style={{ padding: "6px 12px", borderRadius: 7, border: "0.5px solid #F7C1C1", background: "#FCEBEB", color: "#A32D2D", fontSize: 12, cursor: "pointer" }}>Excluir</button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {showLinkModal && (
            <Modal title="Vincular grupo do WhatsApp" onClose={() => setShowLinkModal(false)}>
              <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 12 }}>
                Selecione um grupo já existente para receber as mensagens desta campanha.
              </div>
              {availableWGs.length === 0 ? (
                <div style={{ textAlign: "center", padding: "20px 0", color: "var(--color-text-secondary)", fontSize: 12 }}>
                  Todos os grupos já estão vinculados. Crie um novo grupo para continuar.
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 320, overflowY: "auto" }}>
                  {availableWGs.map(w => {
                    const number = numbers.find(n => n.id === w.numberId);
                    return (
                      <div key={w.id} onClick={() => { linkWG(w.id); setShowLinkModal(false); }} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: 10, border: "0.5px solid var(--color-border-tertiary)", cursor: "pointer", background: "var(--color-background-secondary)" }}>
                        <span style={{ width: 8, height: 8, borderRadius: "50%", background: w.status === "connected" ? PRIMARY : "#E24B4A", flexShrink: 0 }} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 500 }}>{w.name}</div>
                          <div style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>
                            {w.members} membros · via {number ? number.label : "?"}
                          </div>
                        </div>
                        <span style={{ fontSize: 11, color: PRIMARY_DARK, fontWeight: 500 }}>+ Vincular</span>
                      </div>
                    );
                  })}
                </div>
              )}
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
                <button onClick={() => setShowLinkModal(false)} style={{ padding: "8px 16px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 13, cursor: "pointer" }}>Fechar</button>
              </div>
            </Modal>
          )}

          {showCreateWGModal && (
            <Modal title="Criar grupo no WhatsApp" onClose={() => setShowCreateWGModal(false)}>
              <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 14, lineHeight: 1.5 }}>
                Um novo grupo será criado <strong>de fato no WhatsApp</strong> e vinculado a esta campanha. O WhatsApp exige pelo menos um participante além de você.
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div>
                  <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Nome do grupo</label>
                  <input value={newWGForm.name} onChange={e => setNewWGForm(f => ({ ...f, name: e.target.value }))} placeholder={`Ex: ${group.name} — Regional`} style={{ width: "100%", padding: "9px 12px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13, boxSizing: "border-box" }} />
                </div>
                <div>
                  <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Número que vai criar</label>
                  <select value={newWGForm.numberId || ""} onChange={e => setNewWGForm(f => ({ ...f, numberId: e.target.value }))} style={{ width: "100%", padding: "9px 12px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13 }}>
                    {numbers.map(n => <option key={n.id} value={n.id}>{n.label} — {n.phone}</option>)}
                  </select>
                </div>
                <div>
                  <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Participantes iniciais</label>
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
                <button onClick={() => setShowCreateWGModal(false)} disabled={creatingWG} style={{ padding: "8px 16px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 13, cursor: "pointer" }}>Cancelar</button>
                <button onClick={submitCreateWG} disabled={!newWGForm.name.trim() || !newWGForm.numberId || creatingWG} style={{ padding: "8px 16px", borderRadius: 8, background: PRIMARY, color: "#fff", border: "none", fontSize: 13, cursor: "pointer", fontWeight: 500, opacity: (!newWGForm.name.trim() || !newWGForm.numberId || creatingWG) ? 0.5 : 1 }}>
                  {creatingWG ? "⟳ Criando..." : "Criar e vincular"}
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
      )}

      {tab === "scraping" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <div>
                <div style={{ fontWeight: 500 }}>Scraping automático</div>
                <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 2 }}>Busca produtos automaticamente nos horários configurados</div>
              </div>
              <Toggle value={scraping.auto} onChange={v => setScraping(s => ({ ...s, auto: v }))} />
            </div>
            {scraping.auto && (
              <div>
                <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 8 }}>Horários de scraping</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
                  {scraping.times.map((t, i) => (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, background: "var(--color-background-secondary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 8, padding: "5px 10px" }}>
                      <span style={{ fontSize: 13, fontWeight: 500 }}>{t}</span>
                      <button onClick={() => setScraping(s => ({ ...s, times: s.times.filter((_, j) => j !== i) }))} style={{ background: "transparent", border: "none", cursor: "pointer", fontSize: 14, color: "var(--color-text-secondary)", lineHeight: 1, padding: 0 }}>&times;</button>
                    </div>
                  ))}
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <input type="time" value={newTime} onChange={e => setNewTime(e.target.value)} style={{ padding: "5px 8px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13 }} />
                    <button onClick={() => { if (!scraping.times.includes(newTime)) setScraping(s => ({ ...s, times: [...s.times, newTime].sort() })); }} style={{ padding: "5px 12px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 13, cursor: "pointer" }}>+ Adicionar</button>
                  </div>
                </div>
              </div>
            )}
          </div>

          <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: 16 }}>
            <div style={{ fontWeight: 500, marginBottom: 4 }}>Modo de entrada na fila</div>
            <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 12 }}>Como os produtos encontrados entram na fila de envio</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {[
                { id: "auto", label: "Automático", desc: "Produto aprovado pelos filtros entra direto na fila" },
                { id: "manual", label: "Revisão manual", desc: "Você aprova cada produto antes de entrar na fila" },
                { id: "both", label: "Automático com revisão", desc: "Entra na fila, mas você pode rejeitar antes do envio", recommended: true },
              ].map(opt => (
                <div key={opt.id} onClick={() => setScraping(s => ({ ...s, mode: opt.id }))} style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "10px 12px", borderRadius: 10, border: `0.5px solid ${scraping.mode === opt.id ? PRIMARY : "var(--color-border-tertiary)"}`, background: scraping.mode === opt.id ? PRIMARY_LIGHT : "transparent", cursor: "pointer" }}>
                  <div style={{ width: 16, height: 16, borderRadius: "50%", border: `2px solid ${scraping.mode === opt.id ? PRIMARY : "var(--color-border-secondary)"}`, background: scraping.mode === opt.id ? PRIMARY : "transparent", flexShrink: 0, marginTop: 1 }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 500, color: scraping.mode === opt.id ? PRIMARY_DARK : "var(--color-text-primary)", display: "flex", alignItems: "center", gap: 6 }}>
                      {opt.label}
                      {opt.recommended && <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 4, background: "#EAF3DE", color: "#3B6D11", fontWeight: 500 }}>Recomendado</span>}
                    </div>
                    <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>{opt.desc}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div style={{ display: "flex", gap: 10 }}>
            <button onClick={save} style={{ padding: "9px 24px", borderRadius: 8, background: saved ? "#3B6D11" : PRIMARY, color: "#fff", border: "none", fontSize: 13, cursor: "pointer", fontWeight: 500 }}>{saved ? "✓ Salvo!" : "Salvar configurações"}</button>
            <button onClick={runScraping} disabled={scrapingRunning} style={{ padding: "9px 18px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 13, cursor: "pointer", opacity: scrapingRunning ? 0.6 : 1 }}>{scrapingRunning ? "⟳ Buscando..." : "⟳ Executar scraping agora"}</button>
          </div>
        </div>
      )}

      {tab === "queue" && (
        <div>
          <div style={{ display: "flex", flexDirection: "column", gap: 14, marginBottom: 20 }}>
            <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: 16 }}>
              <div style={{ fontWeight: 500, marginBottom: 4 }}>Fontes de busca</div>
              <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 12 }}>
                Selecione as lojas onde a campanha vai procurar ofertas.
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {allSources.map(src => {
                  const active = scraping.sources.includes(src);
                  return <div key={src} onClick={() => setScraping(s => ({ ...s, sources: active ? s.sources.filter(x => x !== src) : [...s.sources, src] }))} style={{ padding: "6px 14px", borderRadius: 8, border: `0.5px solid ${active ? PRIMARY : "var(--color-border-tertiary)"}`, background: active ? PRIMARY_LIGHT : "transparent", color: active ? PRIMARY_DARK : "var(--color-text-secondary)", fontSize: 13, cursor: "pointer", fontWeight: active ? 500 : 400 }}>{active ? "✓ " : ""}{src}</div>;
                })}
              </div>
              {scraping.sources.length === 0 && (
                <div style={{ marginTop: 10, fontSize: 11, color: "#A32D2D" }}>Selecione ao menos uma fonte para o scraping funcionar.</div>
              )}
            </div>

            <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: 16 }}>
              <div style={{ fontWeight: 500, marginBottom: 4 }}>Palavras-chave</div>
              <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 10 }}>
                Separe por vírgula. Apenas produtos cujo nome contenha <strong>pelo menos uma</strong> das palavras serão considerados. Deixe vazio para aceitar todos.
              </div>
              <textarea
                value={scraping.filters.keywords}
                onChange={e => setScraping(s => ({ ...s, filters: { ...s.filters, keywords: e.target.value } }))}
                rows={2}
                placeholder="Ex: notebook, monitor, fone bluetooth, ssd"
                style={{ width: "100%", padding: "9px 12px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13, resize: "vertical", boxSizing: "border-box", fontFamily: "inherit" }}
              />
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

            <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: 16 }}>
              <div style={{ fontWeight: 500, marginBottom: 4 }}>Filtros de qualidade</div>
              <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 16 }}>
                Produtos que não atenderem a <strong>todos</strong> os critérios serão ignorados.
              </div>
              <div className="grid-collapse" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
                {[
                  { label: "Desconto mínimo", key: "minDiscount", min: 0, max: 80, unit: "%", step: 5 },
                  { label: "Preço máximo", key: "maxPrice", min: 50, max: 10000, unit: "R$", step: 50, prefix: true },
                  { label: "Avaliação mínima", key: "minRating", min: 1, max: 5, unit: "★", step: 0.1 },
                  { label: "Vendas mínimas", key: "minSales", min: 0, max: 1000, unit: " vendas", step: 10 },
                ].map(({ label, key, min, max, unit, step, prefix }) => (
                  <div key={key}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                      <label style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>{label}</label>
                      <span style={{ fontSize: 13, fontWeight: 500 }}>{prefix ? `${unit} ${scraping.filters[key].toLocaleString("pt-BR")}` : `${scraping.filters[key]}${unit}`}</span>
                    </div>
                    <input type="range" min={min} max={max} step={step} value={scraping.filters[key]} onChange={e => setScraping(s => ({ ...s, filters: { ...s.filters, [key]: Number(e.target.value) } }))} style={{ width: "100%" }} />
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--color-text-secondary)", marginTop: 2 }}>
                      <span>{prefix ? `${unit} ${min}` : `${min}${unit}`}</span><span>{prefix ? `${unit} ${max.toLocaleString("pt-BR")}` : `${max}${unit}`}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button onClick={save} style={{ padding: "9px 24px", borderRadius: 8, background: saved ? "#3B6D11" : PRIMARY, color: "#fff", border: "none", fontSize: 13, cursor: "pointer", fontWeight: 500 }}>{saved ? "✓ Salvo!" : "Salvar configurações"}</button>
              <button onClick={runScraping} disabled={scrapingRunning} style={{ padding: "9px 18px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 13, cursor: "pointer", opacity: scrapingRunning ? 0.6 : 1 }}>{scrapingRunning ? "⟳ Buscando..." : "⟳ Buscar produtos agora"}</button>
            </div>
          </div>

          {pending.length > 0 && (
            <div style={{ marginBottom: 20 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 500 }}>Aguardando revisão</div>
                  <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 2 }}>Produtos do scraping que precisam de aprovação</div>
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  <button onClick={() => { [...pending].forEach(p => approveProduct(p.id)); }} style={{ padding: "5px 12px", borderRadius: 7, background: PRIMARY_LIGHT, color: PRIMARY_DARK, border: `0.5px solid ${PRIMARY}`, fontSize: 12, cursor: "pointer", fontWeight: 500 }}>Aprovar todos</button>
                  <button onClick={() => setPending([])} style={{ padding: "5px 12px", borderRadius: 7, background: "#FCEBEB", color: "#A32D2D", border: "0.5px solid #F7C1C1", fontSize: 12, cursor: "pointer" }}>Rejeitar todos</button>
                </div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {pending.map(p => (
                  <ProductRow
                    key={p.id}
                    product={p}
                    actions={<>
                      <button onClick={() => approveProduct(p.id)} style={{ padding: "5px 12px", borderRadius: 7, background: PRIMARY_LIGHT, color: PRIMARY_DARK, border: `0.5px solid ${PRIMARY}`, fontSize: 12, cursor: "pointer", fontWeight: 500 }}>Aprovar</button>
                      <button onClick={() => rejectProduct(p.id)} style={{ padding: "5px 10px", borderRadius: 7, border: "0.5px solid #F7C1C1", background: "#FCEBEB", color: "#A32D2D", fontSize: 12, cursor: "pointer" }}>Rejeitar</button>
                    </>}
                  />
                ))}
              </div>
              <div style={{ margin: "20px 0 12px", borderTop: "0.5px solid var(--color-border-tertiary)" }} />
            </div>
          )}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 2 }}>Fila de envio</div>
              <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>{queue.length} produto{queue.length !== 1 ? "s" : ""} agendados</div>
            </div>
            {queue.length > 0 && (
              <button onClick={() => setQueue([])} style={{ padding: "5px 12px", borderRadius: 7, background: "#FCEBEB", color: "#A32D2D", border: "0.5px solid #F7C1C1", fontSize: 12, cursor: "pointer" }}>Limpar fila</button>
            )}
          </div>
          {queue.length === 0 ? (
            <div style={{ textAlign: "center", padding: "40px 0", color: "var(--color-text-secondary)", fontSize: 13, background: "var(--color-background-secondary)", borderRadius: 12 }}>Fila vazia. Execute o scraping para adicionar produtos.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {queue.map((item, idx) => (
                <ProductRow
                  key={item.id}
                  product={item}
                  index={idx + 1}
                  actions={
                    <button onClick={() => removeFromQueue(item.id)} style={{ padding: "5px 10px", borderRadius: 7, border: "0.5px solid #F7C1C1", background: "#FCEBEB", color: "#A32D2D", fontSize: 12, cursor: "pointer", flexShrink: 0 }}>Remover</button>
                  }
                />
              ))}
            </div>
          )}
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
                {[["Início", "from", "time"], ["Fim", "to", "time"], ["Intervalo", "interval", "select"]].map(([label, field, type]) => (
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
          <button onClick={save} style={{ padding: "9px 24px", borderRadius: 8, background: saved ? "#3B6D11" : PRIMARY, color: "#fff", border: "none", fontSize: 13, cursor: "pointer", fontWeight: 500, alignSelf: "flex-start" }}>{saved ? "✓ Salvo!" : "Salvar configurações"}</button>
        </div>
      )}

      {tab === "history" && (
        <div>
          <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 14 }}>Histórico de envios</div>
          {group.history.length === 0
            ? <div style={{ textAlign: "center", padding: "40px 0", color: "var(--color-text-secondary)", fontSize: 13, background: "var(--color-background-secondary)", borderRadius: 12 }}>Nenhum envio registrado.</div>
            : <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, overflow: "hidden" }}>
              {group.history.map((h, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", borderBottom: i < group.history.length - 1 ? "0.5px solid var(--color-border-tertiary)" : "none" }}>
                  <div style={{ fontSize: 11, color: "var(--color-text-secondary)", minWidth: 44 }}>{h.time}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{h.name}</div>
                    <div style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>{h.store}</div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontSize: 13, fontWeight: 500, color: PRIMARY_DARK }}>{h.price}</div>
                    <Badge color="green">-{h.discount}</Badge>
                  </div>
                </div>
              ))}
            </div>
          }
        </div>
      )}
    </div>
  );
}
