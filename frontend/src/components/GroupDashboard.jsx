import { useState } from "react";
import { PRIMARY, PRIMARY_DARK, PRIMARY_LIGHT, allSources, categoryLabel, categoryColor, formatPrice } from "../data/constants";
import { fetchOfertas } from "../data/api";
import Badge from "./ui/Badge";
import StatCard from "./ui/StatCard";
import MiniBar from "./ui/MiniBar";
import Toggle from "./ui/Toggle";
import Tabs from "./ui/Tabs";
import Modal from "./ui/Modal";
import { ProductRow } from "./ui/ProductCard";

export default function GroupDashboard({ group, numbers, onBack, onUpdate, onDelete }) {
  const [tab, setTab] = useState("overview");
  const [sched, setSched] = useState(group.schedule);
  const [scraping, setScraping] = useState(group.scraping);
  const [queue, setQueue] = useState(group.queue);
  const [pending, setPending] = useState(group.pending);
  const [groupInfo, setGroupInfo] = useState({ name: group.name, category: group.category, numberId: group.numberId, messageTemplate: group.messageTemplate });
  const [saved, setSaved] = useState(false);
  const [scrapingRunning, setScrapingRunning] = useState(false);
  const [newTime, setNewTime] = useState("08:00");
  const [showDelete, setShowDelete] = useState(false);

  const barColor = group.category === "gamer" ? "#378ADD" : PRIMARY;
  const catColor = categoryColor(group.category);
  const connectedNumber = numbers.find(n => n.id === groupInfo.numberId);

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
      const res = await fetchOfertas({ category: groupInfo.category, minDiscount, maxPrice, limit: 50, refresh: true });

      // Aplicar filtros client-side que o backend não suporta
      let filtered = res.products;
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
            <Badge color={catColor}>{categoryLabel(groupInfo.category)}</Badge>
            <Badge color={group.status === "connected" ? "green" : "red"}>{group.status === "connected" ? "Conectado" : "Desconectado"}</Badge>
            <Badge color="gray">{group.members} membros</Badge>
            {connectedNumber && <Badge color="purple">{"��"} {connectedNumber.label}</Badge>}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={runScraping} disabled={scrapingRunning} style={{ padding: "7px 14px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 13, cursor: "pointer", opacity: scrapingRunning ? 0.6 : 1 }}>
            {scrapingRunning ? "⟳ Buscando..." : "⟳ Buscar agora"}
          </button>
          <button style={{ padding: "7px 14px", borderRadius: 8, background: group.status === "connected" ? PRIMARY : "#E24B4A", color: "#fff", border: "none", fontSize: 13, cursor: "pointer", fontWeight: 500 }}>
            {group.status === "connected" ? "Enviar agora" : "Reconectar"}
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
            <div className="grid-collapse" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div>
                <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Nome do grupo</label>
                <input value={groupInfo.name} onChange={e => setGroupInfo(g => ({ ...g, name: e.target.value }))} style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13, boxSizing: "border-box" }} />
              </div>
              <div>
                <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Categoria</label>
                <select value={groupInfo.category} onChange={e => setGroupInfo(g => ({ ...g, category: e.target.value }))} style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13 }}>
                  <option value="gamer">Gamer</option>
                  <option value="bebe">Bebê</option>
                </select>
              </div>
            </div>
          </div>

          <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: 16 }}>
            <div style={{ fontWeight: 500, marginBottom: 4 }}>Número do WhatsApp</div>
            <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 14 }}>Qual número enviará as mensagens neste grupo</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {numbers.map(n => (
                <div key={n.id} onClick={() => setGroupInfo(g => ({ ...g, numberId: n.id }))} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: 10, border: `0.5px solid ${groupInfo.numberId === n.id ? PRIMARY : "var(--color-border-tertiary)"}`, background: groupInfo.numberId === n.id ? PRIMARY_LIGHT : "transparent", cursor: "pointer" }}>
                  <div style={{ width: 16, height: 16, borderRadius: "50%", border: `2px solid ${groupInfo.numberId === n.id ? PRIMARY : "var(--color-border-secondary)"}`, background: groupInfo.numberId === n.id ? PRIMARY : "transparent", flexShrink: 0 }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>{n.label} — {n.phone}</div>
                    <div style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>{n.groupsCount} grupo{n.groupsCount !== 1 ? "s" : ""} vinculados</div>
                  </div>
                  <Badge color={n.status === "connected" ? "green" : "red"}>{n.status === "connected" ? "Conectado" : "Desconectado"}</Badge>
                </div>
              ))}
            </div>
          </div>

          <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: 16 }}>
            <div style={{ fontWeight: 500, marginBottom: 4 }}>Modelo de mensagem</div>
            <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 10 }}>Use {"{produto}"}, {"{preco}"}, {"{preco_antigo}"}, {"{desconto}"}, {"{loja}"}, {"{link}"}</div>
            <textarea value={groupInfo.messageTemplate} onChange={e => setGroupInfo(g => ({ ...g, messageTemplate: e.target.value }))} style={{ width: "100%", padding: 10, borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13, resize: "vertical", minHeight: 130, boxSizing: "border-box", fontFamily: "inherit" }} placeholder="Se vazio, usa o modelo padrão das Configurações" />
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
              {[{ id: "auto", label: "Automático", desc: "Produto aprovado pelos filtros entra direto na fila" }, { id: "manual", label: "Revisão manual", desc: "Você aprova cada produto antes de entrar na fila" }, { id: "both", label: "Automático com revisão", desc: "Entra na fila, mas você pode rejeitar antes do envio" }].map(opt => (
                <div key={opt.id} onClick={() => setScraping(s => ({ ...s, mode: opt.id }))} style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "10px 12px", borderRadius: 10, border: `0.5px solid ${scraping.mode === opt.id ? PRIMARY : "var(--color-border-tertiary)"}`, background: scraping.mode === opt.id ? PRIMARY_LIGHT : "transparent", cursor: "pointer" }}>
                  <div style={{ width: 16, height: 16, borderRadius: "50%", border: `2px solid ${scraping.mode === opt.id ? PRIMARY : "var(--color-border-secondary)"}`, background: scraping.mode === opt.id ? PRIMARY : "transparent", flexShrink: 0, marginTop: 1 }} />
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 500, color: scraping.mode === opt.id ? PRIMARY_DARK : "var(--color-text-primary)" }}>{opt.label}</div>
                    <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>{opt.desc}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: 16 }}>
            <div style={{ fontWeight: 500, marginBottom: 12 }}>Fontes de busca</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {allSources.map(src => {
                const active = scraping.sources.includes(src);
                return <div key={src} onClick={() => setScraping(s => ({ ...s, sources: active ? s.sources.filter(x => x !== src) : [...s.sources, src] }))} style={{ padding: "6px 14px", borderRadius: 8, border: `0.5px solid ${active ? PRIMARY : "var(--color-border-tertiary)"}`, background: active ? PRIMARY_LIGHT : "transparent", color: active ? PRIMARY_DARK : "var(--color-text-secondary)", fontSize: 13, cursor: "pointer", fontWeight: active ? 500 : 400 }}>{src}</div>;
              })}
            </div>
          </div>

          <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: 16 }}>
            <div style={{ fontWeight: 500, marginBottom: 10 }}>Palavras-chave</div>
            <textarea value={scraping.filters.keywords} onChange={e => setScraping(s => ({ ...s, filters: { ...s.filters, keywords: e.target.value } }))} rows={2} style={{ width: "100%", padding: "9px 12px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13, resize: "vertical", boxSizing: "border-box", fontFamily: "inherit" }} />
          </div>

          <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: 16 }}>
            <div style={{ fontWeight: 500, marginBottom: 16 }}>Filtros de qualidade</div>
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

          <div style={{ display: "flex", gap: 10 }}>
            <button onClick={save} style={{ padding: "9px 24px", borderRadius: 8, background: saved ? "#3B6D11" : PRIMARY, color: "#fff", border: "none", fontSize: 13, cursor: "pointer", fontWeight: 500 }}>{saved ? "✓ Salvo!" : "Salvar configurações"}</button>
            <button onClick={runScraping} disabled={scrapingRunning} style={{ padding: "9px 18px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 13, cursor: "pointer", opacity: scrapingRunning ? 0.6 : 1 }}>{scrapingRunning ? "⟳ Buscando..." : "⟳ Executar scraping agora"}</button>
          </div>
        </div>
      )}

      {tab === "queue" && (
        <div>
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
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ fontSize: 14, fontWeight: 500 }}>Janelas de envio</div>
            <button onClick={addWindow} style={{ padding: "6px 12px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 13, cursor: "pointer" }}>+ Adicionar janela</button>
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
