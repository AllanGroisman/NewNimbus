// Admin › Cupons (task 17): navegar pelos cupons guardados.
//
// É a tela de CONSULTA — a de operar a colheita continua em Admin › Cupom. Em
// cima, o resumo e os maiores descontos; no meio, os cupons em cartões, com os
// filtros que importam no dia a dia (vigente, com palavra, tipo, categoria, com
// produtos); ao clicar num cartão, um painel lateral com tudo do cupom e os
// produtos dele, filtráveis de novo — e setas para passar ao cupom seguinte sem
// fechar o painel.
import { useState, useEffect, useCallback, useRef } from "react";
import { PRIMARY, PRIMARY_DARK, PRIMARY_LIGHT, formatPrice } from "../data/constants";
import {
  adminCuponsResumo, adminCuponsListar, adminCupomDetalhe, adminCupomProdutosFiltrados, errText,
} from "../data/api";
import Badge from "../components/ui/Badge";
import Pagination from "../components/ui/Pagination";
import { rotuloCategoria, categoriasDoCupom, prazoDoCupom as prazo } from "../data/cupomCategorias";

const PAGE_SIZE = 24;
const PROD_PAGE_SIZE = 20;
const DEBOUNCE_MS = 400;

const FILTROS_PADRAO = {
  q: "", situacao: "vigentes", palavra: "", tipo: "", escopo: "", produtos: "", categoria: "", sortBy: "recentes",
};
const FILTROS_PROD_PADRAO = {
  q: "", sortBy: "preco_asc", valendo: false, origem: "", catalogo: "", minPrice: "", maxPrice: "",
};

// Os grupos de chips da barra de filtros. `""` é sempre o "sem filtro".
const GRUPOS = [
  { campo: "situacao", rotulo: "Situação", opcoes: [["vigentes", "Vigentes"], ["vencendo", "Vencendo (72h)"], ["vencidos", "Vencidos"], ["todos", "Todos"]] },
  { campo: "palavra", rotulo: "Palavra", opcoes: [["", "Todas"], ["com", "Com palavra"], ["sem", "Sem palavra"]] },
  { campo: "tipo", rotulo: "Tipo", opcoes: [["", "Todos"], ["percent", "% OFF"], ["fixed", "R$ OFF"]] },
  { campo: "escopo", rotulo: "Escopo", opcoes: [["", "Todos"], ["campaign", "Mercado Livre"], ["store", "De loja"]] },
  { campo: "produtos", rotulo: "Produtos", opcoes: [["", "Todos"], ["com", "Com produtos"], ["sem", "Sem produtos"]] },
];
const ORDENS = [
  ["recentes", "Vistos por último"], ["desconto", "Maior desconto"], ["vence", "Vencem primeiro"],
  ["produtos", "Mais produtos"], ["minimo", "Menor compra mínima"],
];
const ORDENS_PROD = [
  ["preco_asc", "Menor preço"], ["preco_desc", "Maior preço"], ["desconto", "Maior desconto da loja"],
  ["vendidos", "Mais vendidos"], ["nota", "Melhor avaliação"], ["recentes", "Vinculados por último"],
];
const ORIGEM_LABEL = { vitrine: "Vitrine", parcial: "Vitrine parcial", checkout: "Checkout", repasse: "Repasse" };

const COR_PRAZO = { vencido: "var(--danger-text)", urgente: "var(--warn-text)", ok: "var(--color-text-secondary)", neutro: "var(--color-text-secondary)" };

const dataHora = (v) => (v ? new Date(v).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—");

// O texto digitado só vira consulta depois que a pessoa para de digitar.
function useDebounced(valor, ms = DEBOUNCE_MS) {
  const [v, setV] = useState(valor);
  useEffect(() => {
    const t = setTimeout(() => setV(valor), ms);
    return () => clearTimeout(t);
  }, [valor, ms]);
  return v;
}

const card = { background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: 16 };
const input = { padding: "8px 10px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13, boxSizing: "border-box", color: "var(--color-text-primary)" };
const chip = (ativo) => ({
  padding: "5px 11px", borderRadius: 999, fontSize: 12, cursor: "pointer", whiteSpace: "nowrap",
  border: `0.5px solid ${ativo ? PRIMARY : "var(--color-border-tertiary)"}`,
  background: ativo ? PRIMARY_LIGHT : "transparent",
  color: ativo ? PRIMARY_DARK : "var(--color-text-primary)", fontWeight: ativo ? 600 : 400,
});
const botao = { padding: "6px 12px", borderRadius: 8, fontSize: 12, cursor: "pointer", border: "0.5px solid var(--color-border-secondary)", background: "transparent", color: "var(--color-text-primary)" };

function Stat({ rotulo, valor, sub, onClick, ativo }) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      onClick={onClick}
      style={{
        textAlign: "left", flex: "1 1 120px", minWidth: 110, padding: "12px 14px", borderRadius: 10,
        background: ativo ? PRIMARY_LIGHT : "var(--color-background-secondary)",
        border: `0.5px solid ${ativo ? PRIMARY : "transparent"}`, cursor: onClick ? "pointer" : "default",
        color: "var(--color-text-primary)", font: "inherit",
      }}
    >
      <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 3 }}>{rotulo}</div>
      <div style={{ fontSize: 20, fontWeight: 600 }}>{valor ?? "—"}</div>
      {sub && <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 2 }}>{sub}</div>}
    </Tag>
  );
}

// A palavra do cupom, com um clique para copiar.
function Palavra({ code, grande = false }) {
  const [copiado, setCopiado] = useState(false);
  if (!code) return <span style={{ fontSize: 12, color: "var(--color-text-secondary)", fontStyle: "italic" }}>sem palavra</span>;
  const copiar = (e) => {
    e.stopPropagation();
    try { navigator.clipboard?.writeText(code).catch(() => {}); } catch { /* sem clipboard */ }
    setCopiado(true);
    setTimeout(() => setCopiado(false), 1200);
  };
  return (
    <button
      type="button"
      onClick={copiar}
      title="Copiar a palavra"
      style={{
        display: "inline-flex", alignItems: "center", gap: 6, padding: grande ? "5px 10px" : "3px 8px", borderRadius: 6,
        border: `1px dashed ${PRIMARY}`, background: "var(--color-background-secondary)", color: PRIMARY_DARK,
        fontFamily: "monospace", fontSize: grande ? 14 : 12, fontWeight: 700, cursor: "pointer", letterSpacing: 0.5,
      }}
    >
      {code} <span style={{ fontFamily: "inherit", fontSize: 10, fontWeight: 400 }}>{copiado ? "✓ copiado" : "⧉"}</span>
    </button>
  );
}

function CupomCard({ c, labels, onAbrir, selecionado }) {
  const p = prazo(c.expiresAt);
  const regras = [
    c.minPurchase > 0 && `Mín. ${formatPrice(c.minPurchase)}`,
    c.maxDiscount > 0 && `Teto ${formatPrice(c.maxDiscount)}`,
  ].filter(Boolean);
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Abrir cupom ${c.title}`}
      onClick={() => onAbrir(c.campaignId)}
      onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onAbrir(c.campaignId); } }}
      style={{
        ...card, padding: 14, cursor: "pointer", display: "flex", flexDirection: "column", gap: 8, minWidth: 0,
        borderColor: selecionado ? PRIMARY : "var(--color-border-tertiary)", opacity: c.vigente ? 1 : 0.65,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
        {c.iconUrl
          ? <img src={c.iconUrl} alt="" style={{ width: 36, height: 36, borderRadius: 8, objectFit: "contain", background: "#fff", flexShrink: 0 }} />
          : <div style={{ width: 36, height: 36, borderRadius: 8, background: PRIMARY_LIGHT, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>🎟️</div>}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: PRIMARY_DARK, lineHeight: 1.1 }}>{c.rotulo || "valor desconhecido"}</div>
          <div style={{ fontSize: 11, color: COR_PRAZO[p.tom], marginTop: 2 }}>{p.texto}</div>
        </div>
        {c.scope === "store" && <Badge color="amber">Loja</Badge>}
      </div>
      <div title={c.title} style={{ fontSize: 13, fontWeight: 500, lineHeight: 1.35, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", minHeight: 35 }}>
        {c.title}
      </div>
      <div style={{ fontSize: 11, color: "var(--color-text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={categoriasDoCupom(c, labels)}>
        {categoriasDoCupom(c, labels)}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: "auto" }}>
        <Palavra code={c.code} />
        {regras.length > 0 && <span style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>{regras.join(" · ")}</span>}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--color-text-secondary)", borderTop: "0.5px solid var(--color-border-tertiary)", paddingTop: 7 }}>
        <span>📦 {c.produtos} {c.produtos === 1 ? "produto" : "produtos"}</span>
        <span>#{c.campaignId}</span>
      </div>
    </div>
  );
}

function ProdutoLinha({ p }) {
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "center", padding: "9px 0", borderTop: "0.5px solid var(--color-border-tertiary)", minWidth: 0 }}>
      <a href={p.link} target="_blank" rel="noopener noreferrer" style={{ width: 48, height: 48, borderRadius: 8, background: "#fff", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", border: "0.5px solid var(--color-border-tertiary)" }}>
        {p.img ? <img src={p.img} alt="" style={{ maxWidth: 48, maxHeight: 48, objectFit: "contain" }} /> : <span style={{ fontSize: 20 }}>📦</span>}
      </a>
      <div style={{ flex: 1, minWidth: 0 }}>
        <a href={p.link} target="_blank" rel="noopener noreferrer" title={p.name || p.link}
          style={{ fontSize: 12, fontWeight: 500, color: "var(--color-text-primary)", textDecoration: "none", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
          {p.name || <span style={{ color: "var(--color-text-secondary)", fontStyle: "italic" }}>Fora do catálogo — {p.productKey}</span>}
        </a>
        <div style={{ display: "flex", gap: 6, marginTop: 3, flexWrap: "wrap", alignItems: "center" }}>
          <Badge color={p.origem === "vitrine" ? "green" : p.origem === "checkout" ? "blue" : "gray"}>{ORIGEM_LABEL[p.origem] || p.origem}</Badge>
          {p.discount > 0 && <Badge color="green">-{p.discount}%</Badge>}
          {p.rating && <span style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>★ {p.rating}</span>}
          {p.sold && <span style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>{p.sold}</span>}
        </div>
      </div>
      <div style={{ textAlign: "right", flexShrink: 0 }}>
        {p.price != null ? (
          <>
            {p.priceWithCoupon != null ? (
              <>
                <div style={{ fontSize: 14, fontWeight: 700, color: PRIMARY_DARK }}>{formatPrice(p.priceWithCoupon)}</div>
                <div style={{ fontSize: 11, color: "var(--color-text-secondary)", textDecoration: "line-through" }}>{formatPrice(p.price)}</div>
              </>
            ) : (
              <>
                <div style={{ fontSize: 14, fontWeight: 500 }}>{formatPrice(p.price)}</div>
                <div style={{ fontSize: 10, color: "var(--warn-text)" }}>cupom não pega</div>
              </>
            )}
          </>
        ) : <div style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>sem preço</div>}
      </div>
    </div>
  );
}

// O painel lateral de um cupom: o que se sabe dele e os produtos, com filtros.
function PainelCupom({ campaignId, labels, onFechar, onAnterior, onProximo }) {
  const [info, setInfo] = useState(null);
  const [erro, setErro] = useState(null);
  const [f, setF] = useState(FILTROS_PROD_PADRAO);
  const [page, setPage] = useState(1);
  const [lista, setLista] = useState({ items: [], total: 0 });
  const [carregando, setCarregando] = useState(true);
  const qDeb = useDebounced(f.q);
  const minDeb = useDebounced(f.minPrice);
  const maxDeb = useDebounced(f.maxPrice);

  // Cupom novo é painel novo (a página monta com `key={campaignId}`): filtros e
  // página começam do zero — o que se procurava no outro cupom não vale aqui.
  useEffect(() => {
    let vivo = true;
    adminCupomDetalhe(campaignId)
      .then(r => { if (vivo) setInfo(r); })
      .catch(err => { if (vivo) setErro(errText(err, "Não foi possível abrir o cupom.")); });
    return () => { vivo = false; };
  }, [campaignId]);

  const sig = JSON.stringify({ campaignId, q: qDeb, sortBy: f.sortBy, valendo: f.valendo, origem: f.origem, catalogo: f.catalogo, minPrice: minDeb, maxPrice: maxDeb });
  useEffect(() => {
    const ctrl = new AbortController();
    const p = JSON.parse(sig);
    setCarregando(true);
    adminCupomProdutosFiltrados(campaignId, { ...p, page, pageSize: PROD_PAGE_SIZE }, { signal: ctrl.signal })
      .then(r => setLista({ items: r.items || [], total: r.total || 0 }))
      .catch(err => { if (err.name !== "AbortError") setErro(errText(err, "Não foi possível carregar os produtos.")); })
      .finally(() => { if (!ctrl.signal.aborted) setCarregando(false); });
    return () => ctrl.abort();
  }, [sig, page, campaignId]);

  // Esc fecha; ← → passam de cupom — menos quando a pessoa está digitando.
  useEffect(() => {
    const onKey = (e) => {
      const digitando = /^(INPUT|SELECT|TEXTAREA)$/.test(e.target?.tagName || "");
      if (e.key === "Escape") onFechar();
      else if (!digitando && e.key === "ArrowLeft" && onAnterior) onAnterior();
      else if (!digitando && e.key === "ArrowRight" && onProximo) onProximo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onFechar, onAnterior, onProximo]);

  // Filtro novo volta para a primeira página: a página 3 de outra lista não existe.
  const set = (campo, valor) => { setF(x => ({ ...x, [campo]: valor })); setPage(1); };
  const p = info ? prazo(info.expiresAt) : null;
  const campos = info ? [
    ["Compra mínima", info.minPurchase > 0 ? formatPrice(info.minPurchase) : "sem mínimo"],
    ["Teto do desconto", info.maxDiscount > 0 ? formatPrice(info.maxDiscount) : "sem teto"],
    ["Começa", info.startsAt ? dataHora(info.startsAt) : "já vale"],
    ["Validade", info.expiresAt ? dataHora(info.expiresAt) : (info.expiresText || "sem validade")],
    ["Escopo", info.scope === "store" ? `Loja${info.sellerName ? ` · ${info.sellerName}` : ""}` : "Mercado Livre"],
    ["Categorias", (info.groupings || []).map(k => rotuloCategoria(k, labels)).join(" · ") || "—"],
    ["Ativado na conta", info.activated ? "sim" : "não"],
    ["Na vitrine do ML", info.vitrineTotal != null ? `${info.vitrineTotal} produtos` : "—"],
    ["Vitrine completa em", dataHora(info.productsSyncedAt)],
    ["Visto pela 1ª vez", dataHora(info.firstSeenAt)],
  ] : [];
  const totalPaginas = Math.max(1, Math.ceil(lista.total / PROD_PAGE_SIZE));
  const filtrando = JSON.stringify({ ...f }) !== JSON.stringify(FILTROS_PROD_PADRAO);

  return (
    <>
      <div onClick={onFechar} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", zIndex: 900 }} />
      <aside
        role="dialog"
        aria-label={info ? `Cupom ${info.title}` : "Cupom"}
        style={{
          position: "fixed", top: 0, right: 0, bottom: 0, width: "min(720px, 100vw)", zIndex: 901,
          background: "var(--color-background-primary)", borderLeft: "0.5px solid var(--color-border-tertiary)",
          display: "flex", flexDirection: "column", boxShadow: "-8px 0 24px rgba(0,0,0,0.15)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 16px", borderBottom: "0.5px solid var(--color-border-tertiary)" }}>
          <button onClick={onAnterior} disabled={!onAnterior} aria-label="Cupom anterior" title="Cupom anterior (←)" style={{ ...botao, opacity: onAnterior ? 1 : 0.4, cursor: onAnterior ? "pointer" : "default" }}>‹</button>
          <button onClick={onProximo} disabled={!onProximo} aria-label="Próximo cupom" title="Próximo cupom (→)" style={{ ...botao, opacity: onProximo ? 1 : 0.4, cursor: onProximo ? "pointer" : "default" }}>›</button>
          <div style={{ flex: 1, fontSize: 12, color: "var(--color-text-secondary)" }}>#{campaignId}</div>
          <button onClick={onFechar} aria-label="Fechar" style={{ ...botao, border: "none", fontSize: 16 }}>✕</button>
        </div>

        <div style={{ overflowY: "auto", padding: 16, flex: 1 }}>
          {erro && <div style={{ fontSize: 13, color: "var(--danger-text)", marginBottom: 12 }}>{erro}</div>}
          {!info && !erro && <div style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>Carregando…</div>}
          {info && (
            <>
              <div style={{ display: "flex", gap: 12, alignItems: "flex-start", marginBottom: 12 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 26, fontWeight: 700, color: PRIMARY_DARK, lineHeight: 1.1 }}>{info.rotulo || "valor desconhecido"}</div>
                  <div style={{ fontSize: 15, fontWeight: 500, marginTop: 4 }}>{info.title}</div>
                  {info.subtitle && <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 2 }}>{info.subtitle}</div>}
                  <div style={{ fontSize: 12, color: COR_PRAZO[p.tom], marginTop: 4 }}>{p.texto}</div>
                </div>
                <Palavra code={info.code} grande />
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 8, marginBottom: 12 }}>
                {campos.map(([k, v]) => (
                  <div key={k} style={{ background: "var(--color-background-secondary)", borderRadius: 8, padding: "7px 10px", minWidth: 0 }}>
                    <div style={{ fontSize: 10, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: 0.4 }}>{k}</div>
                    <div style={{ fontSize: 12, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={String(v)}>{v}</div>
                  </div>
                ))}
              </div>

              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginBottom: 16 }}>
                {info.origens.map(o => (
                  <button key={o.origem} onClick={() => set("origem", f.origem === o.origem ? "" : o.origem)} style={chip(f.origem === o.origem)} title="Filtrar os produtos por esta origem">
                    {ORIGEM_LABEL[o.origem] || o.origem}: {o.n}
                  </button>
                ))}
                <span style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>{info.noCatalogo} de {info.produtos} no catálogo</span>
                {info.containerUrl && (
                  <a href={info.containerUrl} target="_blank" rel="noopener noreferrer" style={{ ...botao, textDecoration: "none", marginLeft: "auto" }}>Abrir vitrine no ML ↗</a>
                )}
              </div>

              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>Produtos do cupom</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                <input aria-label="Buscar produto" value={f.q} onChange={e => set("q", e.target.value)} placeholder="Buscar produto pelo nome…" style={{ ...input, flex: "1 1 200px" }} />
                <select aria-label="Ordenar produtos" value={f.sortBy} onChange={e => set("sortBy", e.target.value)} style={input}>
                  {ORDENS_PROD.map(([id, l]) => <option key={id} value={id}>{l}</option>)}
                </select>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 6 }}>
                <button onClick={() => set("valendo", !f.valendo)} style={chip(f.valendo)} title="Só produtos que passam da compra mínima do cupom">
                  Só onde o cupom pega
                </button>
                <select aria-label="Catálogo" value={f.catalogo} onChange={e => set("catalogo", e.target.value)} style={{ ...input, padding: "5px 8px", fontSize: 12 }}>
                  <option value="">Catálogo: todos</option>
                  <option value="com">Só no catálogo</option>
                  <option value="sem">Só fora do catálogo</option>
                </select>
                <input aria-label="Preço mínimo" type="number" min={0} value={f.minPrice} onChange={e => set("minPrice", e.target.value)} placeholder="R$ mín." style={{ ...input, width: 90, padding: "5px 8px", fontSize: 12 }} />
                <input aria-label="Preço máximo" type="number" min={0} value={f.maxPrice} onChange={e => set("maxPrice", e.target.value)} placeholder="R$ máx." style={{ ...input, width: 90, padding: "5px 8px", fontSize: 12 }} />
                {filtrando && <button onClick={() => { setF(FILTROS_PROD_PADRAO); setPage(1); }} style={{ ...botao, border: "none", color: PRIMARY_DARK }}>Limpar</button>}
              </div>
              <div aria-live="polite" style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 4 }}>
                {carregando ? "Carregando…" : `${lista.total} ${lista.total === 1 ? "produto" : "produtos"}`}
              </div>
              {!carregando && lista.items.length === 0 && (
                <div style={{ fontSize: 13, color: "var(--color-text-secondary)", padding: "18px 0", textAlign: "center" }}>
                  {info.produtos === 0 ? "Este cupom ainda não tem produto vinculado — a etapa 2 da colheita (Admin › Cupom) é quem busca." : "Nenhum produto bate com estes filtros."}
                </div>
              )}
              <div style={{ opacity: carregando ? 0.6 : 1 }}>
                {lista.items.map(it => <ProdutoLinha key={it.productKey} p={it} />)}
              </div>
              <Pagination page={page} totalPages={totalPaginas} onChange={setPage} disabled={carregando} />
            </>
          )}
        </div>
      </aside>
    </>
  );
}

export default function PageAdminCupons() {
  const [resumo, setResumo] = useState(null);
  const [f, setF] = useState(FILTROS_PADRAO);
  const [page, setPage] = useState(1);
  const [lista, setLista] = useState({ items: [], total: 0 });
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState(null);
  const [aberto, setAberto] = useState(null);
  const qDeb = useDebounced(f.q);

  useEffect(() => {
    adminCuponsResumo().then(setResumo).catch(() => setResumo({}));
  }, []);
  const labels = resumo?.groupingLabels || {};

  const sig = JSON.stringify({ ...f, q: qDeb });
  const pedido = useRef(null);
  const carregar = useCallback(() => {
    pedido.current?.abort();
    const ctrl = new AbortController();
    pedido.current = ctrl;
    setCarregando(true);
    setErro(null);
    adminCuponsListar({ ...JSON.parse(sig), page, pageSize: PAGE_SIZE }, { signal: ctrl.signal })
      .then(r => setLista({ items: r.items || [], total: r.total || 0 }))
      .catch(err => { if (err.name !== "AbortError") setErro(errText(err, "Não foi possível carregar os cupons.")); })
      .finally(() => { if (pedido.current === ctrl) setCarregando(false); });
  }, [sig, page]);
  useEffect(() => { carregar(); return () => pedido.current?.abort(); }, [carregar]);

  // Filtro novo volta para a primeira página: a página 3 de outra lista não existe.
  const set = (campo, valor) => { setF(x => ({ ...x, [campo]: valor })); setPage(1); };
  const filtrando = JSON.stringify(f) !== JSON.stringify(FILTROS_PADRAO);
  const totalPaginas = Math.max(1, Math.ceil(lista.total / PAGE_SIZE));

  // Navegar de cupom em cupom sem fechar o painel: dentro da página que está na
  // tela e, nas pontas, passando para a página vizinha.
  const idx = aberto ? lista.items.findIndex(c => c.campaignId === aberto) : -1;
  const irPara = useRef(null);
  useEffect(() => {
    if (!irPara.current || carregando || !lista.items.length) return;
    setAberto(irPara.current === "primeiro" ? lista.items[0].campaignId : lista.items[lista.items.length - 1].campaignId);
    irPara.current = null;
  }, [lista, carregando]);
  const anterior = idx > 0
    ? () => setAberto(lista.items[idx - 1].campaignId)
    : (idx === 0 && page > 1 ? () => { irPara.current = "ultimo"; setPage(p => p - 1); } : null);
  const proximo = idx >= 0 && idx < lista.items.length - 1
    ? () => setAberto(lista.items[idx + 1].campaignId)
    : (idx === lista.items.length - 1 && page < totalPaginas ? () => { irPara.current = "primeiro"; setPage(p => p + 1); } : null);

  // Os números do topo também filtram: clicar em "Vencendo" mostra os que vencem.
  const atalho = (patch) => { setF({ ...FILTROS_PADRAO, ...patch }); setPage(1); };
  const eh = (patch) => Object.entries({ ...FILTROS_PADRAO, ...patch }).every(([k, v]) => f[k] === v);

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: 20, marginBottom: 4 }}>Cupons</h1>
        <div style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>
          Todos os cupons do Mercado Livre que o sistema guardou, com os produtos de cada um. A colheita fica em Admin › Cupom.
        </div>
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
        <Stat rotulo="Vigentes" valor={resumo?.vigentes} sub={resumo ? `de ${resumo.total} guardados` : null} onClick={() => atalho({})} ativo={eh({})} />
        <Stat rotulo="Com palavra" valor={resumo?.comPalavra} sub="dá pra anunciar" onClick={() => atalho({ palavra: "com" })} ativo={eh({ palavra: "com" })} />
        <Stat rotulo="Com produtos" valor={resumo?.comProdutos} sub={resumo ? `${resumo.vinculos} vínculos` : null} onClick={() => atalho({ produtos: "com" })} ativo={eh({ produtos: "com" })} />
        <Stat rotulo="Vencendo" valor={resumo?.vencendo} sub="nas próximas 72h" onClick={() => atalho({ situacao: "vencendo", sortBy: "vence" })} ativo={eh({ situacao: "vencendo", sortBy: "vence" })} />
        <Stat rotulo="De loja" valor={resumo?.deLoja} sub="valem só no vendedor" onClick={() => atalho({ escopo: "store" })} ativo={eh({ escopo: "store" })} />
        <Stat rotulo="Vencidos" valor={resumo?.vencidos} sub="saem na faxina" onClick={() => atalho({ situacao: "vencidos" })} ativo={eh({ situacao: "vencidos" })} />
      </div>

      {resumo?.destaques?.length > 0 && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 14 }}>
          <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>🔥 Maiores com palavra:</span>
          {resumo.destaques.map(d => (
            <button key={d.campaignId} onClick={() => setAberto(d.campaignId)} style={chip(false)} title={d.title}>
              <strong>{d.rotulo}</strong> · {d.code}
            </button>
          ))}
        </div>
      )}

      <div style={{ ...card, marginBottom: 14, display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input aria-label="Buscar cupom" value={f.q} onChange={e => set("q", e.target.value)} placeholder="Buscar por título, palavra, vendedor ou nº da campanha…" style={{ ...input, flex: "1 1 260px" }} />
          <select aria-label="Ordenar cupons" value={f.sortBy} onChange={e => set("sortBy", e.target.value)} style={input}>
            {ORDENS.map(([id, l]) => <option key={id} value={id}>{l}</option>)}
          </select>
          <select aria-label="Categoria" value={f.categoria} onChange={e => set("categoria", e.target.value)} style={{ ...input, maxWidth: 220 }}>
            <option value="">Todas as categorias</option>
            {(resumo?.categorias || []).map(c => <option key={c.chave} value={c.chave}>{rotuloCategoria(c.chave, labels)} ({c.n})</option>)}
          </select>
        </div>
        {GRUPOS.map(g => (
          <div key={g.campo} role="radiogroup" aria-label={g.rotulo} style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            <span style={{ fontSize: 11, color: "var(--color-text-secondary)", width: 64, flexShrink: 0 }}>{g.rotulo}</span>
            {g.opcoes.map(([v, l]) => (
              <button key={v || "todos"} role="radio" aria-checked={f[g.campo] === v} onClick={() => set(g.campo, v)} style={chip(f[g.campo] === v)}>{l}</button>
            ))}
          </div>
        ))}
        {filtrando && (
          <button onClick={() => atalho({})} style={{ ...botao, alignSelf: "flex-start", border: "none", color: PRIMARY_DARK, padding: 0 }}>Limpar filtros</button>
        )}
      </div>

      <div aria-live="polite" style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 10 }}>
        {carregando && lista.items.length === 0 ? "Carregando…" : `${lista.total} ${lista.total === 1 ? "cupom" : "cupons"}${totalPaginas > 1 ? ` · página ${page} de ${totalPaginas}` : ""}`}
      </div>
      {erro && <div style={{ fontSize: 13, color: "var(--danger-text)", marginBottom: 12 }}>{erro}</div>}
      {!carregando && !erro && lista.items.length === 0 && (
        <div style={{ ...card, textAlign: "center", color: "var(--color-text-secondary)", fontSize: 13, padding: 32 }}>
          {filtrando ? "Nenhum cupom bate com estes filtros." : "Nenhum cupom guardado ainda — rode a colheita em Admin › Cupom."}
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: 12, opacity: carregando ? 0.6 : 1 }}>
        {lista.items.map(c => <CupomCard key={c.campaignId} c={c} labels={labels} onAbrir={setAberto} selecionado={c.campaignId === aberto} />)}
      </div>
      <Pagination page={page} totalPages={totalPaginas} onChange={setPage} disabled={carregando} />

      {aberto && (
        <PainelCupom
          key={aberto}
          campaignId={aberto}
          labels={labels}
          onFechar={() => setAberto(null)}
          onAnterior={anterior}
          onProximo={proximo}
        />
      )}
    </div>
  );
}
