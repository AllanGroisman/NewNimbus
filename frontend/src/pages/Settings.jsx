import { useState } from "react";
import { PRIMARY, PRIMARY_DARK, PRIMARY_LIGHT, allSources, CATEGORIES } from "../data/constants";
import Badge from "../components/ui/Badge";
import Toggle from "../components/ui/Toggle";
import Modal from "../components/ui/Modal";
import { authUpdate, authChangePassword } from "../data/api";
import { DEFAULT_MESSAGE_TEMPLATE } from "../data/mockData";

export default function PageSettings({ user, setUser, onLogout, settings = {}, setSettings = () => {} }) {
  const [section, setSection] = useState("account");
  const msgTemplate = settings.messageTemplate ?? DEFAULT_MESSAGE_TEMPLATE;
  const setMsgTemplate = (v) => setSettings(s => ({ ...s, messageTemplate: v }));
  const notifications = settings.notifications || { email: true, push: false, weeklyReport: true, pendingReview: true };
  const setNotifications = (updater) => setSettings(s => ({ ...s, notifications: typeof updater === "function" ? updater(s.notifications || {}) : updater }));
  const sources = settings.sources || allSources;
  const setSources = (updater) => setSettings(s => ({ ...s, sources: typeof updater === "function" ? updater(s.sources || allSources) : updater }));
  const theme = settings.theme || "auto";
  const setTheme = (v) => setSettings(s => ({ ...s, theme: v }));

  const [account, setAccount] = useState({
    name: user?.name || "",
    email: user?.email || "",
    phone: user?.phone || "",
  });
  const [accountMsg, setAccountMsg] = useState(null);
  const [accountSaving, setAccountSaving] = useState(false);
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [showDeleteAccount, setShowDeleteAccount] = useState(false);
  const [showLogout, setShowLogout] = useState(false);
  const [pwd, setPwd] = useState({ current: "", next: "", confirm: "" });
  const [pwdMsg, setPwdMsg] = useState(null);
  const [pwdSaving, setPwdSaving] = useState(false);

  async function handleSaveAccount() {
    setAccountSaving(true);
    setAccountMsg(null);
    try {
      const r = await authUpdate({ name: account.name, phone: account.phone });
      if (setUser) setUser(r.user);
      setAccountMsg({ type: "ok", text: "Salvo!" });
    } catch (err) {
      setAccountMsg({ type: "err", text: err.message });
    } finally {
      setAccountSaving(false);
    }
  }

  async function handleChangePassword() {
    setPwdMsg(null);
    if (pwd.next !== pwd.confirm) { setPwdMsg({ type: "err", text: "Senhas não conferem" }); return; }
    if (pwd.next.length < 6) { setPwdMsg({ type: "err", text: "Nova senha precisa ter 6+ caracteres" }); return; }
    setPwdSaving(true);
    try {
      await authChangePassword({ currentPassword: pwd.current, newPassword: pwd.next });
      setPwd({ current: "", next: "", confirm: "" });
      setShowPasswordModal(false);
    } catch (err) {
      setPwdMsg({ type: "err", text: err.message });
    } finally {
      setPwdSaving(false);
    }
  }

  const sections = [
    { id: "account", label: "Conta" },
    { id: "security", label: "Segurança" },
    { id: "notifications", label: "Notificações" },
    { id: "sources", label: "Fontes e categorias" },
    { id: "template", label: "Modelo padrão" },
    { id: "appearance", label: "Aparência" },
    { id: "danger", label: "Zona de perigo" },
  ];

  return (
    <div>
      <h2 style={{ fontSize: 18, fontWeight: 500, marginBottom: 20 }}>Configurações</h2>
      <div className="settings-layout" style={{ display: "grid", gridTemplateColumns: "180px 1fr", gap: 20 }}>
        <div className="settings-nav" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {sections.map(s => (
            <button key={s.id} onClick={() => setSection(s.id)} style={{ padding: "8px 12px", borderRadius: 8, border: "none", background: section === s.id ? PRIMARY_LIGHT : "transparent", color: section === s.id ? PRIMARY_DARK : (s.id === "danger" ? "#A32D2D" : "var(--color-text-secondary)"), fontSize: 13, cursor: "pointer", textAlign: "left", fontWeight: section === s.id ? 500 : 400, whiteSpace: "nowrap" }}>{s.label}</button>
          ))}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {section === "account" && (
            <>
              <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: 16 }}>
                <div style={{ fontWeight: 500, marginBottom: 4 }}>Informações pessoais</div>
                <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 14 }}>Dados exibidos na sua conta</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {[["Nome completo", "name", false], ["Email", "email", true], ["Telefone", "phone", false]].map(([label, key, readOnly]) => (
                    <div key={key}>
                      <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>{label}</label>
                      <input
                        value={account[key]}
                        onChange={e => !readOnly && setAccount(a => ({ ...a, [key]: e.target.value }))}
                        readOnly={readOnly}
                        style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: readOnly ? "var(--color-background-tertiary, #f3f3f3)" : "var(--color-background-secondary)", fontSize: 13, boxSizing: "border-box", color: readOnly ? "var(--color-text-secondary)" : "inherit" }}
                      />
                    </div>
                  ))}
                </div>
                {accountMsg && (
                  <div style={{ marginTop: 10, fontSize: 12, color: accountMsg.type === "ok" ? PRIMARY_DARK : "#A32D2D" }}>{accountMsg.text}</div>
                )}
                <button onClick={handleSaveAccount} disabled={accountSaving} style={{ marginTop: 14, padding: "7px 16px", borderRadius: 8, background: PRIMARY, color: "#fff", border: "none", fontSize: 13, cursor: accountSaving ? "wait" : "pointer", fontWeight: 500, opacity: accountSaving ? 0.7 : 1 }}>{accountSaving ? "Salvando..." : "Salvar alterações"}</button>
              </div>
              <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: 16 }}>
                <div style={{ fontWeight: 500, marginBottom: 4 }}>Sessão</div>
                <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 14 }}>Encerre sua sessão neste navegador</div>
                <button onClick={() => setShowLogout(true)} style={{ padding: "7px 16px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 13, cursor: "pointer" }}>Sair da conta</button>
              </div>
            </>
          )}

          {section === "security" && (
            <>
              <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: 16 }}>
                <div style={{ fontWeight: 500, marginBottom: 4 }}>Senha</div>
                <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 14 }}>Última alteração há 45 dias</div>
                <button onClick={() => setShowPasswordModal(true)} style={{ padding: "7px 16px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 13, cursor: "pointer" }}>Alterar senha</button>
              </div>
              <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                  <div style={{ fontWeight: 500 }}>Autenticação em dois fatores</div>
                  <Toggle value={false} onChange={() => {}} />
                </div>
                <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>Adicione uma camada extra de segurança via SMS ou app autenticador</div>
              </div>
              <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: 16 }}>
                <div style={{ fontWeight: 500, marginBottom: 12 }}>Dispositivos conectados</div>
                {[
                  { device: "Chrome • macOS", location: "Porto Alegre, BR", current: true, lastSeen: "agora" },
                  { device: "Safari • iPhone", location: "Porto Alegre, BR", current: false, lastSeen: "há 2 horas" },
                ].map((d, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: i === 0 ? "0.5px solid var(--color-border-tertiary)" : "none" }}>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 500 }}>{d.device} {d.current && <Badge color="green">Este dispositivo</Badge>}</div>
                      <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 2 }}>{d.location} &middot; {d.lastSeen}</div>
                    </div>
                    {!d.current && <button style={{ padding: "5px 10px", borderRadius: 7, border: "0.5px solid #F7C1C1", background: "#FCEBEB", color: "#A32D2D", fontSize: 12, cursor: "pointer" }}>Encerrar</button>}
                  </div>
                ))}
              </div>
            </>
          )}

          {section === "notifications" && (
            <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: 16 }}>
              <div style={{ fontWeight: 500, marginBottom: 4 }}>Preferências de notificação</div>
              <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 14 }}>Escolha como e quando ser avisado</div>
              {[
                { key: "email", label: "Notificações por email", desc: "Receba alertas importantes no seu email" },
                { key: "push", label: "Notificações push no navegador", desc: "Aparecem como pop-up durante o uso" },
                { key: "pendingReview", label: "Produtos aguardando revisão", desc: "Aviso quando produtos precisam de aprovação" },
                { key: "weeklyReport", label: "Relatório semanal", desc: "Resumo de envios toda segunda-feira" },
              ].map(n => (
                <div key={n.key} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 0", borderBottom: "0.5px solid var(--color-border-tertiary)", gap: 12 }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>{n.label}</div>
                    <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 2 }}>{n.desc}</div>
                  </div>
                  <Toggle value={notifications[n.key]} onChange={v => setNotifications(s => ({ ...s, [n.key]: v }))} />
                </div>
              ))}
            </div>
          )}

          {section === "sources" && (
            <>
              <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: 16 }}>
                <div style={{ fontWeight: 500, marginBottom: 4 }}>Sites monitorados</div>
                <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 12 }}>Clique para ativar/desativar. Hoje só Mercado Livre tem scraper implementado.</div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {allSources.map(item => {
                    const active = sources.includes(item);
                    return (
                      <button
                        key={item}
                        onClick={() => setSources(arr => active ? arr.filter(s => s !== item) : [...arr, item])}
                        style={{ display: "flex", alignItems: "center", gap: 6, background: active ? "var(--color-background-secondary)" : "transparent", border: `0.5px solid ${active ? "var(--color-border-tertiary)" : "var(--color-border-secondary)"}`, borderRadius: 8, padding: "5px 10px", fontSize: 13, cursor: "pointer", opacity: active ? 1 : 0.5 }}
                      >
                        <span style={{ width: 8, height: 8, borderRadius: "50%", background: active ? PRIMARY : "var(--color-border-secondary)" }} />{item}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: 16 }}>
                <div style={{ fontWeight: 500, marginBottom: 4 }}>Categorias ativas</div>
                <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 12 }}>Categorias de produtos disponíveis na plataforma.</div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {Object.values(CATEGORIES).map(c => (
                    <div key={c.label} style={{ display: "flex", alignItems: "center", gap: 6, background: "var(--color-background-secondary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 8, padding: "5px 10px", fontSize: 13 }}>
                      <span style={{ width: 8, height: 8, borderRadius: "50%", background: PRIMARY }} />{c.label}
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}

          {section === "template" && (
            <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: 16 }}>
              <div style={{ fontWeight: 500, marginBottom: 4 }}>Modelo de mensagem padrão</div>
              <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 12 }}>Aplicado a campanhas novas. Cada campanha pode ter seu próprio modelo depois.</div>
              <textarea value={msgTemplate} onChange={e => setMsgTemplate(e.target.value)} style={{ width: "100%", padding: 10, borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13, resize: "vertical", minHeight: 160, boxSizing: "border-box", fontFamily: "inherit" }} />
              <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 8 }}>
                Variáveis: {"{produto}"}, {"{preco}"}, {"{preco_antigo}"}, {"{desconto}"}, {"{loja}"}, {"{link}"}
              </div>
              <div style={{ fontSize: 11, color: PRIMARY_DARK, marginTop: 8 }}>Salva automaticamente.</div>
            </div>
          )}

          {section === "appearance" && (
            <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: 16 }}>
              <div style={{ fontWeight: 500, marginBottom: 4 }}>Tema</div>
              <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 14 }}>Escolha a aparência da interface</div>
              <div style={{ display: "flex", gap: 8 }}>
                {[{ id: "light", label: "Claro" }, { id: "dark", label: "Escuro" }, { id: "auto", label: "Automático" }].map(t => (
                  <button key={t.id} onClick={() => setTheme(t.id)} style={{ flex: 1, padding: "10px", borderRadius: 8, border: `0.5px solid ${theme === t.id ? PRIMARY : "var(--color-border-tertiary)"}`, background: theme === t.id ? PRIMARY_LIGHT : "transparent", color: theme === t.id ? PRIMARY_DARK : "var(--color-text-secondary)", fontSize: 13, cursor: "pointer", fontWeight: theme === t.id ? 500 : 400 }}>{t.label}</button>
                ))}
              </div>
            </div>
          )}

          {section === "danger" && (
            <div style={{ background: "var(--color-background-primary)", border: "0.5px solid #F7C1C1", borderRadius: 12, padding: 16 }}>
              <div style={{ fontWeight: 500, marginBottom: 4, color: "#A32D2D" }}>Excluir conta</div>
              <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 14 }}>Essa ação é permanente. Todos os seus dados, grupos, agendamentos e histórico serão apagados definitivamente.</div>
              <button onClick={() => setShowDeleteAccount(true)} style={{ padding: "8px 16px", borderRadius: 8, background: "#E24B4A", color: "#fff", border: "none", fontSize: 13, cursor: "pointer", fontWeight: 500 }}>Excluir minha conta</button>
            </div>
          )}
        </div>
      </div>

      {showPasswordModal && (
        <Modal title="Alterar senha" onClose={() => { setShowPasswordModal(false); setPwdMsg(null); }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {[
              ["Senha atual", "current"],
              ["Nova senha", "next"],
              ["Confirmar nova senha", "confirm"],
            ].map(([label, key]) => (
              <div key={key}>
                <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>{label}</label>
                <input
                  type="password"
                  value={pwd[key]}
                  onChange={e => setPwd(p => ({ ...p, [key]: e.target.value }))}
                  style={{ width: "100%", padding: "9px 12px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13, boxSizing: "border-box" }}
                />
              </div>
            ))}
          </div>
          {pwdMsg && (
            <div style={{ marginTop: 10, fontSize: 12, color: pwdMsg.type === "ok" ? PRIMARY_DARK : "#A32D2D" }}>{pwdMsg.text}</div>
          )}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
            <button onClick={() => { setShowPasswordModal(false); setPwdMsg(null); }} style={{ padding: "8px 16px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 13, cursor: "pointer" }}>Cancelar</button>
            <button onClick={handleChangePassword} disabled={pwdSaving} style={{ padding: "8px 16px", borderRadius: 8, background: PRIMARY, color: "#fff", border: "none", fontSize: 13, cursor: pwdSaving ? "wait" : "pointer", fontWeight: 500, opacity: pwdSaving ? 0.7 : 1 }}>{pwdSaving ? "Salvando..." : "Alterar senha"}</button>
          </div>
        </Modal>
      )}

      {showLogout && (
        <Modal title="Sair da conta?" onClose={() => setShowLogout(false)}>
          <p style={{ fontSize: 13, marginBottom: 16, color: "var(--color-text-secondary)" }}>Você será desconectado neste dispositivo. Os envios automáticos continuam funcionando normalmente.</p>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button onClick={() => setShowLogout(false)} style={{ padding: "8px 16px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 13, cursor: "pointer" }}>Cancelar</button>
            <button onClick={() => { onLogout(); setShowLogout(false); }} style={{ padding: "8px 16px", borderRadius: 8, background: PRIMARY, color: "#fff", border: "none", fontSize: 13, cursor: "pointer", fontWeight: 500 }}>Sair</button>
          </div>
        </Modal>
      )}

      {showDeleteAccount && (
        <Modal title="Excluir conta permanentemente?" onClose={() => setShowDeleteAccount(false)} danger>
          <p style={{ fontSize: 13, marginBottom: 12, color: "var(--color-text-secondary)", lineHeight: 1.5 }}>Esta ação não pode ser desfeita. Serão apagados:</p>
          <ul style={{ fontSize: 12, color: "var(--color-text-secondary)", paddingLeft: 20, marginBottom: 14, lineHeight: 1.6 }}>
            <li>Todos os seus grupos e agendamentos</li>
            <li>Todo o histórico de envios</li>
            <li>Dados da assinatura (sem reembolso)</li>
            <li>Números do WhatsApp conectados</li>
          </ul>
          <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 6 }}>Digite <strong style={{ color: "#A32D2D" }}>EXCLUIR</strong> para confirmar:</label>
          <input style={{ width: "100%", padding: "9px 12px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13, boxSizing: "border-box", marginBottom: 16 }} />
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button onClick={() => setShowDeleteAccount(false)} style={{ padding: "8px 16px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 13, cursor: "pointer" }}>Cancelar</button>
            <button style={{ padding: "8px 16px", borderRadius: 8, background: "#E24B4A", color: "#fff", border: "none", fontSize: 13, cursor: "pointer", fontWeight: 500 }}>Excluir para sempre</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
