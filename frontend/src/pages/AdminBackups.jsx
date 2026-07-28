import { useState, useEffect, useCallback, useRef } from "react";
import { PRIMARY, PRIMARY_DARK, PRIMARY_LIGHT } from "../data/constants";
import Modal from "../components/ui/Modal";
import {
  adminBackupsLocal,
  adminBackupsRemote,
  adminCreateLocalBackup,
  adminPushBackup,
  adminRestoreBackup,
  adminDeleteLocalBackup,
  adminDeleteRemoteBackup,
} from "../data/api";

const BACKUPS_POLL_MS = 20 * 1000;

function fmtSize(bytes) {
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function nameToDate(name) {
  // db-20260522-183000.sql.gz → "2026-05-22 18:30"
  const m = name.match(/db-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})/);
  if (!m) return name;
  return `${m[3]}/${m[2]}/${m[1].slice(2)} ${m[4]}:${m[5]}`;
}

const s = {
  btn: (variant = "default", disabled) => ({
    padding: "5px 11px", borderRadius: 6, fontSize: 11, cursor: disabled ? "default" : "pointer",
    fontWeight: 500, opacity: disabled ? 0.45 : 1, transition: "opacity .15s",
    ...(variant === "default" && { border: "0.5px solid var(--color-border-secondary)", background: "transparent", color: "var(--color-text-primary)" }),
    ...(variant === "primary" && { border: `0.5px solid ${PRIMARY}`, background: PRIMARY_LIGHT, color: PRIMARY_DARK }),
    ...(variant === "danger"  && { border: "0.5px solid var(--danger-border)", background: "var(--danger-bg)", color: "var(--danger-text)" }),
    ...(variant === "success" && { border: "0.5px solid var(--success-border)", background: "var(--success-bg)", color: "var(--success-text)" }),
    ...(variant === "solid"   && { border: "none", background: PRIMARY, color: "#fff" }),
  }),
};

function BackupRow({ item, source, busy, onRestore, onPush, onDelete }) {
  const isBusy = busy[`${source}:${item.name}`];
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 12px", borderBottom: "0.5px solid var(--color-border-tertiary)", flexWrap: "wrap" }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 500, fontFamily: "monospace", color: "var(--color-text-primary)", marginBottom: 2 }}>{nameToDate(item.name)}</div>
        <div style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>{item.name} · {fmtSize(item.size)}</div>
      </div>
      <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
        {onPush && (
          <button disabled={isBusy} onClick={() => onPush(item)} style={s.btn("primary", isBusy)}>
            ↑ Enviar
          </button>
        )}
        <button disabled={isBusy} onClick={() => onRestore(item, source)} style={s.btn("success", isBusy)}>
          ▶ Restaurar
        </button>
        {onDelete && (
          <button disabled={isBusy} onClick={() => onDelete(item, source)} style={s.btn("danger", isBusy)}>
            Excluir
          </button>
        )}
      </div>
    </div>
  );
}

export default function PageAdminBackups() {
  const [local,   setLocal]   = useState([]);
  const [remote,  setRemote]  = useState([]);
  const [b2ok,    setB2ok]    = useState(false);
  const [remoteWritable, setRemoteWritable] = useState(true); // false no modo ngrok (só leitura)
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);
  const [toast,   setToast]   = useState(null);
  const [busy,    setBusy]    = useState({});   // "local:filename" | "remote:filename" → true
  const [creating,setCreating]= useState(false);
  // Espelham busy/creating pro polling de fundo ler o valor atual sem re-criar o timer.
  const busyRef = useRef(busy);
  useEffect(() => { busyRef.current = busy; }, [busy]);
  const creatingRef = useRef(creating);
  useEffect(() => { creatingRef.current = creating; }, [creating]);

  // Confirm modal
  const [confirm, setConfirm] = useState(null); // { action, item, source, label, danger }

  // Restore countdown (após restaurar, backend reinicia)
  const [restartCountdown, setRestartCountdown] = useState(0);
  useEffect(() => {
    if (restartCountdown <= 0) return;
    if (restartCountdown === 1) { setTimeout(() => window.location.reload(), 1000); }
    const t = setTimeout(() => setRestartCountdown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [restartCountdown]);

  const showToast = (msg, isError = false) => {
    setToast({ msg, isError });
    setTimeout(() => setToast(null), 5000);
  };

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [loc, rem] = await Promise.all([adminBackupsLocal(), adminBackupsRemote()]);
      setLocal(loc.items || []);
      setB2ok(rem.ok !== false);
      setRemoteWritable(rem.writable !== false);
      setRemote(rem.items || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Polling de fundo — backups/restores feitos em outra aba/sessão (ou via cron)
  // só apareciam com F5. Pausa com a aba oculta e enquanto uma ação local (criar/
  // enviar/excluir/restaurar) já está em andamento, pra não disputar com refresh().
  useEffect(() => {
    let cancelled = false;
    let timer = null;
    async function tick() {
      const idle = Object.keys(busyRef.current).length === 0 && !creatingRef.current;
      if (!cancelled && !document.hidden && idle) {
        try {
          const [loc, rem] = await Promise.all([adminBackupsLocal(), adminBackupsRemote()]);
          if (!cancelled) {
            setLocal(loc.items || []);
            setB2ok(rem.ok !== false);
            setRemoteWritable(rem.writable !== false);
            setRemote(rem.items || []);
          }
        } catch { /* mantém a última lista conhecida */ }
      }
      if (!cancelled) timer = setTimeout(tick, BACKUPS_POLL_MS);
    }
    timer = setTimeout(tick, BACKUPS_POLL_MS);
    const onVisibility = () => { if (!document.hidden) { clearTimeout(timer); tick(); } };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  function withBusy(key, fn) {
    setBusy(b => ({ ...b, [key]: true }));
    return fn().then(
      () => { setBusy(b => ({ ...b, [key]: false })); refresh(); },
      (err) => { setBusy(b => ({ ...b, [key]: false })); showToast(err.message, true); }
    );
  }

  async function handleCreate() {
    setCreating(true);
    setError(null);
    try {
      const r = await adminCreateLocalBackup();
      showToast(`Backup criado: ${r.backup?.name || "OK"}`);
      await refresh();
    } catch (err) {
      showToast(err.message, true);
    } finally {
      setCreating(false);
    }
  }

  function askConfirm(action, item, source) {
    const labels = {
      restore: { label: `Restaurar backup de ${nameToDate(item.name)}?`, danger: true,
        body: `O banco de dados atual será SOBRESCRITO por este backup. O backend reiniciará automaticamente após a restauração. Esta ação não pode ser desfeita.` },
      push:    { label: `Enviar "${item.name}" ao Backblaze?`, danger: false,
        body: `O arquivo local será enviado ao Backblaze. Se já existir um arquivo com o mesmo nome, ele será sobrescrito.` },
      delete:  { label: `Excluir "${item.name}"?`, danger: true,
        body: source === "local" ? "O arquivo será removido do disco local permanentemente." : "O arquivo será removido do Backblaze permanentemente." },
    };
    setConfirm({ action, item, source, ...labels[action] });
  }

  async function executeConfirm() {
    if (!confirm) return;
    const { action, item, source } = confirm;
    setConfirm(null);
    const key = `${source}:${item.name}`;

    if (action === "restore") {
      setBusy(b => ({ ...b, [key]: true }));
      try {
        await adminRestoreBackup(source, item.name);
        showToast("Banco restaurado! Backend reiniciando...");
        setRestartCountdown(8);
      } catch (err) {
        showToast(err.message, true);
      } finally {
        setBusy(b => ({ ...b, [key]: false }));
      }
    } else if (action === "push") {
      withBusy(key, () => adminPushBackup(item.name).then(() => showToast("Enviado ao Backblaze!")));
    } else if (action === "delete") {
      const fn = source === "local" ? adminDeleteLocalBackup : adminDeleteRemoteBackup;
      withBusy(key, () => fn(item.name).then(() => showToast("Excluído.")));
    }
  }

  const latestLocal  = local[0]?.name;
  const latestRemote = remote[0]?.name;
  const inSync = latestLocal && latestRemote && latestLocal === latestRemote;
  const localNewer  = latestLocal && latestRemote && latestLocal > latestRemote;
  const remoteNewer = latestLocal && latestRemote && latestRemote > latestLocal;

  return (
    <div style={{ maxWidth: 900 }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16, flexWrap: "wrap", gap: 10 }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 500, margin: 0 }}>Backups</h2>
          <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 4, display: "flex", gap: 12, flexWrap: "wrap" }}>
            <span>{local.length} local{local.length !== 1 ? "is" : ""}</span>
            {b2ok ? <span>{remote.length} no Backblaze</span> : <span style={{ color: "#B45309" }}>Backblaze não configurado</span>}
            {inSync    && <span style={{ color: "var(--success-text)" }}>✓ Sincronizado</span>}
            {localNewer  && <span style={{ color: "#B45309" }}>▲ Local mais novo</span>}
            {remoteNewer && <span style={{ color: "#B45309" }}>▼ Remoto mais novo</span>}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={refresh} disabled={loading} style={s.btn("default", loading)}>
            ⟳ Atualizar
          </button>
          <button onClick={handleCreate} disabled={creating || loading} style={s.btn("solid", creating || loading)}>
            {creating ? "Criando..." : "+ Criar backup"}
          </button>
        </div>
      </div>

      {/* Restart countdown */}
      {restartCountdown > 0 && (
        <div style={{ background: "var(--warn-bg)", border: "0.5px solid var(--warn-border)", color: "var(--warn-text)", padding: "12px 14px", borderRadius: 10, marginBottom: 14, fontSize: 13, fontWeight: 500 }}>
          ⏳ Backend reiniciando... página será atualizada em {restartCountdown}s
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div style={{ background: toast.isError ? "var(--danger-bg)" : "var(--success-bg)", color: toast.isError ? "var(--danger-text)" : "var(--success-text)", border: `0.5px solid ${toast.isError ? "var(--danger-border)" : "var(--success-border)"}`, padding: "10px 14px", borderRadius: 10, marginBottom: 14, fontSize: 13 }}>
          {toast.msg}
        </div>
      )}

      {error && (
        <div style={{ background: "var(--danger-bg)", color: "var(--danger-text)", padding: "10px 12px", borderRadius: 8, fontSize: 13, marginBottom: 14 }}>
          {error}
        </div>
      )}

      {creating && (
        <div style={{ background: "var(--info-bg)", border: "0.5px solid var(--info-border)", color: "var(--info-text)", padding: "10px 14px", borderRadius: 10, marginBottom: 14, fontSize: 13 }}>
          ⏳ Gerando dump do banco... isso pode levar alguns segundos.
        </div>
      )}

      {/* Conteúdo */}
      {loading && local.length === 0 ? (
        <div style={{ textAlign: "center", padding: 40, color: "var(--color-text-secondary)", fontSize: 13 }}>Carregando...</div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>

          {/* Coluna Local */}
          <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, overflow: "hidden" }}>
            <div style={{ padding: "12px 14px", borderBottom: "0.5px solid var(--color-border-tertiary)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>Local</div>
                <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 2 }}>backend/backups/ · {local.length} arquivo{local.length !== 1 ? "s" : ""}</div>
              </div>
            </div>
            {local.length === 0 ? (
              <div style={{ padding: 24, textAlign: "center", color: "var(--color-text-secondary)", fontSize: 12 }}>
                Nenhum backup local.<br />
                <span style={{ fontSize: 11 }}>Clique em "+ Criar backup" para gerar um.</span>
              </div>
            ) : (
              local.map(item => (
                <BackupRow
                  key={item.name}
                  item={item}
                  source="local"
                  busy={busy}
                  onRestore={(i, src) => askConfirm("restore", i, src)}
                  onPush={b2ok && remoteWritable ? (i) => askConfirm("push", i, "local") : null}
                  onDelete={(i, src) => askConfirm("delete", i, src)}
                />
              ))
            )}
          </div>

          {/* Coluna Remoto */}
          <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, overflow: "hidden" }}>
            <div style={{ padding: "12px 14px", borderBottom: "0.5px solid var(--color-border-tertiary)" }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>
                Backblaze
                {b2ok && !remoteWritable && (
                  <span style={{ fontSize: 10, fontWeight: 500, color: "#B45309", marginLeft: 8, padding: "1px 6px", borderRadius: 5, background: "var(--warn-bg)", border: "0.5px solid var(--warn-border)" }}>
                    somente leitura
                  </span>
                )}
              </div>
              <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 2 }}>
                {!b2ok
                  ? "Não configurado — adicione BACKUP_S3_* no .env"
                  : remoteWritable
                    ? `${remote.length} arquivo${remote.length !== 1 ? "s" : ""} na nuvem`
                    : `${remote.length} de produção · envio/exclusão desabilitados (modo ngrok)`}
              </div>
            </div>
            {!b2ok ? (
              <div style={{ padding: 24, textAlign: "center", color: "var(--color-text-secondary)", fontSize: 12 }}>
                Configure as variáveis <code>BACKUP_S3_*</code> no <code>backend/.env</code> para habilitar.
              </div>
            ) : remote.length === 0 ? (
              <div style={{ padding: 24, textAlign: "center", color: "var(--color-text-secondary)", fontSize: 12 }}>
                Nenhum backup na nuvem.<br />
                <span style={{ fontSize: 11 }}>Crie um backup local e clique em "↑ Enviar".</span>
              </div>
            ) : (
              remote.map(item => (
                <BackupRow
                  key={item.name}
                  item={item}
                  source="remote"
                  busy={busy}
                  onRestore={(i, src) => askConfirm("restore", i, src)}
                  onDelete={remoteWritable ? (i, src) => askConfirm("delete", i, src) : null}
                />
              ))
            )}
          </div>
        </div>
      )}

      {/* Modal de confirmação */}
      {confirm && (
        <Modal title={confirm.label} onClose={() => setConfirm(null)} danger={confirm.danger}>
          <p style={{ fontSize: 13, color: "var(--color-text-secondary)", lineHeight: 1.6, marginBottom: 16 }}>
            {confirm.body}
          </p>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button onClick={() => setConfirm(null)} style={s.btn("default")}>Cancelar</button>
            <button
              onClick={executeConfirm}
              style={{ padding: "8px 18px", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer", border: "none",
                background: confirm.danger ? "#E24B4A" : PRIMARY, color: "#fff" }}
            >
              {confirm.action === "restore" ? "Restaurar agora" : confirm.action === "push" ? "Enviar" : "Excluir"}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
