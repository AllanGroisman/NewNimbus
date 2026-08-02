import { useState, useEffect } from "react";
import { PRIMARY } from "../data/constants";
import { adminStripeGet, adminStripeSetMode, errText} from "../data/api";

const card = {
  background: "var(--color-background-primary)",
  border: "0.5px solid var(--color-border-tertiary)",
  borderRadius: 12,
  padding: 16,
};

const MODE_META = {
  test: {
    label: "Teste",
    hint: "Produtos e cartões de teste do Stripe. Nenhuma cobrança real acontece.",
    tone: { bg: "var(--warn-bg)", border: "var(--warn-border)", text: "var(--warn-text)" },
  },
  live: {
    label: "Produção",
    hint: "Produtos de verdade. As cobranças são reais e vão pros clientes.",
    tone: { bg: "var(--success-bg)", border: "var(--success-border)", text: "var(--success-text)" },
  },
};

const fmtPrice = (brl) =>
  typeof brl === "number"
    ? brl.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })
    : "—";

// Price ID inteiro não cabe na tela e não é segredo, mas o final basta pra
// conferir se é o produto certo sem precisar abrir o dashboard.
const shortId = (id) => (id ? `…${id.slice(-8)}` : null);

function Check({ ok, children }) {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "baseline", fontSize: 12 }}>
      <span style={{ color: ok ? "var(--success-text)" : "var(--danger-text)" }}>{ok ? "✓" : "✕"}</span>
      <span style={{ color: "var(--color-text-secondary)" }}>{children}</span>
    </div>
  );
}

export default function PageAdminStripe() {
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);
  // Trocar de modo mexe no que os clientes veem e podem assinar, então pede
  // um segundo clique — sem modal, no próprio botão.
  const [confirming, setConfirming] = useState(false);

  // Usado pelo botão "Recarregar" — busca de novo o catálogo do modo ativo.
  const load = async () => {
    try {
      setData(await adminStripeGet());
      setLoadError(null);
    } catch (err) {
      setLoadError(errText(err, "Não foi possível carregar."));
    }
  };

  // Carga inicial. IIFE + guarda `alive` (mesmo padrão de AdminLayout): sair da
  // tela antes da resposta chegar não pode virar setState em componente morto.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const next = await adminStripeGet();
        if (alive) { setData(next); setLoadError(null); }
      } catch (err) {
        if (alive) setLoadError(errText(err, "Não foi possível carregar."));
      }
    })();
    return () => { alive = false; };
  }, []);

  if (loadError) {
    return <div style={{ fontSize: 13, color: "var(--danger-text)" }}>{loadError}</div>;
  }
  if (!data) {
    return <div style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>Carregando…</div>;
  }

  const active = data.mode;
  const target = active === "test" ? "live" : "test";
  const targetInfo = data.modes[target];
  const canSwitch = targetInfo && targetInfo.missing.length === 0;

  const switchMode = async () => {
    if (!confirming) { setConfirming(true); return; }
    setSaving(true);
    setMsg(null);
    try {
      const next = await adminStripeSetMode(target);
      setData(next);
      setConfirming(false);
      setMsg({
        type: "ok",
        text: `Agora o sistema está em modo ${MODE_META[target].label}. Recarregue a página de Assinatura pra ver os produtos deste modo.`,
      });
    } catch (err) {
      setMsg({ type: "err", text: errText(err, "Não foi possível trocar de modo.") });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 720 }}>
      <div>
        <h1 style={{ fontSize: 20, marginBottom: 4 }}>Stripe</h1>
        <div style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>
          Escolha se o sistema cobra pelos produtos de teste ou pelos de produção. As
          chaves dos dois modos ficam no servidor; aqui só se decide qual está valendo.
        </div>
      </div>

      {/* ─── MODO ATIVO ─── */}
      <div style={{ ...card, display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
        <span style={{
          padding: "6px 14px", borderRadius: 8, fontSize: 13, fontWeight: 600,
          background: MODE_META[active].tone.bg,
          border: `1px solid ${MODE_META[active].tone.border}`,
          color: MODE_META[active].tone.text,
        }}>
          Modo {MODE_META[active].label}
        </span>
        <span style={{ flex: 1, minWidth: 200, fontSize: 12, color: "var(--color-text-secondary)" }}>
          {MODE_META[active].hint}
        </span>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {confirming && canSwitch && (
            <button
              onClick={() => setConfirming(false)}
              style={{
                padding: "9px 14px", borderRadius: 10, fontSize: 13, cursor: "pointer",
                border: "0.5px solid var(--color-border-secondary)", background: "transparent",
                color: "var(--color-text-primary)",
              }}
            >
              Cancelar
            </button>
          )}
          <button
            onClick={switchMode}
            disabled={!canSwitch || saving}
            style={{
              padding: "9px 18px", borderRadius: 10, border: "none", fontSize: 13, fontWeight: 600,
              background: canSwitch && !saving ? PRIMARY : "var(--color-border-secondary)",
              color: "#fff", cursor: canSwitch && !saving ? "pointer" : "not-allowed",
            }}
          >
            {saving ? "Trocando…"
              : confirming ? `Confirmar troca para ${MODE_META[target].label}`
              : `Trocar para ${MODE_META[target].label}`}
          </button>
        </div>
      </div>

      {confirming && canSwitch && (
        <div style={{
          padding: "10px 14px", borderRadius: 10, fontSize: 12.5,
          background: "var(--info-bg)", border: "1px solid var(--info-border)", color: "var(--info-text)",
        }}>
          Ao trocar, as assinaturas feitas no modo {MODE_META[active].label} deixam de valer
          enquanto o sistema estiver em {MODE_META[target].label} — quem assinou lá aparece
          como sem plano ativo. Nada é apagado: voltando o modo, tudo volta como estava.
        </div>
      )}

      {!canSwitch && (
        <div style={{
          padding: "10px 14px", borderRadius: 10, fontSize: 12.5,
          background: "var(--warn-bg)", border: "1px solid var(--warn-border)", color: "var(--warn-text)",
        }}>
          Pra liberar o modo {MODE_META[target].label}, preencha no <code>backend/.env</code> do
          servidor: {targetInfo?.missing.join(", ")} — depois reinicie o backend.
        </div>
      )}

      {/* ─── O QUE ESTÁ CONFIGURADO EM CADA MODO ─── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 14 }}>
        {["test", "live"].map((m) => {
          const info = data.modes[m];
          const isActive = m === active;
          return (
            <div key={m} style={{
              ...card,
              border: isActive ? `1.5px solid ${PRIMARY}` : card.border,
              display: "flex", flexDirection: "column", gap: 8,
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <strong style={{ fontSize: 14 }}>{MODE_META[m].label}</strong>
                {isActive && (
                  <span style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>em uso</span>
                )}
              </div>
              <Check ok={info.hasSecret}>Chave secreta</Check>
              <Check ok={info.hasWebhookSecret}>Segredo do webhook</Check>
              {["basic", "pro", "business"].map((plan) => (
                <Check key={plan} ok={!!info.prices[plan]}>
                  Preço {plan} {info.prices[plan] ? shortId(info.prices[plan]) : ""}
                </Check>
              ))}
              <Check ok={!!info.prices.trialFee}>Taxa do trial de R$ 1</Check>
            </div>
          );
        })}
      </div>

      {/* ─── PRODUTOS DO MODO ATIVO ─── */}
      <div style={{ ...card, display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
          <strong style={{ fontSize: 14 }}>Produtos em uso</strong>
          <span style={{ flex: 1, fontSize: 12, color: "var(--color-text-secondary)" }}>
            Nome e preço vêm do Stripe — mudou lá, muda no site.
          </span>
          <button
            onClick={load}
            style={{
              padding: "6px 12px", borderRadius: 8, fontSize: 12, cursor: "pointer",
              border: "0.5px solid var(--color-border-secondary)", background: "transparent",
              color: "var(--color-text-primary)",
            }}
          >
            Recarregar
          </button>
        </div>
        {data.catalogError ? (
          <div style={{ fontSize: 12.5, color: "var(--danger-text)" }}>
            Não deu pra buscar o catálogo no Stripe: {data.catalogError}
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: "left", color: "var(--color-text-secondary)", fontSize: 12 }}>
                  <th style={{ padding: "4px 8px 4px 0", fontWeight: 500 }}>Plano</th>
                  <th style={{ padding: "4px 8px", fontWeight: 500 }}>Nome no Stripe</th>
                  <th style={{ padding: "4px 8px", fontWeight: 500 }}>Preço</th>
                  <th style={{ padding: "4px 0 4px 8px", fontWeight: 500 }}>Price ID</th>
                </tr>
              </thead>
              <tbody>
                {(data.catalog || []).map((p) => (
                  <tr key={p.id} style={{ borderTop: "0.5px solid var(--color-border-tertiary)" }}>
                    <td style={{ padding: "7px 8px 7px 0", color: "var(--color-text-secondary)" }}>{p.id}</td>
                    <td style={{ padding: "7px 8px", fontWeight: 500 }}>{p.label}</td>
                    <td style={{ padding: "7px 8px" }}>{fmtPrice(p.priceBRL)}</td>
                    <td style={{ padding: "7px 0 7px 8px", color: "var(--color-text-secondary)" }}>
                      {shortId(p.priceId) || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!data.catalog?.some(p => p.priceId) && (
              <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 8 }}>
                Sem resposta do Stripe agora — a tabela mostra os nomes e preços de reserva
                que ficam no código.
              </div>
            )}
          </div>
        )}
      </div>

      {msg && (
        <div style={{
          padding: "10px 14px", borderRadius: 10, fontSize: 13,
          background: msg.type === "ok" ? "var(--success-bg)" : "var(--danger-bg)",
          border: `1px solid ${msg.type === "ok" ? "var(--success-border)" : "var(--danger-border)"}`,
          color: msg.type === "ok" ? "var(--success-text)" : "var(--danger-text)",
        }}>
          {msg.text}
        </div>
      )}
    </div>
  );
}
