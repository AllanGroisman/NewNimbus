// A fila do teste de cupom no checkout (task 7), à mostra na aba Repasse.
//
// Até aqui ela só existia no servidor (repasse/coupon-autotest.js:pendentesCheckout)
// e o admin via os cupons dela apenas como "⏳ nunca testado" na lista de baixo.
// Aqui ela aparece inteira — código, link e de onde veio — com:
//   - o "Testar automaticamente": a aba pega sozinha o primeiro da fila a cada 30s;
//   - o Testar de cada item e o "Testar todos", que anda a fila um a um (com Parar);
//   - o "+ Adicionar teste", para testar um código num link escolhido à mão.
//
// Tudo passa pelo mesmo `emSerie` da página: o checkout é um só por conta do ML, e
// dois testes ao mesmo tempo se atropelariam.
import { useState, useEffect, useCallback, useRef } from "react";
import {
  adminRepasseCupomCheckoutPendentes, adminRepasseCupomCheckoutReivindicar,
  adminRepasseCupomCheckoutAuto, adminRepasseCupomCheckoutManual,
  adminRepasseCupomCheckoutManualRemover, errText,
} from "../../data/api";
import { testarNoCheckout } from "../../data/cupomCheckoutRepasse";
import Modal from "../ui/Modal";
import {
  cardStyle, inputStyle, labelStyle, th, td, botaoLink, botaoPrimario, botaoSecundario,
} from "./cupomEstilos";

export const FILA_INTERVALO_MS = 30000;
const LIMITE = 200;

const dataHora = (v) => (v ? new Date(v).toLocaleString("pt-BR") : "—");

// O link cabe numa célula: domínio + o pedaço final do caminho.
function linkCurto(url) {
  try {
    const u = new URL(url);
    const caminho = u.pathname.length > 38 ? `…${u.pathname.slice(-36)}` : u.pathname;
    return `${u.hostname.replace(/^www\./, "")}${caminho}`;
  } catch {
    return url;
  }
}

export default function FilaCheckoutRepasse({ temCheckout, emSerie, ocupadoRef, onTestado, onTestando }) {
  const [fila, setFila] = useState(null);
  const [erro, setErro] = useState(null);
  const [aviso, setAviso] = useState(null);
  const [testando, setTestando] = useState(null);
  // O último desfecho de cada código testado por aqui — o item some da fila
  // depois do teste, e sem isto o resultado sumiria junto.
  const [resultados, setResultados] = useState([]);
  const [lote, setLote] = useState(false);
  const [salvandoAuto, setSalvandoAuto] = useState(false);
  const [adicionando, setAdicionando] = useState(false);
  const pararRef = useRef(false);

  const carregar = useCallback(async () => {
    try {
      const r = await adminRepasseCupomCheckoutPendentes({ limit: LIMITE });
      setFila(r);
      setErro(null);
      return r;
    } catch (err) {
      setErro(errText(err, "Não deu pra carregar a fila."));
      return null;
    }
  }, []);

  // Um item: reivindica (outra aba pode estar nele), roda na extensão, grava.
  const testarItem = useCallback(async (item, source) => {
    try {
      await adminRepasseCupomCheckoutReivindicar(item.code);
    } catch (err) {
      if (err?.status === 409) { setAviso(`${item.code}: outra aba já está testando esse cupom.`); return null; }
      throw err;
    }
    setTestando(item.code);
    onTestando?.(item.code);
    try {
      const res = await emSerie(() => testarNoCheckout(item.code, item.url, { source, manualId: item.manualId || null }));
      onTestado?.(item.code, res);
      // A mensagem já diz "ligado ao produto"; a campanha nova só o vínculo sabe.
      const texto = `${res.message || res.verdict}${res.vinculo?.cuponsNovos ? " · campanha nova no sistema" : ""}`;
      setResultados(rs => [{ code: item.code, url: item.url, verdict: res.verdict, texto, em: new Date().toISOString() },
        ...rs.filter(r => r.code !== item.code)].slice(0, 20));
      setAviso(null);
      return res;
    } finally {
      setTestando(null);
      onTestando?.(null);
    }
  }, [emSerie, onTestado, onTestando]);

  // O laço automático. Lê o AGORA num ref: o efeito monta uma vez só.
  const agoraRef = useRef(null);
  useEffect(() => {
    agoraRef.current = { temCheckout, lote, testando, testarItem };
  });
  const olharRef = useRef(null);
  useEffect(() => {
    let vivo = true;
    let rodando = false;
    const olhar = async () => {
      if (rodando) return;
      rodando = true;
      try {
        const r = await carregar();
        const x = agoraRef.current;
        if (!vivo || !r?.auto || !x?.temCheckout || x.lote || x.testando || ocupadoRef.current > 0) return;
        const p = (r.itens || []).find(i => !i.reservado);
        if (!p) return;
        await x.testarItem(p, "repasse-checkout-auto");
        if (vivo) await carregar();
      } catch (err) {
        if (vivo) setAviso(errText(err, "A fila automática não conseguiu testar agora."));
      } finally {
        rodando = false;
      }
    };
    olharRef.current = olhar;
    olhar();
    const id = setInterval(olhar, FILA_INTERVALO_MS);
    return () => { vivo = false; clearInterval(id); olharRef.current = null; };
  }, [carregar, ocupadoRef]);
  // Assim que se sabe que a extensão está aí, a primeira volta não espera 30s.
  useEffect(() => { if (temCheckout) olharRef.current?.(); }, [temCheckout]);

  const testarUm = async (item) => {
    try {
      await testarItem(item, "repasse-checkout");
    } catch (err) {
      setAviso(errText(err, `Não deu pra testar ${item.code} agora.`));
    }
    await carregar();
  };

  // A fila inteira, na ordem, um de cada vez. Parar vale ENTRE itens: o que está
  // no meio do checkout termina (fechar a aba no meio deixaria o carrinho sujo).
  const testarTodos = async () => {
    pararRef.current = false;
    setLote(true);
    try {
      const alvo = (fila?.itens || []).filter(i => !i.reservado);
      for (const item of alvo) {
        if (pararRef.current) break;
        try {
          await testarItem(item, "repasse-checkout");
        } catch (err) {
          setAviso(errText(err, `Não deu pra testar ${item.code}.`));
        }
        await carregar();
      }
    } finally {
      setLote(false);
    }
  };

  const trocarAuto = async (v) => {
    setSalvandoAuto(true);
    setFila(f => f && { ...f, checkoutAuto: v, auto: v && !f.bloqueadoAte });
    try {
      await adminRepasseCupomCheckoutAuto(v);
    } catch (err) {
      setAviso(errText(err, "Não deu pra salvar."));
    } finally {
      setSalvandoAuto(false);
      await carregar();
    }
  };

  const remover = async (item) => {
    try {
      await adminRepasseCupomCheckoutManualRemover(item.manualId);
    } catch (err) {
      setAviso(errText(err, "Não deu pra tirar esse pedido da fila."));
    }
    await carregar();
  };

  const itens = fila?.itens || [];
  const semExtensao = temCheckout === false;

  return (
    <section style={cardStyle} aria-label="Fila do teste no checkout">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <div style={{ fontWeight: 500 }}>Fila do teste no checkout {fila && <span style={{ color: "var(--color-text-secondary)", fontWeight: 400 }}>({fila.total})</span>}</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <label style={{ fontSize: 12, display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={!!fila?.checkoutAuto}
              disabled={!fila || salvandoAuto}
              onChange={e => trocarAuto(e.target.checked)}
            />
            Testar automaticamente
          </label>
          {lote ? (
            <button onClick={() => { pararRef.current = true; }} style={botaoSecundario}>■ Parar</button>
          ) : (
            <button
              onClick={testarTodos}
              disabled={semExtensao || !temCheckout || !itens.length || !!testando}
              style={botaoPrimario(semExtensao || !temCheckout || !itens.length || !!testando)}
            >
              ▶ Testar todos ({itens.length})
            </button>
          )}
          <button onClick={() => setAdicionando(true)} style={botaoSecundario}>+ Adicionar teste</button>
        </div>
      </div>

      <div style={{ fontSize: 12, color: "var(--color-text-secondary)", margin: "6px 0 12px", lineHeight: 1.5 }}>
        Cada cupom é testado no checkout do link ao lado, numa aba do seu Chrome, pela extensão — sem
        nunca finalizar a compra. {fila?.checkoutAuto
          ? "Com o automático ligado, esta aba pega o primeiro da fila a cada 30s."
          : "O automático está desligado: a fila só anda pelos botões."}
        {lote && <b> Testando a fila inteira, um de cada vez… “Parar” vale depois do cupom atual.</b>}
      </div>

      {semExtensao && (
        <div style={{ fontSize: 12, color: "var(--warn-text)", marginBottom: 10 }}>
          ⚠️ A extensão “Nimbus — cupons no meu Chrome” não está instalada nesta aba, ou está desatualizada
          (precisa da 2.4.0). Sem ela nada da fila é testado.
        </div>
      )}
      {temCheckout === null && <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 10 }}>Procurando a extensão do Chrome…</div>}
      {fila?.bloqueadoAte && (
        <div style={{ fontSize: 12, color: "var(--warn-text)", marginBottom: 10 }}>
          🚧 O ML pediu verificação num teste automático. O automático volta em {dataHora(fila.bloqueadoAte)} — os botões continuam valendo.
        </div>
      )}
      {erro && <div style={{ fontSize: 12, color: "var(--danger-text)", marginBottom: 10 }}>{erro}</div>}
      {aviso && <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 10 }}>{aviso}</div>}

      {!fila ? (
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>Carregando a fila...</div>
      ) : itens.length === 0 ? (
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>Nenhum cupom esperando teste.</div>
      ) : (
        <div style={{ overflowX: "auto", maxHeight: 360, overflowY: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "var(--color-text-secondary)", borderBottom: "0.5px solid var(--color-border-tertiary)" }}>
                <th style={th}>Cupom</th>
                <th style={th}>Link do produto</th>
                <th style={th}>Origem</th>
                <th style={th}>Na fila desde</th>
                <th style={th}>Ações</th>
              </tr>
            </thead>
            <tbody>
              {itens.map(item => {
                const ocupado = testando === item.code || item.reservado;
                return (
                  <tr key={`${item.origem}-${item.manualId || item.code}`} style={{ borderBottom: "0.5px solid var(--color-border-tertiary)" }}>
                    <td style={{ ...td, fontFamily: "monospace", fontWeight: 500 }}>{item.code}</td>
                    <td style={{ ...td, maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      <a href={item.url} target="_blank" rel="noreferrer" title={item.url}>{linkCurto(item.url)}</a>
                    </td>
                    <td style={td}>
                      {item.origem === "manual" ? "manual" : `repasse · ${item.capturas ?? "?"} captura(s)`}
                      {item.motivo === "indeterminado" && <div style={{ color: "var(--color-text-secondary)" }}>nova tentativa</div>}
                    </td>
                    <td style={td}>{dataHora(item.criadoEm)}</td>
                    <td style={td}>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        <button
                          onClick={() => testarUm(item)}
                          disabled={!temCheckout || ocupado || lote || !!testando}
                          style={botaoLink}
                        >
                          {ocupado ? "⟳ testando..." : "Testar"}
                        </button>
                        {item.origem === "manual" && (
                          <button
                            onClick={() => remover(item)}
                            disabled={ocupado}
                            style={{ ...botaoLink, borderColor: "var(--danger-text)", color: "var(--danger-text)" }}
                          >
                            Remover
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {resultados.length > 0 && (
        <div style={{ marginTop: 12, fontSize: 12 }}>
          <div style={{ color: "var(--color-text-secondary)", marginBottom: 4 }}>Testados agora há pouco nesta aba:</div>
          {resultados.map(r => (
            <div key={r.code} style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontFamily: "monospace", fontWeight: 500 }}>{r.code}</span>
              <span style={{ color: r.verdict === "valid" ? "var(--color-primary-dark)" : r.verdict === "invalid" ? "var(--danger-text)" : "var(--warn-text)" }}>
                {r.verdict === "valid" ? "✅" : r.verdict === "invalid" ? "❌" : "❓"}
              </span>
              <span style={{ color: "var(--color-text-secondary)" }}>{r.texto}</span>
            </div>
          ))}
        </div>
      )}

      {adicionando && (
        <AdicionarTeste
          onClose={() => setAdicionando(false)}
          onAdicionado={async (item) => {
            setAdicionando(false);
            setAviso(`${item.code} entrou no começo da fila.`);
            await carregar();
          }}
        />
      )}
    </section>
  );
}

function AdicionarTeste({ onClose, onAdicionado }) {
  const [url, setUrl] = useState("");
  const [code, setCode] = useState("");
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState(null);

  const enviar = async (e) => {
    e.preventDefault();
    setSalvando(true);
    setErro(null);
    try {
      const item = await adminRepasseCupomCheckoutManual({ code: code.trim().toUpperCase(), url: url.trim() });
      await onAdicionado(item);
    } catch (err) {
      setErro(errText(err, "Não deu pra adicionar."));
    } finally {
      setSalvando(false);
    }
  };

  const falta = !url.trim() || !code.trim();
  return (
    <Modal title="Adicionar teste de cupom" onClose={onClose}>
      <form onSubmit={enviar}>
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 14, lineHeight: 1.5 }}>
          O cupom é testado no checkout deste produto, como os que chegam pelo repasse, e entra no começo da fila.
        </div>
        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle} htmlFor="fila-manual-url">Link do produto (Mercado Livre)</label>
          <input
            id="fila-manual-url"
            type="url"
            placeholder="https://www.mercadolivre.com.br/..."
            value={url}
            onChange={e => setUrl(e.target.value)}
            style={{ ...inputStyle, width: "100%" }}
          />
        </div>
        <div style={{ marginBottom: 16 }}>
          <label style={labelStyle} htmlFor="fila-manual-code">Código do cupom</label>
          <input
            id="fila-manual-code"
            placeholder="MELIKIDS"
            value={code}
            onChange={e => setCode(e.target.value)}
            style={{ ...inputStyle, width: "100%", textTransform: "uppercase" }}
          />
        </div>
        {erro && <div style={{ fontSize: 12, color: "var(--danger-text)", marginBottom: 12 }}>{erro}</div>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" onClick={onClose} disabled={salvando} style={botaoSecundario}>Cancelar</button>
          <button type="submit" disabled={salvando || falta} style={botaoPrimario(salvando || falta)}>
            {salvando ? "Adicionando..." : "Adicionar à fila"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
