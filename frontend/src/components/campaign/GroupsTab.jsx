// Aba Grupos da campanha (tasks 24 e 25).
//
// No repasse a aba mostra o caminho do link: os Grupos Origem (de onde a captura
// pesca os links) ligados por uma seta aos Grupos Destino (para onde a campanha
// envia). Na campanha de busca só existe o destino. Os dois lados usam o MESMO
// cartão — foto do grupo, WhatsApp de onde ele vem e se está conectado — e as
// ações ficam atrás do "⋯", para a lista não virar um mar de botões.
//
// Adicionar, dos dois lados, é o mesmo popup: primeiro o WhatsApp, depois o grupo
// daquele WhatsApp. No destino, o popup também cria um grupo novo.
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { PRIMARY, PRIMARY_DARK, PRIMARY_LIGHT, WA_GROUP_MAX, WA_GROUP_ENCHENDO } from "../../data/constants";
import { getWAGroupPicture, getWAInvite, listDmBroadcasts, cancelDmBroadcast, errText } from "../../data/api";
import Modal from "../ui/Modal";
import AlertBanner from "../ui/AlertBanner";
import { useMedia, isTouch, TOUCH } from "../../data/useMedia";
import DmMembersModal from "./DmMembersModal";
import GroupDescriptionModal from "./GroupDescriptionModal";
import DmProgresso from "./DmProgresso";
import { partesPorGrupo, parteAtiva, chaveDaParte, lerDispensados, gravarDispensados } from "./dmPartes";
import Badge from "../ui/Badge";
import UsageBadge from "../ui/UsageBadge";

// Membros a partir dos quais o cartão avisa que o grupo está enchendo (ver
// data/constants.js).
const GROUP_MAX = WA_GROUP_MAX;
const ENCHENDO = WA_GROUP_ENCHENDO;

// ── Foto do grupo ────────────────────────────────────────────────────────────
// Uma consulta por grupo por sessão da página: a URL é do CDN do WhatsApp e vale
// dias. O cache guarda a promessa, então dois cartões do mesmo grupo (origem e
// destino ao mesmo tempo) fazem um pedido só.
// No popup de adicionar a lista pode ter centenas de grupos: no máximo
// PIC_CONCORRENCIA pedidos ao mesmo tempo, o resto espera na fila.
const picCache = new Map();
const PIC_CONCORRENCIA = 4;
let picAndando = 0;
const picFila = [];
function picProximo() {
  while (picAndando < PIC_CONCORRENCIA && picFila.length) {
    const { numberId, jid, resolve } = picFila.shift();
    picAndando++;
    getWAGroupPicture(numberId, jid).then(r => r?.url || null).catch(() => null)
      .then(url => { picAndando--; resolve(url); picProximo(); });
  }
}
function pictureOf(numberId, jid) {
  const k = `${numberId}::${jid}`;
  if (!picCache.has(k)) {
    picCache.set(k, new Promise(resolve => { picFila.push({ numberId, jid, resolve }); picProximo(); }));
  }
  return picCache.get(k);
}

const AVATAR_CORES = ["#5B8DEF", "#E0795B", "#3FA98A", "#B169D6", "#D9A43B", "#4FA3C7", "#D1607F"];
function iniciais(nome) {
  const partes = String(nome || "?").replace(/[^\p{L}\p{N}\s]/gu, " ").trim().split(/\s+/).filter(Boolean);
  return ((partes[0]?.[0] || "?") + (partes[1]?.[0] || "")).toUpperCase();
}

export function GroupAvatar({ numberId, jid, name, canFetch = true, size = 40, lazy = false }) {
  // A foto fica guardada junto da chave do grupo: trocou o grupo, o que estava
  // guardado não vale mais e o cartão volta às iniciais até a nova chegar.
  const chave = `${numberId}::${jid}`;
  const [foto, setFoto] = useState({ chave: null, url: null, falhou: false });
  // `lazy`: só pede a foto quando o avatar aparece na tela (lista do popup).
  const ref = useRef(null);
  const semObserver = typeof IntersectionObserver === "undefined";
  const [visivel, setVisivel] = useState(!lazy || semObserver);
  useEffect(() => {
    if (visivel || !ref.current) return undefined;
    const obs = new IntersectionObserver((entradas) => {
      if (entradas.some(e => e.isIntersecting)) { setVisivel(true); obs.disconnect(); }
    }, { rootMargin: "100px" });
    obs.observe(ref.current);
    return () => obs.disconnect();
  }, [visivel]);
  useEffect(() => {
    let vivo = true;
    if (visivel && canFetch && numberId && jid) pictureOf(numberId, jid).then(u => { if (vivo) setFoto({ chave, url: u, falhou: false }); });
    return () => { vivo = false; };
  }, [chave, numberId, jid, canFetch, visivel]);
  const url = foto.chave === chave ? foto.url : null;
  const falhou = foto.chave === chave && foto.falhou;
  const setFalhou = () => setFoto(f => ({ ...f, falhou: true }));
  const cor = AVATAR_CORES[[...String(jid || name || "")].reduce((s, c) => s + c.charCodeAt(0), 0) % AVATAR_CORES.length];
  const base = { width: size, height: size, borderRadius: "50%", flexShrink: 0, overflow: "hidden" };
  if (url && !falhou) {
    return <img ref={ref} src={url} alt="" onError={() => setFalhou(true)} style={{ ...base, objectFit: "cover", background: "var(--color-background-secondary)" }} />;
  }
  return (
    <div ref={ref} aria-hidden="true" style={{ ...base, background: cor, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: size * 0.38, fontWeight: 600 }}>
      {iniciais(name)}
    </div>
  );
}

// ── Menu "⋯" ─────────────────────────────────────────────────────────────────
// items: [{ label, onClick, danger, checked (undefined = item comum), disabled, hint }]
// `hint` é tooltip no mouse; no toque (sem tooltip) vira uma 2ª linha no item.
export function KebabMenu({ label, items }) {
  const [aberto, setAberto] = useState(false);
  // Perto do rodapé o menu abre pra cima — pra baixo ele saía da tela.
  const [paraCima, setParaCima] = useState(false);
  const touch = useMedia(TOUCH);
  const ref = useRef(null);
  useEffect(() => {
    if (!aberto) return undefined;
    // pointerdown e não mousedown: no iPhone tocar numa área sem clique não
    // gera mousedown, e o menu não fechava tocando fora.
    const fora = (e) => { if (ref.current && !ref.current.contains(e.target)) setAberto(false); };
    const esc = (e) => { if (e.key === "Escape") setAberto(false); };
    document.addEventListener("pointerdown", fora);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("pointerdown", fora); document.removeEventListener("keydown", esc); };
  }, [aberto]);
  const alternar = () => {
    if (!aberto) {
      const r = ref.current?.getBoundingClientRect?.();
      const abaixo = r ? window.innerHeight - r.bottom : Infinity;
      setParaCima(abaixo < 280 && r.top > abaixo);
    }
    setAberto(a => !a);
  };
  return (
    <div ref={ref} style={{ position: "relative", flexShrink: 0 }}>
      <button
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={aberto}
        onClick={alternar}
        style={{ width: 36, height: 36, borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: aberto ? "var(--color-background-secondary)" : "transparent", cursor: "pointer", fontSize: 16, lineHeight: 1, color: "var(--color-text-primary)" }}
      >⋯</button>
      {aberto && (
        // z 96: acima do botão flutuante de suporte (95), abaixo dos modais (100).
        <div role="menu" style={{
          position: "absolute", right: 0, ...(paraCima ? { bottom: 40 } : { top: 40 }), zIndex: 96,
          minWidth: 250, maxWidth: "calc(100vw - 24px)", padding: 4,
          background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-secondary)",
          borderRadius: 10, boxShadow: "0 8px 24px rgba(0,0,0,0.16)",
        }}>
          {items.filter(Boolean).map(it => (
            <button
              key={it.label}
              type="button"
              role={it.checked === undefined ? "menuitem" : "menuitemcheckbox"}
              aria-checked={it.checked === undefined ? undefined : !!it.checked}
              disabled={it.disabled}
              title={it.hint}
              onClick={() => { setAberto(false); it.onClick(); }}
              style={{
                display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left",
                padding: touch ? "11px 10px" : "8px 10px", borderRadius: 7, border: "none", background: "transparent", fontSize: 13,
                cursor: it.disabled ? "not-allowed" : "pointer", opacity: it.disabled ? 0.5 : 1,
                color: it.danger ? "var(--danger-text)" : "var(--color-text-primary)",
              }}
              onMouseEnter={e => { e.currentTarget.style.background = "var(--color-background-secondary)"; }}
              onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
            >
              {it.checked !== undefined && (
                <span style={{ width: 16, height: 16, borderRadius: 4, flexShrink: 0, border: `1px solid ${it.checked ? PRIMARY : "var(--color-border-secondary)"}`, background: it.checked ? PRIMARY : "transparent", color: "#fff", fontSize: 11, display: "flex", alignItems: "center", justifyContent: "center" }}>
                  {it.checked ? "✓" : ""}
                </span>
              )}
              <span style={{ flex: 1 }}>
                {it.label}
                {touch && it.hint && <span style={{ display: "block", fontSize: 11, color: "var(--color-text-secondary)", marginTop: 2 }}>{it.hint}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── O cartão de um grupo (origem ou destino) ─────────────────────────────────
// `missing`: o número está conectado mas não está mais no grupo — apagado, ou o
// número saiu ou foi removido (task 9). Vem da verificação da aba.
function GroupCard({ name, jid, number, numberMissing, connected, missing = false, members, extra, badges = [], warning, menu, children }) {
  const vivo = connected && !missing;
  const estado = missing ? "Não encontrado no WhatsApp" : connected ? "Conectado" : "Desconectado";
  return (
    <div style={{
      display: "flex", gap: 12, alignItems: "flex-start", padding: 12, borderRadius: 12, minWidth: 0,
      background: "var(--color-background-primary)",
      border: `0.5px solid ${vivo ? "var(--color-border-tertiary)" : "var(--danger-border)"}`,
    }}>
      <div style={{ position: "relative" }}>
        <GroupAvatar numberId={number?.id} jid={jid} name={name} canFetch={vivo} />
        <span
          title={estado}
          style={{ position: "absolute", right: -1, bottom: -1, width: 11, height: 11, borderRadius: "50%", border: "2px solid var(--color-background-primary)", background: vivo ? "#22C55E" : "#E24B4A" }}
        />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <span title={name} style={{ fontSize: 14, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%" }}>{name}</span>
          <Badge color={vivo ? "green" : "red"}>{estado}</Badge>
          {badges}
        </div>
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 3, display: "flex", gap: 10, flexWrap: "wrap" }}>
          <span title={number ? `${number.label || ""} ${number.phone || ""}`.trim() : undefined}>
            📱 {numberMissing
              ? <span style={{ color: "var(--danger-text)", fontStyle: "italic" }}>número removido</span>
              : <>{number?.label || number?.phone || "—"}{number?.phone && number?.label ? <span style={{ opacity: 0.8 }}> · {number.phone}</span> : null}</>}
          </span>
          {members != null && (
            <span style={{ color: members >= ENCHENDO ? "var(--warn-text)" : undefined }} title={`O WhatsApp aceita até ${GROUP_MAX} membros`}>
              👥 {members} {members === 1 ? "membro" : "membros"}
            </span>
          )}
          {extra}
        </div>
        {warning && <div style={{ fontSize: 11, color: missing ? "var(--danger-text)" : "var(--warn-text)", marginTop: 4, lineHeight: 1.4 }}>{warning}</div>}
        {children}
      </div>
      {menu}
    </div>
  );
}

// `actionsHint`: por que a ação extra (`actions`) está travada. No toque não há
// tooltip, então esse porquê — e o do "+ Adicionar" — aparece como texto.
function SectionHeader({ title, count, limit, limitLabel, sub, addLabel, onAdd, addDisabled, addTitle, tourAdd, actions, actionsHint }) {
  const touch = useMedia(TOUCH);
  const travas = touch ? [addDisabled && addTitle, actionsHint].filter(Boolean) : [];
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>{title}</div>
        <UsageBadge current={count} limit={limit} label={limitLabel} />
        {actions && <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>{actions}</div>}
        <button
          data-tour={tourAdd}
          onClick={onAdd}
          disabled={addDisabled}
          title={addTitle}
          aria-label={addLabel}
          style={{ marginLeft: actions ? 0 : "auto", padding: "6px 12px", borderRadius: 8, border: "none", fontSize: 12, fontWeight: 600, background: addDisabled ? "var(--color-border-secondary)" : PRIMARY, color: "#fff", cursor: addDisabled ? "not-allowed" : "pointer" }}
        >+ Adicionar</button>
      </div>
      {sub && <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 3, lineHeight: 1.4 }}>{sub}</div>}
      {travas.map(t => <div key={t} style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 3 }}>🔒 {t}</div>)}
    </div>
  );
}

const vazioStyle = { textAlign: "center", padding: "22px 14px", color: "var(--color-text-secondary)", fontSize: 12, background: "var(--color-background-secondary)", borderRadius: 12, lineHeight: 1.5 };
const btnSec = { padding: "8px 16px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 13, cursor: "pointer", color: "var(--color-text-primary)" };
const btnPri = (off) => ({ padding: "8px 16px", borderRadius: 8, background: PRIMARY, color: "#fff", border: "none", fontSize: 13, cursor: off ? "not-allowed" : "pointer", fontWeight: 500, opacity: off ? 0.5 : 1 });
const btnRemover = { marginTop: 8, padding: "5px 12px", borderRadius: 8, fontSize: 12, fontWeight: 500, cursor: "pointer", border: "0.5px solid var(--danger-border)", background: "var(--danger-bg)", color: "var(--danger-text)" };
const campo = { width: "100%", padding: "9px 12px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13, boxSizing: "border-box", color: "var(--color-text-primary)" };

// ── Popup de adicionar: WhatsApp → grupo (→ criar, no destino) ────────────────
// `inicio` ({ numberId, name, numero }) pula direto para a criação (o "Duplicar grupo" do menu).
function AddGroupModal({ modo, numbers, loadGroups, statusOf, onPick, onCreate, onClose, inicio = null, campaignName }) {
  const [numberId, setNumberId] = useState(inicio?.numberId || null);
  const [passo, setPasso] = useState(inicio ? "criar" : "numero");
  const [lista, setLista] = useState(null);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState(null);
  const [busca, setBusca] = useState("");
  const [ocupado, setOcupado] = useState(null);
  const [form, setForm] = useState({ name: inicio?.name || "", numero: String(inicio?.numero ?? 1), participants: "" });
  const [aviso, setAviso] = useState(null);
  const numero = numbers.find(n => n.id === numberId);
  const destino = modo === "destino";
  // O nome da campanha fica de fundo no campo vazio; TAB aceita (como um autocomplete).
  const sugestao = (campaignName || "").trim();
  const aceitarSugestao = (e) => {
    if (e.key !== "Tab" || e.shiftKey || form.name || !sugestao) return;
    e.preventDefault();
    setForm(f => ({ ...f, name: sugestao }));
  };
  // O grupo sai "Nome #N" (a série: Ofertas #1, #2...). Número vazio: só o nome.
  const serie = form.numero.trim();
  const serieOk = !serie || /^[1-9]\d*$/.test(serie);
  const nomeFinal = form.name.trim() && (serie ? `${form.name.trim()} #${serie}` : form.name.trim());
  const podeCriar = !!nomeFinal && serieOk && ocupado !== "criar";
  // Colou "Ofertas #3" no nome: o 3 vai pro campo Número (senão sairia "Ofertas #3 #1").
  const separarNumero = () => {
    const m = form.name.match(/^(.*?)\s*#(\d+)\s*$/);
    if (m && m[1].trim()) setForm(f => ({ ...f, name: m[1].trim(), numero: String(Number(m[2])) }));
  };

  const escolherNumero = async (id) => {
    setNumberId(id); setPasso("grupo"); setBusca(""); setErro(null); setLista(null); setCarregando(true);
    try {
      setLista(await loadGroups(id));
    } catch (err) {
      setErro(errText(err, "Não foi possível listar os grupos deste WhatsApp."));
      setLista([]);
    } finally {
      setCarregando(false);
    }
  };

  const escolher = async (g) => {
    setOcupado(g.jid);
    try {
      await onPick(numberId, g);
      onClose();
    } catch (err) {
      setErro(errText(err, "Não foi possível adicionar o grupo."));
    } finally {
      setOcupado(null);
    }
  };

  const criar = async () => {
    if (!podeCriar) return;
    setOcupado("criar"); setErro(null); setAviso(null);
    try {
      const r = await onCreate({ numberId, name: nomeFinal, participants: form.participants });
      if (r?.warning) { setAviso(r.warning); setForm({ name: "", numero: "1", participants: "" }); return; }
      onClose();
    } catch (err) {
      setErro(errText(err, "Não foi possível criar o grupo."));
    } finally {
      setOcupado(null);
    }
  };

  const titulo = passo === "criar" ? "Criar grupo no WhatsApp" : destino ? "Adicionar grupo destino" : "Adicionar grupo de origem";
  const q = busca.trim().toLowerCase();
  const filtrados = (lista || []).filter(g => !q || (g.name || "").toLowerCase().includes(q));

  return (
    <Modal title={titulo} onClose={onClose} confirmOnClickOutside={passo === "criar"}>
      {/* Trilha: 1. WhatsApp → 2. Grupo */}
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 12 }}>
        <span style={{ fontWeight: passo === "numero" ? 600 : 400, color: passo === "numero" ? PRIMARY_DARK : undefined }}>1. WhatsApp</span>
        <span>→</span>
        <span style={{ fontWeight: passo !== "numero" ? 600 : 400, color: passo !== "numero" ? PRIMARY_DARK : undefined }}>2. {passo === "criar" ? "Novo grupo" : "Grupo"}</span>
        {numero && passo !== "numero" && (
          <button onClick={() => { setPasso("numero"); setErro(null); setAviso(null); }} style={{ ...btnSec, padding: "3px 10px", fontSize: 12, marginLeft: "auto" }}>
            📱 {numero.label || numero.phone} · trocar
          </button>
        )}
      </div>

      {passo === "numero" && (
        <>
          <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 10 }}>
            {destino ? "De qual WhatsApp é o grupo que vai receber as ofertas?" : "Qual WhatsApp participa do grupo que vai ser escutado?"}
          </div>
          {numbers.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--warn-text)", padding: "10px 12px", background: "var(--warn-bg)", borderRadius: 8 }}>Nenhum WhatsApp conectado. Conecte um número na página WhatsApp.</div>
          ) : (
            <div className="unclamp-mobile" style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 320, overflowY: "auto" }}>
              {numbers.map(n => {
                const on = n.status === "connected";
                return (
                  <button
                    key={n.id}
                    onClick={() => escolherNumero(n.id)}
                    disabled={!on}
                    style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: 10, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", cursor: on ? "pointer" : "not-allowed", opacity: on ? 1 : 0.55, textAlign: "left", color: "var(--color-text-primary)" }}
                  >
                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: on ? "#22C55E" : "#E24B4A", flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 500 }}>{n.label || n.phone || n.id}</div>
                      <div style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>{on ? n.phone : "desconectado"}</div>
                    </div>
                    {on && <span style={{ fontSize: 11, color: PRIMARY_DARK, fontWeight: 500 }}>Ver grupos →</span>}
                  </button>
                );
              })}
            </div>
          )}
        </>
      )}

      {passo === "grupo" && (
        <>
          {destino && (
            <button
              onClick={() => { setPasso("criar"); setErro(null); }}
              style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "10px 12px", borderRadius: 10, border: `1px dashed ${PRIMARY}`, background: PRIMARY_LIGHT, color: PRIMARY_DARK, cursor: "pointer", textAlign: "left", marginBottom: 10 }}
            >
              <span style={{ fontSize: 18 }}>➕</span>
              <span style={{ fontSize: 13, fontWeight: 600 }}>Criar grupo novo neste WhatsApp</span>
            </button>
          )}
          <input autoFocus={!isTouch()} aria-label="Buscar grupo" value={busca} onChange={e => setBusca(e.target.value)} placeholder="Buscar grupo pelo nome..." style={{ ...campo, marginBottom: 10 }} />
          {erro && <div style={{ fontSize: 12, color: "var(--danger-text)", padding: "8px 10px", background: "var(--danger-bg)", borderRadius: 8, marginBottom: 8 }}>{erro}</div>}
          {carregando ? (
            <div style={{ fontSize: 12, color: "var(--color-text-secondary)", padding: "20px 0", textAlign: "center" }}>⟳ Carregando grupos do WhatsApp...</div>
          ) : (lista || []).length === 0 ? (
            !erro && <div style={{ fontSize: 12, color: "var(--color-text-secondary)", padding: "20px 0", textAlign: "center", fontStyle: "italic" }}>Nenhum grupo encontrado neste WhatsApp.</div>
          ) : filtrados.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--color-text-secondary)", padding: "20px 0", textAlign: "center", fontStyle: "italic" }}>Nenhum grupo bate com "{busca}".</div>
          ) : (
            <div className="unclamp-mobile" style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 340, overflowY: "auto" }}>
              {filtrados.map(g => {
                const st = statusOf(numberId, g) || {};
                const travado = !!st.done;
                const indo = ocupado === g.jid;
                return (
                  <button
                    key={g.jid}
                    onClick={() => escolher(g)}
                    disabled={travado || !!ocupado}
                    style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", borderRadius: 10, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", cursor: travado ? "default" : "pointer", opacity: travado ? 0.5 : 1, textAlign: "left", color: "var(--color-text-primary)" }}
                  >
                    <GroupAvatar numberId={numberId} jid={g.jid} name={g.name} size={32} lazy />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g.name || "(sem nome)"}</div>
                      <div style={{ fontSize: 11, color: st.warn ? "var(--warn-text)" : "var(--color-text-secondary)" }}>
                        {g.members || 0} membro{g.members === 1 ? "" : "s"}{st.warn ? ` · ${st.warn}` : ""}
                      </div>
                    </div>
                    <span style={{ fontSize: 11, color: travado ? "var(--color-text-secondary)" : PRIMARY_DARK, fontWeight: 500, maxWidth: 96, textAlign: "right", lineHeight: 1.3, flexShrink: 0 }}>
                      {indo ? "⟳ Adicionando..." : (st.label || "+ Adicionar")}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </>
      )}

      {passo === "criar" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ fontSize: 12, color: "var(--color-text-secondary)", lineHeight: 1.5 }}>
            O grupo é criado <strong>de fato no WhatsApp</strong>, só com envio para admins, e já entra nesta campanha.
          </div>
          <div>
            <div style={{ display: "flex", gap: 8 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <label htmlFor="novo-grupo-nome" style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Nome do grupo</label>
                <input id="novo-grupo-nome" autoFocus value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} onKeyDown={aceitarSugestao} onBlur={separarNumero} placeholder={sugestao || "Ex: Ofertas"} style={campo} />
              </div>
              <div style={{ width: 90, flexShrink: 0 }}>
                <label htmlFor="novo-grupo-numero" style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Número</label>
                <div style={{ position: "relative" }}>
                  <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", fontSize: 13, color: "var(--color-text-secondary)", pointerEvents: "none" }}>#</span>
                  <input id="novo-grupo-numero" type="number" min={1} step={1} inputMode="numeric" value={form.numero} onChange={e => setForm(f => ({ ...f, numero: e.target.value }))} style={{ ...campo, paddingLeft: 22, border: serieOk ? campo.border : "0.5px solid var(--danger-text)" }} />
                </div>
              </div>
            </div>
            <div style={{ fontSize: 11, color: serieOk ? "var(--color-text-secondary)" : "var(--danger-text)", marginTop: 4 }}>
              {!serieOk ? "O número precisa ser inteiro, a partir de 1." : nomeFinal ? <>Fica: <strong>{nomeFinal}</strong></> : "Duplicar o grupo depois soma 1 no número."}
            </div>
          </div>
          <div>
            <label htmlFor="novo-grupo-part" style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Participantes iniciais (opcional)</label>
            <textarea id="novo-grupo-part" rows={3} value={form.participants} onChange={e => setForm(f => ({ ...f, participants: e.target.value }))} placeholder="+5511999998888&#10;+5521988887777" style={{ ...campo, resize: "vertical", fontFamily: "inherit" }} />
            <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 4 }}>Um por linha, com o código do país (+55). Vazio: o grupo nasce só com você.</div>
          </div>
          {aviso && <div style={{ background: "var(--warn-bg)", color: "var(--warn-text)", padding: "8px 10px", borderRadius: 8, fontSize: 12 }}>{aviso}</div>}
          {erro && <div style={{ background: "var(--danger-bg)", color: "var(--danger-text)", padding: "8px 10px", borderRadius: 8, fontSize: 12, whiteSpace: "pre-wrap" }}>{erro}</div>}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
        <button onClick={onClose} disabled={ocupado === "criar"} style={btnSec}>{passo === "criar" ? "Cancelar" : "Fechar"}</button>
        {passo === "criar" && (
          <button onClick={criar} disabled={!podeCriar} style={btnPri(!podeCriar)}>
            {ocupado === "criar" ? "⟳ Criando..." : "Criar e vincular"}
          </button>
        )}
      </div>
    </Modal>
  );
}

// ── A aba ─────────────────────────────────────────────────────────────────────
export default function GroupsTab({
  isRepasse, campaignName, numbers, whatsappGroups, linkedWGs, leaders,
  leaderLimit, destLimit, loadGroups, knownGroups = {},
  onAddLeader, onRemoveLeader, onLinkExisting, onImportAndLink, onUnlink, onCreateGroup,
  onUpdateWhatsappGroup, onRevokeInvite, computeCloneName, onError,
  isAdmin = false, campaignId = null,
  groupCheck = {}, checkingGroups = false, onRecheckGroups,
}) {
  const [modal, setModal] = useState(null);       // { modo, inicio }
  const [confirmar, setConfirmar] = useState(null); // { tipo, alvo, dm }
  const [aviso, setAviso] = useState(null);
  const [editDesc, setEditDesc] = useState(null);  // o grupo cujo popup de descrição está aberto
  const [dm, setDm] = useState(null);              // { grupos, todos } — popup de mensagem no privado
  const [dmLista, setDmLista] = useState([]);      // envios no privado desta campanha, com a parte de cada grupo
  const [dmDispensados, setDmDispensados] = useState(lerDispensados);
  const avisar = (texto, ms = 2500) => { setAviso(texto); setTimeout(() => setAviso(a => (a === texto ? null : a)), ms); };

  // Mensagem no privado (tasks 4 e 6, só admin): o envio roda no servidor e cada
  // cartão destino mostra a parte dele (DmProgresso). Consulta ao abrir a aba e,
  // só enquanto alguma parte anda, a cada 10s — o envio leva horas. Montando a
  // lista, que leva segundos, a cada 5s.
  const podeDm = isAdmin && campaignId != null;
  const recarregarDm = useCallback(async () => {
    if (!podeDm) return;
    try {
      const r = await listDmBroadcasts(campaignId);
      setDmLista(r?.broadcasts || []);
    } catch { /* a faixa é acessória: a próxima consulta tenta de novo */ }
  }, [podeDm, campaignId]);
  useEffect(() => {
    if (!podeDm) return undefined;
    let vivo = true;   // trocou de campanha antes da resposta: a antiga não vale
    listDmBroadcasts(campaignId).then(r => { if (vivo) setDmLista(r?.broadcasts || []); }).catch(() => {});
    return () => { vivo = false; };
  }, [podeDm, campaignId]);
  const dmAndando = dmLista.some(b => (b.grupos || []).some(parteAtiva));
  const dmMontando = dmLista.some(b => b.status === "preparing");
  useEffect(() => {
    if (!dmAndando) return undefined;
    const t = setInterval(recarregarDm, dmMontando ? 5000 : 10_000);
    return () => clearInterval(t);
  }, [dmAndando, dmMontando, recarregarDm]);
  const dmPorGrupo = useMemo(() => partesPorGrupo(dmLista, dmDispensados), [dmLista, dmDispensados]);
  const dmOcupado = (w) => parteAtiva(dmPorGrupo.get(w.id)?.parte);
  const dispensarDm = ({ parte, broadcast }) => setDmDispensados(d => gravarDispensados([...d, chaveDaParte(broadcast, parte)]));
  const cancelarDm = async (w, { broadcast }) => {
    try {
      await cancelDmBroadcast(campaignId, broadcast.id, w.id);
    } catch (err) {
      onError?.(errText(err, "Não foi possível cancelar o envio."));
    }
    recarregarDm();
  };

  const numberOf = (id) => numbers.find(n => n.id === id) || null;
  // A verificação da aba (task 9, feita no GroupDashboard): o número está
  // conectado mas não está mais no grupo.
  const sumiu = (numberId, jid) => groupCheck[`${numberId}::${jid}`] === "gone";
  const conectado = (w) => w.status !== "disconnected" && numberOf(w.numberId)?.status === "connected" && !sumiu(w.numberId, w.jid || w.id);
  const destSumidos = linkedWGs.filter(w => sumiu(w.numberId, w.jid || w.id));
  const origemSumidos = leaders.filter(l => sumiu(l.numberId, l.jid));
  // O grupo que é origem e destino conta uma vez só.
  const nSumidos = new Set([...destSumidos.map(w => `${w.numberId}::${w.jid || w.id}`), ...origemSumidos.map(l => `${l.numberId}::${l.jid}`)]).size;
  const abrirDm = (grupos, todos = false) => setDm({ grupos: grupos.map(w => ({ ...w, connected: conectado(w), ocupado: dmOcupado(w) })), todos });
  const dmLivres = linkedWGs.filter(w => conectado(w) && !dmOcupado(w));
  const leaderKeys = new Set(leaders.map(l => `${l.numberId}::${l.jid}`));
  const destKeys = new Set(linkedWGs.map(w => `${w.numberId}::${w.id}`));
  const leaderFull = leaderLimit != null && leaders.length >= leaderLimit;
  const destFull = destLimit != null && linkedWGs.length >= destLimit;
  const semNumero = numbers.length === 0;
  const byId = new Map(whatsappGroups.map(w => [w.id, w]));

  const copiarConvite = async (w) => {
    try {
      let link = w.inviteLink;
      if (!link) {
        link = (await getWAInvite(w.numberId, w.id))?.inviteLink;
        if (link) onUpdateWhatsappGroup?.(w.id, { inviteLink: link });
      }
      if (!link) throw new Error("O WhatsApp não devolveu o link de convite.");
      try { await navigator.clipboard?.writeText(link); } catch { /* sem clipboard: o link fica no aviso */ }
      avisar(`Link de convite de "${w.name}" copiado: ${link}`);
    } catch (err) {
      onError?.(errText(err, "Não foi possível pegar o link de convite — o número precisa estar conectado e ser admin do grupo."));
    }
  };

  // O que o popup diz de cada grupo da lista.
  const statusOrigem = (numberId, g) => {
    if (leaderKeys.has(`${numberId}::${g.jid}`)) return { done: true, label: "✓ Já é origem" };
    if (destKeys.has(`${numberId}::${g.jid}`)) return { warn: "já é destino desta campanha" };
    return null;
  };
  const statusDestino = (numberId, g) => {
    const cad = byId.get(g.jid);
    if (cad && linkedWGs.some(w => w.id === cad.id)) return { done: true, label: "✓ Já nesta campanha" };
    if (leaderKeys.has(`${numberId}::${g.jid}`)) return { warn: "é origem desta campanha", label: cad ? "+ Vincular" : undefined };
    return cad ? { label: "+ Vincular" } : null;
  };
  const pickDestino = async (numberId, g) => {
    const cad = byId.get(g.jid);
    if (cad) onLinkExisting(cad.id);
    else await onImportAndLink(numberId, g);
  };

  const origemSection = isRepasse && (
    <section data-tour="pr-leader" aria-label="Grupos Origem" style={{ minWidth: 0 }}>
      <SectionHeader
        title="Grupos Origem" count={leaders.length} limit={leaderLimit} limitLabel="grupos de origem"
        sub="Os grupos que o sistema escuta: todo link de produto postado neles é capturado."
        addLabel="Adicionar grupo de origem" onAdd={() => setModal({ modo: "origem" })}
        addDisabled={semNumero || leaderFull}
        addTitle={semNumero ? "Conecte um número de WhatsApp primeiro" : leaderFull ? `Limite de ${leaderLimit} do seu plano` : "Escolher um grupo para escutar"}
      />
      {leaderFull && (
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)", background: "var(--color-background-secondary)", padding: "8px 10px", borderRadius: 8, marginBottom: 8 }}>
          Você chegou no limite de {leaderLimit} {leaderLimit === 1 ? "grupo de origem" : "grupos de origem"} do seu plano. Remova um para trocar, ou suba de plano para escutar mais grupos.
        </div>
      )}
      {leaders.length === 0 ? (
        <div style={{ ...vazioStyle, color: semNumero ? "var(--color-text-secondary)" : "var(--warn-text)", background: semNumero ? vazioStyle.background : "var(--warn-bg)" }}>
          {semNumero
            ? "Conecte um número de WhatsApp na página WhatsApp para escolher os grupos de origem."
            : <>⚠ <strong>Nenhum grupo de origem escolhido.</strong> Sem origem a campanha não captura nenhum link, e a fila fica vazia.</>}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {leaders.map(l => {
            const n = numberOf(l.numberId);
            const on = n?.status === "connected";
            const cad = byId.get(l.jid);
            const members = cad?.members ?? knownGroups[l.numberId]?.find(g => g.jid === l.jid)?.members;
            const some = sumiu(l.numberId, l.jid);
            return (
              <GroupCard
                key={`${l.numberId}::${l.jid}`}
                name={l.name || l.jid} jid={l.jid} number={n} numberMissing={!n} connected={on} missing={some} members={members ?? null}
                badges={destKeys.has(`${l.numberId}::${l.jid}`) ? [<Badge key="d" color="blue">Também é destino</Badge>] : []}
                warning={some
                  ? "O número não está mais neste grupo — ele foi apagado, ou o número saiu ou foi removido. Nada é capturado dele."
                  : !on ? (n ? "Enquanto este número estiver desconectado, nada é capturado neste grupo." : "O número que escutava este grupo não existe mais — nada é capturado até escolher outro grupo.") : null}
                menu={<KebabMenu label={`Mais ações — ${l.name || l.jid}`} items={[
                  { label: "Remover da origem", danger: true, onClick: () => setConfirmar({ tipo: "origem", alvo: l }) },
                ]} />}
              >
                {some && <button onClick={() => setConfirmar({ tipo: "origem", alvo: l, sumiu: true })} style={btnRemover}>Remover da origem</button>}
              </GroupCard>
            );
          })}
        </div>
      )}
    </section>
  );

  const destinoSection = (
    <section data-tour="wg-list" aria-label="Grupos Destino" style={{ minWidth: 0 }}>
      <SectionHeader
        title="Grupos Destino" count={linkedWGs.length} limit={destLimit} limitLabel="grupos criados"
        sub={isRepasse ? "Para onde vão os links capturados. Todos recebem a mesma fila." : "Para onde esta campanha envia. Todos recebem a mesma fila de produtos."}
        addLabel="Adicionar grupo destino" onAdd={() => setModal({ modo: "destino" })} tourAdd="wg-add"
        addDisabled={semNumero || destFull}
        addTitle={semNumero ? "Conecte um número de WhatsApp primeiro" : destFull ? `Limite de ${destLimit} do seu plano` : "Adicionar grupo a esta campanha"}
        actionsHint={podeDm && linkedWGs.length > 0 && !dmLivres.length
          ? `Mensagem a todos: ${linkedWGs.some(conectado) ? "todos os grupos conectados já têm uma mensagem no privado indo" : "nenhum número destes grupos está conectado"}`
          : null}
        actions={podeDm && linkedWGs.length > 0 ? (
          <button
            onClick={() => abrirDm(linkedWGs, true)}
            disabled={!dmLivres.length}
            title={dmLivres.length
              ? "Mandar uma mensagem no privado para os membros de todos os grupos destino"
              : linkedWGs.some(conectado) ? "Todos os grupos conectados já têm uma mensagem no privado indo" : "Nenhum número destes grupos está conectado"}
            style={{ padding: "6px 12px", borderRadius: 8, fontSize: 12, fontWeight: 500, border: "0.5px solid var(--color-border-secondary)", background: "transparent", color: "var(--color-text-primary)", cursor: dmLivres.length ? "pointer" : "not-allowed", opacity: dmLivres.length ? 1 : 0.5 }}
          >✉ Mensagem a todos</button>
        ) : null}
      />
      {linkedWGs.length === 0 ? (
        <div style={vazioStyle}>
          <div style={{ fontSize: 24, marginBottom: 6 }}>💬</div>
          <div style={{ fontWeight: 500, color: "var(--color-text-primary)", marginBottom: 4 }}>Nenhum grupo destino vinculado</div>
          {semNumero
            ? "Conecte um número do WhatsApp na página WhatsApp para adicionar grupos."
            : <button onClick={() => setModal({ modo: "destino" })} style={{ ...btnPri(false), marginTop: 6 }}>+ Adicionar primeiro grupo</button>}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {linkedWGs.map(w => {
            const n = numberOf(w.numberId);
            const on = w.status !== "disconnected" && n?.status === "connected";
            const some = sumiu(w.numberId, w.jid || w.id);
            const cheio = w.duplicatedTo ? byId.get(w.duplicatedTo) : null;
            const dmParte = podeDm ? dmPorGrupo.get(w.id) : null;
            const dmIndo = parteAtiva(dmParte?.parte);
            return (
              <GroupCard
                key={w.id}
                name={w.name} jid={w.id} number={n} numberMissing={!n} connected={on} missing={some} members={w.members ?? null}
                extra={<span>📤 {w.sentToday ?? 0} hoje{w.lastSend && w.lastSend !== "—" ? ` · último ${w.lastSend}` : ""}</span>}
                badges={[
                  leaderKeys.has(`${w.numberId}::${w.id}`) && <Badge key="o" color="amber">Também é origem</Badge>,
                  w.autoDuplicate && !w.duplicatedTo && <Badge key="a" color="purple">⧉ Duplica ao encher</Badge>,
                ].filter(Boolean)}
                warning={some
                  ? "O número não está mais neste grupo — ele foi apagado, ou o número saiu ou foi removido. Nada é enviado para ele."
                  : w.duplicatedTo
                  ? `Encheu e foi duplicado${cheio ? ` para "${cheio.name}"` : ""} — divulgue o link do grupo novo.`
                  : (w.members ?? 0) >= ENCHENDO && !w.autoDuplicate
                    ? `Quase cheio (o WhatsApp aceita até ${GROUP_MAX}). Ligue a duplicação automática no ⋯ para não perder gente.`
                    : null}
                menu={<KebabMenu label={`Mais ações — ${w.name}`} items={[
                  { label: "🔗 Copiar link de convite", onClick: () => copiarConvite(w) },
                  { label: "↻ Gerar novo link de convite", onClick: () => onRevokeInvite(w), hint: "O link antigo para de funcionar" },
                  { label: "⎘ Duplicar grupo", disabled: semNumero, onClick: () => setModal({ modo: "destino", inicio: { numberId: w.numberId, ...computeCloneName(w.name) } }) },
                  { label: "Duplicar automaticamente quando encher", checked: !!w.autoDuplicate, onClick: () => {
                    onUpdateWhatsappGroup?.(w.id, { autoDuplicate: !w.autoDuplicate });
                    avisar(w.autoDuplicate ? `Duplicação automática desligada em "${w.name}".` : `"${w.name}" vai ser duplicado sozinho quando chegar a 1.000 membros.`);
                  } },
                  { label: "✎ Editar descrição", hint: "A descrição do grupo no WhatsApp", onClick: () => setEditDesc(w) },
                  podeDm && {
                    label: "✉ Mensagem no privado aos membros", disabled: !on || dmIndo,
                    hint: !on ? "O número deste grupo está desconectado" : dmIndo ? "Já tem uma mensagem no privado indo para este grupo" : "Manda uma mensagem no privado para cada membro deste grupo",
                    onClick: () => abrirDm([w]),
                  },
                  { label: "Remover da campanha", danger: true, onClick: () => setConfirmar({ tipo: "destino", alvo: w }) },
                ]} />}
              >
                {some && <button onClick={() => setConfirmar({ tipo: "destino", alvo: w, sumiu: true })} style={btnRemover}>Remover da campanha</button>}
                {w.description ? (
                  <div title={w.description} style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 5, fontStyle: "italic", whiteSpace: "pre-wrap", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{w.description}</div>
                ) : null}
                {dmParte && (
                  <DmProgresso
                    parte={dmParte.parte}
                    broadcast={dmParte.broadcast}
                    onCancelar={() => setConfirmar({ tipo: "dm", alvo: w, dm: dmParte })}
                    onDispensar={() => dispensarDm(dmParte)}
                  />
                )}
              </GroupCard>
            );
          })}
        </div>
      )}
    </section>
  );

  return (
    <div>
      {nSumidos > 0 && (
        <AlertBanner
          tone="warn"
          style={{ marginBottom: 10 }}
          message={nSumidos === 1
            ? "1 grupo não foi encontrado no WhatsApp — foi apagado, ou o número saiu ou foi removido dele."
            : `${nSumidos} grupos não foram encontrados no WhatsApp — foram apagados, ou o número saiu ou foi removido deles.`}
          actions={[
            nSumidos > 1 && { label: "Remover todos", onClick: () => setConfirmar({ tipo: "sumidos" }) },
            { label: checkingGroups ? "Verificando…" : "Verificar de novo", onClick: () => { if (!checkingGroups) onRecheckGroups?.(); } },
          ].filter(Boolean)}
        />
      )}
      {aviso && (
        <div role="status" style={{ fontSize: 12, padding: "8px 12px", borderRadius: 8, background: PRIMARY_LIGHT, color: PRIMARY_DARK, marginBottom: 10, overflowWrap: "anywhere" }}>{aviso}</div>
      )}
      {isRepasse ? (
        <div className="groups-flow">
          {origemSection}
          <div className="groups-flow-arrow" aria-hidden="true">
            <span className="groups-flow-arrow-h">→</span>
            <span className="groups-flow-arrow-v">↓</span>
            <span className="groups-flow-arrow-label">links capturados</span>
          </div>
          {destinoSection}
        </div>
      ) : destinoSection}

      {modal && (
        <AddGroupModal
          modo={modal.modo}
          inicio={modal.inicio || null}
          campaignName={campaignName}
          numbers={numbers}
          loadGroups={loadGroups}
          statusOf={modal.modo === "origem" ? statusOrigem : statusDestino}
          onPick={modal.modo === "origem" ? (numberId, g) => onAddLeader(numberId, g) : pickDestino}
          onCreate={onCreateGroup}
          onClose={() => setModal(null)}
        />
      )}

      {dm && (
        <DmMembersModal
          campaignId={campaignId}
          grupos={dm.grupos}
          todos={dm.todos}
          onStarted={() => {
            setDm(null);
            avisar("✉ O envio começou em segundo plano — o andamento aparece no cartão de cada grupo.", 5000);
            recarregarDm();
          }}
          onClose={() => setDm(null)}
        />
      )}

      {editDesc && (
        <GroupDescriptionModal
          grupo={{ ...editDesc, connected: conectado(editDesc) }}
          grupos={linkedWGs.map(w => ({ ...w, connected: conectado(w) }))}
          onSaved={(results, texto) => {
            const ok = results.filter(r => r.ok);
            for (const r of ok) onUpdateWhatsappGroup?.(r.id, { description: r.description ?? texto });
            if (!ok.length) return;
            avisar(results.length === 1
              ? `Descrição de "${ok[0].name}" salva no WhatsApp.`
              : ok.length === results.length
                ? `Descrição salva nos ${ok.length} grupos.`
                : `Descrição salva em ${ok.length} de ${results.length} grupos.`, 4000);
          }}
          onClose={() => setEditDesc(null)}
        />
      )}

      {confirmar?.tipo === "dm" && (
        <Modal title="Cancelar a mensagem no privado?" onClose={() => setConfirmar(null)}>
          <p style={{ fontSize: 13, marginBottom: 16, color: "var(--color-text-secondary)", lineHeight: 1.5 }}>
            Para de mandar para quem ainda não recebeu em <strong style={{ color: "var(--color-text-primary)" }}>{confirmar.alvo.name}</strong>. Quem já recebeu, recebeu.
            {(confirmar.dm.broadcast.grupos || []).filter(parteAtiva).length > 1 && " Os outros grupos deste envio continuam."}
          </p>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button onClick={() => setConfirmar(null)} style={btnSec}>Voltar</button>
            <button
              onClick={() => { cancelarDm(confirmar.alvo, confirmar.dm); setConfirmar(null); }}
              style={{ ...btnSec, border: "0.5px solid var(--danger-border)", background: "var(--danger-bg)", color: "var(--danger-text)", fontWeight: 500 }}
            >Cancelar envio</button>
          </div>
        </Modal>
      )}

      {confirmar?.tipo === "sumidos" && (
        <Modal title="Remover os grupos não encontrados?" onClose={() => setConfirmar(null)}>
          <p style={{ fontSize: 13, marginBottom: 8, color: "var(--color-text-secondary)", lineHeight: 1.5 }}>
            Estes grupos não foram encontrados no WhatsApp e saem desta campanha. As outras campanhas não mudam.
          </p>
          <ul style={{ fontSize: 13, margin: "0 0 16px", paddingLeft: 18, lineHeight: 1.6 }}>
            {destSumidos.map(w => <li key={`d:${w.id}`}>{w.name}{isRepasse && <span style={{ color: "var(--color-text-secondary)" }}> · destino</span>}</li>)}
            {origemSumidos.map(l => <li key={`o:${l.numberId}::${l.jid}`}>{l.name || l.jid}<span style={{ color: "var(--color-text-secondary)" }}> · origem</span></li>)}
          </ul>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button onClick={() => setConfirmar(null)} style={btnSec}>Cancelar</button>
            <button
              onClick={() => {
                if (destSumidos.length) onUnlink(destSumidos.map(w => w.id));
                if (origemSumidos.length) onRemoveLeader(origemSumidos);
                setConfirmar(null);
              }}
              style={btnPri(false)}
            >Remover todos</button>
          </div>
        </Modal>
      )}

      {(confirmar?.tipo === "origem" || confirmar?.tipo === "destino") && (
        <Modal title={confirmar.tipo === "origem" ? "Remover grupo de origem?" : "Remover grupo da campanha?"} onClose={() => setConfirmar(null)}>
          <p style={{ fontSize: 13, marginBottom: 16, color: "var(--color-text-secondary)", lineHeight: 1.5 }}>
            {confirmar.sumiu
              ? <><strong style={{ color: "var(--color-text-primary)" }}>{confirmar.alvo.name || confirmar.alvo.jid}</strong> não foi encontrado no WhatsApp — foi apagado, ou o número saiu ou foi removido dele. {confirmar.tipo === "origem" ? "Ele sai da origem desta campanha." : "Ele sai desta campanha; as outras campanhas não mudam."}</>
              : confirmar.tipo === "origem"
              ? <><strong style={{ color: "var(--color-text-primary)" }}>{confirmar.alvo.name || confirmar.alvo.jid}</strong> deixa de ser escutado: os links postados nele não entram mais na fila. O grupo continua no seu WhatsApp.</>
              : <><strong style={{ color: "var(--color-text-primary)" }}>{confirmar.alvo.name}</strong> deixa de receber os envios desta campanha. O grupo em si não é excluído — continua disponível para vincular de novo ou usar em outras campanhas.</>}
          </p>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button onClick={() => setConfirmar(null)} style={btnSec}>Cancelar</button>
            <button
              onClick={() => {
                if (confirmar.tipo === "origem") onRemoveLeader(confirmar.alvo); else onUnlink(confirmar.alvo.id);
                setConfirmar(null);
              }}
              style={btnPri(false)}
            >Remover</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
