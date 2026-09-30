// Popup "mensagem no privado" para os membros dos grupos destino (tasks 4 e 6,
// só admin).
//
// Só o formulário: escrever a mensagem e ver quantas pessoas e quanto tempo.
// Enviou, o popup fecha e o envio segue no servidor, em segundo plano
// (backend/dm-broadcast/runner.js). O andamento e o cancelar ficam no cartão de
// cada grupo (DmProgresso.jsx).
//
// O ritmo é decisão do produto e mora no servidor: 20–45s entre mensagens e no
// máximo 200 por número por dia. Os números daqui são só para a estimativa.
import { useState } from "react";
import { PRIMARY } from "../../data/constants";
import { startDmBroadcast, errText } from "../../data/api";
import Modal from "../ui/Modal";

const GAP_MEDIO_S = 32.5;
const TETO_DIA = 200;
const TEXTO_MAX = 4096;

const btnSec = { padding: "8px 16px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 13, cursor: "pointer", color: "var(--color-text-primary)" };
const btnPri = (off) => ({ padding: "8px 16px", borderRadius: 8, background: PRIMARY, color: "#fff", border: "none", fontSize: 13, cursor: off ? "not-allowed" : "pointer", fontWeight: 500, opacity: off ? 0.5 : 1 });
const campo = { width: "100%", padding: "9px 12px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13, boxSizing: "border-box", color: "var(--color-text-primary)", fontFamily: "inherit", resize: "vertical" };

function duracao(seg) {
  if (seg < 3600) return `cerca de ${Math.max(1, Math.round(seg / 60))} min`;
  return `cerca de ${Math.round(seg / 3600)}h`;
}

// Quantas pessoas (no máximo) e quanto tempo. "No máximo" porque quem está em
// mais de um grupo recebe uma vez só, e o seu número fica de fora de cada grupo.
// Números diferentes enviam ao mesmo tempo, então quem manda no tempo é o número
// com mais gente.
export function estimativa(grupos) {
  const porNumero = new Map();
  let pessoas = 0;
  for (const w of grupos) {
    const n = Math.max(0, (Number(w.members) || 0) - 1);
    pessoas += n;
    porNumero.set(w.numberId, (porNumero.get(w.numberId) || 0) + n);
  }
  const maiorNumero = Math.max(0, ...porNumero.values());
  const dias = Math.ceil(maiorNumero / TETO_DIA);
  const tempo = dias > 1
    ? `cerca de ${dias} dias (até ${TETO_DIA} por dia por número)`
    : duracao(maiorNumero * GAP_MEDIO_S);
  return { pessoas, tempo };
}

// "fica de fora" para uma lista de grupos, no singular ou no plural.
function deFora(lista, motivo) {
  if (!lista.length) return null;
  return lista.length === 1
    ? `"${lista[0].name}" ${motivo.um} e fica de fora.`
    : `${lista.length} grupos ${motivo.varios} e ficam de fora.`;
}

// `grupos`: os grupos destino alvo (um, pelo ⋯, ou todos, pelo botão geral), com
// `connected` (o número está no ar) e `ocupado` (já tem um envio andando nele).
// `todos`: true quando é o botão geral — o servidor recebe sem lista e usa todos.
// `onStarted(broadcast)`: o envio começou; quem abriu fecha o popup.
export default function DmMembersModal({ campaignId, grupos, todos = false, onClose, onStarted }) {
  const [texto, setTexto] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState(null);

  const offline = grupos.filter(w => w.connected === false);
  const andando = grupos.filter(w => w.connected !== false && w.ocupado);
  const vao = grupos.filter(w => w.connected !== false && !w.ocupado);
  const { pessoas, tempo } = estimativa(vao);
  const vazio = !texto.trim();
  const longo = texto.length > TEXTO_MAX;
  const travado = vazio || longo || enviando || !vao.length;

  const enviar = async () => {
    if (travado) return;
    setEnviando(true);
    setErro(null);
    try {
      const r = await startDmBroadcast(campaignId, { whatsappGroupIds: todos ? undefined : grupos.map(w => w.id), text: texto.trim() });
      onStarted?.(r.broadcast);
    } catch (err) {
      setErro(errText(err, "Não foi possível começar o envio."));
      setEnviando(false);
    }
  };

  const alvo = todos
    ? `Todos os ${grupos.length} grupos destino desta campanha`
    : grupos.length === 1 ? `Grupo "${grupos[0].name}"` : `${grupos.length} grupos`;
  const avisos = [
    deFora(offline, { um: "está com o número desconectado", varios: "estão com o número desconectado" }),
    deFora(andando, { um: "já tem uma mensagem no privado indo", varios: "já têm uma mensagem no privado indo" }),
  ].filter(Boolean);

  return (
    <Modal title="✉ Mensagem no privado" onClose={onClose} confirmOnClickOutside>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ fontSize: 13 }}>
          <div style={{ fontWeight: 500 }}>{alvo}</div>
          <div style={{ color: "var(--color-text-secondary)", marginTop: 2 }}>
            Até ~{pessoas.toLocaleString("pt-BR")} {pessoas === 1 ? "pessoa" : "pessoas"} · {tempo}
          </div>
          {avisos.map(a => (
            <div key={a} style={{ color: "var(--warn-text)", marginTop: 4, fontSize: 12 }}>{a}</div>
          ))}
        </div>

        <div style={{ fontSize: 12, lineHeight: 1.5, padding: "8px 10px", borderRadius: 8, background: "var(--warn-bg)", border: "1px solid var(--warn-border)", color: "var(--warn-text)" }}>
          O WhatsApp bane número que manda muita mensagem no privado para quem não tem o contato salvo. Por isso
          o envio sai devagar (uma mensagem a cada 20–45s, até {TETO_DIA} por dia por número; números diferentes
          enviam ao mesmo tempo) e para sozinho depois de 5 falhas seguidas. Cada pessoa recebe uma vez só, mesmo
          estando em mais de um grupo.
        </div>

        <div>
          <textarea
            aria-label="Mensagem"
            rows={6}
            value={texto}
            onChange={e => setTexto(e.target.value)}
            placeholder="Escreva a mensagem que cada membro vai receber no privado. *negrito*, _itálico_ e ~riscado~ funcionam como no WhatsApp."
            style={campo}
          />
          <div style={{ fontSize: 11, textAlign: "right", color: longo ? "var(--danger-text)" : "var(--color-text-secondary)" }}>
            {texto.length}/{TEXTO_MAX}
          </div>
        </div>

        <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
          O envio roda em segundo plano: o popup fecha e o andamento aparece no cartão de cada grupo, com o botão de cancelar.
        </div>

        {erro && <div role="alert" style={{ fontSize: 12, color: "var(--danger-text)" }}>{erro}</div>}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={onClose} style={btnSec}>Cancelar</button>
          <button onClick={enviar} disabled={travado} style={btnPri(travado)}>
            {enviando ? "⟳ Começando…" : "Enviar no privado"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
