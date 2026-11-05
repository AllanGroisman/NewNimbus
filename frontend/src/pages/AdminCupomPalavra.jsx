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
  adminMlCuponsCodes, adminMlCuponsImportCampaign, adminMlCuponsImportStatus,
  adminMlCuponsClearCodes, errText,
} from "../data/api";
import Modal from "../components/ui/Modal";
import { testarPalavra } from "../data/cupomPalavra";
import { coletorEntende } from "../data/coletor";
import { buscarNoChrome as buscarCampanhaNoChrome } from "../data/buscarCampanha";
import { VERDICT } from "../data/cupomRotulos";
import { useLembrado } from "../data/useLembrado";
import { cardStyle, inputStyle, dia, desconto, botaoPrimario, botaoSecundario, botaoLink } from "../components/admin/cupomEstilos";

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

// A explicação de "achei a palavra e não achei a campanha" mora em
// data/buscarCampanha.js (`naoAchei`), junto da busca que a usa.

// O convite pra trazer a campanha que a palavra apontou.
//
// O ML só responde o ID da campanha; se ela nunca foi raspada, não existe linha
// nenhuma aqui e a resposta fica sendo um número solto. Este modal é o atalho que
// evita rodar a coleta inteira só pra descobrir o que aquele número é.
// A busca roda SOLTA no servidor (varrer a lista do ML passa dos 90s do nginx), então
// o botão só dispara e este modal acompanha pelo status — mesmo desenho do "Puxar
// cupons agora" lá em cima.
export function ImportarCampanhaModal({ campaignId, word, onClose, onDone }) {
  const [comProdutos, setComProdutos] = useLembrado("cupons.importarComProdutos", true);
  const [enviando, setEnviando] = useState(false);
  const [rodando, setRodando] = useState(false);
  const [progresso, setProgresso] = useState(null);
  const [feito, setFeito] = useState(null);
  const [erro, setErro] = useState(null);

  const fechar = () => {
    if (feito) onDone?.(feito);
    onClose();
  };

  // A busca numa aba do Chrome do admin. É o caminho que não apanha CAPTCHA: o ML
  // barra navegador automatizado, e a busca do servidor abre um Chrome próprio.
  //
  // A varredura é a mesma da rodada de cupons — `percorrerLista` com `procurar`,
  // que para na página em que a campanha aparecer. Depois dela, a vitrine, pelo
  // mesmo caminho que a aba "Cupons do ML" já usa.
  const buscarNoChrome = async () => {
    setEnviando(true); setErro(null); setProgresso(null);
    try {
      setFeito(await buscarCampanhaNoChrome(campaignId, { comProdutos, onProgresso: setProgresso }));
    } catch (err) {
      setErro(errText(err, "Não deu pra buscar essa campanha no seu Chrome."));
    } finally {
      setEnviando(false);
      setProgresso(null);
    }
  };

  const buscar = async () => {
    if (await coletorEntende("lista")) return buscarNoChrome();
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
      {/* Duas redações, porque são duas perguntas diferentes chegando no mesmo modal:
          o número que uma PALAVRA testada apontou, e o número que alguém digitou na
          aba "Cupons do ML". Com `word` nulo a frase da palavra ficava sem sujeito
          ("O ML reconheceu disse que ela é da campanha..."). */}
      <div style={{ fontSize: 13, lineHeight: 1.6, marginBottom: 14 }}>
        {word ? (
          <>
            O ML reconheceu a palavra <code>{word}</code> e disse que ela é da campanha{" "}
            <code>{campaignId}</code> — mas esse cupom nunca foi raspado, então não sabemos o título
            dele, o desconto nem quais produtos ele cobre.
          </>
        ) : (
          <>
            A campanha <code>{campaignId}</code> não está guardada aqui, então não sabemos o título
            dela, o desconto nem quais produtos ela cobre.
          </>
        )}
        {" "}Dá pra ir buscar essa campanha no ML agora, sem rodar a coleta inteira.
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
// `onVerCupom` recebe o número da campanha e leva para a aba "Cupons do ML" já
// filtrada por ele (AdminCupom.jsx). É opcional: sem ela os botões não aparecem, e o
// componente continua montável sozinho.
export default function DescobrirPalavra({ onVerCupom = null }) {
  const [word, setWord] = useState("");
  const [rodando, setRodando] = useState(false);
  const [res, setRes] = useState(null);
  const [erro, setErro] = useState(null);
  const [historico, setHistorico] = useState([]);
  const [importar, setImportar] = useState(null);
  // A campanha importada só aparece na aba "Cupons do ML" — sem esta linha, o modal
  // fecha e parece que nada aconteceu.
  const [importada, setImportada] = useState(null);
  const [confirmarLimpeza, setConfirmarLimpeza] = useState(false);
  const [limpando, setLimpando] = useState(false);

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
      const res = await testarPalavra(word, { force });
      setRes(res);
      carregar();
      // A palavra existe, o ML disse de que campanha ela é — e a campanha não está
      // aqui. Vale também pra resposta vinda do cache: ele guarda o veredito da
      // palavra, não diz nada sobre a campanha ter entrado no sistema desde então.
      if (res?.verdict === "valid" && res.campaignId && !res.coupon) {
        setImportar({ campaignId: res.campaignId, word: res.word });
      }
    } catch (err) {
      setErro(errText(err, "Não deu pra testar essa palavra."));
    } finally {
      setRodando(false);
    }
  };

  const limparLista = async () => {
    setConfirmarLimpeza(false);
    setErro(null);
    setLimpando(true);
    try {
      await adminMlCuponsClearCodes();
      setHistorico([]);
      setRes(null);
      carregar();
    } catch (err) {
      setErro(errText(err, "Não deu pra limpar a lista de palavras."));
    } finally {
      setLimpando(false);
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
          {res.campaignId && <> · campanha <code>{res.campaignId}</code></>}
          {res.cached && <span style={{ color: "var(--color-text-secondary)" }}> · resposta guardada de {new Date(res.checkedAt).toLocaleString("pt-BR")}</span>}
          <div style={{ color: "var(--color-text-secondary)", fontSize: 12, marginTop: 4 }}>{res.message || res.reason}</div>
          {/* O cupom que esse número é, quando ele já está guardado. Só o id não diz
              nada a quem está decidindo se vale repassar a palavra: o que responde é
              o desconto e até quando ele vale. */}
          {res.coupon && (
            <div style={{ marginTop: 6, display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap", fontSize: 12 }}>
              <b>{res.coupon.title}</b>
              <span style={{ color: "var(--color-text-secondary)" }}>
                {`${desconto(res.coupon)} · vence ${dia(res.coupon.expiresAt)}`}
              </span>
              {onVerCupom && (
                <button onClick={() => onVerCupom(res.campaignId)} style={botaoLink}>ver cupom →</button>
              )}
            </div>
          )}
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
          <div style={{ display: "flex", gap: 10, alignItems: "baseline", marginBottom: 6 }}>
            <span style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>Palavras já testadas</span>
            <button onClick={() => setConfirmarLimpeza(true)} disabled={limpando} style={botaoLink}>
              {limpando ? "apagando..." : "🗑 Limpar lista"}
            </button>
          </div>
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
                {h.campaignId && h.inSystem && onVerCupom && (
                  <button onClick={() => onVerCupom(h.campaignId)} style={botaoLink}>ver cupom →</button>
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

      {confirmarLimpeza && (
        <Modal title="Apagar todas as palavras testadas?" onClose={() => setConfirmarLimpeza(false)} danger>
          <p style={{ fontSize: 13, marginBottom: 16, color: "var(--color-text-secondary)", lineHeight: 1.5 }}>
            Todas as palavras testadas serão apagadas do sistema, não só desta lista. Testar uma delas de novo
            abre o Chrome com a conta do sistema, e a aba <b>Repasse</b> deixa de mostrar o resultado
            dos códigos já testados. A palavra que já está no cupom (aba <b>Cupons do ML</b>)
            <strong style={{ color: "var(--color-text-primary)" }}> continua lá</strong>.
            Esta ação não pode ser desfeita.
          </p>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button onClick={() => setConfirmarLimpeza(false)} style={botaoSecundario}>Cancelar</button>
            <button
              onClick={limparLista}
              style={{ padding: "8px 16px", borderRadius: 8, background: "#E24B4A", color: "#fff", border: "none", fontSize: 13, fontWeight: 500, cursor: "pointer" }}
            >Apagar palavras</button>
          </div>
        </Modal>
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
