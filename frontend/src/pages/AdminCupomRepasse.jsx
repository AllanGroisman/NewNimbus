// Admin › Cupom › aba "Repasse" — os cupons que a captura pescou nas legendas
// dos grupos líderes.
//
// A captura já lia o código ("use o cupom JBL20") e o levava junto do produto até
// o envio, mas ninguém nunca perguntava ao ML se aquele código existe. O cupom
// ficava só na coluna `coupon` do log de captura — uma linha por LINK, então o
// mesmo código aparecia dezenas de vezes e nenhuma delas dizia nada sobre ele.
//
// Esta aba junta as duas metades: de um lado o que o repasse viu (quantas vezes,
// desde quando, em quantas campanhas), do outro o que o sistema sabe da palavra
// (`ml_coupon_codes` + `ml_coupons`, o dicionário da aba "Descobrir palavra").
// O teste é SOB DEMANDA, pelo botão da linha: cada um abre um Chrome com a conta
// do ML, e disparar isso sozinho a cada mensagem recebida é pedir CAPTCHA.
import { useState, useEffect, useCallback } from "react";
import { PRIMARY_DARK } from "../data/constants";
import {
  adminRepasseCoupons, adminRepasseLogs,
  adminMlCuponsSyncProducts, adminRepasseCouponForget, adminRepasseCouponsClear, errText,
} from "../data/api";
import Pagination from "../components/ui/Pagination";
import Modal from "../components/ui/Modal";
import { ImportarCampanhaModal } from "./AdminCupomPalavra";
import { testarPalavra } from "../data/cupomPalavra";
import { VERDICT, OUTCOME_LABEL } from "../data/cupomRotulos";
import {
  cardStyle, inputStyle, labelStyle, th, td, botaoLink, botaoPerigo, botaoSecundario,
} from "../components/admin/cupomEstilos";

// O semáforo da aba "Descobrir palavra" mais o estado que só existe aqui: a
// palavra que nunca foi ao ML. É o caso da esmagadora maioria das linhas, e
// mostrá-lo como "o ML não reconheceu" seria dizer o oposto da verdade.
const SEMAFORO = {
  ...VERDICT,
  "nao-testado": { label: "⏳ nunca testado", color: "var(--color-text-secondary)" },
};

const FILTROS_STATUS = [
  ["todos", "Todos"],
  ["nao-testado", "Nunca testados"],
  ["sem-campanha", "Falta trazer a campanha"],
  ["valid", "Palavra existe"],
  ["invalid", "O ML não reconheceu"],
  ["indeterminado", "O ML não respondeu"],
];

const PERIODOS = [["7", "7 dias"], ["30", "30 dias"], ["90", "90 dias"], ["tudo", "Tudo"]];

const PAGE_SIZE = 30;

const data = (v) => (v ? new Date(v).toLocaleDateString("pt-BR") : "—");
const dataHora = (v) => (v ? new Date(v).toLocaleString("pt-BR") : "—");

export default function CuponsDoRepasse() {
  const [days, setDays] = useState("90");
  const [status, setStatus] = useState("todos");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);

  const [dados, setDados] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState(null);
  // Qual código está aberto (as capturas individuais) e qual está sendo importado.
  const [aberto, setAberto] = useState(null);
  const [importando, setImportando] = useState(null);
  // A confirmação de excluir mora aqui, no pai, e não em cada linha: renderizar
  // 30 modais fechados é desperdício, e é o pai quem recarrega a lista depois.
  const [excluindo, setExcluindo] = useState(null);
  const [limpando, setLimpando] = useState(false);
  const [apagando, setApagando] = useState(false);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      setDados(await adminRepasseCoupons({ page, pageSize: PAGE_SIZE, days, status, q: q.trim() }));
    } catch (err) {
      setErro(errText(err, "Não deu pra carregar os cupons do repasse."));
    } finally {
      setCarregando(false);
    }
  }, [page, days, status, q]);

  useEffect(() => { carregar(); }, [carregar]);

  // Filtro novo volta pra primeira página: manter a página 3 de uma lista que
  // encolheu deixa a tela vazia sem explicar por quê.
  const trocarFiltro = (fn) => (v) => { fn(v); setPage(1); };

  // Troca UMA linha no lugar, sem recarregar a lista inteira: recarregar jogaria
  // a linha testada pra fora do filtro "nunca testados" no meio da leitura.
  const atualizarLinha = (code, patch) => {
    setDados(d => d && ({
      ...d,
      items: d.items.map(i => (i.code === code ? { ...i, ...patch } : i)),
    }));
  };

  // Depois de excluir a lista é recarregada de verdade — o oposto do `Testar`,
  // que troca a linha no lugar pra não se auto-ejetar do filtro. Aqui ejetar é o
  // ponto, e `total`/paginação precisam acompanhar.
  const excluirUm = async () => {
    setApagando(true);
    setErro(null);
    try {
      await adminRepasseCouponForget(excluindo.code);
      setExcluindo(null);
      setAberto(null);
      await carregar();
    } catch (err) {
      setErro(errText(err, "Não deu pra excluir esse cupom."));
      setExcluindo(null);
    } finally {
      setApagando(false);
    }
  };

  const limparLista = async () => {
    setApagando(true);
    setErro(null);
    try {
      await adminRepasseCouponsClear({ days, status, q: q.trim() });
      setLimpando(false);
      setAberto(null);
      // A lista some inteira: ficar na página 3 mostraria vazio sem explicar.
      if (page !== 1) setPage(1);
      else await carregar();
    } catch (err) {
      setErro(errText(err, "Não deu pra limpar a lista."));
      setLimpando(false);
    } finally {
      setApagando(false);
    }
  };

  const items = dados?.items || [];
  const totalPages = Math.max(1, Math.ceil((dados?.total || 0) / PAGE_SIZE));

  return (
    <div>
      <div style={cardStyle}>
        <div style={{ fontWeight: 500, marginBottom: 4 }}>Cupons capturados pelo repasse</div>
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 14, lineHeight: 1.5 }}>
          Um por código, com quantas vezes ele apareceu nas legendas dos grupos líderes.
          O <b>Testar</b> pergunta ao ML a que campanha a palavra pertence — abre um Chrome
          com a conta do sistema e leva alguns segundos, por isso não roda sozinho.
          Quando a palavra vale mas a campanha nunca foi raspada, o <b>Trazer campanha</b>
          busca ela e os produtos dela.
        </div>

        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div>
            <label style={labelStyle} htmlFor="repasse-cupom-periodo">Período</label>
            <select id="repasse-cupom-periodo" value={days} onChange={e => trocarFiltro(setDays)(e.target.value)} style={inputStyle}>
              {PERIODOS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div>
            <label style={labelStyle} htmlFor="repasse-cupom-status">Situação</label>
            <select id="repasse-cupom-status" value={status} onChange={e => trocarFiltro(setStatus)(e.target.value)} style={inputStyle}>
              {FILTROS_STATUS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div>
            <label style={labelStyle} htmlFor="repasse-cupom-q">Código</label>
            <input
              id="repasse-cupom-q"
              type="search"
              placeholder="JBL20"
              value={q}
              onChange={e => trocarFiltro(setQ)(e.target.value)}
              style={{ ...inputStyle, textTransform: "uppercase" }}
            />
          </div>
          <button onClick={carregar} disabled={carregando} style={botaoLink}>
            {carregando ? "⟳" : "↻"} atualizar
          </button>
          <button
            onClick={() => setLimpando(true)}
            disabled={carregando || !dados?.total}
            style={botaoPerigo(carregando || !dados?.total)}
          >
            🗑 Limpar lista ({dados?.total ?? 0})
          </button>
        </div>

        {dados && (
          <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 12 }}>
            {dados.total} cupom(ns)
            {dados.total !== dados.totalCapturados && <> de {dados.totalCapturados} no período</>}
          </div>
        )}
      </div>

      {erro && (
        <div style={{ ...cardStyle, background: "var(--danger-bg)", color: "var(--danger-text)", fontSize: 12 }}>
          {erro}
        </div>
      )}

      <div style={cardStyle}>
        {carregando && !dados ? (
          <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>Carregando...</div>
        ) : items.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
            Nenhum cupom capturado pelo repasse com esses filtros.
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ textAlign: "left", color: "var(--color-text-secondary)", borderBottom: "0.5px solid var(--color-border-tertiary)" }}>
                  <th style={th}>Cupom</th>
                  <th style={th}>Capturas</th>
                  <th style={th}>Visto</th>
                  <th style={th}>Situação</th>
                  <th style={th}>Campanha do ML</th>
                  <th style={th}>Ações</th>
                </tr>
              </thead>
              <tbody>
                {items.map(c => (
                  <Linha
                    key={c.code}
                    cupom={c}
                    aberto={aberto === c.code}
                    onToggle={() => setAberto(a => (a === c.code ? null : c.code))}
                    onPatch={patch => atualizarLinha(c.code, patch)}
                    onImportar={() => setImportando(c)}
                    onExcluir={() => setExcluindo(c)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}

        <Pagination page={page} totalPages={totalPages} onChange={setPage} disabled={carregando} />
      </div>

      {importando && (
        <ImportarCampanhaModal
          campaignId={importando.campaignId}
          word={importando.code}
          onClose={() => setImportando(null)}
          // A campanha chegou: recarrega, que agora a linha muda de coluna
          // (inSystem, título e contagem de produtos vêm todos do servidor).
          onDone={() => carregar()}
        />
      )}

      {excluindo && (
        <Modal title={`Excluir o cupom ${excluindo.code}?`} onClose={() => setExcluindo(null)} danger>
          <ExplicacaoDaExclusao>
            O código sai das <strong>{excluindo.capturas}</strong> captura(s) em que apareceu.
          </ExplicacaoDaExclusao>
          <BotoesDoModal
            apagando={apagando}
            onCancelar={() => setExcluindo(null)}
            onConfirmar={excluirUm}
            rotulo="Excluir cupom"
          />
        </Modal>
      )}

      {limpando && (
        <Modal title="Limpar a lista de cupons?" onClose={() => setLimpando(false)} danger>
          <ExplicacaoDaExclusao>
            {/* O filtro em vigor vai escrito por extenso: limpar 200 cupons
                achando que eram os 12 da tela é o erro caro aqui. */}
            Serão excluídos os <strong>{dados?.total ?? 0}</strong> cupons de{" "}
            <strong>{rotulo(FILTROS_STATUS, status)}</strong>
            {q.trim() && <> com <strong>{q.trim().toUpperCase()}</strong> no código</>}
            {" "}em <strong>{rotulo(PERIODOS, days).toLowerCase()}</strong>.
          </ExplicacaoDaExclusao>
          <BotoesDoModal
            apagando={apagando}
            onCancelar={() => setLimpando(false)}
            onConfirmar={limparLista}
            rotulo="Limpar lista"
          />
        </Modal>
      )}
    </div>
  );
}

const rotulo = (pares, valor) => (pares.find(([v]) => v === valor) || [null, valor])[1];

// O texto que os dois modais compartilham. Ele existe porque a palavra "excluir"
// promete mais do que acontece: nada é apagado do log, e o cupom pode voltar.
function ExplicacaoDaExclusao({ children }) {
  return (
    <div style={{ fontSize: 13, marginBottom: 16, color: "var(--color-text-secondary)", lineHeight: 1.5 }}>
      <p style={{ marginBottom: 10 }}>{children}</p>
      <p style={{ marginBottom: 10 }}>
        As capturas <strong style={{ color: "var(--color-text-primary)" }}>continuam no log</strong> de
        Admin › Repasse (grupo, link, produto, desfecho) — some só o código de dentro delas.
        A palavra já testada também <strong style={{ color: "var(--color-text-primary)" }}>continua guardada</strong>:
        cada uma custou um Chrome aberto com a conta do ML pra descobrir.
      </p>
      <p>
        Se o mesmo cupom for capturado de novo, ele volta pra esta lista. Pra barrar de vez uma
        palavra que nunca é cupom, use a lista de ignorados em <strong>Config Test</strong>.
      </p>
    </div>
  );
}

function BotoesDoModal({ apagando, onCancelar, onConfirmar, rotulo: texto }) {
  return (
    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
      <button onClick={onCancelar} disabled={apagando} style={botaoSecundario}>Cancelar</button>
      <button
        onClick={onConfirmar}
        disabled={apagando}
        style={{ padding: "8px 16px", borderRadius: 8, background: "#E24B4A", color: "#fff", border: "none", fontSize: 13, fontWeight: 500, cursor: apagando ? "default" : "pointer", opacity: apagando ? 0.6 : 1 }}
      >{apagando ? "Excluindo..." : texto}</button>
    </div>
  );
}

function Linha({ cupom, aberto, onToggle, onPatch, onImportar, onExcluir }) {
  const [testando, setTestando] = useState(false);
  const [raspando, setRaspando] = useState(false);
  const [aviso, setAviso] = useState(null);

  const sem = SEMAFORO[cupom.verdict] || SEMAFORO["nao-testado"];

  const testar = async () => {
    setTestando(true);
    setAviso(null);
    try {
      // `force` porque o botão é um pedido explícito de "vai lá agora": sem ele o
      // checkWord devolveria o cache de 12h e o clique não faria nada visível.
      const res = await testarPalavra(cupom.code, { force: true, source: "repasse" });
      onPatch({
        verdict: res.verdict ?? null,
        campaignId: res.campaignId ?? null,
        couponTitle: res.coupon?.title ?? null,
        inSystem: res.campaignId ? !!res.coupon : null,
        message: res.message ?? null,
        checkedAt: new Date().toISOString(),
        checkCount: (cupom.checkCount || 0) + 1,
        source: "repasse",
      });
      if (res.verdict === "valid" && res.campaignId && !res.coupon) {
        setAviso("A palavra vale, mas essa campanha não está no sistema — use “Trazer campanha”.");
      }
    } catch (err) {
      setAviso(errText(err, "Não deu pra testar essa palavra agora."));
    } finally {
      setTestando(false);
    }
  };

  const rasparVitrine = async () => {
    setRaspando(true);
    setAviso(null);
    try {
      const r = await adminMlCuponsSyncProducts(cupom.campaignId);
      if (r?.produtos) {
        onPatch({ produtos: r.produtos });
        setAviso(`Vitrine raspada: ${r.produtos} produto(s).`);
      } else {
        setAviso("O ML não devolveu produto nenhum pra essa campanha.");
      }
    } catch (err) {
      setAviso(errText(err, "Não deu pra raspar a vitrine agora."));
    } finally {
      setRaspando(false);
    }
  };

  return (
    <>
      <tr style={{ borderBottom: "0.5px solid var(--color-border-tertiary)" }}>
        <td style={{ ...td, fontFamily: "monospace", fontWeight: 500 }}>{cupom.code}</td>
        <td style={td}>
          {cupom.capturas}
          <div style={{ color: "var(--color-text-secondary)" }}>
            {cupom.aproveitados} na fila · {cupom.campanhas} campanha(s)
          </div>
        </td>
        <td style={td}>
          {data(cupom.ultima)}
          <div style={{ color: "var(--color-text-secondary)" }}>desde {data(cupom.primeira)}</div>
        </td>
        <td style={td}>
          <span style={{ color: sem.color, fontWeight: 500 }}>{sem.label}</span>
          {cupom.checkedAt && (
            <div style={{ color: "var(--color-text-secondary)" }}>
              testado {dataHora(cupom.checkedAt)}
              {cupom.source === "repasse" && " (por aqui)"}
            </div>
          )}
          {cupom.message && (
            <div style={{ color: "var(--color-text-secondary)" }}>“{cupom.message}”</div>
          )}
        </td>
        <td style={td}>
          {cupom.campaignId ? (
            <>
              <div>{cupom.couponTitle || <code>{cupom.campaignId}</code>}</div>
              <div style={{ color: cupom.inSystem ? "var(--color-text-secondary)" : "var(--warn-text)" }}>
                {cupom.inSystem
                  ? `no sistema · ${cupom.produtos} produto(s)`
                  : "não está no sistema"}
              </div>
            </>
          ) : (
            <span style={{ color: "var(--color-text-secondary)" }}>—</span>
          )}
        </td>
        <td style={td}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button onClick={testar} disabled={testando} style={botaoLink}>
              {testando ? "⟳ testando..." : cupom.verdict ? "Testar de novo" : "Testar"}
            </button>
            {cupom.verdict === "valid" && cupom.campaignId && !cupom.inSystem && (
              <button onClick={onImportar} style={{ ...botaoLink, borderColor: PRIMARY_DARK, color: PRIMARY_DARK }}>
                Trazer campanha
              </button>
            )}
            {cupom.inSystem && cupom.produtos === 0 && (
              <button onClick={rasparVitrine} disabled={raspando} style={botaoLink}>
                {raspando ? "⟳ raspando..." : "Raspar vitrine"}
              </button>
            )}
            <button onClick={onToggle} style={botaoLink}>
              {aberto ? "▲ capturas" : "▼ capturas"}
            </button>
            <button
              onClick={onExcluir}
              style={{ ...botaoLink, borderColor: "var(--danger-text)", color: "var(--danger-text)" }}
              title="Tira o cupom desta lista. As capturas continuam no log."
            >
              Excluir
            </button>
          </div>
          {aviso && (
            <div style={{ marginTop: 6, color: "var(--color-text-secondary)", maxWidth: 280 }}>{aviso}</div>
          )}
        </td>
      </tr>
      {aberto && (
        <tr>
          <td style={{ ...td, background: "var(--color-background-secondary)" }} colSpan={6}>
            <Capturas code={cupom.code} />
          </td>
        </tr>
      )}
    </>
  );
}

// As linhas do log de captura desse cupom — de onde ele veio e o que aconteceu com
// cada link. Reusa a rota do log de repasse (Admin › Repasse) com o filtro `coupon`.
function Capturas({ code }) {
  const [linhas, setLinhas] = useState(null);
  const [erro, setErro] = useState(null);

  useEffect(() => {
    let vivo = true;
    (async () => {
      try {
        const r = await adminRepasseLogs({ coupon: code, pageSize: 20 });
        if (vivo) setLinhas(r.items || []);
      } catch (err) {
        if (vivo) setErro(errText(err, "Não deu pra carregar as capturas."));
      }
    })();
    return () => { vivo = false; };
  }, [code]);

  if (erro) return <div style={{ color: "var(--danger-text)" }}>{erro}</div>;
  if (!linhas) return <div style={{ color: "var(--color-text-secondary)" }}>Carregando capturas...</div>;
  if (!linhas.length) return <div style={{ color: "var(--color-text-secondary)" }}>Nenhuma captura.</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {linhas.map(r => {
        const out = OUTCOME_LABEL[r.outcome] || { label: r.outcome, color: "var(--color-text-secondary)" };
        return (
          <div key={r.id} style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "baseline" }}>
            <span style={{ color: "var(--color-text-secondary)", minWidth: 120 }}>{dataHora(r.createdAt)}</span>
            <span style={{ color: out.color, fontWeight: 500 }}>{out.label}</span>
            <span>{r.groupName || `campanha ${r.groupId}`}</span>
            <span style={{ flex: "1 1 220px", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {r.productName || r.rawUrl}
            </span>
          </div>
        );
      })}
    </div>
  );
}
