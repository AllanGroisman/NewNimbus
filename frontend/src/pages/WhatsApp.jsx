import { useState, useRef, useEffect } from "react";
import { PRIMARY, PRIMARY_DARK } from "../data/constants";
import Badge from "../components/ui/Badge";
import UsageBadge from "../components/ui/UsageBadge";
import Modal from "../components/ui/Modal";
import Spinner from "../components/ui/Spinner";
import WhatsappQR from "../components/WhatsappQR";
import { deleteWASession, deleteWASessionKeepalive, testWASession, errText} from "../data/api";

// Mapeia o status cru da sessão (Baileys) pra rótulo + cor amigáveis.
const STATUS_UI = {
  connected:    { label: "Conectado",               dot: "#22C55E", badge: "green" },
  connecting:   { label: "Conectando...",           dot: "#F59E0B", badge: "amber" },
  awaiting_qr:  { label: "Aguardando leitura do QR", dot: "#F59E0B", badge: "amber" },
  disconnected: { label: "Desconectado",            dot: "#E24B4A", badge: "red" },
  logged_out:   { label: "Desconectado (relogar)",  dot: "#E24B4A", badge: "red" },
};
function statusUI(status) {
  return STATUS_UI[status] || STATUS_UI.disconnected;
}

// Uma linha do resultado do teste. `leg` é { ok, skipped?, error? } vindo do
// backend. Pulada (WhatsNimbus não conectado) não é falha: fica neutra.
function TestLine({ label, leg, note }) {
  const skipped = !leg.ok && leg.skipped;
  const icon = leg.ok ? "✓" : skipped ? "—" : "✗";
  const color = leg.ok ? "#22C55E" : skipped ? "var(--color-text-secondary)" : "var(--danger-text)";
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
      <span aria-hidden="true" style={{ color, fontWeight: 600, flexShrink: 0 }}>{icon}</span>
      <span>
        {label}: {leg.ok ? "ok" : (leg.error || "falhou")}
        {note ? <div style={{ marginTop: 2, opacity: 0.9 }}>{note}</div> : null}
      </span>
    </div>
  );
}

// O envio ter saído do servidor não quer dizer que o celular conseguiu abrir a
// mensagem. Quando ele não consegue, mostra "Aguardando mensagem…" e pede o reenvio
// — e o backend detecta isso (self.retried). Só falamos de entrega quando o backend
// sabe (self.deliveryKnown); sem isso, silêncio é melhor que um "entregue" mentiroso.
function selfNote(leg) {
  if (!leg || !leg.ok || !leg.deliveryKnown) return null;
  if (leg.retried) {
    return (
      <span style={{ color: "var(--danger-text)" }}>
        ⚠️ O aparelho não conseguiu ler a mensagem de primeira e pediu reenvio — é isso
        que aparece como “Aguardando mensagem. Essa ação pode levar alguns instantes”
        no celular. Reenviamos; se continuar assim, avise.
      </span>
    );
  }
  return <span>entregue, sem pedido de reenvio</span>;
}

// Bloco de resultado dentro do card. `result` pode ser o veredito das duas
// pernas ou { error } quando a requisição inteira falhou (rede, 402, cooldown).
function TestResult({ result, onDismiss }) {
  const failed = !!result.error || result.ok === false;
  return (
    <div
      role="status"
      style={{
        marginTop: 10, padding: "8px 10px", borderRadius: 8, fontSize: 12, lineHeight: 1.6,
        display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8,
        background: failed ? "var(--danger-bg)" : "var(--color-background-secondary)",
        border: `0.5px solid ${failed ? "var(--danger-border)" : "var(--color-border-tertiary)"}`,
        color: "var(--color-text-secondary)",
      }}
    >
      <div>
        {result.error ? (
          <div style={{ color: "var(--danger-text)" }}>{result.error}</div>
        ) : (
          <>
            <TestLine label="Envio pelo próprio número" leg={result.self || {}} note={selfNote(result.self)} />
            <TestLine label="DM do WhatsNimbus" leg={result.whatsnimbus || {}} />
          </>
        )}
      </div>
      <button
        onClick={onDismiss}
        aria-label="Fechar resultado do teste"
        style={{ background: "transparent", border: "none", cursor: "pointer", color: "inherit", fontSize: 16, lineHeight: 1, padding: 0 }}
      >&times;</button>
    </div>
  );
}

export default function PageWhatsApp({
  numbers, setNumbers,
  whatsappGroups = [],
  onRemoveNumber,
  onRelinkNumber,
  limits,
  planPausedIds = [],
  onActivatePlanPaused,
  // Status ao vivo das sessões — vem do poll único do App.jsx. Antes esta página
  // mantinha um poll próprio do MESMO endpoint: dois GETs a cada 8s por aba e,
  // ao contrário do App, sem recuo em 429 (com o QR aberto, que pede status a
  // cada 1,5s, isso chegava perto do teto de requisições do backend).
  liveStatus = {},
  stuckIds = {},
  liveLoaded = false,
}) {
  // Números pausados pelo plano (cancelamento/downgrade): a sessão continua de
  // pé — não perde o pareamento — mas nenhum envio sai por eles até o cliente
  // ativar de volta (trocando com um dos ativos).
  const isPlanPaused = (id) => planPausedIds.some(x => String(x) === String(id));
  const [showQR, setShowQR] = useState(null); // sessionId em conexão | "new" | null
  const [newLabel, setNewLabel] = useState("");
  const [confirmDisconnect, setConfirmDisconnect] = useState(null);
  const [confirmRemove, setConfirmRemove] = useState(null);
  const [pendingNumberId, setPendingNumberId] = useState(null);
  const [pendingLabel, setPendingLabel] = useState("");
  // Erro da última ação (desconectar/remover/reconectar). Mostrado numa faixa na
  // própria página — antes era um window.alert do navegador, que trava a tela e
  // destoa do resto do sistema.
  const [actionError, setActionError] = useState(null);
  // Teste de conexão por card: `testing` guarda o id em execução (um por vez) e
  // `testResult` o veredito das duas pernas por id. Nada de poll — o resultado é
  // pontual, resposta de um clique.
  const [testing, setTesting] = useState(null);
  const [testResult, setTestResult] = useState({});

  // Status efetivo de um número: prioriza o status ao vivo do servidor. Depois
  // que o poll carregou, número AUSENTE da lista significa que não existe sessão
  // no servidor — antes caía no `n.status` do estado salvo (quase sempre
  // "connected", escrito otimisticamente no connect) e a tela mentia.
  const effectiveStatus = (n) =>
    liveStatus[n.id] ?? (liveLoaded ? "disconnected" : (n.status || "disconnected"));

  // Sessão provisória em aberto (id `Date.now()` do fluxo de QR). Só o cancelQR
  // limpava: fechar a aba, recarregar ou trocar de página deixava no servidor uma
  // sessão que não existe em `numbers` — invisível na tela e impossível de
  // remover por lá, reciclando QR pra ninguém. Best-effort dos dois lados: aqui
  // avisamos o servidor; lá existe uma varredura de órfãs como rede de segurança.
  const pendingRef = useRef(null);
  useEffect(() => {
    pendingRef.current = (showQR && pendingNumberId) ? pendingNumberId : null;
  }, [showQR, pendingNumberId]);
  useEffect(() => {
    const bail = () => { if (pendingRef.current) deleteWASessionKeepalive(pendingRef.current); };
    window.addEventListener("beforeunload", bail);
    window.addEventListener("pagehide", bail);
    return () => {
      window.removeEventListener("beforeunload", bail);
      window.removeEventListener("pagehide", bail);
      bail(); // desmontou com o QR aberto (troca de página): limpa também
    };
  }, []);

  // Edição inline do apelido — { id, value } enquanto editando.
  const [editingLabel, setEditingLabel] = useState(null);
  const editInputRef = useRef(null);
  useEffect(() => {
    if (editingLabel && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingLabel?.id]);

  // Desconecta: faz logout no Baileys e limpa o auth_state, mas MANTÉM o número
  // na lista (status "desconectado"). Assim o numberId é preservado e, ao reconectar
  // via QR, os grupos vinculados continuam apontando pro mesmo número.
  const disconnect = async (id) => {
    setActionError(null);
    try {
      await deleteWASession(id);
    } catch (err) {
      setActionError(errText(err, "Não foi possível desconectar no servidor. Tente novamente."));
      return;
    }
    setNumbers(ns => ns.map(n => n.id === id ? { ...n, status: "disconnected", lastActivity: "—" } : n));
    setConfirmDisconnect(null);
  };

  // Remove o número por completo: limpa sessão no backend e apaga o número + seus
  // grupos vinculados (via App). Use quando não quiser mais esse número.
  const removeNumber = async (id) => {
    setActionError(null);
    try {
      await deleteWASession(id);
    } catch (err) {
      setActionError(errText(err, "Não foi possível remover a sessão no servidor. Tente novamente."));
      return;
    }
    onRemoveNumber?.(id);
    setConfirmRemove(null);
  };

  // Reabre o QR para um número que perdeu sessão. Limpa a sessão/credenciais
  // antigas ANTES de abrir o popup: um número em estado terminal (logout real ou
  // desconexão manual) tem creds inválidas/ausentes — reusá-las dispara 401 e
  // "Erro de conexão" sem nunca gerar QR. Começando limpo, o Baileys emite um QR
  // novo. O numberId (= telefone) é preservado, então os grupos vinculados
  // continuam apontando pro mesmo número. O WhatsappQR (autoStart) reabre a sessão.
  const reconnect = async (id) => {
    setActionError(null);
    try {
      await deleteWASession(id);
    } catch (err) {
      setActionError(errText(err, "Não foi possível limpar a sessão anterior no servidor. Tente novamente."));
      return;
    }
    setPendingNumberId(id);
    setShowQR(id);
  };

  // Inicia o fluxo de adicionar um número novo
  const startAddNumber = () => {
    const newId = String(Date.now());
    setPendingNumberId(newId);
    setPendingLabel(newLabel || "Novo número");
    setShowQR("new");
  };

  // Testa o número de verdade: o backend manda uma DM do próprio número pra ele
  // mesmo (prova que a sessão está ENVIANDO — o status "Conectado" da tela não
  // prova isso) e outra do WhatsNimbus pro número. Cada perna volta com seu
  // veredito; WhatsNimbus desconectado é informativo, não reprova.
  const runTest = async (id) => {
    setTesting(id);
    setTestResult(r => ({ ...r, [id]: null }));
    try {
      const res = await testWASession(id);
      setTestResult(r => ({ ...r, [id]: res }));
    } catch (err) {
      // Mensagem do servidor quando existe (ex.: o aviso de cooldown do 429).
      setTestResult(r => ({ ...r, [id]: { error: errText(err, "Não foi possível testar agora. Tente novamente.") } }));
    } finally {
      setTesting(t => (t === id ? null : t));
    }
  };

  // Callback chamado pelo WhatsappQR quando a conexão é estabelecida
  const handleConnected = (info) => {
    if (showQR === "new") {
      const phone = info.phone ? `+${info.phone}` : "?";
      // O id definitivo do número é o telefone (só dígitos) — o backend canonicaliza
      // a sessão Baileys pro mesmo id. Assim re-scan do mesmo número reusa o id e os
      // grupos nunca ficam órfãos. Fallback pro id provisório se o telefone não veio.
      const canonicalId = info.phone ? String(info.phone).replace(/\D/g, "") : pendingNumberId;
      // Re-vincula os grupos de qualquer número anterior do mesmo telefone (id volátil
      // antigo) pro id canônico e remove duplicados.
      const dup = numbers.find(n => phone !== "?" && n.phone === phone && n.id !== canonicalId);
      if (dup) onRelinkNumber?.(dup.id, canonicalId);
      setNumbers(ns => [
        ...ns.filter(n => n.id !== canonicalId && (!dup || n.id !== dup.id)),
        {
          id: canonicalId,
          phone,
          label: dup?.label || pendingLabel,
          status: "connected",
          lastActivity: "agora",
          waName: info.name || null,
        },
      ]);
    } else {
      setNumbers(ns => ns.map(n => n.id === showQR ? { ...n, status: "connected", lastActivity: "agora", phone: info.phone ? `+${info.phone}` : n.phone } : n));
    }
    setShowQR(null);
    setNewLabel("");
    setPendingNumberId(null);
    setPendingLabel("");
  };

  // Cancela o fluxo de QR. Fechou o popup sem conectar (tanto "novo" quanto
  // "reconectar"): apaga a sessão pendente no backend pra não deixar um QR
  // reciclando em loop — que apareceria como "Conectando..." eterno na lista.
  // No sucesso, quem fecha o modal é o handleConnected (não passa por aqui).
  const cancelQR = async () => {
    setActionError(null);
    if (pendingNumberId) {
      try {
        await deleteWASession(pendingNumberId);
      } catch (err) {
        setActionError((errText(err, "Não foi possível limpar a sessão pendente no servidor.")) + " Pode ter sobrado uma sessão pendente — verifique antes de tentar de novo.");
      }
    }
    setShowQR(null);
    setPendingNumberId(null);
    setPendingLabel("");
  };

  // Commit do apelido editado — só persiste se houver valor não-vazio
  const commitEditingLabel = () => {
    if (!editingLabel) return;
    const next = String(editingLabel.value || "").trim();
    if (next) {
      setNumbers(ns => ns.map(n => n.id === editingLabel.id ? { ...n, label: next } : n));
    }
    setEditingLabel(null);
  };

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20, flexWrap: "wrap", gap: 10 }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 500, display: "flex", alignItems: "center", gap: 8 }}>
            WhatsApp
            {/* O limite vale sobre os ATIVOS — pausados pelo plano não contam. */}
            <UsageBadge current={numbers.filter(n => !isPlanPaused(n.id)).length} limit={limits?.numbers} label="números ativos" />
          </h2>
          <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 4 }}>
            Gerencie os números aqui; grupos vão na aba de cada campanha.
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button onClick={startAddNumber} style={{ padding: "7px 14px", borderRadius: 8, background: PRIMARY, color: "#fff", border: "none", fontSize: 13, cursor: "pointer", fontWeight: 500 }}>+ Adicionar número</button>
        </div>
      </div>

      {actionError && (
        <div role="alert" style={{ background: "var(--danger-bg)", border: "0.5px solid var(--danger-border)", color: "var(--danger-text)", padding: "10px 14px", borderRadius: 8, fontSize: 13, marginBottom: 14, display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ flex: 1 }}>{actionError}</span>
          <button onClick={() => setActionError(null)} aria-label="Fechar aviso" style={{ background: "transparent", border: "none", cursor: "pointer", color: "inherit", fontSize: 18, lineHeight: 1, padding: 0 }}>&times;</button>
        </div>
      )}

      {/* Números */}
      <h3 style={{ fontSize: 14, fontWeight: 500, marginBottom: 10 }}>Números conectados</h3>
      {numbers.length === 0 && (
        <div style={{ textAlign: "center", padding: "30px 20px", background: "var(--color-background-secondary)", borderRadius: 12, border: "0.5px dashed var(--color-border-secondary)", marginBottom: 26 }}>
          <div style={{ fontSize: 24, marginBottom: 8 }}>📱</div>
          <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 4 }}>Conecte seu primeiro número</div>
          <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 12 }}>Adicione um número do WhatsApp pra começar a vincular grupos nas campanhas.</div>
          <button onClick={startAddNumber} style={{ padding: "8px 18px", borderRadius: 8, background: PRIMARY, color: "#fff", border: "none", fontSize: 13, cursor: "pointer", fontWeight: 500 }}>+ Adicionar número</button>
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {numbers.map(n => {
          const wgCount = whatsappGroups.filter(w => w.numberId === n.id).length;
          const isEditing = editingLabel?.id === n.id;
          const st = effectiveStatus(n);
          const ui = statusUI(st);
          const connected = st === "connected";
          // Reconexão em background (restart pós-scan, conflito, queda de rede) chega
          // como "connecting": mostramos spinner "Conectando...", sem o "Reconectar"
          // aparente. "awaiting_qr" NÃO entra aqui — significa "precisa escanear", um
          // estado acionável: cai no botão Reconectar (só ocorre com o popup aberto ou
          // numa sessão órfã que o usuário precisa retomar).
          const connecting = st === "connecting";
          // Preso reconectando: connecting há mais que o limiar → oferece "Reconectar".
          const stuck = connecting && !!stuckIds[n.id];
          const planPausedNumber = isPlanPaused(n.id);
          return (
            <div key={n.id} style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: "14px 16px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                    {connecting
                      ? <Spinner size={10} style={{ flexShrink: 0 }} />
                      : <span title={ui.label} style={{ width: 8, height: 8, borderRadius: "50%", background: ui.dot, flexShrink: 0 }} />}
                    {isEditing ? (
                      <input
                        ref={editInputRef}
                        value={editingLabel.value}
                        onChange={e => setEditingLabel(s => ({ ...s, value: e.target.value }))}
                        onBlur={commitEditingLabel}
                        onKeyDown={e => {
                          if (e.key === "Enter") commitEditingLabel();
                          else if (e.key === "Escape") setEditingLabel(null);
                        }}
                        placeholder="Apelido"
                        style={{ padding: "3px 8px", borderRadius: 6, border: `0.5px solid ${PRIMARY}`, background: "var(--color-background-secondary)", fontSize: 13, fontWeight: 500, minWidth: 140 }}
                      />
                    ) : (
                      <>
                        <span style={{ fontWeight: 500 }}>{n.label}</span>
                        <button
                          onClick={() => setEditingLabel({ id: n.id, value: n.label })}
                          title="Editar apelido"
                          aria-label={`Editar apelido de ${n.label}`}
                          style={{ background: "transparent", border: "none", cursor: "pointer", padding: "2px 4px", color: "var(--color-text-secondary)", fontSize: 12, borderRadius: 4 }}
                        >✎</button>
                      </>
                    )}
                  </div>
                  <div style={{ fontSize: 13, color: "var(--color-text-secondary)", marginBottom: 6 }}>{n.phone}</div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <Badge color={ui.badge}>{ui.label}</Badge>
                    {planPausedNumber && <Badge color="amber">Pausado pelo plano</Badge>}
                    {wgCount > 0 && <Badge color="gray">Em uso por {wgCount} grupo{wgCount !== 1 ? "s" : ""}</Badge>}
                    {n.lastActivity && <Badge color="gray">Atividade: {n.lastActivity}</Badge>}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  {planPausedNumber && (
                    <button
                      onClick={() => onActivatePlanPaused?.(n.id)}
                      title="Ativar este número dentro do seu plano (troca com um dos ativos)"
                      style={{ padding: "6px 14px", borderRadius: 8, border: "none", background: "var(--warn-text)", color: "var(--color-background-primary)", fontSize: 12, cursor: "pointer", fontWeight: 500 }}
                    >
                      ▶ Ativar
                    </button>
                  )}
                  {connected ? (
                    <>
                      <button
                        onClick={() => runTest(n.id)}
                        disabled={testing === n.id}
                        title="Envia uma mensagem de teste pra provar que este número está enviando"
                        style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 14px", borderRadius: 8, border: `0.5px solid ${PRIMARY}`, background: "transparent", color: PRIMARY, fontSize: 12, cursor: testing === n.id ? "default" : "pointer", fontWeight: 500, opacity: testing === n.id ? 0.7 : 1 }}
                      >
                        {testing === n.id ? <><Spinner size={12} /> Testando...</> : "Testar"}
                      </button>
                      <button onClick={() => setConfirmDisconnect(n.id)} style={{ padding: "6px 14px", borderRadius: 8, border: "0.5px solid var(--danger-border)", background: "var(--danger-bg)", color: "var(--danger-text)", fontSize: 12, cursor: "pointer" }}>Desconectar</button>
                    </>
                  ) : connecting ? (
                    <span style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--color-text-secondary)" }}>
                      <Spinner size={14} />
                      Conectando...
                      {stuck && (
                        <button onClick={() => reconnect(n.id)} style={{ background: "transparent", border: "none", color: PRIMARY, cursor: "pointer", fontSize: 12, padding: 0, textDecoration: "underline" }}>Reconectar</button>
                      )}
                    </span>
                  ) : (
                    <>
                      <button onClick={() => reconnect(n.id)} style={{ padding: "6px 14px", borderRadius: 8, background: PRIMARY, color: "#fff", border: "none", fontSize: 12, cursor: "pointer", fontWeight: 500 }}>Reconectar</button>
                      <button onClick={() => setConfirmRemove(n.id)} title="Remove o número e seus grupos" style={{ padding: "6px 14px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", color: "var(--color-text-secondary)", fontSize: 12, cursor: "pointer" }}>Remover</button>
                    </>
                  )}
                </div>
              </div>
              {testResult[n.id] && (
                <TestResult
                  result={testResult[n.id]}
                  onDismiss={() => setTestResult(r => ({ ...r, [n.id]: null }))}
                />
              )}
            </div>
          );
        })}
      </div>

      {numbers.length > 0 && (
        <div style={{ marginTop: 18, fontSize: 11, color: "var(--color-text-secondary)", padding: "8px 12px", background: "var(--color-background-secondary)", borderRadius: 8, lineHeight: 1.5 }}>
          💡 Para criar, vincular ou importar grupos do WhatsApp, vá na campanha desejada e use a aba <strong style={{ color: PRIMARY_DARK }}>Grupos</strong>.
        </div>
      )}

      {/* Modal QR (adicionar/reconectar número) — usa Baileys real */}
      {showQR && pendingNumberId && (
        <Modal title={showQR === "new" ? "Adicionar novo número" : "Reconectar número"} onClose={cancelQR} confirmOnClickOutside>
          {showQR === "new" && (
            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Apelido</label>
              <input value={pendingLabel} onChange={e => setPendingLabel(e.target.value)} placeholder="Ex: Principal, Trabalho..." style={{ width: "100%", padding: "9px 12px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13, boxSizing: "border-box" }} />
            </div>
          )}
          <WhatsappQR
            sessionId={pendingNumberId}
            onConnected={handleConnected}
            knownNumberIds={numbers.map(n => n.id)}
            defaultPhone={showQR === "new" ? "" : (numbers.find(n => n.id === showQR)?.phone || "")}
          />
        </Modal>
      )}

      {/* Modal desconectar número */}
      {confirmDisconnect && (
        <Modal title="Desconectar número?" onClose={() => setConfirmDisconnect(null)} danger>
          <p style={{ fontSize: 13, marginBottom: 16, color: "var(--color-text-secondary)", lineHeight: 1.5 }}>
            Os envios deste número serão interrompidos. O número e seus grupos vinculados <strong>continuam salvos</strong> — basta reconectar via QR Code depois que tudo volta a funcionar, sem precisar refazer os grupos.
          </p>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button onClick={() => setConfirmDisconnect(null)} style={{ padding: "8px 16px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 13, cursor: "pointer" }}>Cancelar</button>
            <button onClick={() => disconnect(confirmDisconnect)} style={{ padding: "8px 16px", borderRadius: 8, background: "#E24B4A", color: "#fff", border: "none", fontSize: 13, cursor: "pointer", fontWeight: 500 }}>Desconectar</button>
          </div>
        </Modal>
      )}

      {/* Modal remover número (apaga número + grupos vinculados) */}
      {confirmRemove && (() => {
        const wgCount = whatsappGroups.filter(w => w.numberId === confirmRemove).length;
        return (
          <Modal title="Remover número?" onClose={() => setConfirmRemove(null)} danger>
            <p style={{ fontSize: 13, marginBottom: 16, color: "var(--color-text-secondary)", lineHeight: 1.5 }}>
              O número será removido permanentemente{wgCount > 0 ? <> junto com <strong>{wgCount} grupo{wgCount !== 1 ? "s" : ""} vinculado{wgCount !== 1 ? "s" : ""}</strong></> : ""}. Esta ação não pode ser desfeita. Para apenas pausar os envios, use <strong>Desconectar</strong>.
            </p>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => setConfirmRemove(null)} style={{ padding: "8px 16px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 13, cursor: "pointer" }}>Cancelar</button>
              <button onClick={() => removeNumber(confirmRemove)} style={{ padding: "8px 16px", borderRadius: 8, background: "#E24B4A", color: "#fff", border: "none", fontSize: 13, cursor: "pointer", fontWeight: 500 }}>Remover</button>
            </div>
          </Modal>
        );
      })()}
    </div>
  );
}
