import { useState } from "react";
import { PRIMARY, PRIMARY_DARK, PRIMARY_LIGHT, WHATSNIMBUS_EVENTS } from "../data/constants";
import Badge from "../components/ui/Badge";
import Toggle from "../components/ui/Toggle";
import Modal from "../components/ui/Modal";
import LogoutConfirmModal from "../components/LogoutConfirmModal";
import { authUpdate, authChangePassword, accountRequestEmailChange, errText} from "../data/api";
import { useUnsavedGuard } from "../data/navGuard";
import { formatPhone, isValidPhone, maskPhoneInput, toStoredPhone } from "../data/phone";


export default function PageSettings({ user, setUser, onLogout, settings = {}, setSettings = () => {}, numbers = [] }) {
  const [section, setSection] = useState("account");
  const notifications = settings.notifications || { email: true, push: false, weeklyReport: true, pendingReview: true };
  const setNotifications = (updater) => setSettings(s => ({ ...s, notifications: typeof updater === "function" ? updater(s.notifications || {}) : updater }));
  const wnEnabled = !!notifications.enabled;
  const wnDest = notifications.destinationNumberId || "";
  const wnEvents = notifications.events || {};
  const setWnEvent = (key, val) => setNotifications(s => ({ ...s, events: { ...(s.events || {}), [key]: val } }));
  const theme = settings.theme || "auto";
  const setTheme = (v) => setSettings(s => ({ ...s, theme: v }));

  const [account, setAccount] = useState({
    name: user?.name || "",
    email: user?.email || "",
    // Já vem mascarado do servidor (123.***.***-09) — o CPF inteiro nunca sai do backend.
    cpf: user?.cpf || "",
    // O campo trabalha na forma legível; o servidor guarda 5511999999999.
    phone: formatPhone(user?.phone || ""),
  });
  const [accountMsg, setAccountMsg] = useState(null);
  const [accountSaving, setAccountSaving] = useState(false);
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [showDeleteAccount, setShowDeleteAccount] = useState(false);
  const [showLogout, setShowLogout] = useState(false);
  const [showEmailModal, setShowEmailModal] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [emailPwd, setEmailPwd] = useState("");
  const [emailMsg, setEmailMsg] = useState(null);
  const [emailSaving, setEmailSaving] = useState(false);
  const [pwd, setPwd] = useState({ current: "", next: "", confirm: "" });
  const [pwdMsg, setPwdMsg] = useState(null);
  const [pwdSaving, setPwdSaving] = useState(false);

  // Guard de navegação: avisa ao sair de Configurações com o form de conta editado.
  const accountDirty = account.name !== (user?.name || "")
    || account.phone !== formatPhone(user?.phone || "");
  const discardAccount = () => setAccount({
    name: user?.name || "", email: user?.email || "", cpf: user?.cpf || "",
    phone: formatPhone(user?.phone || ""),
  });
  useUnsavedGuard({ dirty: accountDirty, save: handleSaveAccount, discard: discardAccount });

  async function handleSaveAccount() {
    // O telefone é obrigatório na conta — salvar vazio ou torto o apagaria.
    if (!isValidPhone(account.phone)) {
      setAccountMsg({ type: "err", text: "Informe um celular válido com DDD" });
      return;
    }
    setAccountSaving(true);
    setAccountMsg(null);
    try {
      const r = await authUpdate({ name: account.name, phone: toStoredPhone(account.phone) });
      if (setUser) setUser(r.user);
      setAccountMsg({ type: "ok", text: "Salvo!" });
    } catch (err) {
      setAccountMsg({ type: "err", text: errText(err, "Não foi possível salvar. Tente novamente.") });
    } finally {
      setAccountSaving(false);
    }
  }

  // Pede a troca: o email novo recebe um link e nada muda até alguém clicar.
  // Por isso a tela termina em "confira sua caixa de entrada", não em "pronto".
  async function handleRequestEmailChange() {
    setEmailMsg(null);
    const alvo = newEmail.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(alvo)) { setEmailMsg({ type: "err", text: "Email inválido" }); return; }
    if (alvo === (user?.email || "").toLowerCase()) { setEmailMsg({ type: "err", text: "Este já é o email da sua conta" }); return; }
    if (!emailPwd) { setEmailMsg({ type: "err", text: "Informe sua senha atual" }); return; }
    setEmailSaving(true);
    try {
      await accountRequestEmailChange({ password: emailPwd, newEmail: alvo });
      setEmailPwd("");
      setEmailMsg({ type: "ok", text: `Enviamos um link para ${alvo}. Abra o email e confirme — só depois disso o endereço muda.` });
    } catch (err) {
      setEmailMsg({ type: "err", text: errText(err, "Não foi possível salvar. Tente novamente.") });
    } finally {
      setEmailSaving(false);
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
      setPwdMsg({ type: "err", text: errText(err, "Não foi possível salvar. Tente novamente.") });
    } finally {
      setPwdSaving(false);
    }
  }

  // [label, chave, somente leitura]. O CPF só aparece pra quem já informou: contas
  // anteriores à regra e o admin (isento) têm cpf nulo e não devem ver campo vazio.
  const personalFields = [
    ["Nome completo", "name", false],
    ["Email", "email", true],
    ...(user?.cpf ? [["CPF", "cpf", true]] : []),
    ["Telefone", "phone", false],
  ];

  const sections = [
    { id: "account", label: "Conta" },
    { id: "security", label: "Segurança" },
    { id: "notifications", label: "Notificações" },
    { id: "appearance", label: "Aparência" },
    { id: "danger", label: "Zona de perigo" },
  ];

  return (
    <div>
      <h2 style={{ fontSize: 18, fontWeight: 500, marginBottom: 20 }}>Configurações</h2>
      <div className="settings-layout" style={{ display: "grid", gridTemplateColumns: "180px 1fr", gap: 20 }}>
        <div className="settings-nav" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {sections.map(s => (
            <button key={s.id} onClick={() => setSection(s.id)} style={{ padding: "8px 12px", borderRadius: 8, border: "none", background: section === s.id ? PRIMARY_LIGHT : "transparent", color: section === s.id ? PRIMARY_DARK : (s.id === "danger" ? "var(--danger-text)" : "var(--color-text-secondary)"), fontSize: 13, cursor: "pointer", textAlign: "left", fontWeight: section === s.id ? 500 : 400, whiteSpace: "nowrap" }}>{s.label}</button>
          ))}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {section === "account" && (
            <>
              <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: 16 }}>
                <div style={{ fontWeight: 500, marginBottom: 4 }}>Informações pessoais</div>
                <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 14 }}>Dados exibidos na sua conta</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {personalFields.map(([label, key, readOnly]) => (
                    <div key={key}>
                      <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>{label}</label>
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <input
                          value={account[key]}
                          onChange={e => !readOnly && setAccount(a => ({
                            ...a,
                            [key]: key === "phone" ? maskPhoneInput(e.target.value) : e.target.value,
                          }))}
                          readOnly={readOnly}
                          // Campo travado: o fundo e a borda é que dizem "não dá pra editar".
                          // O texto fica na cor normal — cinza sobre cinza some no tema escuro.
                          style={{ flex: 1, minWidth: 0, padding: "8px 10px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: readOnly ? "var(--color-background-tertiary)" : "var(--color-background-secondary)", fontSize: 13, boxSizing: "border-box", color: "var(--color-text-primary)" }}
                        />
                        {key === "email" && (
                          <button onClick={() => { setEmailMsg(null); setNewEmail(""); setEmailPwd(""); setShowEmailModal(true); }} style={{ padding: "7px 12px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 12, cursor: "pointer", whiteSpace: "nowrap" }}>Alterar</button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
                {user?.pendingEmail && (
                  <div style={{ marginTop: 10, fontSize: 11, color: "var(--warn-text)", background: "var(--warn-bg)", border: "0.5px solid var(--warn-border)", borderRadius: 8, padding: "8px 10px", lineHeight: 1.5 }}>
                    Troca de email aguardando confirmação em <strong>{user.pendingEmail}</strong>. Abra o link que mandamos para lá — até isso, o login continua neste email.
                  </div>
                )}
                {user?.cpf && (
                  <div style={{ marginTop: 10, fontSize: 11, color: "var(--color-text-secondary)", lineHeight: 1.5 }}>
                    Mostramos só parte do CPF por segurança. O documento não pode ser alterado — se estiver errado, fale com o suporte.
                  </div>
                )}
                {accountMsg && (
                  <div style={{ marginTop: 10, fontSize: 12, color: accountMsg.type === "ok" ? PRIMARY_DARK : "var(--danger-text)" }}>{accountMsg.text}</div>
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
                    {!d.current && <button style={{ padding: "5px 10px", borderRadius: 7, border: "0.5px solid var(--danger-border)", background: "var(--danger-bg)", color: "var(--danger-text)", fontSize: 12, cursor: "pointer" }}>Encerrar</button>}
                  </div>
                ))}
              </div>
            </>
          )}

          {section === "notifications" && (
            <>
            <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
                <div>
                  <div style={{ fontWeight: 500, marginBottom: 4 }}>Notificações no WhatsApp (WhatsNimbus)</div>
                  <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 4 }}>
                    Receba avisos do sistema direto no seu WhatsApp.
                  </div>
                </div>
                <Toggle value={wnEnabled} onChange={v => setNotifications(s => ({ ...s, enabled: v }))} />
              </div>

              {wnEnabled && (
                <div style={{ marginTop: 12 }}>
                  <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Número que vai receber os avisos</label>
                  {numbers.length === 0 ? (
                    <div style={{ fontSize: 12, color: "var(--color-text-secondary)", background: "var(--color-background-secondary)", borderRadius: 8, padding: "10px 12px" }}>
                      Você ainda não conectou nenhum número. Vá em <strong>WhatsApp</strong> e conecte um número primeiro.
                    </div>
                  ) : (
                    <select
                      value={wnDest}
                      onChange={e => setNotifications(s => ({ ...s, destinationNumberId: e.target.value || null }))}
                      style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13, boxSizing: "border-box", color: "inherit" }}
                    >
                      <option value="">Selecione um número...</option>
                      {numbers.map(n => (
                        <option key={n.id} value={n.id}>
                          {n.label || n.id}{n.phone ? ` (+${n.phone})` : ""}{n.status === "connected" ? " ✓" : ""}
                        </option>
                      ))}
                    </select>
                  )}
                  {wnEnabled && numbers.length > 0 && !wnDest && (
                    <div style={{ fontSize: 12, color: "#B45309", marginTop: 4 }}>Escolha um número pra ativar os avisos.</div>
                  )}

                  <div style={{ fontWeight: 500, fontSize: 13, marginTop: 16, marginBottom: 4 }}>Quais avisos você quer receber</div>
                  {/* O texto da linha também liga/desliga: no dedo, acertar só a
                      chavinha de 22px era difícil. */}
                  {WHATSNIMBUS_EVENTS.map(ev => (
                    <div key={ev.key} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: "0.5px solid var(--color-border-tertiary)", gap: 12 }}>
                      <div onClick={() => setWnEvent(ev.key, wnEvents[ev.key] === false)} style={{ flex: 1, cursor: "pointer" }}>
                        <div style={{ fontSize: 13, fontWeight: 500 }}>{ev.label}</div>
                        <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 2 }}>{ev.desc}</div>
                      </div>
                      <Toggle label={ev.label} value={wnEvents[ev.key] !== false} onChange={v => setWnEvent(ev.key, v)} />
                    </div>
                  ))}
                  <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 10 }}>
                    As alterações são salvas automaticamente.
                  </div>
                </div>
              )}
            </div>

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
                  <div onClick={() => setNotifications(s => ({ ...s, [n.key]: !s[n.key] }))} style={{ flex: 1, cursor: "pointer" }}>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>{n.label}</div>
                    <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 2 }}>{n.desc}</div>
                  </div>
                  <Toggle label={n.label} value={notifications[n.key]} onChange={v => setNotifications(s => ({ ...s, [n.key]: v }))} />
                </div>
              ))}
            </div>
            </>
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
            <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--danger-border)", borderRadius: 12, padding: 16 }}>
              <div style={{ fontWeight: 500, marginBottom: 4, color: "var(--danger-text)" }}>Excluir conta</div>
              <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 14 }}>Essa ação é permanente. Todos os seus dados, grupos, agendamentos e histórico serão apagados definitivamente.</div>
              <button onClick={() => setShowDeleteAccount(true)} style={{ padding: "8px 16px", borderRadius: 8, background: "#E24B4A", color: "#fff", border: "none", fontSize: 13, cursor: "pointer", fontWeight: 500 }}>Excluir minha conta</button>
            </div>
          )}
        </div>
      </div>

      {showEmailModal && (
        <Modal title="Alterar email" onClose={() => { setShowEmailModal(false); setEmailMsg(null); }}>
          <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 12, lineHeight: 1.5 }}>
            Você usa <strong style={{ color: "var(--color-text-primary)" }}>{user?.email}</strong> para entrar.
            Vamos mandar um link de confirmação para o endereço novo — o email só muda depois que você clicar nele.
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div>
              <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Novo email</label>
              <input
                type="email"
                value={newEmail}
                onChange={e => setNewEmail(e.target.value)}
                placeholder="voce@exemplo.com"
                style={{ width: "100%", padding: "9px 12px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13, boxSizing: "border-box" }}
              />
            </div>
            <div>
              <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Sua senha atual</label>
              <input
                type="password"
                value={emailPwd}
                onChange={e => setEmailPwd(e.target.value)}
                style={{ width: "100%", padding: "9px 12px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13, boxSizing: "border-box" }}
              />
            </div>
          </div>
          {emailMsg && (
            <div style={{ marginTop: 10, fontSize: 12, lineHeight: 1.5, color: emailMsg.type === "ok" ? PRIMARY_DARK : "var(--danger-text)" }}>{emailMsg.text}</div>
          )}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
            <button onClick={() => { setShowEmailModal(false); setEmailMsg(null); }} style={{ padding: "8px 16px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 13, cursor: "pointer" }}>Fechar</button>
            <button onClick={handleRequestEmailChange} disabled={emailSaving} style={{ padding: "8px 16px", borderRadius: 8, background: PRIMARY, color: "#fff", border: "none", fontSize: 13, cursor: emailSaving ? "wait" : "pointer", fontWeight: 500, opacity: emailSaving ? 0.7 : 1 }}>{emailSaving ? "Enviando..." : "Enviar link"}</button>
          </div>
        </Modal>
      )}

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
            <div style={{ marginTop: 10, fontSize: 12, color: pwdMsg.type === "ok" ? PRIMARY_DARK : "var(--danger-text)" }}>{pwdMsg.text}</div>
          )}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
            <button onClick={() => { setShowPasswordModal(false); setPwdMsg(null); }} style={{ padding: "8px 16px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 13, cursor: "pointer" }}>Cancelar</button>
            <button onClick={handleChangePassword} disabled={pwdSaving} style={{ padding: "8px 16px", borderRadius: 8, background: PRIMARY, color: "#fff", border: "none", fontSize: 13, cursor: pwdSaving ? "wait" : "pointer", fontWeight: 500, opacity: pwdSaving ? 0.7 : 1 }}>{pwdSaving ? "Salvando..." : "Alterar senha"}</button>
          </div>
        </Modal>
      )}

      {showLogout && (
        <LogoutConfirmModal
          onCancel={() => setShowLogout(false)}
          onConfirm={() => { setShowLogout(false); onLogout(); }}
        />
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
          <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 6 }}>Digite <strong style={{ color: "var(--danger-text)" }}>EXCLUIR</strong> para confirmar:</label>
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
