// Admin › Cupom — testa um cupom do Mercado Livre num produto, na hora.
//
// Duas perguntas diferentes, respondidas na mesma tela:
//   "Só leitura" — quais cupons a PÁGINA do produto já oferece (o clipado).
//   "Leitura + checkout" — se um CÓDIGO (o que veio na legenda do grupo líder)
//   é aceito naquele produto. Isso só o checkout responde, então o robô leva o
//   item até a tela de pagamento com a conta do sistema — e para ali.
//
// Nada é gravado na fila e nada é enviado: é diagnóstico.
import { useState, useEffect, useCallback } from "react";
import { PRIMARY, PRIMARY_DARK } from "../data/constants";
import { adminCouponTest, adminCouponHistory, errText } from "../data/api";
import CuponsDoML from "./AdminCupomML";

// Semáforo por desfecho. Os "cupom existe mas não serve" ficam em amarelo de
// propósito: são respostas úteis do ML, não falha da ferramenta.
const STATUS = {
  valido:                 { label: "✅ Cupom válido",            color: PRIMARY_DARK },
  leitura:                { label: "👁 Só leitura",              color: "var(--color-text-secondary)" },
  invalido:               { label: "❌ Código não reconhecido",  color: "var(--danger-text)" },
  expirado:               { label: "⌛ Cupom expirado",          color: "var(--danger-text)" },
  usado:                  { label: "🔁 Cupom já usado",          color: "var(--warn-text)" },
  "nao-aplicavel":        { label: "🚫 Não vale pra este produto", color: "var(--warn-text)" },
  "minimo-nao-atingido":  { label: "💰 Falta o valor mínimo",    color: "var(--warn-text)" },
  login:                  { label: "🔑 Sessão do ML caiu",       color: "var(--danger-text)" },
  verificacao:            { label: "🪪 Conta em verificação",    color: "var(--danger-text)" },
  captcha:                { label: "🤖 ML pediu CAPTCHA",        color: "var(--danger-text)" },
  indeterminado:          { label: "❓ Não deu pra saber",       color: "var(--warn-text)" },
};

const brl = (v) => (typeof v === "number" ? `R$ ${v.toFixed(2).replace(".", ",")}` : "—");

// Duas perguntas diferentes moram nesta página, e cada uma tem a sua aba:
// "Testar cupom" é o diagnóstico de UM código num produto; "Cupons do ML" é a
// lista que o Mercado Livre oferece para a conta do sistema, com os produtos de
// cada cupom (AdminCupomML.jsx).
export default function PageAdminCupom() {
  const [aba, setAba] = useState("teste");

  return (
    <div>
      <div style={{ marginBottom: 18 }}>
        <h1 style={{ fontSize: 20, marginBottom: 4 }}>Cupom</h1>
        <div style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>
          Confere um cupom antes de ele ir pro grupo — e guarda os cupons que o ML oferece.
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        {[
          ["teste", "Testar cupom"],
          ["ml", "Cupons do ML"],
        ].map(([id, label]) => (
          <button
            key={id}
            onClick={() => setAba(id)}
            style={{
              padding: "7px 14px", borderRadius: 8, fontSize: 13, cursor: "pointer",
              border: `1px solid ${aba === id ? PRIMARY : "var(--color-border-tertiary)"}`,
              background: aba === id ? "var(--color-background-secondary)" : "transparent",
              color: aba === id ? PRIMARY_DARK : "var(--color-text-primary)",
              fontWeight: aba === id ? 600 : 400,
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {aba === "teste" ? <TestarNoCheckout /> : <CuponsDoML />}
    </div>
  );
}

function TestarNoCheckout() {
  const [url, setUrl] = useState("");
  const [code, setCode] = useState("");
  const [mode, setMode] = useState("checkout");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [history, setHistory] = useState([]);

  const refreshHistory = useCallback(async () => {
    try {
      const r = await adminCouponHistory();
      setHistory(r.history || []);
    } catch { /* histórico é acessório — não vale derrubar a tela */ }
  }, []);

  useEffect(() => { refreshHistory(); }, [refreshHistory]);

  const podeRodar = url.trim() && (mode === "leitura" || code.trim());

  const testar = async () => {
    if (!podeRodar) return;
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const r = await adminCouponTest({ url: url.trim(), code: code.trim() || null, mode });
      setResult(r.result);
      refreshHistory();
    } catch (err) {
      setError(errText(err, "Não foi possível testar o cupom agora."));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div>
      <div style={cardStyle}>
        <div style={{ fontWeight: 500, marginBottom: 4 }}>Testar um cupom</div>
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 12, lineHeight: 1.5 }}>
          Usa a conta do Mercado Livre do sistema (a mesma do Hub — Admin › Mercado Livre).
          No modo <b>Leitura + checkout</b> o produto é levado até a tela de pagamento pra
          aplicar o código e ler a resposta do ML: <b>a compra nunca é finalizada</b>. Nada é
          gravado na fila e nada é enviado. Leva de 40 a 60 segundos.
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 640 }}>
          <div>
            <label style={labelStyle}>Link do produto</label>
            <input
              type="url"
              placeholder="https://produto.mercadolivre.com.br/MLB-..."
              value={url}
              onChange={e => setUrl(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && !running) testar(); }}
              style={inputStyle}
            />
          </div>

          <div>
            <label style={labelStyle}>Código do cupom</label>
            <input
              type="text"
              placeholder="JBL20"
              value={code}
              onChange={e => setCode(e.target.value.toUpperCase())}
              onKeyDown={e => { if (e.key === "Enter" && !running) testar(); }}
              style={{ ...inputStyle, textTransform: "uppercase" }}
            />
          </div>

          <div>
            <label style={labelStyle}>O que fazer</label>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {[
                ["leitura", "Só leitura", "Lê os cupons que a página oferece. Não mexe em carrinho."],
                ["checkout", "Leitura + checkout", "Também aplica o código na tela de pagamento."],
              ].map(([val, label, hint]) => (
                <button
                  key={val}
                  onClick={() => setMode(val)}
                  title={hint}
                  style={{
                    padding: "7px 14px", borderRadius: 8, fontSize: 13, cursor: "pointer", textAlign: "left",
                    border: `1px solid ${mode === val ? PRIMARY : "var(--color-border-tertiary)"}`,
                    background: mode === val ? "var(--color-background-secondary)" : "transparent",
                    color: mode === val ? PRIMARY_DARK : "var(--color-text-primary)",
                    fontWeight: mode === val ? 600 : 400,
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            {mode === "checkout" && (
              <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 6 }}>
                Um teste por vez. Se o botão “Comprar agora” não aparecer, o robô passa pelo
                carrinho e tira o item de lá no fim.
              </div>
            )}
          </div>

          <div>
            <button
              onClick={testar}
              disabled={running || !podeRodar}
              style={{
                padding: "9px 18px", borderRadius: 8, border: "none", fontSize: 13, fontWeight: 500,
                background: PRIMARY, color: "#fff",
                cursor: running || !podeRodar ? "not-allowed" : "pointer",
                opacity: running || !podeRodar ? 0.6 : 1,
              }}
            >
              {running ? "⟳ Testando (~1 min)..." : "Testar cupom"}
            </button>
          </div>
        </div>

        {error && (
          <div style={{ marginTop: 12, background: "var(--danger-bg)", color: "var(--danger-text)", padding: "8px 10px", borderRadius: 8, fontSize: 12 }}>
            {error}
          </div>
        )}

        {result && <Resultado result={result} />}
      </div>

      <div style={cardStyle}>
        <div style={{ fontWeight: 500, marginBottom: 10 }}>Últimos testes</div>
        {history.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>Nenhum teste rodado ainda.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {history.map((h, i) => {
              const st = STATUS[h.status] || { label: h.status, color: "var(--color-text-secondary)" };
              return (
                <div key={i} style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap", fontSize: 12, paddingBottom: 6, borderBottom: "0.5px solid var(--color-border-tertiary)" }}>
                  <span style={{ color: "var(--color-text-secondary)", minWidth: 130 }}>
                    {new Date(h.at).toLocaleString("pt-BR")}
                  </span>
                  <span style={{ color: st.color, fontWeight: 500 }}>{st.label}</span>
                  <span style={{ fontFamily: "monospace" }}>{h.code || "—"}</span>
                  <span style={{ color: "var(--color-text-secondary)", flex: "1 1 200px", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {h.url}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function Resultado({ result }) {
  const st = STATUS[result.status] || { label: result.status, color: "var(--color-text-secondary)" };
  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
        <span style={{ fontWeight: 600, color: st.color }}>{st.label}</span>
        <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
          {result.code ? `código ${result.code} · ` : ""}{((result.durationMs || 0) / 1000).toFixed(1)}s
        </span>
      </div>

      <div style={{ fontSize: 13, marginBottom: 12 }}>{result.reason}</div>

      {result.checkout?.attempted && (
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 12 }}>
          Total do pedido: <b>{brl(result.totalBefore)}</b> → <b>{brl(result.totalAfter)}</b>
          {typeof result.discount === "number" && ` (desconto de ${brl(result.discount)})`}
          {result.checkout.cartUsed && (
            <> · carrinho {result.checkout.cartCleaned ? "limpo" : <b style={{ color: "var(--warn-text)" }}>NÃO limpo — confira à mão</b>}</>
          )}
        </div>
      )}

      {result.checkout?.trail?.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 4 }}>
            Por onde o robô passou no checkout
          </div>
          <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: "var(--color-text-secondary)" }}>
            {result.checkout.trail.map(p => (
              <li key={p.passo}>
                <b>{p.titulo || "(tela sem título)"}</b>
                {p.escolha && p.escolha !== "nada a escolher" && ` · ${p.escolha}`}
                {p.clicou && ` · clicou "${p.clicou}"`}
                {p.clicou && p.mudou === false && " · a tela não mudou"}
                {p.erro && ` · o checkout do ML caiu (${p.erro})`}
                {p.parou === "recarreguei" && " · recarreguei e tentei de novo"}
                {p.parou && p.parou !== "achei-o-cupom" && p.parou !== "recarreguei" && ` · parou aqui`}
              </li>
            ))}
          </ol>
        </div>
      )}

      {result.checkout?.couponOpen?.tentativas?.length > 0 && !result.checkout.fieldFound && (
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 12 }}>
          Tentei abrir o cupom clicando em:{" "}
          {result.checkout.couponOpen.tentativas.map((t, i) => (
            <span key={i}>{i > 0 && ", "}{t.clicou ? `"${t.clicou}" (${t.tag})` : "nada encontrado"}</span>
          ))}
          {result.checkout.couponOpen.titulo && ` · parou em "${result.checkout.couponOpen.titulo}"`}
        </div>
      )}

      {result.clipped?.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 4 }}>
            Cupons que a própria página oferece
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {result.clipped.map((c, i) => (
              <span key={i} style={{ fontSize: 12, padding: "3px 8px", borderRadius: 6, background: "var(--color-background-secondary)" }}>
                {c.label}
              </span>
            ))}
          </div>
        </div>
      )}

      <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 4 }}>
        {(result.checks || []).map(c => (
          <li key={c.key} style={{ fontSize: 12, display: "flex", gap: 8 }}>
            <span>{c.ok ? "✅" : "⚠️"}</span>
            <span style={{ color: "var(--color-text-secondary)", minWidth: 210 }}>{c.label}</span>
            <span style={{ flex: 1, minWidth: 0, wordBreak: "break-word" }}>{String(c.value ?? "—")}</span>
          </li>
        ))}
      </ul>

      {result.shots?.files?.length > 0 && (
        <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 12 }}>
          📸 {result.shots.files.length} print(s) do caminho em <code style={{ wordBreak: "break-all" }}>{result.shots.dir}</code>
        </div>
      )}

      <details style={{ marginTop: 12 }}>
        <summary style={{ cursor: "pointer", fontSize: 12, color: "var(--color-text-secondary)" }}>Resposta crua</summary>
        <pre style={{ fontSize: 11, background: "var(--color-background-secondary)", padding: 10, borderRadius: 8, overflowX: "auto", marginTop: 8 }}>
          {JSON.stringify(result, null, 2)}
        </pre>
      </details>
    </div>
  );
}

const cardStyle = { background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: 16, marginBottom: 18 };
const inputStyle = { width: "100%", padding: "7px 10px", borderRadius: 7, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13, boxSizing: "border-box" };
const labelStyle = { fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 6 };
