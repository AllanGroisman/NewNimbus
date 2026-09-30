import { useState, useEffect, useCallback } from "react";
import { PRIMARY } from "../data/constants";
import { adminExtensaoInfo, adminExtensaoBaixar, errText } from "../data/api";
import { coletorInfo, _resetColetor } from "../data/coletor";

// Admin › Extensão — baixar a extensão "cupons no meu Chrome" pelo próprio
// sistema e saber se a cópia deste Chrome está em dia.
//
// Não há "instalar direto": fora da Chrome Web Store o Chrome só aceita
// extensão carregada sem compactação, e ela não se atualiza sozinha. Por isso a
// tela ensina o caminho (extrair por cima da MESMA pasta + ↻) e compara a versão
// que respondeu aqui com a do servidor.

const card = {
  background: "var(--color-background-primary)",
  border: "0.5px solid var(--color-border-tertiary)",
  borderRadius: 12,
  padding: 16,
};
const btnSec = {
  padding: "7px 12px", borderRadius: 8, fontSize: 12, cursor: "pointer",
  border: "0.5px solid var(--color-border-secondary)", background: "transparent",
  color: "var(--color-text-primary)",
};
const passo = { fontSize: 13, lineHeight: 1.6, color: "var(--color-text-primary)" };

// -1, 0, 1 — "2.4.10" > "2.4.9", que a comparação de texto erraria.
export function compararVersao(a, b) {
  const pa = String(a).split(".").map(n => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

// O que dizer da cópia deste Chrome, dado o que o servidor tem.
export function situacao(servidor, chrome) {
  if (!chrome) return { tom: "neutro", texto: "perguntando à extensão…" };
  if (!chrome.instalada) return { tom: "erro", texto: "Não respondeu neste Chrome — ela não está instalada (ou está desligada)." };
  if (!servidor?.versao || !chrome.versao) return { tom: "neutro", texto: `Respondeu${chrome.versao ? ` — versão ${chrome.versao}` : ""}.` };
  const c = compararVersao(chrome.versao, servidor.versao);
  if (c === 0) return { tom: "ok", texto: `Em dia — a versão ${chrome.versao} deste Chrome é a mesma do servidor.` };
  if (c < 0) return { tom: "aviso", texto: `Atualização disponível: este Chrome tem a ${chrome.versao}, o servidor tem a ${servidor.versao}.` };
  return { tom: "neutro", texto: `Este Chrome tem a ${chrome.versao}, mais nova que a ${servidor.versao} do servidor (cópia de desenvolvimento?).` };
}

const TONS = {
  ok:     { bg: "var(--success-bg)", border: "var(--success-border)", color: "var(--success-text)" },
  aviso:  { bg: "var(--warn-bg)",    border: "var(--warn-border)", color: "var(--warn-text)" },
  erro:   { bg: "var(--danger-bg)",  border: "var(--danger-border)",  color: "var(--danger-text)" },
  neutro: { bg: "var(--color-background-secondary)", border: "var(--color-border-tertiary)", color: "var(--color-text-secondary)" },
};

function Copiavel({ texto }) {
  const [copiado, setCopiado] = useState(false);
  const copiar = async () => {
    try { await navigator.clipboard?.writeText(texto); setCopiado(true); setTimeout(() => setCopiado(false), 1500); } catch { /* sem clipboard: o texto está à vista */ }
  };
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <code>{texto}</code>
      <button onClick={copiar} style={{ ...btnSec, padding: "2px 8px", fontSize: 11 }}>{copiado ? "Copiado" : "Copiar"}</button>
    </span>
  );
}

export default function PageAdminExtensao() {
  const [servidor, setServidor] = useState(null);   // { nome, versao }
  const [chrome, setChrome] = useState(null);       // { instalada, versao, comandos }
  const [baixando, setBaixando] = useState(false);
  const [msg, setMsg] = useState(null);

  const perguntarAoChrome = useCallback(async () => {
    setChrome(null);
    _resetColetor();
    setChrome(await coletorInfo());
  }, []);

  useEffect(() => {
    let alive = true;
    adminExtensaoInfo()
      .then(r => { if (alive) setServidor(r); })
      .catch(err => { if (alive) setMsg({ type: "err", text: errText(err, "Não foi possível ler a versão da extensão no servidor.") }); });
    coletorInfo().then(i => { if (alive) setChrome(i); });
    return () => { alive = false; };
  }, []);

  const baixar = async () => {
    setBaixando(true);
    setMsg(null);
    try {
      const { arquivo } = await adminExtensaoBaixar();
      setMsg({ type: "ok", text: `Baixado: ${arquivo}. Siga os passos abaixo para instalar ou atualizar.` });
    } catch (err) {
      setMsg({ type: "err", text: errText(err, "Não foi possível baixar a extensão.") });
    } finally {
      setBaixando(false);
    }
  };

  const sit = situacao(servidor, chrome);
  const tom = TONS[sit.tom];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 680 }}>
      <div>
        <h1 style={{ fontSize: 20, marginBottom: 4 }}>Extensão</h1>
        <div style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>
          {servidor?.nome || "Nimbus — cupons no meu Chrome"}: faz as etapas de cupom do Mercado Livre numa aba
          deste Chrome, a pedido das telas de cupom.
        </div>
      </div>

      <div style={{ ...card, display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", gap: 24, flexWrap: "wrap", fontSize: 13 }}>
          <div>
            <div style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>No servidor</div>
            <div style={{ fontWeight: 600 }}>{servidor?.versao ? `v${servidor.versao}` : "—"}</div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>Neste Chrome</div>
            <div style={{ fontWeight: 600 }}>
              {chrome === null ? "…" : chrome.instalada ? (chrome.versao ? `v${chrome.versao}` : "instalada") : "não respondeu"}
            </div>
          </div>
        </div>
        <div role="status" style={{ padding: "8px 12px", borderRadius: 8, fontSize: 12, background: tom.bg, border: `1px solid ${tom.border}`, color: tom.color }}>
          {sit.texto}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <button
            onClick={baixar}
            disabled={baixando}
            style={{
              padding: "9px 18px", borderRadius: 10, border: "none", fontSize: 13, fontWeight: 600,
              background: baixando ? "var(--color-border-secondary)" : PRIMARY,
              color: "#fff", cursor: baixando ? "not-allowed" : "pointer",
            }}
          >
            {baixando ? "Baixando…" : `⤓ Baixar extensão${servidor?.versao ? ` (v${servidor.versao})` : ""}`}
          </button>
          <button onClick={perguntarAoChrome} style={btnSec}>Verificar de novo</button>
        </div>
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

      <div style={card}>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>Instalar pela primeira vez</div>
        <ol style={{ ...passo, paddingLeft: 20, margin: 0 }}>
          <li>Baixe o zip e extraia numa pasta que vai ficar sempre no mesmo lugar (ex.: <code>Documentos/nimbus-extensao</code>).</li>
          <li>Abra <Copiavel texto="chrome://extensions" /> numa aba nova (o Chrome não deixa abrir por link).</li>
          <li>Ligue o <b>Modo do desenvolvedor</b>, no canto superior direito.</li>
          <li>Clique em <b>Carregar sem compactação</b> e escolha a pasta extraída (a que tem o <code>manifest.json</code>).</li>
          <li>Volte aqui e dê F5. Entre no Mercado Livre normalmente neste mesmo Chrome.</li>
        </ol>
      </div>

      <div style={card}>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>Atualizar</div>
        <ol style={{ ...passo, paddingLeft: 20, margin: 0 }}>
          <li>Baixe o zip e extraia <b>por cima da mesma pasta</b> de antes, substituindo os arquivos.</li>
          <li>Em <code>chrome://extensions</code>, clique em ↻ na extensão.</li>
          <li>Dê F5 nesta página e confira a versão acima.</li>
        </ol>
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 8, lineHeight: 1.5 }}>
          Não carregue a pasta nova em outro lugar: vira uma segunda cópia da extensão, e as duas respondem aos
          mesmos comandos. Se isso já aconteceu, remova a antiga em <code>chrome://extensions</code>.
        </div>
      </div>
    </div>
  );
}
