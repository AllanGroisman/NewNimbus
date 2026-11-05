// Admin › Scraping Cupons › aba "Cupons com Palavras" — todo cupom que tem uma
// palavra (tipo BRINQUEDOS) com as condições dele: desconto, mínimo, teto e validade.
//
// Junta as duas metades que moram em abas diferentes: o dicionário palavra →
// campanha (aba "Descobrir palavra", `ml_coupon_codes`) e o cupom em si (aba
// "Cupons do ML", `ml_coupons`). Só entram as palavras que o ML aceitou.
//
// Dois botões:
//   - "Limpar vencidos" apaga o cupom vencido E a palavra dele (o "Apagar
//     vencidos" da aba Cupons do ML guarda as palavras; este não);
//   - "Limpar não achados" apaga, do mesmo jeito, as palavras em que o "Buscar
//     condições" rodou e o cupom não apareceu (a marca fica no banco);
//   - "Buscar condições" abre, pela extensão, um produto ligado à palavra e lê a
//     lista de cupons do checkout dele (a mesma sonda da aba Cupons do produto):
//     lá cada cupom vem com desconto, mínimo, teto e validade. Uma palavra por vez.
//
// Os produtos de cada palavra vêm do repasse (o link que chegou junto com a
// palavra na legenda do grupo líder) e dos vínculos do cupom (vitrine, checkout).
import { Fragment, useState, useEffect, useCallback, useRef } from "react";
import {
  adminMlCuponsPalavras, adminMlCuponsPalavrasVencidosPrevia,
  adminMlCuponsPalavrasApagarVencidos, adminMlCuponsPalavrasCondicoes,
  adminMlCuponsPalavrasMarcarNaoAchou, adminMlCuponsPalavrasNaoAchadosPrevia,
  adminMlCuponsPalavrasApagarNaoAchados, errText,
} from "../data/api";
import Modal from "../components/ui/Modal";
import { coletorEntende, sondarCuponsNoCheckout } from "../data/coletor";
import { materialEnxuto, descreverPasso } from "../data/sondaLote";
import {
  cardStyle, th, td, brl, dia, desconto, botaoPrimario, botaoSecundario, botaoPerigo, botaoLink,
} from "../components/admin/cupomEstilos";

function situacao(l) {
  if (l.vencido) return { label: "vencido", color: "var(--danger-text)" };
  if (l.naoAchou) return { label: "não achado", color: "var(--danger-text)" };
  if (l.semCondicoes) return { label: "sem condições", color: "#B7791F" };
  return { label: "ok", color: "#2F855A" };
}

// Quantos produtos de uma palavra tentar antes de desistir dela. O cupom pode não
// valer num produto (fora da categoria, vendedor de fora) e valer no outro.
const TENTATIVAS_POR_PALAVRA = 3;

const ORIGEM = { teste: "teste ✓", "teste-recusado": "teste ✗", repasse: "repasse", checkout: "checkout", vitrine: "vitrine", parcial: "vitrine (parte)" };

// Uma palavra: tenta os produtos dela, um de cada vez, até a lista do checkout
// mostrar o cupom. Devolve { achou, gravados[], motivo, muro }.
async function sondarPalavra(l, { onPasso = () => {}, parou = () => false } = {}) {
  const gravados = [];
  let motivo = null;
  const produtos = (l.produtos || []).slice(0, TENTATIVAS_POR_PALAVRA);
  if (!produtos.length) return { achou: false, gravados, motivo: "nenhum produto ligado a esta palavra" };
  for (const [i, p] of produtos.entries()) {
    if (parou()) return { achou: false, gravados, motivo: "Interrompido por você", parado: true };
    onPasso({ produto: p, tentativa: i + 1, de: produtos.length, passo: null });
    let viuMuro = false;
    let material;
    try {
      material = await sondarCuponsNoCheckout(p.url, {
        onProgresso: (ev) => {
          if (ev?.tipo === "muro") viuMuro = true;
          onPasso({ produto: p, tentativa: i + 1, de: produtos.length, passo: descreverPasso(ev) });
        },
      });
    } catch (err) {
      motivo = errText(err, "a sonda não terminou");
      continue;
    }
    if (material?.muro && !viuMuro) viuMuro = true;
    const r = await adminMlCuponsPalavrasCondicoes({ campaignId: l.campaignId, url: p.url, material: materialEnxuto(material) });
    gravados.push(...(r.gravados || []));
    if (r.achou) return { achou: true, gravados };
    // Muro que ninguém resolveu: seguir só queima a conta do sistema.
    if (viuMuro && !r.ok) return { achou: false, gravados, motivo: "o Mercado Livre pediu verificação", muro: true };
    motivo = r.ok
      ? `o checkout listou ${r.vistos} cupom(ns), mas não este`
      : (r.motivo || "não deu pra ler a lista de cupons do checkout");
  }
  return { achou: false, gravados, motivo };
}

export default function CuponsComPalavras() {
  const [linhas, setLinhas] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState(null);
  const [tick, setTick] = useState(0);
  const recarregar = useCallback(() => setTick(t => t + 1), []);

  // Limpar vencidos / não achados: a prévia abre o modal; confirmar apaga.
  // `previa` = { tipo: "vencidos" | "naoAchados", ...contas }.
  const [previa, setPrevia] = useState(null);
  const [limpando, setLimpando] = useState(false);
  const [limpo, setLimpo] = useState(null);

  // Buscar condições.
  const [busca, setBusca] = useState(null); // { i, total, code, passo }
  const [abertas, setAbertas] = useState(() => new Set());
  const alternar = (id) => setAbertas(a => { const n = new Set(a); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const [resumo, setResumo] = useState(null); // { achou, falhou: [{code, motivo}], parado }
  const pararRef = useRef(false);

  useEffect(() => {
    let vivo = true;
    (async () => {
      setCarregando(true);
      try {
        const r = await adminMlCuponsPalavras();
        if (vivo) { setLinhas(r.cupons || []); setErro(null); }
      } catch (err) {
        if (vivo) setErro(errText(err, "Não deu pra carregar os cupons com palavra."));
      } finally {
        if (vivo) setCarregando(false);
      }
    })();
    return () => { vivo = false; };
  }, [tick]);

  const vencidos = linhas.filter(l => l.vencido);
  const semCondicoes = linhas.filter(l => l.semCondicoes && !l.vencido);
  const buscaveis = semCondicoes.filter(l => l.produtos?.length);
  const naoAchados = linhas.filter(l => l.naoAchou);
  const ocupado = !!busca || limpando;

  const LIMPEZA = {
    vencidos: { previa: adminMlCuponsPalavrasVencidosPrevia, apagar: adminMlCuponsPalavrasApagarVencidos, nome: "vencido(s)" },
    naoAchados: { previa: adminMlCuponsPalavrasNaoAchadosPrevia, apagar: adminMlCuponsPalavrasApagarNaoAchados, nome: "não achado(s)" },
  };

  const abrirPrevia = async (tipo) => {
    setErro(null); setLimpo(null);
    try {
      setPrevia({ tipo, ...await LIMPEZA[tipo].previa() });
    } catch (err) {
      setErro(errText(err, "Não deu pra contar o que sairia."));
    }
  };

  const limpar = async () => {
    const tipo = previa.tipo;
    setPrevia(null);
    setLimpando(true); setErro(null);
    try {
      setLimpo({ tipo, ...await LIMPEZA[tipo].apagar() });
      recarregar();
    } catch (err) {
      setErro(errText(err, "Não deu pra apagar."));
    } finally {
      setLimpando(false);
    }
  };

  // `fila` = as linhas a buscar (o botão geral manda todas; o da linha, uma só).
  const buscarCondicoes = async (fila = buscaveis) => {
    if (!fila.length) return;
    if (!(await coletorEntende("cupons-checkout"))) {
      setErro("A extensão do Chrome não está ligada (ou é antiga demais): ela é quem abre o produto e lê os cupons do checkout.");
      return;
    }
    pararRef.current = false;
    setErro(null); setResumo(null); setLimpo(null);
    let achou = 0;
    const falhou = [];
    // Uma sonda grava as condições de TODA palavra que o checkout listar — então a
    // palavra que uma sonda anterior já resolveu é pulada.
    const resolvidas = new Set();
    let parado = null;
    try {
      for (let i = 0; i < fila.length; i++) {
        if (pararRef.current) { parado = "Interrompido por você"; break; }
        const l = fila[i];
        if (resolvidas.has(l.campaignId)) { achou++; continue; }
        setBusca({ i: i + 1, total: fila.length, code: l.code, passo: null });
        try {
          const r = await sondarPalavra(l, {
            parou: () => pararRef.current,
            onPasso: (p) => setBusca(b => (b ? { ...b, ...p } : b)),
          });
          for (const g of r.gravados) resolvidas.add(g.campaignId);
          if (r.achou) achou++;
          else if (r.parado) { parado = r.motivo; break; }
          else if (r.muro) { parado = "O Mercado Livre pediu verificação — parei aqui de propósito"; break; }
          else {
            falhou.push({ code: l.code, campaignId: l.campaignId, motivo: r.motivo });
            // Testou e não achou: fica marcado no banco, para o "Limpar não achados".
            await adminMlCuponsPalavrasMarcarNaoAchou(l.campaignId, r.motivo).catch(() => {});
          }
        } catch (err) {
          falhou.push({ code: l.code, campaignId: l.campaignId, motivo: errText(err, "não deu pra buscar") });
        }
      }
    } finally {
      const extras = [...resolvidas].filter(id => !fila.some(l => l.campaignId === id)).length;
      setBusca(null);
      setResumo({ achou, falhou, parado, total: fila.length, extras });
      recarregar();
    }
  };

  return (
    <div style={cardStyle}>
      <div style={{ fontWeight: 500, marginBottom: 4 }}>Cupons com palavra</div>
      <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 12, lineHeight: 1.5 }}>
        Todo cupom que tem uma palavra aceita pelo ML, com as condições dele e os produtos ligados a ela.
        “Buscar condições” abre um desses produtos no seu Chrome (pela extensão), vai até os cupons do
        checkout — sem comprar nada — e lê de lá o desconto, o mínimo, o teto e a validade.
      </div>

      <div style={{ display: "flex", gap: 14, fontSize: 12, marginBottom: 12, flexWrap: "wrap", color: "var(--color-text-secondary)" }}>
        <span><b style={{ color: "var(--color-text-primary)" }}>{linhas.length}</b> cupons</span>
        <span><b style={{ color: "var(--color-text-primary)" }}>{semCondicoes.length}</b> sem condições</span>
        <span><b style={{ color: "var(--color-text-primary)" }}>{naoAchados.length}</b> não achados</span>
        <span><b style={{ color: "var(--color-text-primary)" }}>{vencidos.length}</b> vencidos</span>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        <button
          onClick={() => buscarCondicoes()}
          disabled={ocupado || !buscaveis.length}
          style={botaoPrimario(ocupado || !buscaveis.length)}
          title={semCondicoes.length > buscaveis.length ? `${semCondicoes.length - buscaveis.length} sem produto ligado ficam de fora` : undefined}
        >
          {busca ? "⟳ buscando..." : `Buscar condições (${buscaveis.length})`}
        </button>
        {busca && (
          <button onClick={() => { pararRef.current = true; }} style={botaoSecundario}>Parar</button>
        )}
        <button onClick={() => abrirPrevia("vencidos")} disabled={ocupado || !vencidos.length} style={botaoPerigo(ocupado || !vencidos.length)}>
          {limpando ? "apagando..." : `🗑 Limpar vencidos (${vencidos.length})`}
        </button>
        <button onClick={() => abrirPrevia("naoAchados")} disabled={ocupado || !naoAchados.length} style={botaoPerigo(ocupado || !naoAchados.length)}>
          {limpando ? "apagando..." : `🗑 Limpar não achados (${naoAchados.length})`}
        </button>
        <button onClick={recarregar} disabled={ocupado} style={botaoSecundario}>⟳ Atualizar</button>
      </div>

      {busca && (
        <div style={{ fontSize: 12, marginBottom: 12, color: "var(--color-text-secondary)" }}>
          ⟳ {busca.i} de {busca.total} — <code>{busca.code}</code>
          {busca.produto && <> · produto {busca.tentativa}/{busca.de}: {busca.produto.name || busca.produto.url}</>}
          {busca.passo && <> · {busca.passo}</>}
        </div>
      )}

      {resumo && (
        <div style={{ fontSize: 12, marginBottom: 12, background: "var(--color-background-secondary)", padding: "8px 10px", borderRadius: 8, lineHeight: 1.6 }}>
          Achei as condições de {resumo.achou} de {resumo.total} palavra{resumo.total === 1 ? "" : "s"}.
          {resumo.extras > 0 && <> De quebra, o checkout trouxe as de mais {resumo.extras}.</>}
          {resumo.parado && <div>Parei: {resumo.parado}</div>}
          {resumo.falhou.length > 0 && (
            <div style={{ marginTop: 4 }}>
              Não vieram:
              {resumo.falhou.map(f => (
                <div key={f.campaignId} style={{ color: "var(--color-text-secondary)" }}>
                  <code>{f.code}</code> (campanha {f.campaignId}) — {f.motivo}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {limpo && (
        <div style={{ fontSize: 12, marginBottom: 12, background: "var(--color-background-secondary)", padding: "8px 10px", borderRadius: 8 }}>
          Apaguei {limpo.palavras} palavra(s) {LIMPEZA[limpo.tipo].nome}, {limpo.cupons} cupom(ns) e {limpo.produtos} produto(s) que só vinham da vitrine deles.
        </div>
      )}

      {erro && <div style={{ fontSize: 12, color: "var(--danger-text)", marginBottom: 12 }}>{erro}</div>}

      {carregando && !linhas.length ? (
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>carregando...</div>
      ) : !linhas.length ? (
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>Nenhum cupom com palavra no sistema ainda.</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "var(--color-text-secondary)", borderBottom: "0.5px solid var(--color-border-tertiary)" }}>
                <th style={th}>Palavra</th>
                <th style={th}>Campanha</th>
                <th style={th}>Desconto</th>
                <th style={th}>Mínimo</th>
                <th style={th}>Teto</th>
                <th style={th}>Validade</th>
                <th style={th}>Situação</th>
                <th style={th}>Produtos</th>
              </tr>
            </thead>
            <tbody>
              {linhas.map(l => {
                const s = situacao(l);
                const aberta = abertas.has(l.campaignId);
                const n = l.produtos?.length || 0;
                return (
                  <Fragment key={l.campaignId}>
                    <tr style={{ borderBottom: aberta ? "none" : "0.5px solid var(--color-border-tertiary)", opacity: l.vencido ? 0.6 : 1 }}>
                      <td style={{ ...td, fontFamily: "monospace" }}>{l.codes.join(", ")}</td>
                      <td style={td}>
                        {l.title || <span style={{ color: "var(--color-text-secondary)" }}>—</span>}
                        <div style={{ color: "var(--color-text-secondary)", fontSize: 11 }}>{l.campaignId}</div>
                      </td>
                      <td style={td}>{desconto(l)}</td>
                      <td style={td}>{brl(l.minPurchase)}</td>
                      <td style={td}>{brl(l.maxDiscount)}</td>
                      <td style={td}>{l.expiresAt ? dia(l.expiresAt) : (l.expiresText || "—")}</td>
                      <td style={{ ...td, color: s.color, fontWeight: 500 }}>
                        <span style={{ whiteSpace: "nowrap" }}>{s.label}</span>
                        {l.naoAchou && !l.vencido && (
                          <div style={{ color: "var(--color-text-secondary)", fontWeight: 400, fontSize: 11, maxWidth: 220 }}>
                            buscado em {dia(l.naoAchou.at)}{l.naoAchou.motivo ? ` — ${l.naoAchou.motivo}` : ""}
                          </div>
                        )}
                      </td>
                      <td style={{ ...td, whiteSpace: "nowrap" }}>
                        {n ? (
                          <button onClick={() => alternar(l.campaignId)} style={botaoLink}>
                            {aberta ? "▾" : "▸"} {l.totalProdutos > n ? `${n} de ${l.totalProdutos}` : n}
                          </button>
                        ) : <span style={{ color: "var(--color-text-secondary)" }}>nenhum</span>}
                        {n > 0 && l.semCondicoes && !l.vencido && (
                          <button onClick={() => buscarCondicoes([l])} disabled={ocupado} style={{ ...botaoLink, marginLeft: 6 }}>
                            buscar
                          </button>
                        )}
                      </td>
                    </tr>
                    {aberta && (
                      <tr style={{ borderBottom: "0.5px solid var(--color-border-tertiary)" }}>
                        <td colSpan={8} style={{ ...td, paddingTop: 0 }}>
                          <div style={{ display: "flex", flexDirection: "column", gap: 3, paddingLeft: 12 }}>
                            {l.produtos.map(p => (
                              <div key={p.url} style={{ display: "flex", gap: 10, alignItems: "baseline", fontSize: 11, minWidth: 0 }}>
                                <span style={{ color: "var(--color-text-secondary)", minWidth: 90 }}>{ORIGEM[p.origem] || p.origem}</span>
                                <a href={p.url} target="_blank" rel="noreferrer" style={{ flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                  {p.name || p.url}
                                </a>
                                <span style={{ whiteSpace: "nowrap" }}>{brl(p.price)}</span>
                                <span style={{ color: "var(--color-text-secondary)", whiteSpace: "nowrap" }}>{dia(p.quando)}</span>
                              </div>
                            ))}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {previa && (
        <Modal title={previa.tipo === "vencidos" ? "Apagar os cupons com palavra vencidos?" : "Apagar as palavras não achadas?"} onClose={() => setPrevia(null)} danger>
          <p style={{ fontSize: 13, marginBottom: 16, color: "var(--color-text-secondary)", lineHeight: 1.5 }}>
            {previa.tipo === "naoAchados" && <>São as palavras em que o “Buscar condições” rodou e o cupom não apareceu no checkout. </>}
            Vão sair <b>{previa.palavras}</b> palavra(s) do dicionário e <b>{previa.cupons}</b> cupom(ns),
            mais <b>{previa.produtos}</b> produto(s) do catálogo que só vinham da vitrine deles
            {previa.produtosMantidos ? <> ({previa.produtosMantidos} ficam, por terem outra origem)</> : null}.
            Esta ação não pode ser desfeita.
          </p>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button onClick={() => setPrevia(null)} style={botaoSecundario}>Cancelar</button>
            <button
              onClick={limpar}
              disabled={!previa.cupons && !previa.palavras}
              style={{ padding: "8px 16px", borderRadius: 8, background: "#E24B4A", color: "#fff", border: "none", fontSize: 13, fontWeight: 500, cursor: "pointer" }}
            >{previa.tipo === "vencidos" ? "Apagar vencidos" : "Apagar não achados"}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
