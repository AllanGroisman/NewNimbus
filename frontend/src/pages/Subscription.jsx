import { useState } from "react";
import { PRIMARY, PRIMARY_DARK, PRIMARY_LIGHT } from "../data/constants";
import Badge from "../components/ui/Badge";
import Toggle from "../components/ui/Toggle";
import Modal from "../components/ui/Modal";

export default function PageSubscription() {
  const [showCancel, setShowCancel] = useState(false);
  const [showInvoiceDetails, setShowInvoiceDetails] = useState(false);
  const [autoRenew, setAutoRenew] = useState(true);

  const plans = [
    { id: "basic", name: "Básico", price: "R$ 49", features: ["1 número WhatsApp", "3 grupos", "2 categorias", "Scraping manual", "Suporte por email"], current: false },
    { id: "pro", name: "Pro", price: "R$ 99", features: ["3 números WhatsApp", "15 grupos", "Todas as categorias", "Scraping automático", "Dashboard por grupo", "Filtros avançados", "Suporte via WhatsApp"], current: true },
    { id: "business", name: "Business", price: "R$ 199", features: ["Ilimitado", "Grupos ilimitados", "API de integração", "Painel multi-usuário", "Relatórios avançados", "SLA garantido", "Gerente dedicado"], current: false },
  ];

  return (
    <div>
      <h2 style={{ fontSize: 18, fontWeight: 500, marginBottom: 16 }}>Assinatura</h2>

      <div style={{ background: PRIMARY_LIGHT, border: `0.5px solid ${PRIMARY}`, borderRadius: 12, padding: 16, marginBottom: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 10 }}>
          <div>
            <div style={{ fontSize: 12, color: PRIMARY_DARK, fontWeight: 500, marginBottom: 4 }}>PLANO ATUAL</div>
            <div style={{ fontSize: 20, fontWeight: 500, color: PRIMARY_DARK }}>Nimbus Pro</div>
            <div style={{ fontSize: 13, color: PRIMARY_DARK, marginTop: 4 }}>R$ 99/mês &middot; {autoRenew ? "Renova em 15/05/2026" : "Cancelado — acesso até 15/05/2026"}</div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button style={{ padding: "7px 14px", borderRadius: 8, background: "#fff", color: PRIMARY_DARK, border: `0.5px solid ${PRIMARY}`, fontSize: 13, cursor: "pointer", fontWeight: 500 }}>Fazer upgrade</button>
            {autoRenew
              ? <button onClick={() => setShowCancel(true)} style={{ padding: "7px 14px", borderRadius: 8, border: "0.5px solid #F7C1C1", background: "#FCEBEB", color: "#A32D2D", fontSize: 13, cursor: "pointer" }}>Cancelar assinatura</button>
              : <button onClick={() => setAutoRenew(true)} style={{ padding: "7px 14px", borderRadius: 8, background: PRIMARY, color: "#fff", border: "none", fontSize: 13, cursor: "pointer", fontWeight: 500 }}>Reativar renovação</button>
            }
          </div>
        </div>
      </div>

      <h3 style={{ fontSize: 14, fontWeight: 500, marginBottom: 12 }}>Planos disponíveis</h3>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12, marginBottom: 24 }}>
        {plans.map(p => (
          <div key={p.id} style={{ background: "var(--color-background-primary)", border: p.current ? `2px solid ${PRIMARY}` : "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: 16, position: "relative" }}>
            {p.current && <div style={{ position: "absolute", top: -10, left: "50%", transform: "translateX(-50%)", background: PRIMARY, color: "#fff", fontSize: 11, padding: "2px 10px", borderRadius: 6, fontWeight: 500, whiteSpace: "nowrap" }}>Plano atual</div>}
            <div style={{ fontWeight: 500, marginBottom: 4 }}>{p.name}</div>
            <div style={{ fontSize: 22, fontWeight: 500, color: PRIMARY_DARK, marginBottom: 12 }}>{p.price}<span style={{ fontSize: 13, fontWeight: 400, color: "var(--color-text-secondary)" }}>/mês</span></div>
            <ul style={{ paddingLeft: 0, margin: "0 0 14px", listStyle: "none", display: "flex", flexDirection: "column", gap: 6 }}>
              {p.features.map(f => <li key={f} style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "flex", gap: 6 }}><span style={{ color: PRIMARY, fontWeight: 700 }}>{"✓"}</span>{f}</li>)}
            </ul>
            <button style={{ width: "100%", padding: "7px", borderRadius: 8, background: p.current ? PRIMARY_LIGHT : "transparent", color: p.current ? PRIMARY_DARK : "var(--color-text-primary)", border: p.current ? "none" : "0.5px solid var(--color-border-secondary)", fontSize: 13, cursor: "pointer", fontWeight: 500 }}>
              {p.current ? "Plano ativo" : "Assinar"}
            </button>
          </div>
        ))}
      </div>

      <h3 style={{ fontSize: 14, fontWeight: 500, marginBottom: 12 }}>Método de pagamento</h3>
      <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: 16, marginBottom: 24 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ width: 40, height: 28, background: "var(--color-background-secondary)", borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 500 }}>VISA</div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 500 }}>&bull;&bull;&bull;&bull; &bull;&bull;&bull;&bull; &bull;&bull;&bull;&bull; 4242</div>
              <div style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>Expira em 12/2027</div>
            </div>
          </div>
          <button style={{ padding: "6px 14px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 13, cursor: "pointer" }}>Alterar</button>
        </div>
      </div>

      <h3 style={{ fontSize: 14, fontWeight: 500, marginBottom: 12 }}>Histórico de pagamentos</h3>
      <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, overflow: "hidden" }}>
        {[["15/04/2026", "Plano Pro", "R$ 99", "Pago"], ["15/03/2026", "Plano Pro", "R$ 99", "Pago"], ["15/02/2026", "Plano Pro", "R$ 99", "Pago"], ["15/01/2026", "Plano Pro", "R$ 99", "Pago"]].map(([date, plan, val, status], i, arr) => (
          <div key={date} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", borderBottom: i < arr.length - 1 ? "0.5px solid var(--color-border-tertiary)" : "none" }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 500 }}>{plan}</div>
              <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 2 }}>{date}</div>
            </div>
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <span style={{ fontSize: 13, fontWeight: 500 }}>{val}</span>
              <Badge color="green">{status}</Badge>
              <button onClick={() => setShowInvoiceDetails(true)} style={{ padding: "4px 10px", borderRadius: 6, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 12, cursor: "pointer" }}>Fatura</button>
            </div>
          </div>
        ))}
      </div>

      {showCancel && (
        <Modal title="Cancelar assinatura?" onClose={() => setShowCancel(false)} danger>
          <p style={{ fontSize: 13, marginBottom: 12, color: "var(--color-text-secondary)", lineHeight: 1.5 }}>
            Ao cancelar, você continuará com acesso ao plano Pro até <strong style={{ color: "var(--color-text-primary)" }}>15/05/2026</strong>. Após essa data:
          </p>
          <ul style={{ fontSize: 12, color: "var(--color-text-secondary)", paddingLeft: 20, marginBottom: 14, lineHeight: 1.6 }}>
            <li>Os envios automáticos serão interrompidos</li>
            <li>Seus dados serão mantidos por 30 dias</li>
            <li>Você pode reativar a qualquer momento</li>
          </ul>
          <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 6 }}>Nos ajude a melhorar &mdash; por que está cancelando?</label>
          <select style={{ width: "100%", padding: "9px 12px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13, marginBottom: 16 }}>
            <option>Selecione um motivo...</option>
            <option>Preço muito alto</option>
            <option>Não estou usando o suficiente</option>
            <option>Faltam funcionalidades</option>
            <option>Problemas técnicos</option>
            <option>Outro motivo</option>
          </select>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button onClick={() => setShowCancel(false)} style={{ padding: "8px 16px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 13, cursor: "pointer" }}>Manter assinatura</button>
            <button onClick={() => { setAutoRenew(false); setShowCancel(false); }} style={{ padding: "8px 16px", borderRadius: 8, background: "#E24B4A", color: "#fff", border: "none", fontSize: 13, cursor: "pointer", fontWeight: 500 }}>Confirmar cancelamento</button>
          </div>
        </Modal>
      )}

      {showInvoiceDetails && (
        <Modal title="Fatura #2026-04-15" onClose={() => setShowInvoiceDetails(false)}>
          <div style={{ fontSize: 13, lineHeight: 1.8 }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}><span style={{ color: "var(--color-text-secondary)" }}>Plano</span><span>Nimbus Pro</span></div>
            <div style={{ display: "flex", justifyContent: "space-between" }}><span style={{ color: "var(--color-text-secondary)" }}>Período</span><span>15/04 a 15/05/2026</span></div>
            <div style={{ display: "flex", justifyContent: "space-between" }}><span style={{ color: "var(--color-text-secondary)" }}>Método</span><span>Visa &bull;&bull;&bull;&bull; 4242</span></div>
            <div style={{ borderTop: "0.5px solid var(--color-border-tertiary)", margin: "12px 0", paddingTop: 12, display: "flex", justifyContent: "space-between", fontWeight: 500 }}><span>Total</span><span>R$ 99,00</span></div>
          </div>
          <button style={{ marginTop: 14, width: "100%", padding: "9px", borderRadius: 8, background: PRIMARY, color: "#fff", border: "none", fontSize: 13, cursor: "pointer", fontWeight: 500 }}>Baixar PDF</button>
        </Modal>
      )}
    </div>
  );
}
