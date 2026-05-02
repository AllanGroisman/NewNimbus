import { useState } from "react";
import { PRIMARY, PRIMARY_DARK, PRIMARY_LIGHT, categoryColor, getGroupCategories } from "../data/constants";
import Badge from "../components/ui/Badge";
import Modal from "../components/ui/Modal";
import WhatsappQR from "../components/WhatsappQR";
import { deleteWASession, startWASession, createWAGroup, leaveWAGroup, listWAGroups } from "../data/api";

export default function PageWhatsApp({
  numbers, setNumbers,
  groups, whatsappGroups,
  onCreateWhatsappGroup, onDeleteWhatsappGroup, onSetWhatsappGroupStatus,
}) {
  const [showQR, setShowQR] = useState(null); // sessionId em conexão | "new" | null
  const [newLabel, setNewLabel] = useState("");
  const [confirmDisconnect, setConfirmDisconnect] = useState(null);
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [confirmDeleteGroup, setConfirmDeleteGroup] = useState(null);
  const [groupForm, setGroupForm] = useState({ name: "", numberIds: numbers[0]?.id ? [numbers[0].id] : [], participants: "", linkToAppGroupId: "" });
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [createError, setCreateError] = useState(null);
  const [filterNumber, setFilterNumber] = useState("all");
  const [pendingNumberId, setPendingNumberId] = useState(null); // id local enquanto aguarda QR
  const [pendingLabel, setPendingLabel] = useState("");

  // Importar grupos existentes do WhatsApp
  const [showImport, setShowImport] = useState(false);
  const [importNumberId, setImportNumberId] = useState(numbers[0]?.id || "");
  const [importGroups, setImportGroups] = useState([]);
  const [importLoading, setImportLoading] = useState(false);
  const [importError, setImportError] = useState(null);
  const [importSelected, setImportSelected] = useState(new Set());
  const [importFilter, setImportFilter] = useState("");
  const [importLinkToAppGroupId, setImportLinkToAppGroupId] = useState("");
  const [importing, setImporting] = useState(false);

  // Desconecta (logout no Baileys e remove auth_state). O número some da lista.
  const disconnect = async (id) => {
    try { await deleteWASession(id); } catch {}
    setNumbers(ns => ns.filter(n => n.id !== id));
    setConfirmDisconnect(null);
  };

  // Reabre o QR para um número que perdeu sessão
  const reconnect = async (id) => {
    setPendingNumberId(id);
    setShowQR(id);
    try { await startWASession(id); } catch (err) { console.error(err); }
  };

  // Inicia o fluxo de adicionar um número novo
  const startAddNumber = () => {
    const newId = String(Date.now());
    setPendingNumberId(newId);
    setPendingLabel(newLabel || "Novo número");
    setShowQR("new");
  };

  // Callback chamado pelo WhatsappQR quando a conexão é estabelecida
  const handleConnected = (info) => {
    if (showQR === "new") {
      // Adiciona o novo número à lista
      setNumbers(ns => [...ns, {
        id: pendingNumberId,
        phone: info.phone ? `+${info.phone}` : "?",
        label: pendingLabel,
        status: "connected",
        lastActivity: "agora",
        waName: info.name || null,
      }]);
    } else {
      // Reconexão de número existente
      setNumbers(ns => ns.map(n => n.id === showQR ? { ...n, status: "connected", lastActivity: "agora", phone: info.phone ? `+${info.phone}` : n.phone } : n));
    }
    setShowQR(null);
    setNewLabel("");
    setPendingNumberId(null);
    setPendingLabel("");
  };

  // Cancela o fluxo de QR (apaga sessão pendente do backend)
  const cancelQR = async () => {
    if (showQR === "new" && pendingNumberId) {
      try { await deleteWASession(pendingNumberId); } catch {}
    }
    setShowQR(null);
    setPendingNumberId(null);
    setPendingLabel("");
  };

  // Cria grupo de fato no WhatsApp via Baileys (1 grupo por número selecionado)
  const submitCreateGroup = async () => {
    setCreateError(null);
    const selectedIds = groupForm.numberIds || [];
    if (!groupForm.name.trim() || selectedIds.length === 0) return;
    const parts = groupForm.participants
      .split(/[\n,;]/)
      .map(p => p.trim())
      .filter(Boolean);
    if (parts.length === 0) {
      setCreateError("Informe ao menos um participante (telefone com DDD).");
      return;
    }

    setCreatingGroup(true);
    const baseName = groupForm.name.trim();
    const useSuffix = selectedIds.length > 1;
    const linkId = groupForm.linkToAppGroupId ? Number(groupForm.linkToAppGroupId) : undefined;
    const errors = [];
    let createdAny = false;
    try {
      for (const numId of selectedIds) {
        const num = numbers.find(n => n.id === numId);
        const name = useSuffix && num ? `${baseName} — ${num.label}` : baseName;
        try {
          const result = await createWAGroup(numId, name, parts);
          onCreateWhatsappGroup({
            id: result.jid,
            name: result.name,
            numberId: Number(numId),
            members: result.participants.length + 1,
            inviteLink: result.inviteLink,
            linkToAppGroupId: linkId,
            skipBackend: true,
          });
          createdAny = true;
        } catch (err) {
          errors.push(`${num?.label || numId}: ${err.message}`);
        }
      }
      if (errors.length > 0) {
        setCreateError(`Falhou em ${errors.length} número(s):\n${errors.join("\n")}`);
        if (!createdAny) return;
      }
      setShowCreateGroup(false);
      setGroupForm({ name: "", numberIds: numbers[0]?.id ? [numbers[0].id] : [], participants: "", linkToAppGroupId: "" });
    } finally {
      setCreatingGroup(false);
    }
  };

  // Abre o modal de importar e busca grupos do número selecionado
  const openImport = async (numberId) => {
    const nid = numberId || numbers[0]?.id || "";
    setImportNumberId(nid);
    setImportGroups([]);
    setImportSelected(new Set());
    setImportFilter("");
    setImportLinkToAppGroupId("");
    setImportError(null);
    setShowImport(true);
    if (nid) await fetchImportGroups(nid);
  };

  const fetchImportGroups = async (numberId) => {
    setImportLoading(true);
    setImportError(null);
    try {
      const list = await listWAGroups(numberId);
      list.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
      setImportGroups(list);
    } catch (err) {
      setImportError(err.message || "Falha ao listar grupos");
      setImportGroups([]);
    } finally {
      setImportLoading(false);
    }
  };

  const toggleImport = (jid) => {
    setImportSelected(prev => {
      const next = new Set(prev);
      next.has(jid) ? next.delete(jid) : next.add(jid);
      return next;
    });
  };

  const submitImport = () => {
    if (importSelected.size === 0 || !importNumberId) return;
    setImporting(true);
    try {
      const linkId = importLinkToAppGroupId ? Number(importLinkToAppGroupId) : undefined;
      for (const jid of importSelected) {
        const g = importGroups.find(x => x.jid === jid);
        if (!g) continue;
        onCreateWhatsappGroup({
          id: g.jid,
          name: g.name,
          numberId: Number(importNumberId),
          members: g.members || 0,
          inviteLink: null,
          linkToAppGroupId: linkId,
        });
      }
      setShowImport(false);
    } finally {
      setImporting(false);
    }
  };

  // Sai do grupo no WhatsApp e remove do estado
  const handleDeleteGroup = async (wg) => {
    try { await leaveWAGroup(wg.numberId, wg.id); } catch (err) { console.error(err); }
    onDeleteWhatsappGroup(wg.id);
    setConfirmDeleteGroup(null);
  };

  // Mapa: whatsapp group id → lista de campanhas (grupos da app) que o usam
  const appGroupsByWG = whatsappGroups.reduce((acc, w) => {
    acc[w.id] = groups.filter(g => (g.whatsappGroupIds || []).includes(w.id));
    return acc;
  }, {});

  const visibleWGs = filterNumber === "all" ? whatsappGroups : whatsappGroups.filter(w => w.numberId === Number(filterNumber));

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20, flexWrap: "wrap", gap: 10 }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 500 }}>WhatsApp</h2>
          <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 4 }}>
            {numbers.filter(n => n.status === "connected").length}/{numbers.length} números · {whatsappGroups.length} grupos
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button onClick={() => openImport()} disabled={numbers.length === 0} title={numbers.length === 0 ? "Conecte um número primeiro" : "Importar grupos que já existem no seu WhatsApp"} style={{ padding: "7px 14px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 13, cursor: numbers.length === 0 ? "not-allowed" : "pointer", opacity: numbers.length === 0 ? 0.5 : 1 }}>↓ Importar grupos</button>
          <button onClick={() => setShowCreateGroup(true)} disabled={numbers.length === 0} title={numbers.length === 0 ? "Conecte um número primeiro" : ""} style={{ padding: "7px 14px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 13, cursor: numbers.length === 0 ? "not-allowed" : "pointer", opacity: numbers.length === 0 ? 0.5 : 1 }}>+ Criar grupo</button>
          <button onClick={startAddNumber} style={{ padding: "7px 14px", borderRadius: 8, background: PRIMARY, color: "#fff", border: "none", fontSize: 13, cursor: "pointer", fontWeight: 500 }}>+ Adicionar número</button>
        </div>
      </div>

      {/* Números */}
      <h3 style={{ fontSize: 14, fontWeight: 500, marginBottom: 10 }}>Números conectados</h3>
      {numbers.length === 0 && (
        <div style={{ textAlign: "center", padding: "30px 20px", background: "var(--color-background-secondary)", borderRadius: 12, border: "0.5px dashed var(--color-border-secondary)", marginBottom: 26 }}>
          <div style={{ fontSize: 24, marginBottom: 8 }}>📱</div>
          <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 4 }}>Conecte seu primeiro número</div>
          <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 12 }}>Adicione um número do WhatsApp para começar a criar grupos.</div>
          <button onClick={startAddNumber} style={{ padding: "8px 18px", borderRadius: 8, background: PRIMARY, color: "#fff", border: "none", fontSize: 13, cursor: "pointer", fontWeight: 500 }}>+ Adicionar número</button>
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 26 }}>
        {numbers.map(n => {
          const wgCount = whatsappGroups.filter(w => w.numberId === n.id).length;
          return (
            <div key={n.id} style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: "14px 16px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: n.status === "connected" ? PRIMARY : "#E24B4A" }} />
                    <span style={{ fontWeight: 500 }}>{n.label}</span>
                  </div>
                  <div style={{ fontSize: 13, color: "var(--color-text-secondary)", marginBottom: 6 }}>{n.phone}</div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <Badge color={n.status === "connected" ? "green" : "red"}>{n.status === "connected" ? "Conectado" : "Desconectado"}</Badge>
                    <Badge color="gray">{wgCount} grupo{wgCount !== 1 ? "s" : ""}</Badge>
                    <Badge color="gray">Atividade: {n.lastActivity}</Badge>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  {n.status === "connected"
                    ? <button onClick={() => setConfirmDisconnect(n.id)} style={{ padding: "6px 14px", borderRadius: 8, border: "0.5px solid #F7C1C1", background: "#FCEBEB", color: "#A32D2D", fontSize: 12, cursor: "pointer" }}>Desconectar</button>
                    : <button onClick={() => reconnect(n.id)} style={{ padding: "6px 14px", borderRadius: 8, background: PRIMARY, color: "#fff", border: "none", fontSize: 12, cursor: "pointer", fontWeight: 500 }}>Reconectar</button>
                  }
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Grupos do WhatsApp */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, gap: 10, flexWrap: "wrap" }}>
        <h3 style={{ fontSize: 14, fontWeight: 500 }}>Grupos do WhatsApp</h3>
        <select value={filterNumber} onChange={e => setFilterNumber(e.target.value)} style={{ padding: "6px 10px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-primary)", fontSize: 12 }}>
          <option value="all">Todos os números</option>
          {numbers.map(n => <option key={n.id} value={n.id}>{n.label} — {n.phone}</option>)}
        </select>
      </div>

      {visibleWGs.length === 0 ? (
        <div style={{ textAlign: "center", padding: "40px 0", color: "var(--color-text-secondary)", fontSize: 13, background: "var(--color-background-secondary)", borderRadius: 12 }}>
          Nenhum grupo encontrado. Crie um novo grupo para começar a enviar mensagens.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {visibleWGs.map(w => {
            const number = numbers.find(n => n.id === w.numberId);
            const linkedApps = appGroupsByWG[w.id] || [];
            return (
              <div key={w.id} style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: "12px 14px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 10 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
                      <span style={{ width: 7, height: 7, borderRadius: "50%", background: w.status === "connected" ? PRIMARY : "#E24B4A" }} />
                      <span style={{ fontWeight: 500, fontSize: 13 }}>{w.name}</span>
                      <span style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>· {w.members} membros</span>
                    </div>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                      <Badge color="purple">{number ? number.label : "Sem número"}</Badge>
                      {linkedApps.length === 0
                        ? <Badge color="gray">Sem campanha vinculada</Badge>
                        : linkedApps.map(g => {
                          const cat = getGroupCategories(g)[0];
                          return <Badge key={g.id} color={cat ? categoryColor(cat) : "gray"}>{g.name}</Badge>;
                        })
                      }
                      <span style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>Criado {w.createdAt}</span>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button
                      onClick={() => onSetWhatsappGroupStatus(w.id, w.status === "connected" ? "disconnected" : "connected")}
                      style={{ padding: "5px 12px", borderRadius: 7, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 12, cursor: "pointer" }}
                    >
                      {w.status === "connected" ? "Desconectar" : "Reconectar"}
                    </button>
                    <button
                      onClick={() => setConfirmDeleteGroup(w)}
                      style={{ padding: "5px 10px", borderRadius: 7, border: "0.5px solid #F7C1C1", background: "#FCEBEB", color: "#A32D2D", fontSize: 12, cursor: "pointer" }}
                    >Excluir</button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Modal QR (adicionar/reconectar número) — usa Baileys real */}
      {showQR && pendingNumberId && (
        <Modal title={showQR === "new" ? "Adicionar novo número" : "Reconectar número"} onClose={cancelQR}>
          {showQR === "new" && (
            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Apelido</label>
              <input value={pendingLabel} onChange={e => setPendingLabel(e.target.value)} placeholder="Ex: Principal, Trabalho..." style={{ width: "100%", padding: "9px 12px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13, boxSizing: "border-box" }} />
            </div>
          )}
          <WhatsappQR sessionId={pendingNumberId} onConnected={handleConnected} />
        </Modal>
      )}

      {/* Modal desconectar número */}
      {confirmDisconnect && (
        <Modal title="Desconectar número?" onClose={() => setConfirmDisconnect(null)}>
          <p style={{ fontSize: 13, marginBottom: 16, color: "var(--color-text-secondary)", lineHeight: 1.5 }}>
            Ao desconectar, os envios deste número serão interrompidos até que você reconecte novamente via QR Code. Grupos vinculados ficarão pausados.
          </p>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button onClick={() => setConfirmDisconnect(null)} style={{ padding: "8px 16px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 13, cursor: "pointer" }}>Cancelar</button>
            <button onClick={() => disconnect(confirmDisconnect)} style={{ padding: "8px 16px", borderRadius: 8, background: "#E24B4A", color: "#fff", border: "none", fontSize: 13, cursor: "pointer", fontWeight: 500 }}>Desconectar</button>
          </div>
        </Modal>
      )}

      {/* Modal criar grupo do WhatsApp */}
      {showCreateGroup && (
        <Modal title="Criar grupo no WhatsApp" onClose={() => setShowCreateGroup(false)}>
          <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 14, lineHeight: 1.5 }}>
            O grupo será criado de fato no WhatsApp. <strong>O WhatsApp exige pelo menos um participante</strong> além de você — informe os telefones (com DDD).
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div>
              <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Nome do grupo</label>
              <input value={groupForm.name} onChange={e => setGroupForm(f => ({ ...f, name: e.target.value }))} placeholder="Ex: Ofertas Tech BH" style={{ width: "100%", padding: "9px 12px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13, boxSizing: "border-box" }} />
            </div>
            <div>
              <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 6 }}>
                Números que vão criar <span style={{ color: "var(--color-text-tertiary, var(--color-text-secondary))" }}>(selecione um ou mais — cria 1 grupo por número)</span>
              </label>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 180, overflowY: "auto", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 8, padding: 8, background: "var(--color-background-secondary)" }}>
                {numbers.map(n => {
                  const checked = (groupForm.numberIds || []).includes(n.id);
                  const connected = n.status === "connected";
                  return (
                    <label key={n.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: 6, cursor: connected ? "pointer" : "not-allowed", opacity: connected ? 1 : 0.5, background: checked ? PRIMARY_LIGHT : "transparent" }}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!connected}
                        onChange={() => setGroupForm(f => {
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
              {(groupForm.numberIds || []).length > 1 && (
                <div style={{ fontSize: 11, color: PRIMARY_DARK, marginTop: 6 }}>
                  💡 Serão criados {groupForm.numberIds.length} grupos (sufixo com o apelido de cada número).
                </div>
              )}
            </div>
            <div>
              <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Participantes iniciais</label>
              <textarea
                value={groupForm.participants}
                onChange={e => setGroupForm(f => ({ ...f, participants: e.target.value }))}
                rows={3}
                placeholder="+5511999998888&#10;+5521988887777&#10;+5511977776666"
                style={{ width: "100%", padding: "9px 12px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13, boxSizing: "border-box", resize: "vertical", fontFamily: "inherit" }}
              />
              <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 4 }}>
                Um por linha (ou separados por vírgula). Inclua o código do país (+55).
              </div>
            </div>
            <div>
              <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Vincular a uma campanha (opcional)</label>
              <select value={groupForm.linkToAppGroupId} onChange={e => setGroupForm(f => ({ ...f, linkToAppGroupId: e.target.value }))} style={{ width: "100%", padding: "9px 12px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13 }}>
                <option value="">Nenhuma — vincular depois</option>
                {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </div>
            {createError && (
              <div style={{ background: "#FCEBEB", color: "#A32D2D", padding: "8px 10px", borderRadius: 8, fontSize: 12 }}>{createError}</div>
            )}
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 18 }}>
            <button onClick={() => setShowCreateGroup(false)} disabled={creatingGroup} style={{ padding: "8px 16px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 13, cursor: "pointer" }}>Cancelar</button>
            <button onClick={submitCreateGroup} disabled={!groupForm.name.trim() || (groupForm.numberIds || []).length === 0 || creatingGroup} style={{ padding: "8px 16px", borderRadius: 8, background: PRIMARY, color: "#fff", border: "none", fontSize: 13, cursor: "pointer", fontWeight: 500, opacity: (!groupForm.name.trim() || (groupForm.numberIds || []).length === 0 || creatingGroup) ? 0.5 : 1 }}>
              {creatingGroup ? "⟳ Criando..." : (groupForm.numberIds || []).length > 1 ? `Criar ${groupForm.numberIds.length} grupos` : "Criar grupo"}
            </button>
          </div>
        </Modal>
      )}

      {/* Modal importar grupos existentes do WhatsApp */}
      {showImport && (() => {
        const filter = importFilter.trim().toLowerCase();
        const existingJids = new Set(whatsappGroups.map(w => w.id));
        const filtered = importGroups.filter(g => !filter || (g.name || "").toLowerCase().includes(filter));
        const importable = filtered.filter(g => !existingJids.has(g.jid));
        return (
          <Modal title="Importar grupos do WhatsApp" onClose={() => setShowImport(false)}>
            <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 14, lineHeight: 1.5 }}>
              Mostra os grupos em que o número conectado já participa. Selecione os que você quer adicionar ao Nimbus para enviar ofertas.
            </div>
            <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
              <select value={importNumberId} onChange={e => { setImportNumberId(e.target.value); fetchImportGroups(e.target.value); }} style={{ flex: 1, minWidth: 160, padding: "8px 10px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13 }}>
                {numbers.map(n => <option key={n.id} value={n.id}>{n.label} — {n.phone}</option>)}
              </select>
              <input value={importFilter} onChange={e => setImportFilter(e.target.value)} placeholder="Buscar grupo..." style={{ flex: 1, minWidth: 160, padding: "8px 10px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13 }} />
            </div>

            {importLoading && (
              <div style={{ textAlign: "center", padding: 30, color: "var(--color-text-secondary)", fontSize: 13 }}>Carregando grupos do WhatsApp…</div>
            )}
            {importError && !importLoading && (
              <div style={{ background: "#FCEBEB", color: "#A32D2D", padding: "10px 12px", borderRadius: 8, fontSize: 12, marginBottom: 10 }}>{importError}</div>
            )}
            {!importLoading && !importError && filtered.length === 0 && (
              <div style={{ textAlign: "center", padding: 30, color: "var(--color-text-secondary)", fontSize: 13 }}>Nenhum grupo encontrado.</div>
            )}
            {!importLoading && filtered.length > 0 && (
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, fontSize: 11, color: "var(--color-text-secondary)" }}>
                <span>{filtered.length} grupo(s) · {importSelected.size} selecionado(s)</span>
                {importable.length > 0 && (
                  <button
                    onClick={() => {
                      const next = new Set(importSelected);
                      const allSelected = importable.every(g => next.has(g.jid));
                      if (allSelected) importable.forEach(g => next.delete(g.jid));
                      else importable.forEach(g => next.add(g.jid));
                      setImportSelected(next);
                    }}
                    style={{ background: "transparent", border: "none", color: PRIMARY, fontSize: 11, cursor: "pointer", padding: 0 }}
                  >
                    {importable.every(g => importSelected.has(g.jid)) ? "Limpar seleção" : "Selecionar todos visíveis"}
                  </button>
                )}
              </div>
            )}
            {!importLoading && filtered.length > 0 && (
              <div style={{ maxHeight: 320, overflowY: "auto", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 10, marginBottom: 12 }}>
                {filtered.map(g => {
                  const already = existingJids.has(g.jid);
                  const checked = importSelected.has(g.jid);
                  return (
                    <label key={g.jid} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderBottom: "0.5px solid var(--color-border-tertiary)", cursor: already ? "not-allowed" : "pointer", opacity: already ? 0.5 : 1 }}>
                      <input type="checkbox" checked={checked} disabled={already} onChange={() => toggleImport(g.jid)} style={{ width: 16, height: 16, cursor: already ? "not-allowed" : "pointer" }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g.name || "(sem nome)"}</div>
                        <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 2 }}>{g.members} membro{g.members !== 1 ? "s" : ""}{already ? " · já adicionado" : ""}</div>
                      </div>
                    </label>
                  );
                })}
              </div>
            )}

            {importSelected.size > 0 && groups.length > 0 && (
              <div style={{ marginBottom: 14 }}>
                <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Vincular a uma campanha (opcional)</label>
                <select value={importLinkToAppGroupId} onChange={e => setImportLinkToAppGroupId(e.target.value)} style={{ width: "100%", padding: "9px 12px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13 }}>
                  <option value="">Nenhuma — vincular depois</option>
                  {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
              </div>
            )}

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => setShowImport(false)} disabled={importing} style={{ padding: "8px 16px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 13, cursor: "pointer" }}>Cancelar</button>
              <button onClick={submitImport} disabled={importSelected.size === 0 || importing} style={{ padding: "8px 16px", borderRadius: 8, background: PRIMARY, color: "#fff", border: "none", fontSize: 13, cursor: importing ? "wait" : "pointer", fontWeight: 500, opacity: (importSelected.size === 0 || importing) ? 0.5 : 1 }}>
                {importing ? "Importando..." : `Importar ${importSelected.size > 0 ? `(${importSelected.size})` : ""}`}
              </button>
            </div>
          </Modal>
        );
      })()}

      {/* Modal excluir grupo do WhatsApp */}
      {confirmDeleteGroup && (
        <Modal title="Excluir grupo do WhatsApp?" onClose={() => setConfirmDeleteGroup(null)} danger>
          <p style={{ fontSize: 13, marginBottom: 12, color: "var(--color-text-secondary)", lineHeight: 1.5 }}>
            <strong style={{ color: "var(--color-text-primary)" }}>{confirmDeleteGroup.name}</strong> será removido e desvinculado de todas as campanhas. Os envios pendentes para este grupo serão cancelados.
          </p>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button onClick={() => setConfirmDeleteGroup(null)} style={{ padding: "8px 16px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 13, cursor: "pointer" }}>Cancelar</button>
            <button onClick={() => handleDeleteGroup(confirmDeleteGroup)} style={{ padding: "8px 16px", borderRadius: 8, background: "#E24B4A", color: "#fff", border: "none", fontSize: 13, cursor: "pointer", fontWeight: 500 }}>Excluir</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
