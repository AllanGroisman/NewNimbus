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
import { Fragment, useState, useEffect, useCallback, useRef } from "react";
import { PRIMARY, PRIMARY_DARK } from "../data/constants";
import {
  adminMlCupons, adminMlCuponsStatus, adminMlCuponsRun, adminMlCuponsCancel,
  adminMlCuponsSaveConfig, adminMlCuponsProducts, adminMlCuponsSyncProducts,
  adminMlCuponsTestWord, adminMlCuponsCodes, adminMlCuponsClearAll,
  adminMlCuponsImportCampaign, adminMlCuponsImportStatus, adminMlCuponsImportVitrine, errText,
} from "../data/api";
import { coletorPronto, raparVitrine } from "../data/coletor";
import Modal from "../components/ui/Modal";

// Entre uma vitrine e a próxima, no lote. Dez listagens seguidas sem respiro é o
// padrão que faz o ML pedir verificação — e a sessão aqui é a do próprio admin.
const PAUSA_ENTRE_VITRINES_MS = 4000;

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
  // Não é veredito sobre a palavra: é o ML que não respondeu ("Tivemos um problema").
  // Dizer "não reconheceu" aqui era mostrar o oposto da verdade.
  indeterminado: { label: "❓ o ML não respondeu", color: "var(--warn-text)" },
};

export default function CuponsDoML() {
  const [status, setStatus] = useState(null);
  const [lista, setLista] = useState({ items: [], total: 0, page: 1, pageSize: 50 });
  const [filtros, setFiltros] = useState({ q: "", scope: "", onlyValid: true, page: 1 });
  const [erro, setErro] = useState(null);
  const [aberto, setAberto] = useState(null);        // campaignId com os produtos à mostra
  // A extensão que colhe a vitrine no Chrome do próprio admin (extension/ na raiz).
  // `null` enquanto não se sabe: o botão fica quieto em vez de piscar de cinza a
  // ativo na montagem.
  const [temColetor, setTemColetor] = useState(null);
  const [colhendo, setColhendo] = useState(null);    // campaignId sendo colhido
  const [colhendoTodas, setColhendoTodas] = useState(false);
  // `ref` e não `state`: o laço do lote precisa ler o valor ATUAL a cada volta, e
  // um state ficaria congelado na closure em que o laço começou.
  const pararRef = useRef(false);
  const [progresso, setProgresso] = useState(null);  // texto do andamento
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

  useEffect(() => { coletorPronto().then(setTemColetor); }, []);

  // Raspar a vitrine na aba do próprio Chrome. O caminho existe porque a vitrine
  // do cupom responde CAPTCHA para navegador automatizado — na aba do admin, com
  // a sessão dele, é só uma página. Ver extension/README.md.
  // Colhe UM cupom. Devolve o que aconteceu em vez de mexer no `erro` da tela,
  // porque quem chama em lote precisa decidir se para ou segue — e um `setErro`
  // por cupom apagaria o anterior.
  const colherUm = async (c, prefixo = "") => {
    setColhendo(c.campaignId);
    setProgresso(`${prefixo}abrindo a vitrine numa aba…`);
    // Muro visto durante ESTE cupom. A extensão traz a aba para a frente e espera
    // o humano, então o cupom ainda pode dar certo — mas a sessão já foi
    // questionada, e é isso que o lote precisa saber.
    let viuMuro = false;
    try {
      const r = await raparVitrine(c.containerUrl, {
        onProgresso: (p) => {
          if (p.tipo === "muro") viuMuro = true;
          setProgresso(prefixo + (p.tipo === "muro"
            // O único momento em que a aba vem para a frente: a decisão é do humano.
            ? "o Mercado Livre pediu verificação — resolva na aba que abriu"
            : `página ${p.pagina} · ${p.produtos} produto(s)`));
        },
      });
      if (!r.produtos.length) return { ok: false, muro: viuMuro, vazia: true, motivo: r.motivo || null };
      setProgresso(`${prefixo}gravando…`);
      const salvo = await adminMlCuponsImportVitrine(c.campaignId, { products: r.produtos, parcial: r.parcial });
      setProdutos(p => ({ ...p, [c.campaignId]: undefined }));
      return { ok: true, muro: viuMuro, produtos: salvo.produtos, parcial: r.parcial };
    } catch (err) {
      return { ok: false, muro: viuMuro, motivo: errText(err, "Não deu pra colher a vitrine desse cupom.") };
    } finally {
      setColhendo(null);
    }
  };

  const colher = async (c) => {
    setErro(null);
    const r = await colherUm(c);
    if (!r.ok) {
      setErro(r.vazia
        ? `A vitrine não devolveu produto nenhum${r.motivo ? ` (${r.motivo})` : ""}.`
        : r.motivo);
      setProgresso(null);
      return;
    }
    setAberto(null);
    recarregar();
    setProgresso(`✅ ${r.produtos} produto(s)${r.parcial ? " — parcial, a vitrine não veio inteira" : ""}`);
  };

  // Todas as vitrines, uma atrás da outra, nas abas deste Chrome.
  //
  // Sequencial de propósito: a extensão abre uma aba por vez, e paralelizar aqui
  // só serviria para o ML ver dez listagens simultâneas da mesma conta. Entre um
  // cupom e outro entra uma pausa pelo mesmo motivo.
  const colherTodas = async () => {
    const alvos = lista.items.filter(c => c.containerUrl);
    if (!alvos.length) return;
    pararRef.current = false;
    setColhendoTodas(true);
    setErro(null);
    let ok = 0, falhas = 0, parado = null;
    for (let i = 0; i < alvos.length; i++) {
      if (pararRef.current) { parado = "Interrompido por você"; break; }
      const c = alvos[i];
      const r = await colherUm(c, `${i + 1}/${alvos.length} · `);
      if (r.ok) ok++; else falhas++;
      // Muro é estado da SESSÃO, não deste cupom: seguir para o próximo é pedir
      // para o ML olhar com mais atenção ainda. Para-se depois de terminar este,
      // porque o humano pode já ter resolvido a verificação no meio dele.
      if (r.muro) { parado = "O Mercado Livre pediu verificação — parei aqui de propósito"; break; }
      if (i < alvos.length - 1) await new Promise(res => setTimeout(res, PAUSA_ENTRE_VITRINES_MS));
    }
    setColhendoTodas(false);
    setAberto(null);
    recarregar();
    setProgresso(`${parado ? `⏸ ${parado}. ` : "✅ "}${ok} vitrine(s) colhida(s)${falhas ? `, ${falhas} sem produto` : ""}.`);
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
  // Quantos cupons DESTA página têm vitrine para abrir. É da página mesmo, não do
  // total guardado: o lote percorre o que está na tela, e prometer um número que
  // ele não vai percorrer seria mentira.
  const comVitrine = lista.items.filter(c => c.containerUrl).length;

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
            {/* Quanto do número acima é prévia (landing ou miniaturas do card) e
                não vitrine fechada. Fica ao lado de propósito: sem ele, "3.000
                vínculos" parece cobertura que o sistema não tem. */}
            <Numero label="…destes, parciais" valor={s.parciais ?? 0} />
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
          {/* O lote das vitrines. Fica desligado durante a rodada do servidor de
              propósito: as duas usam a MESMA conta do ML, uma pelo navegador do
              servidor e outra pelo seu, e somar as duas é dobrar a pressão sobre
              a sessão sem ninguém pedir. */}
          {temColetor && comVitrine > 0 && (
            colhendoTodas ? (
              <button onClick={() => { pararRef.current = true; }} style={botaoSecundario}>
                Parar a colheita
              </button>
            ) : (
              <button
                onClick={colherTodas}
                disabled={rodando || !!colhendo}
                style={botaoSecundario}
                title={rodando
                  ? "Espere a rodada do servidor terminar — as duas usam a mesma conta do ML."
                  : `Abre a vitrine de ${comVitrine} cupom(ns), uma aba por vez, neste Chrome. Demora alguns minutos.`}
              >
                Colher todas as vitrines ({comVitrine})
              </button>
            )
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
            {status.lastResult && ` · ${status.lastResult.cupons} cupons (${status.lastResult.novos} novos)${status.lastResult.ativados ? `, ${status.lastResult.ativados} ativados` : ""}, ${status.lastResult.vinculos} vínculos, ${status.lastResult.catalogoCarimbado} produtos do catálogo carimbados`}
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

        {progresso && (
          <div style={{ marginBottom: 10, fontSize: 12, color: "var(--color-text-secondary)" }}>
            {colhendo ? "⟳ " : ""}{progresso}
          </div>
        )}

        {/* Sem a extensão o botão "no meu Chrome" some — e sumir sem explicação é
            pior do que não existir. Esta linha diz onde ele foi parar. */}
        {temColetor === false && (
          <div style={{ marginBottom: 10, fontSize: 11, color: "var(--color-text-secondary)" }}>
            O “raspar” abre o navegador no servidor, e o Mercado Livre barra ele com CAPTCHA. Para colher a
            vitrine numa aba <b>deste</b> Chrome, instale a extensão da pasta <code>extension/</code> do
            projeto (chrome://extensions › modo do desenvolvedor › “Carregar sem compactação”) e recarregue
            esta página. Se já instalou e o botão não veio, o endereço desta página —{" "}
            <code>{typeof window !== "undefined" ? window.location.origin : ""}</code> — precisa estar em{" "}
            <code>content_scripts.matches</code> do <code>extension/manifest.json</code>; depois de mexer,
            recarregue a extensão (↻) e esta página.
          </div>
        )}

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
                          {c.containerUrl && temColetor && (
                            <button onClick={() => colher(c)} disabled={!!colhendo} style={botaoLink}>
                              {colhendo === c.campaignId ? "⟳ colhendo" : "no meu Chrome"}
                            </button>
                          )}
                          {c.containerUrl ? (
                            <a href={c.containerUrl} target="_blank" rel="noreferrer" style={{ ...botaoLink, textDecoration: "none" }}>ML ↗</a>
                          ) : (
                            // Sem containerUrl não há vitrine para abrir: o ML só
                            // revela a URL dela depois do "Eu quero". O link vai
                            // para a lista de cupons da conta, e NÃO para este
                            // cupom — porque cupom não ativado não tem página
                            // própria no ML. O texto diz isso, senão parece que o
                            // sistema errou o endereço.
                            <a
                              href="https://www.mercadolivre.com.br/cupons"
                              target="_blank"
                              rel="noreferrer"
                              title={'Este cupom ainda não foi ativado, e cupom não ativado não tem página própria no ML — o link abre a lista dos seus cupons. A rodada ativa sozinha até o teto que você definiu; cupons cujo rótulo o ML repete entre campanhas diferentes ficam de fora, porque não dá para saber qual botão é qual.'}
                              style={{ ...botaoLink, textDecoration: "none", color: "var(--color-text-secondary)" }}
                            >meus cupons ↗</a>
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

// Os produtos de um cupom vêm de três lugares e valem coisas diferentes, então a
// tela não pode mostrar os três como se fossem a mesma coisa:
//
//   vitrine — a lista inteira, raspada da página do cupom (_Container_).
//   landing — a prévia de 3-8 itens que a landing de afiliado entrega sem abrir
//             navegador. É o que funciona hoje, com o muro anti-bot de pé.
//   amostra — as 4 miniaturas que o card do cupom mostra na aba /cupons, e o
//             ÚNICO vínculo possível do cupom não ativado.
//
// Quem olha esta lista precisa saber qual está vendo: "5 produtos" de prévia não
// quer dizer que o cupom cobre só 5.
const ORIGEM = {
  vitrine: "vitrine",
  landing: "prévia (landing)",
  amostra: "miniatura do card",
};
function Produtos({ dados }) {
  if (!dados) return <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>carregando…</span>;
  if (!dados.items.length) {
    return (
      <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
        Nenhum produto guardado para este cupom — clique em “raspar” para abrir a vitrine dele no ML.
      </span>
    );
  }
  const parciais = dados.items.filter(p => p.origem !== "vitrine").length;
  const soParcial = parciais === dados.items.length;
  return (
    <div>
      <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 6 }}>
        {dados.total} produto(s) neste cupom
        {soParcial
          ? " — só uma prévia; a vitrine completa dele ainda não foi raspada"
          : parciais ? ` (${parciais} de prévia, não da vitrine completa)` : ""}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {dados.items.map(p => (
          <div key={p.productKey} style={{ display: "flex", gap: 10, alignItems: "center", fontSize: 12 }}>
            {p.catalog?.img && <img src={p.catalog.img} alt="" width={34} height={34} style={{ objectFit: "contain", borderRadius: 6 }} />}
            <a href={p.productUrl} target="_blank" rel="noreferrer" style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "inherit" }}>
              {p.catalog?.name || p.productUrl}
            </a>
            <span style={{ color: "var(--color-text-secondary)" }}>{brl(p.catalog?.price)}</span>
            <span style={{ color: "var(--color-text-secondary)" }}>
              {ORIGEM[p.origem] || p.origem || "vitrine"}
            </span>
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
        <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 6, paddingBottom: 8 }}>
          <input type="checkbox" checked={cfg.activateCoupons !== false}
            onChange={e => setCfg(c => ({ ...c, activateCoupons: e.target.checked }))} />
          ativar os cupons automaticamente (“Eu quero”)
        </label>
        <div>
          <label style={labelStyle}>Ativações por rodada</label>
          <input type="number" min={0} max={100} value={cfg.maxActivationsPerRun ?? 20}
            onChange={e => setCfg(c => ({ ...c, maxActivationsPerRun: Number(e.target.value) }))} style={{ ...inputStyle, width: 110 }} />
        </div>
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
      <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 8 }}>
        <b>Ativar é ESCRITA na sua conta do Mercado Livre</b> — é o mesmo “Eu quero” que você
        clicaria à mão, e não há como desfazer por aqui. É também a única forma de o cupom ter
        vitrine: sem ativar, o ML não diz quais produtos ele cobre. A conta é a mesma do Hub de
        Afiliados, então a rodada ativa poucos por vez, com pausa, e para no primeiro pedido de
        verificação. O número acima é o teto por rodada.
      </div>
    </details>
  );
}

// Onde a busca de uma campanha está agora. As etapas vêm do `crawlFilter` e do
// `findCampaign` — a mesma redação da barra da rodada, lá em cima.
function textoProgresso(p) {
  if (!p) return "começando...";
  if (p.etapa === "abrindo") return "abrindo a página de cupons do ML...";
  if (p.etapa === "ativando") return `ativando ${p.title || "o cupom"} na conta do ML...`;
  if (p.etapa === "vitrine") return `lendo a vitrine de ${p.title || "cupom"}...`;
  if (p.etapa === "cupons") return `procurando na lista — página ${p.pagina}${p.de ? `/${p.de}` : ""}, ${p.cupons} cupons vistos`;
  return "procurando...";
}

// O convite pra trazer a campanha que a palavra apontou.
//
// O ML só responde o ID da campanha; se ela nunca foi raspada, não existe linha
// nenhuma aqui e a resposta fica sendo um número solto. Este modal é o atalho que
// evita rodar a coleta inteira só pra descobrir o que aquele número é.
// A busca roda SOLTA no servidor (varrer a lista do ML passa dos 90s do nginx), então
// o botão só dispara e este modal acompanha pelo status — mesmo desenho do "Puxar
// cupons agora" lá em cima.
function ImportarCampanhaModal({ campaignId, word, onClose, onDone }) {
  const [comProdutos, setComProdutos] = useState(true);
  const [enviando, setEnviando] = useState(false);
  const [rodando, setRodando] = useState(false);
  const [progresso, setProgresso] = useState(null);
  const [feito, setFeito] = useState(null);
  const [erro, setErro] = useState(null);

  const fechar = () => {
    if (feito) onDone?.(feito);
    onClose();
  };

  const buscar = async () => {
    setEnviando(true); setErro(null); setProgresso(null);
    try {
      const r = await adminMlCuponsImportCampaign(campaignId, comProdutos);
      // Já estava no sistema: desfecho na hora, sem acompanhar nada. Só entra no
      // modo "acompanhando" quando existe de fato uma busca correndo lá.
      if (r.already) setFeito(r);
      else setRodando(true);
    } catch (err) {
      setErro(errText(err, "Não deu pra começar a busca dessa campanha."));
    } finally {
      setEnviando(false);
    }
  };

  // Acompanha enquanto a busca corre. O `vivo` evita gravar depois que o modal
  // fechou — a busca dura minutos e a tela pode sair antes.
  useEffect(() => {
    if (!rodando || feito) return undefined;
    let vivo = true;
    const ler = async () => {
      try {
        const s = await adminMlCuponsImportStatus();
        if (!vivo) return;
        setProgresso(s.progress || null);
        if (s.running) return;
        if (s.error) setErro(s.error);
        else if (s.result?.ok) setFeito(s.result);
        else if (s.result) setErro(s.result.reason || "O ML não devolveu essa campanha.");
        setRodando(false);
      } catch { /* uma leitura que falhou não derruba o acompanhamento */ }
    };
    const id = setInterval(ler, 3000);
    ler();
    return () => { vivo = false; clearInterval(id); };
  }, [rodando, feito]);

  return (
    <Modal title="Essa campanha não está no sistema" onClose={fechar}>
      <div style={{ fontSize: 13, lineHeight: 1.6, marginBottom: 14 }}>
        O ML reconheceu {word ? <>a palavra <code>{word}</code> e </> : null}disse que ela é da campanha{" "}
        <code>{campaignId}</code> — mas esse cupom nunca foi raspado, então não sabemos o título dele,
        o desconto nem quais produtos ele cobre. Dá pra ir buscar essa campanha agora, sem rodar a
        coleta inteira.
      </div>

      {!feito && (
        <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 12, marginBottom: 16, cursor: (enviando || rodando) ? "default" : "pointer" }}>
          <input
            type="checkbox"
            checked={comProdutos}
            disabled={enviando || rodando}
            onChange={e => setComProdutos(e.target.checked)}
            style={{ marginTop: 2 }}
          />
          <span>
            Trazer também os produtos da vitrine
            <span style={{ display: "block", color: "var(--color-text-secondary)" }}>
              Sem isto a campanha entra sem lista de produtos — dá pra puxar depois no
              “Sincronizar produtos” da linha dela na tabela.
            </span>
          </span>
        </label>
      )}

      {rodando && (
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 14, lineHeight: 1.6 }}>
          ⟳ {textoProgresso(progresso)}
          <div style={{ marginTop: 4 }}>
            Pode fechar esta janela — a busca continua no servidor e o cupom aparece na tabela
            quando terminar.
          </div>
        </div>
      )}

      {erro && <div style={{ fontSize: 12, color: "var(--danger-text)", marginBottom: 14 }}>{erro}</div>}

      {feito && (
        <div style={{ fontSize: 13, marginBottom: 14 }}>
          {feito.already
            ? <>Essa campanha já estava no sistema: <b>{feito.coupon?.title || campaignId}</b>.</>
            : <>✅ <b>{feito.coupon?.title || campaignId}</b> adicionada · {feito.produtos} produto{feito.produtos === 1 ? "" : "s"}.</>}
          {feito.avisoVitrine && (
            <div style={{ color: "var(--color-text-secondary)", fontSize: 12, marginTop: 6 }}>
              Os produtos não vieram: {feito.avisoVitrine}
            </div>
          )}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        {feito ? (
          <button onClick={fechar} style={botaoPrimario(false)}>Fechar</button>
        ) : (
          <>
            <button onClick={fechar} style={botaoSecundario}>
              {rodando ? "Fechar (a busca continua)" : "Agora não"}
            </button>
            <button onClick={buscar} disabled={enviando || rodando} style={botaoPrimario(enviando || rodando)}>
              {enviando || rodando ? "procurando..." : "Buscar e adicionar"}
            </button>
          </>
        )}
      </div>
    </Modal>
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
  const [importar, setImportar] = useState(null);

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

  const testar = async (force = false) => {
    if (!word.trim()) return;
    setRodando(true); setErro(null); setRes(null);
    try {
      const r = await adminMlCuponsTestWord(word.trim().toUpperCase(), force);
      setRes(r.result);
      carregar();
      onDone?.();
      // A palavra existe, o ML disse de que campanha ela é — e a campanha não está
      // aqui. Vale também pra resposta vinda do cache: ele guarda o veredito da
      // palavra, não diz nada sobre a campanha ter entrado no sistema desde então.
      if (r.result?.verdict === "valid" && r.result.campaignId && !r.result.coupon) {
        setImportar({ campaignId: r.result.campaignId, word: r.result.word });
      }
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
        <button onClick={() => testar()} disabled={rodando || !word.trim()} style={botaoPrimario(rodando || !word.trim())}>
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
          {res.knownLocally && (
            <div style={{ color: "var(--color-text-secondary)", fontSize: 12, marginTop: 4 }}>
              Quem sabe dessa campanha é o sistema, não o ML: a palavra já está carimbada nela por um teste anterior.
            </div>
          )}
          {res.verdict === "indeterminado" && (
            <div style={{ marginTop: 8, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <button onClick={() => testar(true)} disabled={rodando} style={botaoLink}>⟳ testar de novo</button>
              <span style={{ color: "var(--color-text-secondary)", fontSize: 11, flex: "1 1 260px" }}>
                Isso costuma acontecer com cupom que a conta do sistema já aceitou (“Eu quero” dado):
                o ML engasga ao ver o código de novo em vez de responder a que campanha ele é.
              </span>
            </div>
          )}
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
                {h.campaignId && h.inSystem === false && (
                  <button onClick={() => setImportar({ campaignId: h.campaignId, word: h.code })} style={botaoLink}>
                    ＋ adicionar
                  </button>
                )}
                <span style={{ color: "var(--color-text-secondary)", flex: "1 1 200px", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {h.message || "—"}
                </span>
                <span style={{ color: "var(--color-text-secondary)" }}>{new Date(h.checkedAt).toLocaleDateString("pt-BR")}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {importar && (
        <ImportarCampanhaModal
          campaignId={importar.campaignId}
          word={importar.word}
          onClose={() => setImportar(null)}
          onDone={(feito) => {
            carregar();
            onDone?.();
            // A campanha entrou: a linha do resultado acima passa a ter título em vez
            // de só o número, sem precisar testar a palavra de novo (que é um Chrome).
            if (feito?.coupon) {
              setRes(atual => (atual && atual.campaignId === feito.coupon.campaignId ? { ...atual, coupon: feito.coupon } : atual));
            }
          }}
        />
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
