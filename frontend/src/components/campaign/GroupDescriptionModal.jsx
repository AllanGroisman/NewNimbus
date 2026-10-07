// Popup "Editar descrição" de um grupo destino (task 3): a descrição DO GRUPO NO
// WHATSAPP, não uma nota do Nimbus.
//
// Abre com a descrição atual lida do WhatsApp. Se a leitura falha (número caído),
// fica com a última que o Nimbus gravou, e diz isso. Ao salvar, dá para gravar só
// neste grupo ou em todos os grupos destino da campanha. O "todos" passa por uma
// confirmação e grava um grupo por vez, com uma pausa entre eles. Se algum falha,
// o popup fica aberto mostrando o motivo de cada um.
import { useEffect, useRef, useState } from "react";
import { PRIMARY } from "../../data/constants";
import { getWAGroupDescription, setWAGroupDescription, errText } from "../../data/api";
import Modal from "../ui/Modal";

// O máximo do WhatsApp. O servidor recusa acima disto.
export const DESC_MAX = 2048;

const btnSec = { padding: "8px 16px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 13, cursor: "pointer", color: "var(--color-text-primary)" };
const btnPri = (off) => ({ padding: "8px 16px", borderRadius: 8, background: PRIMARY, color: "#fff", border: "none", fontSize: 13, cursor: off ? "not-allowed" : "pointer", fontWeight: 500, opacity: off ? 0.5 : 1 });
const campo = { width: "100%", padding: "9px 12px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13, boxSizing: "border-box", color: "var(--color-text-primary)", fontFamily: "inherit", resize: "vertical" };
const nota = { fontSize: 12, color: "var(--color-text-secondary)" };

const esperar = (ms) => new Promise(r => setTimeout(r, ms));

// `grupo`: o grupo do ⋯ ({ id, numberId, name, description, connected }).
// `grupos`: os grupos destino da campanha, com `connected`. É a lista do "todos".
// `onSaved(results, texto)`: chamado ao fim de cada gravação. `results` traz
// [{ id, name, ok, error }], para quem abriu atualizar a cópia local dos que deram certo.
// `gapMs`: a pausa entre grupos no "todos", para não metralhar o WhatsApp.
export default function GroupDescriptionModal({ grupo, grupos = [], onSaved, onClose, gapMs = 1000 }) {
  const [texto, setTexto] = useState(grupo.description || "");
  const [lendo, setLendo] = useState(true);
  const [leitura, setLeitura] = useState(null);    // "whatsapp" | "falhou"
  const [passo, setPasso] = useState("editar");    // "editar" | "confirmar" | "resultado"
  const [ocupado, setOcupado] = useState(null);    // { feito, total } enquanto grava
  const [resultados, setResultados] = useState([]);
  const tocado = useRef(false);
  const vivo = useRef(true);
  useEffect(() => () => { vivo.current = false; }, []);

  useEffect(() => {
    getWAGroupDescription(grupo.numberId, grupo.id)
      .then(r => {
        if (!vivo.current) return;
        if (!tocado.current) setTexto(r?.description || "");
        setLeitura("whatsapp");
      })
      .catch(() => { if (vivo.current) setLeitura("falhou"); })
      .finally(() => { if (vivo.current) setLendo(false); });
  }, [grupo.numberId, grupo.id]);

  const longo = texto.length > DESC_MAX;
  const travado = lendo || longo || !!ocupado;
  const outros = grupos.length > 1;
  // Gravando, o popup não fecha: os grupos que faltam ficariam sem a descrição.
  const fechar = () => { if (!ocupado) onClose?.(); };

  const gravar = async (alvo) => {
    const final = texto.trim();
    setOcupado({ feito: 0, total: alvo.length });
    const out = [];
    for (let i = 0; i < alvo.length; i++) {
      const w = alvo[i];
      try {
        await setWAGroupDescription(w.numberId, w.id, final);
        out.push({ id: w.id, name: w.name, ok: true });
      } catch (err) {
        out.push({ id: w.id, name: w.name, ok: false, error: errText(err, "Não foi possível salvar.") });
      }
      if (!vivo.current) return;
      setOcupado({ feito: i + 1, total: alvo.length });
      if (gapMs > 0 && i < alvo.length - 1) await esperar(gapMs);
    }
    if (!vivo.current) return;
    setOcupado(null);
    onSaved?.(out, final);
    if (out.every(r => r.ok)) onClose?.();
    else { setResultados(out); setPasso("resultado"); }
  };

  const titulo = `✎ Descrição — ${grupo.name}`;

  if (passo === "resultado") {
    const ok = resultados.filter(r => r.ok).length;
    return (
      <Modal title={titulo} onClose={fechar}>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div role="alert" style={{ fontSize: 13, fontWeight: 500 }}>
            {ok ? `Salvo em ${ok} de ${resultados.length} grupos.` : "Não foi possível salvar."}
          </div>
          <ul style={{ margin: 0, paddingLeft: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
            {resultados.map(r => (
              <li key={r.id} style={{ color: r.ok ? "var(--color-text-secondary)" : "var(--danger-text)" }}>
                {r.ok ? "✓" : "✗"} {r.name}{r.ok ? "" : ` — ${r.error}`}
              </li>
            ))}
          </ul>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button onClick={fechar} style={btnSec}>Fechar</button>
          </div>
        </div>
      </Modal>
    );
  }

  if (passo === "confirmar") {
    return (
      <Modal title="Aplicar em todos os grupos?" onClose={fechar} confirmOnClickOutside>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <p style={{ fontSize: 13, margin: 0, lineHeight: 1.5, color: "var(--color-text-secondary)" }}>
            {texto.trim()
              ? <>A descrição destes {grupos.length} grupos no WhatsApp vai ser trocada por esta:</>
              : <>A descrição destes {grupos.length} grupos no WhatsApp vai ser <strong style={{ color: "var(--color-text-primary)" }}>apagada</strong>.</>}
          </p>
          {texto.trim() && (
            <div style={{ fontSize: 12, whiteSpace: "pre-wrap", maxHeight: 120, overflowY: "auto", padding: "8px 10px", borderRadius: 8, background: "var(--color-background-secondary)" }}>{texto.trim()}</div>
          )}
          <ul style={{ margin: 0, paddingLeft: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
            {grupos.map(w => (
              <li key={w.id}>
                {w.name}
                {w.connected === false && <span style={{ color: "var(--warn-text)" }}> · ⚠ número desconectado — vai falhar</span>}
              </li>
            ))}
          </ul>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button onClick={() => setPasso("editar")} disabled={!!ocupado} style={btnSec}>Voltar</button>
            <button onClick={() => gravar(grupos)} disabled={!!ocupado} style={btnPri(!!ocupado)}>
              {ocupado ? `⟳ Aplicando… ${ocupado.feito} de ${ocupado.total}` : `Aplicar em ${grupos.length} grupos`}
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={titulo} onClose={fechar} confirmOnClickOutside>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={nota}>
          {lendo
            ? "⟳ Lendo a descrição atual do WhatsApp…"
            : leitura === "whatsapp"
              ? "Descrição atual do grupo no WhatsApp. Quem entra no grupo vê este texto."
              : <span style={{ color: "var(--warn-text)" }}>Não deu para ler a descrição do WhatsApp agora (o número está conectado?). Mostrando a última salva pelo Nimbus.</span>}
        </div>
        <div>
          <textarea
            aria-label="Descrição do grupo"
            rows={7}
            value={texto}
            onChange={e => { tocado.current = true; setTexto(e.target.value); }}
            placeholder="Regras do grupo, links, horários das ofertas… *negrito*, _itálico_ e ~riscado~ funcionam como no WhatsApp."
            style={campo}
          />
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 11, color: "var(--color-text-secondary)" }}>
            <span>{!texto.trim() && !lendo ? "Vazio apaga a descrição do grupo." : ""}</span>
            <span style={{ color: longo ? "var(--danger-text)" : undefined }}>{texto.length}/{DESC_MAX}</span>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
          <button onClick={fechar} disabled={!!ocupado} style={btnSec}>Cancelar</button>
          {outros && (
            <button onClick={() => setPasso("confirmar")} disabled={travado} style={{ ...btnSec, cursor: travado ? "not-allowed" : "pointer", opacity: travado ? 0.5 : 1 }}>
              Aplicar em todos os {grupos.length} grupos
            </button>
          )}
          <button onClick={() => gravar([grupo])} disabled={travado} style={btnPri(travado)}>
            {ocupado ? "⟳ Salvando…" : outros ? "Salvar só neste grupo" : "Salvar"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
