// Admin › Cupom › aba "Cupons do ML" — os cupons que o Mercado Livre oferece para
// a conta do sistema, e os produtos de cada um.
//
// Três coisas moram aqui:
//   1. A rodada: puxa a lista de cupons (mercadolivre.com.br/cupons) e, para cada
//      cupom, os produtos da vitrine dele. Demora minutos e roda solta no
//      servidor — esta tela dispara e acompanha pelo status.
//   2. A lista: o que já está guardado, com quantos produtos cada cupom cobre e
//      quantos desses já estão no catálogo.
//   3. O testador de PALAVRA: os cupons desta aba não têm palavra (são "Eu quero"
//      ou automáticos), mas o ML aceita uma palavra digitada e responde a que
//      campanha ela pertence. Não dá para listar as palavras — só testar.
import { Fragment, useState, useEffect, useCallback } from "react";
import { PRIMARY, PRIMARY_DARK } from "../data/constants";
import {
  adminMlCupons, adminMlCuponsStatus, adminMlCuponsRun, adminMlCuponsCancel,
  adminMlCuponsSaveConfig, adminMlCuponsProducts, adminMlCuponsSyncProducts,
  adminMlCuponsTestWord, adminMlCuponsCodes, adminMlCuponsClearAll, errText,
} from "../data/api";
import Modal from "../components/ui/Modal";

const brl = (v) => (typeof v === "number" ? `R$ ${v.toFixed(2).replace(".", ",")}` : "—");
const dia = (v) => (v ? new Date(v).toLocaleDateString("pt-BR") : "—");

// O desconto do cupom em uma linha: "20%" ou "R$ 90".
function desconto(c) {
  if (c.kind === "percent" && c.value != null) return `${c.value}%`;
  if (c.value != null) return brl(c.value);
  return "—";
}

const VERDICT = {
  valid: { label: "✅ palavra existe", color: PRIMARY_DARK },
  invalid: { label: "❌ o ML não reconheceu", color: "var(--danger-text)" },
  indeterminado: { label: "❓ não deu pra saber", color: "var(--warn-text)" },
};

export default function CuponsDoML() {
  const [status, setStatus] = useState(null);
  const [lista, setLista] = useState({ items: [], total: 0, page: 1, pageSize: 50 });
  const [filtros, setFiltros] = useState({ q: "", scope: "", onlyValid: true, page: 1 });
  const [erro, setErro] = useState(null);
  const [aberto, setAberto] = useState(null);        // campaignId com os produtos à mostra
  const [produtos, setProdutos] = useState({});      // campaignId → { items, total }
  const [sincronizando, setSincronizando] = useState(null);
  const [confirmarLimpeza, setConfirmarLimpeza] = useState(false);
  const [limpando, setLimpando] = useState(false);

  // `tick` é o gatilho de recarga: mexer nele refaz as duas leituras. Cada uma
  // roda dentro de um IIFE async e confere `vivo` antes de gravar — a rodada
  // demora minutos e a tela pode ser trocada no meio.
  const [tick, setTick] = useState(0);
  const recarregar = useCallback(() => setTick(t => t + 1), []);

  useEffect(() => {
    let vivo = true;
    (async () => {
      try {
        const r = await adminMlCuponsStatus();
        if (vivo) setStatus(r);
      } catch { /* status é acessório — não vale derrubar a tela */ }
    })();
    return () => { vivo = false; };
  }, [tick]);

  useEffect(() => {
    let vivo = true;
    (async () => {
      try {
        const r = await adminMlCupons({ ...filtros, pageSize: 50 });
        if (vivo) setLista(r);
      } catch (err) {
        if (vivo) setErro(errText(err, "Não deu pra carregar os cupons."));
      }
    })();
    return () => { vivo = false; };
  }, [filtros, tick]);

  // Enquanto a rodada corre, o status é a única forma de saber onde ela está.
  // O mesmo tick recarrega a lista, que só depois de terminar tem o que mostrar.
  useEffect(() => {
    if (!status?.running) return undefined;
    const id = setInterval(recarregar, 5000);
    return () => clearInterval(id);
  }, [status?.running, recarregar]);

  const rodar = async () => {
    setErro(null);
    try {
      await adminMlCuponsRun({});
      recarregar();
    } catch (err) {
      setErro(errText(err, "Não deu pra começar a rodada."));
    }
  };

  const cancelar = async () => {
    try { await adminMlCuponsCancel(); recarregar(); } catch { /* já pode ter acabado */ }
  };

  const verProdutos = async (campaignId) => {
    if (aberto === campaignId) { setAberto(null); return; }
    setAberto(campaignId);
    if (produtos[campaignId]) return;
    try {
      const r = await adminMlCuponsProducts(campaignId, { pageSize: 30 });
      setProdutos(p => ({ ...p, [campaignId]: r }));
    } catch (err) {
      setErro(errText(err, "Não deu pra carregar os produtos desse cupom."));
    }
  };

  const sincronizar = async (campaignId) => {
    setSincronizando(campaignId);
    setErro(null);
    try {
      await adminMlCuponsSyncProducts(campaignId);
      setProdutos(p => ({ ...p, [campaignId]: undefined }));
      setAberto(null);
      recarregar();
    } catch (err) {
      setErro(errText(err, "Não deu pra raspar a vitrine desse cupom."));
    } finally {
      setSincronizando(null);
    }
  };

  const limparTudo = async () => {
    setConfirmarLimpeza(false);
    setErro(null);
    setLimpando(true);
    try {
      await adminMlCuponsClearAll();
      setAberto(null);
      setProdutos({});
      setFiltros(f => ({ ...f, page: 1 }));
      recarregar();
    } catch (err) {
      setErro(errText(err, "Não deu pra apagar os cupons."));
    } finally {
      setLimpando(false);
    }
  };

  const s = status?.stats;
  const rodando = !!status?.running;
  const semCupom = !s?.cupons;

  return (
    <div>
      <div style={cardStyle}>
        <div style={{ fontWeight: 500, marginBottom: 4 }}>Puxar os cupons do Mercado Livre</div>
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 12, lineHeight: 1.5 }}>
          Lê a aba de cupons com a conta do sistema (a mesma do Hub) e, para cada cupom,
          abre a vitrine dele para guardar quais produtos ele cobre. <b>Não ativa cupom nenhum</b> —
          só lê. Demora minutos: a tela vai se atualizando sozinha.
        </div>

        {s && (
          <div style={{ display: "flex", gap: 18, flexWrap: "wrap", fontSize: 12, marginBottom: 12 }}>
            <Numero label="Cupons guardados" valor={s.cupons} />
            <Numero label="Ainda válidos" valor={s.validos} />
            <Numero label="Com vitrine raspada" valor={s.comVitrine} />
            <Numero label="Vínculos cupom↔produto" valor={s.vinculos} />
            <Numero label="Produtos do catálogo com cupom" valor={s.catalogo} />
            <Numero label="Com palavra descoberta" valor={s.comCodigo} />
          </div>
        )}

        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <button onClick={rodar} disabled={rodando} style={botaoPrimario(rodando)}>
            {rodando ? "⟳ Rodando..." : "Puxar cupons agora"}
          </button>
          {rodando && (
            <button onClick={cancelar} style={botaoSecundario}>Cancelar</button>
          )}
          {/* Desabilitado durante a rodada porque a rota devolve 409 — melhor não
              deixar clicar do que explicar o erro depois de confirmar. */}
          <button
            onClick={() => setConfirmarLimpeza(true)}
            disabled={limpando || rodando || semCupom}
            style={botaoPerigo(limpando || rodando || semCupom)}
          >
            {limpando ? "Apagando..." : "🗑 Apagar todos"}
          </button>
          {status?.progress && (
            <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
              {status.progress.etapa === "cupons"
                ? `lendo a lista${status.progress.grouping ? ` de ${status.progress.grouping}` : ""} — página ${status.progress.pagina}/${status.progress.de}, ${status.progress.cupons} cupons${status.progress.ignoradosLoja ? ` (${status.progress.ignoradosLoja} de loja ignorados)` : ""}`
                : `vitrines: ${status.progress.vitrines}/${status.progress.cupons} cupons, ${status.progress.produtos} produtos`}
            </span>
          )}
        </div>

        {status?.lastRun && !rodando && (
          <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 10 }}>
            Última rodada: {new Date(status.lastRun).toLocaleString("pt-BR")}
            {typeof status.lastDuration === "number" && ` · ${(status.lastDuration / 1000).toFixed(0)}s`}
            {status.lastResult && ` · ${status.lastResult.cupons} cupons (${status.lastResult.novos} novos), ${status.lastResult.vinculos} vínculos, ${status.lastResult.catalogoCarimbado} produtos do catálogo carimbados`}
            {status.lastResult?.cuponsDeLojaIgnorados ? ` · ${status.lastResult.cuponsDeLojaIgnorados} de loja ignorados` : ""}
          </div>
        )}
        {status?.lastError && (
          <div style={{ marginTop: 8, background: "var(--warn-bg)", color: "var(--warn-text)", padding: "8px 10px", borderRadius: 8, fontSize: 12 }}>
            {status.lastError}
          </div>
        )}
        {erro && (
          <div style={{ marginTop: 8, background: "var(--danger-bg)", color: "var(--danger-text)", padding: "8px 10px", borderRadius: 8, fontSize: 12 }}>
            {erro}
          </div>
        )}

        <Config config={status?.config} onSaved={recarregar} />
      </div>

      <TestarPalavra onDone={recarregar} />

      <div style={cardStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
          <div style={{ fontWeight: 500 }}>Cupons guardados <span style={{ color: "var(--color-text-secondary)", fontWeight: 400 }}>({lista.total})</span></div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input
              placeholder="buscar por título, loja ou campanha"
              value={filtros.q}
              onChange={e => setFiltros(f => ({ ...f, q: e.target.value, page: 1 }))}
              style={{ ...inputStyle, width: 240 }}
            />
            <select value={filtros.scope} onChange={e => setFiltros(f => ({ ...f, scope: e.target.value, page: 1 }))} style={inputStyle}>
              <option value="">todos os tipos</option>
              <option value="campaign">campanha</option>
              <option value="store">loja</option>
            </select>
            <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}>
              <input type="checkbox" checked={filtros.onlyValid} onChange={e => setFiltros(f => ({ ...f, onlyValid: e.target.checked, page: 1 }))} />
              só os que ainda valem
            </label>
          </div>
        </div>

        {lista.items.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
            Nenhum cupom guardado ainda — rode o “Puxar cupons agora”.
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ textAlign: "left", color: "var(--color-text-secondary)" }}>
                  <th style={th}>Cupom</th>
                  <th style={th}>Desconto</th>
                  <th style={th}>Mín / Teto</th>
                  <th style={th}>Tipo</th>
                  <th style={th}>Vence</th>
                  <th style={th}>Produtos</th>
                  <th style={th}>No catálogo</th>
                  <th style={th}>Palavra</th>
                  <th style={th}></th>
                </tr>
              </thead>
              <tbody>
                {lista.items.map(c => (
                  // Fragment com key: a linha do cupom e a linha expandida dos
                  // produtos são dois <tr> irmãos para o mesmo item da lista.
                  <Fragment key={c.campaignId}>
                    <tr style={{ borderTop: "0.5px solid var(--color-border-tertiary)" }}>
                      <td style={td}>
                        <div style={{ fontWeight: 500 }}>{c.title}</div>
                        <div style={{ color: "var(--color-text-secondary)" }}>{c.subtitle || `campanha ${c.campaignId}`}</div>
                      </td>
                      <td style={td}>{desconto(c)}</td>
                      <td style={td}>{c.minPurchase ? brl(c.minPurchase) : "sem mínimo"}{c.maxDiscount ? ` / ${brl(c.maxDiscount)}` : ""}</td>
                      <td style={td}>{c.scope === "store" ? `loja${c.sellerName ? ` (${c.sellerName})` : ""}` : "campanha"}{!c.activated && " · não ativado"}</td>
                      <td style={td}>{dia(c.expiresAt)}</td>
                      <td style={td}>{c.products || 0}</td>
                      <td style={td}>{c.inCatalog || 0}</td>
                      <td style={{ ...td, fontFamily: "monospace" }}>{c.code || "—"}</td>
                      <td style={td}>
                        <div style={{ display: "flex", gap: 6 }}>
                          <button onClick={() => verProdutos(c.campaignId)} style={botaoLink}>
                            {aberto === c.campaignId ? "fechar" : "produtos"}
                          </button>
                          <button onClick={() => sincronizar(c.campaignId)} disabled={sincronizando === c.campaignId} style={botaoLink}>
                            {sincronizando === c.campaignId ? "⟳" : "raspar"}
                          </button>
                          {c.containerUrl && (
                            <a href={c.containerUrl} target="_blank" rel="noreferrer" style={{ ...botaoLink, textDecoration: "none" }}>ML ↗</a>
                          )}
                        </div>
                      </td>
                    </tr>
                    {aberto === c.campaignId && (
                      <tr>
                        <td colSpan={9} style={{ ...td, background: "var(--color-background-secondary)" }}>
                          <Produtos dados={produtos[c.campaignId]} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {lista.total > lista.pageSize && (
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10, fontSize: 12 }}>
            <button disabled={filtros.page <= 1} onClick={() => setFiltros(f => ({ ...f, page: f.page - 1 }))} style={botaoSecundario}>anterior</button>
            <span style={{ color: "var(--color-text-secondary)" }}>
              página {lista.page} de {Math.ceil(lista.total / lista.pageSize)}
            </span>
            <button
              disabled={lista.page >= Math.ceil(lista.total / lista.pageSize)}
              onClick={() => setFiltros(f => ({ ...f, page: f.page + 1 }))}
              style={botaoSecundario}
            >próxima</button>
          </div>
        )}
      </div>

      {confirmarLimpeza && (
        <Modal title="Apagar todos os cupons?" onClose={() => setConfirmarLimpeza(false)} danger>
          <p style={{ fontSize: 13, marginBottom: 16, color: "var(--color-text-secondary)", lineHeight: 1.5 }}>
            Os <strong style={{ color: "var(--color-text-primary)" }}>{s?.cupons ?? 0}</strong> cupons guardados e os{" "}
            <strong style={{ color: "var(--color-text-primary)" }}>{s?.vinculos ?? 0}</strong> vínculos com produtos serão apagados, e os{" "}
            <strong style={{ color: "var(--color-text-primary)" }}>{s?.catalogo ?? 0}</strong> produtos do catálogo perdem o carimbo de cupom.
            As <strong style={{ color: "var(--color-text-primary)" }}>palavras já testadas continuam guardadas</strong> — cada uma custa um
            Chrome aberto com a conta do sistema pra redescobrir, e elas voltam a carimbar o cupom na próxima rodada.
            Esta ação não pode ser desfeita.
          </p>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button onClick={() => setConfirmarLimpeza(false)} style={botaoSecundario}>Cancelar</button>
            <button
              onClick={limparTudo}
              style={{ padding: "8px 16px", borderRadius: 8, background: "#E24B4A", color: "#fff", border: "none", fontSize: 13, fontWeight: 500, cursor: "pointer" }}
            >Apagar tudo</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Produtos({ dados }) {
  if (!dados) return <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>carregando…</span>;
  if (!dados.items.length) {
    return (
      <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
        Nenhum produto guardado para este cupom — clique em “raspar” para abrir a vitrine dele no ML.
      </span>
    );
  }
  return (
    <div>
      <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 6 }}>
        {dados.total} produto(s) neste cupom
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {dados.items.map(p => (
          <div key={p.productKey} style={{ display: "flex", gap: 10, alignItems: "center", fontSize: 12 }}>
            {p.catalog?.img && <img src={p.catalog.img} alt="" width={34} height={34} style={{ objectFit: "contain", borderRadius: 6 }} />}
            <a href={p.productUrl} target="_blank" rel="noreferrer" style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "inherit" }}>
              {p.catalog?.name || p.productUrl}
            </a>
            <span style={{ color: "var(--color-text-secondary)" }}>{brl(p.catalog?.price)}</span>
            <span style={{ color: p.inCatalog ? PRIMARY_DARK : "var(--color-text-secondary)" }}>
              {p.inCatalog ? "no catálogo" : "fora do catálogo"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Os tetos da rodada. Ficam à vista porque são eles que seguram o tempo (e o
// atrito com o ML): a conta enxerga milhares de cupons, e cada um é uma página.
function Config({ config, onSaved }) {
  // O que está sendo editado, se alguém mexeu; senão, o que o servidor mandou.
  // Estado derivado em vez de efeito copiando prop pra estado — que é o que
  // desfaria a edição sozinho a cada volta do poll de status.
  const [edit, setEdit] = useState(null);
  const [salvando, setSalvando] = useState(false);
  const cfg = edit || config;
  const setCfg = (fn) => setEdit(typeof fn === "function" ? fn(cfg) : fn);
  if (!cfg) return null;

  const salvar = async () => {
    setSalvando(true);
    try { await adminMlCuponsSaveConfig(cfg); onSaved?.(); } catch { /* o erro aparece na próxima leitura */ }
    finally { setSalvando(false); }
  };

  return (
    <details style={{ marginTop: 12 }}>
      <summary style={{ cursor: "pointer", fontSize: 12, color: "var(--color-text-secondary)" }}>Limites da rodada</summary>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end", marginTop: 10 }}>
        <div>
          <label style={labelStyle}>Cupons por categoria</label>
          <input type="number" min={5} max={600} value={cfg.limitPerGrouping}
            onChange={e => setCfg(c => ({ ...c, limitPerGrouping: Number(e.target.value) }))} style={{ ...inputStyle, width: 110 }} />
        </div>
        <div>
          <label style={labelStyle}>Produtos por cupom</label>
          <input type="number" min={10} max={300} value={cfg.maxProductsPerCoupon}
            onChange={e => setCfg(c => ({ ...c, maxProductsPerCoupon: Number(e.target.value) }))} style={{ ...inputStyle, width: 110 }} />
        </div>
        <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 6, paddingBottom: 8 }}>
          <input type="checkbox" checked={cfg.withProducts} onChange={e => setCfg(c => ({ ...c, withProducts: e.target.checked }))} />
          raspar a vitrine de cada cupom
        </label>
        <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 6, paddingBottom: 8 }}>
          <input type="checkbox" checked={cfg.skipStoreCoupons !== false}
            onChange={e => setCfg(c => ({ ...c, skipStoreCoupons: e.target.checked }))} />
          ignorar cupom de loja (só campanha do ML)
        </label>
        <button onClick={salvar} disabled={salvando} style={botaoSecundario}>{salvando ? "salvando…" : "salvar"}</button>
      </div>
      <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 8 }}>
        Sem categoria escolhida, a rodada lê a lista geral. Cada vitrine é uma página aberta
        com a conta do sistema — a mesma do Hub —, então subir muito esses números aumenta a
        chance de o ML pedir verificação. Cupom de loja vale só para os produtos daquele
        vendedor e é o mais caro da rodada (é sempre ativado, então sempre tem vitrine pra
        abrir): ignorá-lo o descarta antes de virar página no Chrome, e o limite acima passa
        a contar só cupom de campanha.
      </div>
    </details>
  );
}

// O testador de palavra. É o que responde "esse CUPOM10 que veio no grupo líder
// existe? de qual campanha ele é?".
function TestarPalavra({ onDone }) {
  const [word, setWord] = useState("");
  const [rodando, setRodando] = useState(false);
  const [res, setRes] = useState(null);
  const [erro, setErro] = useState(null);
  const [historico, setHistorico] = useState([]);

  const [tick, setTick] = useState(0);
  const carregar = useCallback(() => setTick(t => t + 1), []);

  useEffect(() => {
    let vivo = true;
    (async () => {
      try {
        const r = await adminMlCuponsCodes(20);
        if (vivo) setHistorico(r.codes || []);
      } catch { /* histórico é acessório */ }
    })();
    return () => { vivo = false; };
  }, [tick]);

  const testar = async () => {
    if (!word.trim()) return;
    setRodando(true); setErro(null); setRes(null);
    try {
      const r = await adminMlCuponsTestWord(word.trim().toUpperCase());
      setRes(r.result);
      carregar();
      onDone?.();
    } catch (err) {
      setErro(errText(err, "Não deu pra testar essa palavra."));
    } finally {
      setRodando(false);
    }
  };

  return (
    <div style={cardStyle}>
      <div style={{ fontWeight: 500, marginBottom: 4 }}>Descobrir a campanha de uma palavra</div>
      <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 12, lineHeight: 1.5 }}>
        Os cupons desta aba <b>não têm palavra</b>: eles são “Eu quero” (o cliente clica) ou
        automáticos. Mas o ML aceita uma palavra digitada — tipo <code>BRINQUEDOS</code> — e responde
        a que campanha ela pertence. Não dá para listar as palavras: dá para testar uma e guardar
        a resposta. É assim que a palavra que veio na legenda do grupo líder vira uma lista de produtos.
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input
          placeholder="BRINQUEDOS"
          value={word}
          onChange={e => setWord(e.target.value.toUpperCase())}
          onKeyDown={e => { if (e.key === "Enter" && !rodando) testar(); }}
          style={{ ...inputStyle, width: 220, textTransform: "uppercase" }}
        />
        <button onClick={testar} disabled={rodando || !word.trim()} style={botaoPrimario(rodando || !word.trim())}>
          {rodando ? "⟳ testando (~40s)..." : "Testar palavra"}
        </button>
      </div>

      {erro && <div style={{ marginTop: 10, fontSize: 12, color: "var(--danger-text)" }}>{erro}</div>}

      {res && (
        <div style={{ marginTop: 12, fontSize: 13 }}>
          <b style={{ color: (VERDICT[res.verdict] || {}).color }}>{(VERDICT[res.verdict] || {}).label || res.verdict}</b>
          {res.campaignId && <> · campanha <code>{res.campaignId}</code>{res.coupon?.title ? ` (${res.coupon.title})` : ""}</>}
          {res.cached && <span style={{ color: "var(--color-text-secondary)" }}> · resposta guardada de {new Date(res.checkedAt).toLocaleString("pt-BR")}</span>}
          <div style={{ color: "var(--color-text-secondary)", fontSize: 12, marginTop: 4 }}>{res.message || res.reason}</div>
        </div>
      )}

      {historico.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 6 }}>Palavras já testadas</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {historico.map(h => (
              <div key={h.code} style={{ display: "flex", gap: 10, fontSize: 12, alignItems: "baseline", flexWrap: "wrap" }}>
                <span style={{ fontFamily: "monospace", minWidth: 120 }}>{h.code}</span>
                <span style={{ color: (VERDICT[h.verdict] || {}).color }}>{(VERDICT[h.verdict] || {}).label || h.verdict}</span>
                {h.campaignId && <span style={{ color: "var(--color-text-secondary)" }}>campanha {h.campaignId}</span>}
                <span style={{ color: "var(--color-text-secondary)", flex: "1 1 200px", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {h.message || "—"}
                </span>
                <span style={{ color: "var(--color-text-secondary)" }}>{new Date(h.checkedAt).toLocaleDateString("pt-BR")}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Numero({ label, valor }) {
  return (
    <div>
      <div style={{ fontSize: 18, fontWeight: 600 }}>{valor ?? "—"}</div>
      <div style={{ color: "var(--color-text-secondary)" }}>{label}</div>
    </div>
  );
}

const cardStyle = { background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: 16, marginBottom: 18 };
const inputStyle = { padding: "7px 10px", borderRadius: 7, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13, boxSizing: "border-box" };
const labelStyle = { fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 6 };
const th = { padding: "6px 8px", fontWeight: 500, whiteSpace: "nowrap" };
const td = { padding: "8px", verticalAlign: "top" };
const botaoPrimario = (off) => ({
  padding: "9px 18px", borderRadius: 8, border: "none", fontSize: 13, fontWeight: 500,
  background: PRIMARY, color: "#fff", cursor: off ? "not-allowed" : "pointer", opacity: off ? 0.6 : 1,
});
const botaoSecundario = {
  padding: "7px 14px", borderRadius: 8, fontSize: 12, cursor: "pointer",
  border: "1px solid var(--color-border-tertiary)", background: "transparent", color: "var(--color-text-primary)",
};
// O gatilho da ação destrutiva: outline suave, como no "Apagar todos" do catálogo.
// O vermelho sólido fica só no botão de confirmar, dentro do modal.
const botaoPerigo = (off) => ({
  padding: "7px 14px", borderRadius: 8, fontSize: 12,
  border: "1px solid var(--danger-border)", background: "var(--danger-bg)", color: "var(--danger-text)",
  cursor: off ? "not-allowed" : "pointer", opacity: off ? 0.5 : 1,
});
const botaoLink = {
  padding: "3px 8px", borderRadius: 6, fontSize: 11, cursor: "pointer",
  border: "1px solid var(--color-border-tertiary)", background: "transparent", color: "var(--color-text-primary)",
};
