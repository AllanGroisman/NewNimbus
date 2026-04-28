import { useState } from "react";
import { PRIMARY, PRIMARY_DARK, PRIMARY_LIGHT } from "../data/constants";
import Badge from "../components/ui/Badge";
import Toggle from "../components/ui/Toggle";
import Modal from "../components/ui/Modal";

export default function PageSettings({ onLogout }) {
  const [section, setSection] = useState("account");
  const [msgTemplate, setMsgTemplate] = useState("�� OFERTA IMPERDÍVEL!\n\n�� {produto}\n�� {loja}\n\n�� De: {preco_antigo}\n✅ Por: {preco}\n��️ -{desconto}\n\n�� {link}");
  const [account, setAccount] = useState({ name: "João Silva", email: "joao@email.com", phone: "+55 11 99999-9999" });
  const [notifications, setNotifications] = useState({ email: true, push: false, weeklyReport: true, pendingReview: true });
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [showDeleteAccount, setShowDeleteAccount] = useState(false);
  const [showLogout, setShowLogout] = useState(false);
  const [theme, setTheme] = useState("auto");

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
                  {[["Nome completo", "name"], ["Email", "email"], ["Telefone", "phone"]].map(([label, key]) => (
                    <div key={key}>
                      <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>{label}</label>
                      <input value={account[key]} onChange={e => setAccount(a => ({ ...a, [key]: e.target.value }))} style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13, boxSizing: "border-box" }} />
                    </div>
                  ))}
                </div>
                <button style={{ marginTop: 14, padding: "7px 16px", borderRadius: 8, background: PRIMARY, color: "#fff", border: "none", fontSize: 13, cursor: "pointer", fontWeight: 500 }}>Salvar alterações</button>
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
              {[
                { label: "Sites monitorados", desc: "Lojas disponíveis para scraping em todos os grupos", items: ["Mercado Livre", "Amazon", "Shopee", "Americanas"] },
                { label: "Categorias ativas", desc: "Categorias de produtos disponíveis na plataforma", items: ["Gamer", "Bebê"] },
              ].map(sec => (
                <div key={sec.label} style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: 16 }}>
                  <div style={{ fontWeight: 500, marginBottom: 4 }}>{sec.label}</div>
                  <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 12 }}>{sec.desc}</div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {sec.items.map(item => (
                      <div key={item} style={{ display: "flex", alignItems: "center", gap: 6, background: "var(--color-background-secondary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 8, padding: "5px 10px", fontSize: 13 }}>
                        <span style={{ width: 8, height: 8, borderRadius: "50%", background: PRIMARY }} />{item}
                      </div>
                    ))}
                    <button style={{ padding: "5px 12px", borderRadius: 8, border: "0.5px dashed var(--color-border-secondary)", background: "transparent", fontSize: 13, cursor: "pointer", color: "var(--color-text-secondary)" }}>+ Adicionar</button>
                  </div>
                </div>
              ))}
            </>
          )}

          {section === "template" && (
            <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: 16 }}>
              <div style={{ fontWeight: 500, marginBottom: 4 }}>Modelo de mensagem padrão</div>
              <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 12 }}>Usado como base para todos os grupos que não têm modelo próprio.</div>
              <textarea value={msgTemplate} onChange={e => setMsgTemplate(e.target.value)} style={{ width: "100%", padding: 10, borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13, resize: "vertical", minHeight: 160, boxSizing: "border-box", fontFamily: "inherit" }} />
              <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 8 }}>
                Variáveis: {"{produto}"}, {"{preco}"}, {"{preco_antigo}"}, {"{desconto}"}, {"{loja}"}, {"{link}"}
              </div>
              <button style={{ marginTop: 12, padding: "7px 16px", borderRadius: 8, background: PRIMARY, color: "#fff", border: "none", fontSize: 13, cursor: "pointer" }}>Salvar modelo</button>
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
        <Modal title="Alterar senha" onClose={() => setShowPasswordModal(false)}>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {["Senha atual", "Nova senha", "Confirmar nova senha"].map(label => (
              <div key={label}>
                <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>{label}</label>
                <input type="password" style={{ width: "100%", padding: "9px 12px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13, boxSizing: "border-box" }} />
              </div>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
            <button onClick={() => setShowPasswordModal(false)} style={{ padding: "8px 16px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 13, cursor: "pointer" }}>Cancelar</button>
            <button onClick={() => setShowPasswordModal(false)} style={{ padding: "8px 16px", borderRadius: 8, background: PRIMARY, color: "#fff", border: "none", fontSize: 13, cursor: "pointer", fontWeight: 500 }}>Alterar senha</button>
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
