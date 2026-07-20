import { useState, useEffect, useCallback } from "react";
import { PRIMARY, PRIMARY_DARK, PRIMARY_LIGHT } from "../data/constants";
import Badge from "../components/ui/Badge";
import Modal from "../components/ui/Modal";
import {
  adminListUsers,
  adminDeleteUser,
  adminSetUserPassword,
  adminSetUserRole,
  adminVerifyUserEmail,
  adminSetUserSuspended,
  adminResendUserVerification,
  adminGetRegistration,
  adminSetRegistration,
} from "../data/api";

const PLAN_LABEL = { free: "Free", basic: "Basic", pro: "Pro", business: "Business" };
const PLAN_COLOR = { free: "gray", basic: "blue", pro: "green", business: "purple" };

function StatusBadge({ user }) {
  if (user.suspended) return <Badge color="red">Suspenso</Badge>;
  if (!user.emailVerified) return <Badge color="yellow">Email pendente</Badge>;
  return <Badge color="green">Ativo</Badge>;
}

function PlanBadge({ sub }) {
  if (!sub) return null;
  const plan = sub.planId || "free";
  return <Badge color={PLAN_COLOR[plan] || "gray"}>{PLAN_LABEL[plan] || plan}</Badge>;
}

export default function PageAdminUsers({ currentUser }) {
  const [users, setUsers]           = useState([]);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState(null);
  const [search, setSearch]         = useState("");
  const [filter, setFilter]         = useState("all"); // all | unverified | suspended | admin

  // Bloqueio de cadastro (beta fechado). null = ainda carregando.
  const [regBlocked, setRegBlocked] = useState(null);
  const [regBusy, setRegBusy]       = useState(false);

  // Modais
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [pwdUser, setPwdUser]             = useState(null);
  const [newPwd, setNewPwd]               = useState("");
  const [pwdError, setPwdError]           = useState(null);
  const [savingPwd, setSavingPwd]         = useState(false);

  // Ações inline com loading por usuário
  const [busy, setBusy] = useState({}); // userId → true

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [r, reg] = await Promise.all([adminListUsers(), adminGetRegistration()]);
      setUsers(r.users || []);
      setRegBlocked(!!reg.blocked);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  async function toggleRegistration() {
    const next = !regBlocked;
    setRegBusy(true);
    setError(null);
    try {
      const r = await adminSetRegistration(next);
      setRegBlocked(!!r.blocked);
    } catch (err) {
      setError(err.message);
    } finally {
      setRegBusy(false);
    }
  }

  async function withBusy(userId, fn) {
    setBusy(b => ({ ...b, [userId]: true }));
    try { await fn(); await refresh(); }
    catch (err) { setError(err.message); }
    finally { setBusy(b => ({ ...b, [userId]: false })); }
  }

  async function handleDelete() {
    if (!confirmDelete) return;
    await withBusy(confirmDelete.id, () => adminDeleteUser(confirmDelete.id));
    setConfirmDelete(null);
  }

  async function handleChangePassword() {
    setPwdError(null);
    if (newPwd.length < 8) { setPwdError("Senha precisa ter ao menos 8 caracteres"); return; }
    setSavingPwd(true);
    try {
      await adminSetUserPassword(pwdUser.id, newPwd);
      setPwdUser(null);
      setNewPwd("");
    } catch (err) {
      setPwdError(err.message);
    } finally {
      setSavingPwd(false);
    }
  }

  const filtered = users.filter(u => {
    if (filter === "unverified" && u.emailVerified) return false;
    if (filter === "suspended" && !u.suspended) return false;
    if (filter === "admin" && u.role !== "admin") return false;
    if (search) {
      const s = search.toLowerCase();
      return (u.name || "").toLowerCase().includes(s) || (u.email || "").toLowerCase().includes(s);
    }
    return true;
  });

  const unverifiedCount = users.filter(u => !u.emailVerified).length;
  const suspendedCount  = users.filter(u => u.suspended).length;
  const adminCount      = users.filter(u => u.role === "admin").length;

  const btnStyle = (variant = "default") => ({
    padding: "4px 10px", borderRadius: 6, fontSize: 11, cursor: "pointer", fontWeight: 500,
    ...(variant === "default" && {
      border: "0.5px solid var(--color-border-secondary)",
      background: "transparent",
      color: "var(--color-text-primary)",
    }),
    ...(variant === "primary" && {
      border: `0.5px solid ${PRIMARY}`,
      background: PRIMARY_LIGHT,
      color: PRIMARY_DARK,
    }),
    ...(variant === "danger" && {
      border: "0.5px solid #F7C1C1",
      background: "#FCEBEB",
      color: "#A32D2D",
    }),
    ...(variant === "warning" && {
      border: "0.5px solid #FDE68A",
      background: "#FEF9C3",
      color: "#854D0E",
    }),
    ...(variant === "success" && {
      border: "0.5px solid #BBF7D0",
      background: "#F0FDF4",
      color: "#166534",
    }),
  });

  const filterBtn = (value, label, count) => (
    <button
      onClick={() => setFilter(value)}
      style={{
        padding: "5px 12px", borderRadius: 7, fontSize: 12, cursor: "pointer",
        border: filter === value ? `0.5px solid ${PRIMARY}` : "0.5px solid var(--color-border-tertiary)",
        background: filter === value ? PRIMARY_LIGHT : "transparent",
        color: filter === value ? PRIMARY_DARK : "var(--color-text-secondary)",
        fontWeight: filter === value ? 600 : 400,
      }}
    >
      {label}{count > 0 ? ` (${count})` : ""}
    </button>
  );

  return (
    <div>
      {/* Cabeçalho */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16, flexWrap: "wrap", gap: 10 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <h2 style={{ fontSize: 18, fontWeight: 500, margin: 0 }}>Usuários</h2>
            {regBlocked && <Badge color="red">Cadastro fechado (beta)</Badge>}
          </div>
          <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 4, display: "flex", gap: 12, flexWrap: "wrap" }}>
            <span>{users.length} cadastrado{users.length !== 1 ? "s" : ""}</span>
            <span>{adminCount} admin{adminCount !== 1 ? "s" : ""}</span>
            {unverifiedCount > 0 && <span style={{ color: "#B45309" }}>{unverifiedCount} pendente{unverifiedCount !== 1 ? "s" : ""} de verificação</span>}
            {suspendedCount > 0 && <span style={{ color: "#A32D2D" }}>{suspendedCount} suspenso{suspendedCount !== 1 ? "s" : ""}</span>}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {regBlocked !== null && (
            <button onClick={toggleRegistration} disabled={regBusy} style={btnStyle(regBlocked ? "warning" : "default")}>
              {regBusy ? "…" : regBlocked ? "🔒 Cadastro bloqueado — Liberar" : "🔓 Cadastro liberado — Bloquear"}
            </button>
          )}
          <button onClick={refresh} disabled={loading} style={btnStyle()}>
            {loading ? "⟳" : "⟳ Atualizar"}
          </button>
        </div>
      </div>

      {error && (
        <div style={{ background: "#FCEBEB", color: "#A32D2D", padding: "10px 12px", borderRadius: 8, fontSize: 13, marginBottom: 14 }}>
          {error}
        </div>
      )}

      {/* Busca + Filtros */}
      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
        <input
          placeholder="Buscar por nome ou email..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ flex: 1, minWidth: 200, padding: "7px 12px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-primary)", fontSize: 13, boxSizing: "border-box" }}
        />
      </div>
      <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
        {filterBtn("all",        "Todos",        0)}
        {filterBtn("unverified", "Não verificados", unverifiedCount)}
        {filterBtn("suspended",  "Suspensos",    suspendedCount)}
        {filterBtn("admin",      "Admins",       adminCount)}
      </div>

      {filtered.length === 0 ? (
        <div style={{ textAlign: "center", padding: 40, color: "var(--color-text-secondary)", fontSize: 13 }}>
          {loading ? "Carregando..." : "Nenhum usuário encontrado."}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {filtered.map(u => {
            const isMe    = u.id === currentUser?.id;
            const isAdmin = u.role === "admin";
            const isBusy  = !!busy[u.id];
            return (
              <div key={u.id} style={{
                background: "var(--color-background-primary)",
                border: `0.5px solid ${u.suspended ? "#FECACA" : "var(--color-border-tertiary)"}`,
                borderRadius: 12,
                padding: "12px 14px",
                opacity: isBusy ? 0.6 : 1,
              }}>
                {/* Linha principal: nome + badges */}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 8 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 5, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 14, fontWeight: 500 }}>{u.name || "(sem nome)"}</span>
                      <StatusBadge user={u} />
                      {isAdmin && <Badge color="purple">Admin</Badge>}
                      {isMe && <Badge color="gray">Você</Badge>}
                      <PlanBadge sub={u.subscription} />
                    </div>

                    {/* Info secundária */}
                    <div style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
                      <span>{u.email}</span>
                      {u.phone && <span>📱 {u.phone}</span>}
                      {u.createdAt && <span>Criado {new Date(u.createdAt).toLocaleDateString("pt-BR")}</span>}
                      {u._count && (
                        <>
                          <span>{u._count.groups} campanha{u._count.groups !== 1 ? "s" : ""}</span>
                          <span>{u._count.numbers} número{u._count.numbers !== 1 ? "s" : ""}</span>
                        </>
                      )}
                      {u.suspended && u.suspendedAt && (
                        <span style={{ color: "#A32D2D" }}>Suspenso em {new Date(u.suspendedAt).toLocaleDateString("pt-BR")}</span>
                      )}
                    </div>

                    {/* Ações de email (só se não verificado) */}
                    {!u.emailVerified && (
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 6 }}>
                        <button
                          disabled={isBusy}
                          onClick={() => withBusy(u.id, () => adminVerifyUserEmail(u.id))}
                          style={btnStyle("success")}
                        >
                          ✓ Verificar email
                        </button>
                        <button
                          disabled={isBusy}
                          onClick={() => withBusy(u.id, () => adminResendUserVerification(u.id))}
                          style={btnStyle("warning")}
                        >
                          ✉ Reenviar verificação
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Ações principais */}
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "flex-start" }}>
                    <button
                      disabled={isBusy}
                      onClick={() => { setPwdUser(u); setNewPwd(""); setPwdError(null); }}
                      style={btnStyle("default")}
                    >
                      Trocar senha
                    </button>

                    {!isMe && (
                      <button
                        disabled={isBusy}
                        onClick={() => withBusy(u.id, () => adminSetUserRole(u.id, isAdmin ? "user" : "admin"))}
                        style={btnStyle(isAdmin ? "default" : "primary")}
                      >
                        {isAdmin ? "Rebaixar" : "Tornar admin"}
                      </button>
                    )}

                    {!isMe && (
                      <button
                        disabled={isBusy}
                        onClick={() => withBusy(u.id, () => adminSetUserSuspended(u.id, !u.suspended))}
                        style={btnStyle(u.suspended ? "warning" : "default")}
                      >
                        {u.suspended ? "Reativar" : "Suspender"}
                      </button>
                    )}

                    {!isMe && (
                      <button
                        disabled={isBusy}
                        onClick={() => setConfirmDelete(u)}
                        style={btnStyle("danger")}
                      >
                        Excluir
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Modal: trocar senha */}
      {pwdUser && (
        <Modal title={`Trocar senha — ${pwdUser.name || pwdUser.email}`} onClose={() => { setPwdUser(null); setNewPwd(""); setPwdError(null); }}>
          <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 12, lineHeight: 1.5 }}>
            Define uma nova senha. O usuário precisará usá-la no próximo login.
          </div>
          <input
            type="password"
            value={newPwd}
            onChange={e => setNewPwd(e.target.value)}
            placeholder="Mínimo 8 caracteres"
            onKeyDown={e => e.key === "Enter" && handleChangePassword()}
            style={{ width: "100%", padding: "9px 12px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13, boxSizing: "border-box", marginBottom: 10 }}
          />
          {pwdError && (
            <div style={{ background: "#FCEBEB", color: "#A32D2D", padding: "8px 10px", borderRadius: 8, fontSize: 12, marginBottom: 10 }}>{pwdError}</div>
          )}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button onClick={() => { setPwdUser(null); setNewPwd(""); setPwdError(null); }} disabled={savingPwd} style={btnStyle("default")}>Cancelar</button>
            <button onClick={handleChangePassword} disabled={savingPwd || newPwd.length < 8}
              style={{ padding: "8px 16px", borderRadius: 8, background: PRIMARY, color: "#fff", border: "none", fontSize: 13, cursor: "pointer", fontWeight: 500, opacity: (savingPwd || newPwd.length < 8) ? 0.5 : 1 }}>
              {savingPwd ? "Salvando..." : "Trocar senha"}
            </button>
          </div>
        </Modal>
      )}

      {/* Modal: confirmar exclusão */}
      {confirmDelete && (
        <Modal title="Excluir usuário?" onClose={() => setConfirmDelete(null)} danger>
          <p style={{ fontSize: 13, marginBottom: 16, color: "var(--color-text-secondary)", lineHeight: 1.5 }}>
            <strong style={{ color: "var(--color-text-primary)" }}>{confirmDelete.name || confirmDelete.email}</strong> será excluído permanentemente junto com suas campanhas, números do WhatsApp e histórico. Esta ação não pode ser desfeita.
          </p>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button onClick={() => setConfirmDelete(null)} style={btnStyle("default")}>Cancelar</button>
            <button onClick={handleDelete} style={{ padding: "8px 16px", borderRadius: 8, background: "#E24B4A", color: "#fff", border: "none", fontSize: 13, cursor: "pointer", fontWeight: 500 }}>
              Excluir permanentemente
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
