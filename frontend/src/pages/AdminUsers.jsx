import { useState, useEffect, useCallback } from "react";
import { PRIMARY, PRIMARY_DARK, PRIMARY_LIGHT } from "../data/constants";
import Badge from "../components/ui/Badge";
import Modal from "../components/ui/Modal";
import {
  adminListUsers,
  adminDeleteUser,
  adminSetUserPassword,
  adminSetUserRole,
} from "../data/api";

export default function PageAdminUsers({ currentUser }) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState("");

  // Modais
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [pwdUser, setPwdUser] = useState(null);
  const [newPwd, setNewPwd] = useState("");
  const [pwdError, setPwdError] = useState(null);
  const [savingPwd, setSavingPwd] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await adminListUsers();
      setUsers(r.users || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  async function handleDelete() {
    if (!confirmDelete) return;
    try {
      await adminDeleteUser(confirmDelete.id);
      setConfirmDelete(null);
      refresh();
    } catch (err) {
      setError(err.message);
      setConfirmDelete(null);
    }
  }

  async function handleSetRole(user, role) {
    try {
      await adminSetUserRole(user.id, role);
      refresh();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleChangePassword() {
    setPwdError(null);
    if (newPwd.length < 6) { setPwdError("Senha precisa ter ao menos 6 caracteres"); return; }
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
    if (!search) return true;
    const s = search.toLowerCase();
    return (u.name || "").toLowerCase().includes(s) || (u.email || "").toLowerCase().includes(s);
  });

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 10 }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 500 }}>Usuários</h2>
          <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 4 }}>
            {users.length} usuário{users.length !== 1 ? "s" : ""} cadastrado{users.length !== 1 ? "s" : ""} · {users.filter(u => u.role === "admin").length} admin
          </div>
        </div>
        <button onClick={refresh} disabled={loading} style={{ padding: "7px 14px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 13, cursor: "pointer" }}>
          {loading ? "⟳" : "⟳ Atualizar"}
        </button>
      </div>

      {error && (
        <div style={{ background: "#FCEBEB", color: "#A32D2D", padding: "10px 12px", borderRadius: 8, fontSize: 13, marginBottom: 14 }}>
          {error}
        </div>
      )}

      <input
        placeholder="Buscar por nome ou email..."
        value={search}
        onChange={e => setSearch(e.target.value)}
        style={{ width: "100%", padding: "8px 12px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-primary)", fontSize: 13, boxSizing: "border-box", marginBottom: 14 }}
      />

      {filtered.length === 0 ? (
        <div style={{ textAlign: "center", padding: 40, color: "var(--color-text-secondary)", fontSize: 13 }}>
          {loading ? "Carregando..." : "Nenhum usuário encontrado."}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {filtered.map(u => {
            const isMe = u.id === currentUser?.id;
            const isAdmin = u.role === "admin";
            return (
              <div key={u.id} style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: "12px 14px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 10 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 14, fontWeight: 500 }}>{u.name || "(sem nome)"}</span>
                      {isAdmin && <Badge color="purple">Admin</Badge>}
                      {isMe && <Badge color="gray">Você</Badge>}
                    </div>
                    <div style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "flex", gap: 12, flexWrap: "wrap" }}>
                      <span>📧 {u.email}</span>
                      {u.phone && <span>📱 {u.phone}</span>}
                      {u.createdAt && <span>🗓 {new Date(u.createdAt).toLocaleDateString("pt-BR")}</span>}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <button
                      onClick={() => setPwdUser(u)}
                      style={{ padding: "5px 12px", borderRadius: 7, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 12, cursor: "pointer" }}
                    >
                      Trocar senha
                    </button>
                    {!isMe && (
                      <button
                        onClick={() => handleSetRole(u, isAdmin ? "user" : "admin")}
                        style={{ padding: "5px 12px", borderRadius: 7, border: `0.5px solid ${isAdmin ? "var(--color-border-secondary)" : PRIMARY}`, background: isAdmin ? "transparent" : PRIMARY_LIGHT, color: isAdmin ? "var(--color-text-primary)" : PRIMARY_DARK, fontSize: 12, cursor: "pointer", fontWeight: 500 }}
                      >
                        {isAdmin ? "Rebaixar a usuário" : "Promover a admin"}
                      </button>
                    )}
                    {!isMe && (
                      <button
                        onClick={() => setConfirmDelete(u)}
                        style={{ padding: "5px 12px", borderRadius: 7, border: "0.5px solid #F7C1C1", background: "#FCEBEB", color: "#A32D2D", fontSize: 12, cursor: "pointer" }}
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
        <Modal title={`Trocar senha de ${pwdUser.name || pwdUser.email}`} onClose={() => { setPwdUser(null); setNewPwd(""); setPwdError(null); }}>
          <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 12, lineHeight: 1.5 }}>
            Define uma nova senha pra este usuário. Ele vai precisar usar essa senha no próximo login.
          </div>
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Nova senha</label>
            <input
              type="password"
              value={newPwd}
              onChange={e => setNewPwd(e.target.value)}
              placeholder="Mínimo 6 caracteres"
              style={{ width: "100%", padding: "9px 12px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13, boxSizing: "border-box" }}
            />
          </div>
          {pwdError && (
            <div style={{ background: "#FCEBEB", color: "#A32D2D", padding: "8px 10px", borderRadius: 8, fontSize: 12, marginBottom: 12 }}>{pwdError}</div>
          )}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button onClick={() => { setPwdUser(null); setNewPwd(""); setPwdError(null); }} disabled={savingPwd} style={{ padding: "8px 16px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 13, cursor: "pointer" }}>Cancelar</button>
            <button onClick={handleChangePassword} disabled={savingPwd || newPwd.length < 6} style={{ padding: "8px 16px", borderRadius: 8, background: PRIMARY, color: "#fff", border: "none", fontSize: 13, cursor: "pointer", fontWeight: 500, opacity: (savingPwd || newPwd.length < 6) ? 0.5 : 1 }}>
              {savingPwd ? "Salvando..." : "Trocar senha"}
            </button>
          </div>
        </Modal>
      )}

      {/* Modal: excluir */}
      {confirmDelete && (
        <Modal title="Excluir usuário?" onClose={() => setConfirmDelete(null)} danger>
          <p style={{ fontSize: 13, marginBottom: 16, color: "var(--color-text-secondary)", lineHeight: 1.5 }}>
            <strong style={{ color: "var(--color-text-primary)" }}>{confirmDelete.name || confirmDelete.email}</strong> será excluído permanentemente, junto com suas campanhas, números do WhatsApp e histórico.
          </p>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button onClick={() => setConfirmDelete(null)} style={{ padding: "8px 16px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 13, cursor: "pointer" }}>Cancelar</button>
            <button onClick={handleDelete} style={{ padding: "8px 16px", borderRadius: 8, background: "#E24B4A", color: "#fff", border: "none", fontSize: 13, cursor: "pointer", fontWeight: 500 }}>Excluir permanentemente</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
