import { useEffect, useState } from "react";
import { PRIMARY } from "../data/constants";
import { adminMlCupons, vincularPalavraCupom, errText } from "../data/api";
import Modal from "./ui/Modal";

// O admin diz, na mão, de qual cupom é uma palavra (backend:
// coupons/pg.js:vincularPalavraManual). Serve para quando o teste no checkout não
// conseguiu ligar as duas, como no DEZOFF e no "10% OFF com DEZOFF". Os itens da
// fila presos por essa palavra saem sozinhos depois.
// `palavra` vem preenchida pelo card da Fila; na aba Cupons com Palavras ela é digitada.
function fmtMoeda(n) {
  return Number(n) > 0 ? `R$ ${Number(n).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : null;
}

function descricao(c) {
  const partes = [];
  if (c.kind === "percent" && c.value != null) partes.push(`${c.value}% OFF`);
  else if (c.kind === "fixed" && c.value != null) partes.push(`${fmtMoeda(c.value)} OFF`);
  if (fmtMoeda(c.maxDiscount)) partes.push(`até ${fmtMoeda(c.maxDiscount)}`);
  if (fmtMoeda(c.minPurchase)) partes.push(`mínimo ${fmtMoeda(c.minPurchase)}`);
  if (c.expiresAt) partes.push(`vence ${new Date(c.expiresAt).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}`);
  return partes.join(" · ");
}

export default function VincularCupomModal({ palavra: palavraInicial = "", onClose, onDone }) {
  const [palavra, setPalavra] = useState(String(palavraInicial || "").toUpperCase());
  const [busca, setBusca] = useState(String(palavraInicial || ""));
  const [cupons, setCupons] = useState([]);
  const [carregando, setCarregando] = useState(false);
  const [salvando, setSalvando] = useState(null);
  const [erro, setErro] = useState("");

  useEffect(() => {
    let vivo = true;
    const t = setTimeout(() => {
      setCarregando(true);
      adminMlCupons({ q: busca.trim(), onlyValid: true, pageSize: 30 })
        .then(r => { if (vivo) setCupons(r?.items || []); })
        .catch(e => { if (vivo) setErro(errText(e)); })
        .finally(() => { if (vivo) setCarregando(false); });
    }, 300);
    return () => { vivo = false; clearTimeout(t); };
  }, [busca]);

  async function vincular(c) {
    const p = palavra.trim().toUpperCase();
    if (!p) { setErro("Digite a palavra do cupom."); return; }
    setErro("");
    setSalvando(c.campaignId);
    try {
      await vincularPalavraCupom(p, c.campaignId);
      onDone?.({ palavra: p, cupom: c });
      onClose?.();
    } catch (e) {
      setErro(errText(e));
    } finally {
      setSalvando(null);
    }
  }

  const input = { width: "100%", padding: "8px 10px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "var(--color-background-primary)", color: "var(--color-text-primary)", fontSize: 13, boxSizing: "border-box" };

  return (
    <Modal title="Validar cupom na mão" onClose={onClose}>
      <p style={{ fontSize: 12, marginBottom: 12, color: "var(--color-text-secondary)", lineHeight: 1.5 }}>
        Escolha o cupom a que esta palavra pertence. Isso vale para todo o sistema, e os produtos da fila com essa palavra passam a sair com o desconto do cupom.
      </p>
      <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Palavra</label>
      <input
        value={palavra}
        onChange={e => setPalavra(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
        placeholder="Ex.: DEZOFF"
        style={{ ...input, fontFamily: "monospace", marginBottom: 10 }}
      />
      <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Buscar cupom (título, loja ou número da campanha)</label>
      <input value={busca} onChange={e => setBusca(e.target.value)} placeholder="Ex.: DEZOFF, 10% OFF…" style={{ ...input, marginBottom: 10 }} />
      {erro && <div style={{ fontSize: 12, color: "var(--danger-text)", marginBottom: 8 }}>{erro}</div>}
      <div style={{ maxHeight: 320, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
        {carregando && <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>Buscando…</div>}
        {!carregando && !cupons.length && <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>Nenhum cupom vigente com esse texto.</div>}
        {cupons.map(c => (
          <div key={c.campaignId} style={{ display: "flex", alignItems: "center", gap: 10, padding: 10, borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 500, wordBreak: "break-word" }}>{c.title}</div>
              <div style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>
                #{c.campaignId}{descricao(c) ? ` · ${descricao(c)}` : ""}
                {c.code ? <> · palavra atual <span style={{ fontFamily: "monospace" }}>{c.code}</span></> : " · sem palavra"}
              </div>
            </div>
            <button
              onClick={() => vincular(c)}
              disabled={!!salvando || !palavra.trim()}
              style={{ padding: "6px 12px", borderRadius: 7, background: PRIMARY, color: "#fff", border: "none", fontSize: 12, cursor: salvando ? "wait" : "pointer", opacity: salvando && salvando !== c.campaignId ? 0.5 : 1, flexShrink: 0 }}
            >
              {salvando === c.campaignId ? "Vinculando…" : "Vincular"}
            </button>
          </div>
        ))}
      </div>
    </Modal>
  );
}
