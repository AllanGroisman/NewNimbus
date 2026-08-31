// Admin › Cupom › aba "Descobrir palavra" — a que campanha pertence uma palavra
// de cupom.
//
// Os cupons da aba "Cupons do ML" não têm palavra (são "Eu quero" ou automáticos),
// e a página do ML não lista palavra nenhuma: a única forma de saber é digitar a
// palavra no checkout com a conta do sistema e ler a resposta. É isso que esta aba
// faz — e o dicionário `palavra → campanha` que ela vai formando (`ml_coupon_codes`)
// é o que fecha o ciclo "palavra do grupo líder → produtos do cupom".
//
// Morava dentro da aba "Cupons do ML"; saiu de lá porque é outra pergunta, e ficava
// espremida entre a rodada e a tabela.
import { useState, useEffect, useCallback } from "react";
import {
  adminMlCuponsTestWord, adminMlCuponsCodes,
  adminMlCuponsImportCampaign, adminMlCuponsImportStatus, errText,
} from "../data/api";
import Modal from "../components/ui/Modal";
import { VERDICT } from "../data/cupomRotulos";
import { cardStyle, inputStyle, botaoPrimario, botaoSecundario, botaoLink } from "../components/admin/cupomEstilos";

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
export function ImportarCampanhaModal({ campaignId, word, onClose, onDone }) {
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
export default function DescobrirPalavra() {
  const [word, setWord] = useState("");
  const [rodando, setRodando] = useState(false);
  const [res, setRes] = useState(null);
  const [erro, setErro] = useState(null);
  const [historico, setHistorico] = useState([]);
  const [importar, setImportar] = useState(null);
  // A campanha importada só aparece na aba "Cupons do ML" — sem esta linha, o modal
  // fecha e parece que nada aconteceu.
  const [importada, setImportada] = useState(null);

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

      {/* A campanha importada entra na lista da outra aba — dizer isso evita o
          "cliquei e não aconteceu nada". */}
      {importada && (
        <div style={{ marginTop: 10, fontSize: 12, background: "var(--color-background-secondary)", padding: "8px 10px", borderRadius: 8 }}>
          “{importada}” entrou no sistema — ela aparece na aba <b>Cupons do ML</b>.
        </div>
      )}

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
            setImportada(feito?.coupon?.title || `campanha ${importar.campaignId}`);
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
