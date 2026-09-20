import { useState, useEffect } from "react";
import { PRIMARY_DARK } from "../data/constants";
import { adminProdutoCupons, adminSondaCheckoutCupons, errText } from "../data/api";
import { coletorEntende, sondarCuponsNoCheckout } from "../data/coletor";
import { cardStyle, inputStyle, labelStyle, botaoSecundario, botaoPrimario, th, td } from "../components/admin/cupomEstilos";

// Admin › Cupom › Cupons do produto: "quais cupons valem NESTE produto?" (task 12, D).
//
// Duas metades, e só a primeira responde hoje:
//
//   - o que o sistema JÁ SABE, sem rede (backend/coupons/product-coupons.js): cada
//     cupom cuja vitrine trouxe este produto, com a ORIGEM do vínculo — prévia,
//     miniatura do card ou vitrine completa não são a mesma garantia;
//   - a SONDA no checkout, no Chrome do admin: leva o produto até a tela dos cupons e
//     fotografa, sem digitar nada. É o primeiro passo para o teste produto a produto —
//     a tela de cupons do checkout nunca foi conferida, e o parser só é escrito
//     depois de alguém olhar o que a sonda trouxe.

const brl = (v) => (Number.isFinite(Number(v)) ? `R$ ${Number(v).toFixed(2).replace(".", ",")}` : "—");
const dataCurta = (v) => (v ? new Date(v).toLocaleDateString("pt-BR") : "sem validade");

function descreverPasso(p) {
  if (!p) return null;
  if (p.tipo === "muro") return "o Mercado Livre pediu verificação — resolva na aba que abriu";
  if (p.tipo === "pdp") return "página do produto lida";
  if (p.tipo === "checkout") return `indo ao checkout (${p.via})…`;
  if (p.tipo === "passo") return `checkout · passo ${p.passo}${p.titulo ? `: ${p.titulo}` : ""}`;
  if (p.tipo === "seguro") return p.como ? "oferta de seguro recusada (“Agora não”)" : "apareceu a oferta de seguro e não deu pra recusar";
  if (p.tipo === "pagina-cupons") return p.ok ? "lista de cupons do checkout lida" : "não achei a lista de cupons na página do checkout";
  if (p.tipo === "capturado") return "tela dos cupons fotografada — mandando pro servidor…";
  return null;
}

// O material da sonda pode passar dos 2 MB que o servidor aceita. O que se joga fora
// primeiro é o HTML (o texto e as respostas da API bastam pra começar a olhar).
function caberNoPedido(material) {
  const LIMITE = 1_800_000;
  const cabe = (m) => JSON.stringify(m).length <= LIMITE;
  if (cabe(material)) return material;
  const m = { ...material };
  // Ordem do descarte: o HTML da página ao entrar (o texto dela basta), depois o do
  // popup, e só por último o da lista dos ativos — que é o que mais importa.
  // `paginaDosCupons` nunca entra no descarte: é ela que responde a pergunta.
  for (const chave of ["capturaNaParada", "capturaAoEntrar", "capturaDosCupons", "capturaDosAtivos"]) {
    if (m[chave]?.html) m[chave] = { ...m[chave], html: "", htmlDescartado: true };
    if (cabe(m)) return m;
    if (m[chave]?.iframes?.some(f => f.html)) {
      m[chave] = { ...m[chave], iframes: m[chave].iframes.map(f => ({ ...f, html: "" })) };
      if (cabe(m)) return m;
    }
  }
  for (const chave of ["capturaNaParada", "capturaAoEntrar", "capturaDosCupons", "capturaDosAtivos"]) {
    if (m[chave]?.respostas) m[chave] = { ...m[chave], respostas: m[chave].respostas.slice(-3) };
  }
  return m;
}

function TabelaDeCupons({ cupons }) {
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
      <thead>
        <tr style={{ textAlign: "left", color: "var(--color-text-secondary)" }}>
          <th style={th}>Cupom</th>
          <th style={th}>Desconto</th>
          <th style={th}>Neste preço</th>
          <th style={th}>Palavra</th>
          <th style={th}>Validade</th>
          <th style={th}>Como o sistema sabe</th>
        </tr>
      </thead>
      <tbody>
        {cupons.map(c => (
          <tr key={c.campaignId} style={{ borderTop: "0.5px solid var(--color-border-tertiary)" }}>
            <td style={td}>
              <div>{c.title || c.campaignId}</div>
              <div style={{ fontSize: 10, color: "var(--color-text-secondary)" }}>
                campanha {c.campaignId}{c.scope === "store" && c.sellerName ? ` · loja ${c.sellerName}` : ""}
              </div>
            </td>
            <td style={td}>
              {c.kind === "percent" ? `${c.value}%` : brl(c.value)}
              {c.minPurchase ? <div style={{ fontSize: 10, color: "var(--color-text-secondary)" }}>mín. {brl(c.minPurchase)}</div> : null}
            </td>
            <td style={td}>
              {c.priceWithCoupon != null
                ? <span style={{ color: PRIMARY_DARK, fontWeight: 500 }}>{brl(c.priceWithCoupon)} <span style={{ fontWeight: 400 }}>(−{brl(c.economia)})</span></span>
                : <span style={{ color: "var(--color-text-secondary)" }}>não vale neste preço</span>}
            </td>
            <td style={td}>{c.code || <span style={{ color: "var(--color-text-secondary)" }}>sem palavra (cupom de ativação)</span>}</td>
            <td style={td}>{dataCurta(c.expiresAt)}</td>
            <td style={td}>{c.origemRotulo}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function CuponsDoProduto() {
  const [url, setUrl] = useState("");
  const [resp, setResp] = useState(null);
  const [buscando, setBuscando] = useState(false);
  const [erro, setErro] = useState(null);

  const [temSonda, setTemSonda] = useState(false);
  const [sondando, setSondando] = useState(false);
  const [passo, setPasso] = useState(null);
  const [sonda, setSonda] = useState(null);

  useEffect(() => {
    let vivo = true;
    coletorEntende("cupons-checkout").then(ok => { if (vivo) setTemSonda(!!ok); }).catch(() => {});
    return () => { vivo = false; };
  }, []);

  async function buscar() {
    if (!url.trim()) return;
    setBuscando(true);
    setErro(null);
    setSonda(null);
    try {
      setResp(await adminProdutoCupons({ url: url.trim() }));
    } catch (err) {
      setResp(null);
      setErro(errText(err, "Não foi possível consultar os cupons do produto."));
    } finally {
      setBuscando(false);
    }
  }

  async function sondar() {
    setSondando(true);
    setErro(null);
    setSonda(null);
    try {
      const material = await sondarCuponsNoCheckout(url.trim(), { onProgresso: (p) => setPasso(descreverPasso(p)) });
      setSonda(await adminSondaCheckoutCupons({ url: url.trim(), material: caberNoPedido(material) }));
    } catch (err) {
      setErro(errText(err, "A sonda não terminou."));
    } finally {
      setSondando(false);
      setPasso(null);
    }
  }

  return (
    <div>
      <div style={cardStyle}>
        <div style={{ fontWeight: 500, marginBottom: 4 }}>Quais cupons valem neste produto?</div>
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 12, lineHeight: 1.5 }}>
          Responde na hora pelo que o sistema já sabe: os cupons cuja vitrine trouxe este produto.
          Um produto <b>sem</b> cupom aqui pode ter cupom — quer dizer só que nenhuma vitrine lida
          até agora o trouxe. A varredura em <i>Cupons do ML</i> é o que aumenta essa cobertura.
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap", maxWidth: 760 }}>
          <div style={{ flex: 1, minWidth: 260 }}>
            <label style={labelStyle} htmlFor="produto-cupons-url">Link do produto (Mercado Livre)</label>
            <input
              id="produto-cupons-url"
              type="url"
              value={url}
              onChange={e => setUrl(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") buscar(); }}
              placeholder="https://www.mercadolivre.com.br/…/p/MLB…"
              style={{ ...inputStyle, width: "100%" }}
            />
          </div>
          <button onClick={buscar} disabled={buscando || !url.trim()} style={botaoPrimario(buscando || !url.trim())}>
            {buscando ? "Buscando..." : "Ver cupons"}
          </button>
        </div>

        {erro && <div style={{ fontSize: 12, color: "var(--danger-text)", marginTop: 10 }}>{erro}</div>}

        {resp && (
          <div style={{ marginTop: 16 }}>
            {resp.produto ? (
              <div style={{ fontSize: 13, marginBottom: 10 }}>
                <b>{resp.produto.name}</b> · {brl(resp.produto.price)}
              </div>
            ) : (
              <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 10 }}>
                Este produto não está no catálogo — sem preço, não dá pra calcular quanto o cupom tira.
              </div>
            )}
            {resp.semVinculo ? (
              <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
                Nenhuma vitrine lida até agora trouxe este produto. Isso <b>não</b> quer dizer que nenhum
                cupom vale nele.
              </div>
            ) : (
              <TabelaDeCupons cupons={resp.cupons} />
            )}
          </div>
        )}
      </div>

      <div style={cardStyle}>
        <div style={{ fontWeight: 500, marginBottom: 4 }}>Sonda: os cupons que o checkout oferece</div>
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 12, lineHeight: 1.5 }}>
          Leva o produto até a tela dos cupons no <b>seu Chrome</b> (a extensão) e fotografa o que o
          Mercado Livre lista ali, sem digitar nem clicar em cupom nenhum. <b>A compra nunca é
          finalizada</b> e, se o caminho passar pelo carrinho, o item sai de lá no fim. O resultado fica
          guardado no servidor para servir de base ao teste automático produto a produto.
        </div>
        {!temSonda ? (
          <div style={{ fontSize: 12, color: "var(--warn-text)" }}>
            A extensão instalada não tem a sonda (precisa da versão 2.2.5 — recarregue a pasta <code>extension/</code> em chrome://extensions).
          </div>
        ) : (
          <button onClick={sondar} disabled={sondando || !url.trim()} style={{ ...botaoSecundario, borderColor: PRIMARY_DARK, color: PRIMARY_DARK }}>
            {sondando ? "⟳ sondando..." : "Sondar o checkout deste produto"}
          </button>
        )}
        {passo && <div style={{ fontSize: 12, color: PRIMARY_DARK, marginTop: 8 }}>{passo}</div>}
        {sonda && (
          <div style={{ fontSize: 12, marginTop: 10, lineHeight: 1.6 }}>
            <div>Guardado em <code>backend/{sonda.pasta}</code></div>
            {sonda.resumo.checkout?.ok && (
              <div style={{ margin: "6px 0 8px" }}>
                {sonda.resumo.checkout.cupons.length ? sonda.resumo.checkout.cupons.map(c => (
                  <div key={c.campaignId} style={{ color: c.aplicado ? PRIMARY_DARK : "var(--color-text-primary)" }}>
                    🎟️ <b>{c.titulo || c.campaignId}</b>
                    {c.aplicado ? " — aplicado pelo ML" : ""}
                    {c.descontoNoCarrinho != null ? ` · −${brl(c.descontoNoCarrinho)} neste carrinho` : ""}
                    {c.minPurchase ? ` · mín. ${brl(c.minPurchase)}` : ""}
                    {c.maxDiscount ? ` · limite ${brl(c.maxDiscount)}` : ""}
                    <span style={{ fontSize: 10, color: "var(--color-text-secondary)" }}> · campanha {c.campaignId}</span>
                  </div>
                )) : <div>O checkout não listou cupom nenhum para este produto.</div>}
                {sonda.resumo.checkout.gravado && (
                  <div style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>
                    Gravado: o produto passa a carregar {sonda.resumo.checkout.valem.length} cupom(ns) com origem “checkout”
                    {sonda.resumo.checkout.gravado.cuponsNovos ? ` (${sonda.resumo.checkout.gravado.cuponsNovos} cupom(ns) novo(s) no sistema)` : ""}.
                  </div>
                )}
              </div>
            )}
            {(sonda.resumo.chegouNosCupons || sonda.resumo.leuPaginaDosCupons) && sonda.resumo.checkout && !sonda.resumo.checkout.ok && (
              <div style={{ color: "var(--warn-text)" }}>{sonda.resumo.checkout.motivo}</div>
            )}
            {sonda.resumo.cupomAplicado && (
              <div style={{ color: PRIMARY_DARK, fontWeight: 500 }}>
                O ML aplicou sozinho {sonda.resumo.cupomAplicado.emUso} de {sonda.resumo.cupomAplicado.disponiveis} cupom(ns)
                {sonda.resumo.cupomAplicado.desconto != null ? ` — ${brl(sonda.resumo.cupomAplicado.desconto)} de desconto` : ""}
              </div>
            )}
            <div>
              {sonda.resumo.leuPaginaDosCupons || sonda.resumo.chegouNosCupons
                ? <span style={{ color: PRIMARY_DARK }}>
                    {sonda.resumo.leuPaginaDosCupons ? "leu a lista de cupons do checkout" : "chegou na tela dos cupons"}
                  </span>
                : <span style={{ color: "var(--warn-text)" }}>não leu a lista de cupons{sonda.resumo.motivo ? ` — ${sonda.resumo.motivo}` : ""}</span>}
              {sonda.resumo.seguro?.como ? " · recusou a oferta de seguro" : ""}
              {sonda.resumo.chegouNosCupons && !sonda.resumo.leuIframe ? " · o conteúdo do popup (iframe) não carregou" : ""}
              {sonda.resumo.chegouNosCupons ? (sonda.resumo.viuAtivos ? " · abriu a lista dos cupons ativos" : " · não achou o “ver cupons ativos”") : ""}
              {` · ${sonda.resumo.respostasDeApi} resposta(s) da API de cupom`}
              {sonda.resumo.muro ? ` · muro: ${sonda.resumo.muro}` : ""}
              {sonda.resumo.paradaEm && (
                <div style={{ color: "var(--warn-text)" }}>
                  Parou antes do checkout em <code>{sonda.resumo.paradaEm.slice(0, 90)}</code> — a página foi guardada em <code>parada.html</code>.
                </div>
              )}
              {sonda.resumo.seguro && !sonda.resumo.seguro.como && (
                <div style={{ color: "var(--warn-text)" }}>
                  Parou na oferta de seguro: {sonda.resumo.seguro.voltouProSeguro
                    ? "o ML voltou pra ela mesmo indo direto ao checkout"
                    : "não achou o “Agora não”"}
                  {sonda.resumo.seguro.rotulos?.length ? ` — botões na tela: ${sonda.resumo.seguro.rotulos.join(" · ")}` : ""}
                </div>
              )}
              {sonda.resumo.carrinhoLimpo === false ? " · ATENÇÃO: o item pode ter ficado no carrinho" : ""}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
